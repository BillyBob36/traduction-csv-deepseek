/**
 * Routes de traduction CSV
 * Gère l'upload multiple, le traitement parallèle et les SSE pour la progression
 * Avec déduplication des textes et sauvegarde incrémentale
 */

const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { parseCSV, insertTranslations, normalizeAndDeduplicateHandles, generateCSV, createBatches } = require('../services/csv');
const { translateBatch: translateBatchDeepSeek, resetCacheStats, getCacheStats, ParallelController } = require('../services/deepseek');
const { translateBatchOpenAI, resetOpenAIStats, getOpenAIStats, getTierLimits, TIER_LIMITS, RampUpController, createSmartBatches } = require('../services/openai');
const LANGUAGES = require('../config/languages');

// Répertoire temporaire pour les fichiers en cours
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/csv-translator';

// S'assurer que le répertoire temp existe
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Configuration multer pour upload en mémoire
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max par fichier
    files: 20 // Max 20 fichiers simultanés
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers CSV sont acceptés'));
    }
  }
});

// Map pour stocker les sessions SSE actives
const sseClients = new Map();

// Map pour stocker les sessions de traduction en cours (pour téléchargement temp)
const activeSessions = new Map();

// Throttle pour les updates SSE (évite de surcharger le navigateur)
const sseThrottles = new Map();
const SSE_THROTTLE_MS = 100; // Max 10 updates par seconde

function sendSSEThrottled(sessionId, data) {
  const now = Date.now();
  const lastSent = sseThrottles.get(sessionId) || 0;
  
  // Toujours envoyer les messages importants immédiatement
  if (data.type !== 'progress') {
    sendSSE(sessionId, data);
    return;
  }
  
  // Throttle les messages de progression
  if (now - lastSent >= SSE_THROTTLE_MS) {
    sendSSE(sessionId, data);
    sseThrottles.set(sessionId, now);
  }
}

/**
 * Route SSE pour la progression en temps réel
 */
router.get('/progress/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  console.log(`[SSE] Client connecté: ${sessionId}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders(); // Force l'envoi immédiat des headers

  // Enregistrer le client SSE
  sseClients.set(sessionId, res);
  console.log(`[SSE] Clients actifs: ${sseClients.size}`);

  // Envoyer un ping initial
  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);

  // Nettoyage à la déconnexion
  req.on('close', () => {
    console.log(`[SSE] Client déconnecté: ${sessionId}`);
    sseClients.delete(sessionId);
  });
});

/**
 * Envoie un événement SSE à un client
 */
function sendSSE(sessionId, data) {
  const client = sseClients.get(sessionId);
  if (client) {
    try {
      client.write(`data: ${JSON.stringify(data)}\n\n`);
      // Log uniquement pour les événements importants (pas chaque progress)
      if (data.type !== 'progress') {
        console.log(`[SSE] Envoyé ${data.type} à ${sessionId}`);
      }
    } catch (err) {
      console.error(`[SSE] Erreur envoi à ${sessionId}:`, err.message);
    }
  } else {
    console.warn(`[SSE] Client non trouvé: ${sessionId} (clients actifs: ${sseClients.size})`);
  }
}

/**
 * Crée un dictionnaire de déduplication des textes
 * @param {Array} sourceTexts - Tableau de {index, text}
 * @returns {Object} - {uniqueTexts: [{text, indices}], totalOriginal, totalUnique}
 */
function createDeduplicationDict(sourceTexts) {
  const textToIndices = new Map();
  
  for (const item of sourceTexts) {
    const text = item.text;
    if (textToIndices.has(text)) {
      textToIndices.get(text).push(item.index);
    } else {
      textToIndices.set(text, [item.index]);
    }
  }
  
  // Convertir en tableau pour le batching
  const uniqueTexts = [];
  for (const [text, indices] of textToIndices) {
    uniqueTexts.push({ text, indices });
  }
  
  return {
    uniqueTexts,
    totalOriginal: sourceTexts.length,
    totalUnique: uniqueTexts.length,
    deduplicationRatio: sourceTexts.length > 0 
      ? ((1 - uniqueTexts.length / sourceTexts.length) * 100).toFixed(1)
      : 0
  };
}

/**
 * Sauvegarde les traductions dans un fichier temporaire (JSON lines)
 */
function saveTempTranslation(sessionId, fileIndex, text, translation, indices) {
  const tempFile = path.join(TEMP_DIR, `${sessionId}_${fileIndex}.jsonl`);
  const line = JSON.stringify({ text, translation, indices }) + '\n';
  fs.appendFileSync(tempFile, line);
}

/**
 * Charge les traductions depuis le fichier temporaire
 */
function loadTempTranslations(sessionId, fileIndex) {
  const tempFile = path.join(TEMP_DIR, `${sessionId}_${fileIndex}.jsonl`);
  const translationsMap = new Map();
  
  if (fs.existsSync(tempFile)) {
    const content = fs.readFileSync(tempFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      try {
        const { translation, indices } = JSON.parse(line);
        for (const idx of indices) {
          translationsMap.set(idx, translation);
        }
      } catch (e) {
        // Ignorer les lignes malformées
      }
    }
  }
  
  return translationsMap;
}

/**
 * Supprime les fichiers temporaires d'une session
 */
function cleanupTempFiles(sessionId) {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      if (file.startsWith(sessionId)) {
        fs.unlinkSync(path.join(TEMP_DIR, file));
      }
    }
    console.log(`[Cleanup] Fichiers temp supprimés pour session ${sessionId}`);
  } catch (error) {
    console.error(`[Cleanup] Erreur:`, error.message);
  }
}

/**
 * Route principale de traduction
 * POST /api/translate
 */
router.post('/', upload.array('files'), async (req, res) => {
  const startTime = Date.now();
  const sessionId = req.body.sessionId || `session_${Date.now()}`;
  const targetLanguage = req.body.targetLanguage;
  const files = req.files;
  
  // Mode test : limiter le nombre de lignes
  const testMode = req.body.testMode === 'true';
  const testLines = parseInt(req.body.testLines) || 10;

  // Choix du LLM provider
  const llmProvider = req.body.llmProvider || 'deepseek'; // 'deepseek' ou 'openai'
  const openaiApiKey = req.body.openaiApiKey || '';
  const openaiTier = parseInt(req.body.openaiTier) || 3;

  console.log(`[Debug] testMode: ${testMode}, testLines: ${testLines}, provider: ${llmProvider}`);

  // Validation
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'Aucun fichier uploadé' });
  }

  if (!targetLanguage || !LANGUAGES[targetLanguage]) {
    return res.status(400).json({ 
      error: 'Langue cible invalide',
      availableLanguages: Object.keys(LANGUAGES)
    });
  }

  // Validation de la clé API selon le provider
  let apiKey;
  if (llmProvider === 'openai') {
    if (!openaiApiKey) {
      return res.status(400).json({ error: 'Clé API OpenAI requise' });
    }
    apiKey = openaiApiKey;
  } else {
    apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Clé API DeepSeek non configurée' });
    }
  }

  // Déterminer le niveau de parallélisation selon le provider
  let maxParallel, batchSize, tierLimits;
  if (llmProvider === 'openai') {
    tierLimits = getTierLimits(openaiTier);
    maxParallel = tierLimits.maxParallel;
    console.log(`[OpenAI] Tier ${openaiTier}: ${tierLimits.rpm} RPM, ${maxParallel} max parallèles, rampUp=${tierLimits.rampUp.initial}→${maxParallel}`);
    console.log(`[OpenAI] Smart batching: HTML=1/appel, texte simple=max 2000 chars/batch`);
  } else {
    maxParallel = 300; // DeepSeek n'a pas de rate limit
    batchSize = 25;    // DeepSeek utilise des batches de 25
  }

  console.log(`[Traduction] Début - ${files.length} fichier(s), langue: ${targetLanguage}, provider: ${llmProvider}${testMode ? ` (MODE TEST: ${testLines} lignes max)` : ' (COMPLET)'}`);

  // Réinitialiser les stats selon le provider
  if (llmProvider === 'openai') {
    resetOpenAIStats();
  } else {
    resetCacheStats();
  }

  // Enregistrer la session active
  activeSessions.set(sessionId, {
    status: 'running',
    startTime,
    targetLanguage,
    llmProvider,
    files: files.map(f => f.originalname)
  });

  try {
    const results = [];
    // Utiliser RampUpController pour OpenAI (montée progressive), ParallelController pour DeepSeek
    const parallelController = llmProvider === 'openai' 
      ? new RampUpController(tierLimits)
      : new ParallelController(maxParallel);
    
    let globalTotalUnique = 0;
    let globalProcessedUnique = 0;

    // Première passe : parser les fichiers, dédupliquer et compter
    const filesData = [];
    for (const file of files) {
      console.log(`[Parsing] Début parsing de ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} MB)...`);
      const parseStart = Date.now();
      
      const { rows, sourceTexts } = await parseCSV(file.buffer);
      
      console.log(`[Parsing] Terminé en ${Date.now() - parseStart}ms - ${sourceTexts.length} lignes trouvées`);
      
      // Mode test : limiter les lignes à traduire
      let textsToTranslate = sourceTexts;
      if (testMode) {
        textsToTranslate = sourceTexts.slice(0, testLines);
        console.log(`[Mode Test] Limitation à ${textsToTranslate.length} lignes`);
      }
      
      // DÉDUPLICATION : créer le dictionnaire des textes uniques
      const dedup = createDeduplicationDict(textsToTranslate);
      console.log(`[Déduplication] ${dedup.totalOriginal} lignes → ${dedup.totalUnique} uniques (${dedup.deduplicationRatio}% économisé)`);
      
      filesData.push({ 
        file, 
        rows, 
        sourceTexts: textsToTranslate,
        uniqueTexts: dedup.uniqueTexts,
        dedup
      });
      globalTotalUnique += dedup.totalUnique;
    }

    // Calculer le total original pour l'affichage
    const globalTotalOriginal = filesData.reduce((sum, f) => sum + f.dedup.totalOriginal, 0);

    sendSSE(sessionId, {
      type: 'init',
      totalFiles: files.length,
      totalLines: globalTotalOriginal,
      totalUnique: globalTotalUnique,
      deduplicationSaved: globalTotalOriginal - globalTotalUnique
    });

    // Traitement de chaque fichier
    for (let fileIndex = 0; fileIndex < filesData.length; fileIndex++) {
      const { file, rows, uniqueTexts, dedup } = filesData[fileIndex];
      const fileName = file.originalname;

      console.log(`[Fichier ${fileIndex + 1}/${files.length}] ${fileName} - ${dedup.totalUnique} textes uniques à traduire`);

      // Créer les batches selon le provider
      let batches;
      if (llmProvider === 'openai') {
        // OpenAI : smart batches (HTML 1/appel, texte simple max 2000 chars)
        batches = createSmartBatches(uniqueTexts);
      } else {
        // DeepSeek : batches classiques de 25
        batches = createBatches(
          uniqueTexts.map((u, i) => ({ index: i, text: u.text, indices: u.indices })), 
          batchSize
        ).map(batch => ({
          texts: batch.map(item => item.text),
          isHTML: false,
          items: batch.map(item => ({ index: item.index, text: item.text, originalIndices: uniqueTexts[item.index].indices }))
        }));
      }

      sendSSE(sessionId, {
        type: 'file_start',
        fileIndex,
        fileName,
        linesToTranslate: dedup.totalOriginal,
        uniqueToTranslate: dedup.totalUnique,
        totalBatches: batches.length
      });

      let fileProcessedBatches = 0;
      let fileProcessedTexts = 0;

      // Traiter les batches en parallèle
      const batchPromises = batches.map((batch, batchIndex) => 
        parallelController.execute(async () => {
          try {
            // Appeler le bon provider
            let translations;
            if (llmProvider === 'openai') {
              const result = await translateBatchOpenAI(batch.texts, targetLanguage, apiKey, openaiTier, batch.isHTML);
              translations = result.translations;
            } else {
              const result = await translateBatchDeepSeek(batch.texts, targetLanguage, apiKey);
              translations = result.translations;
            }
            
            // Sauvegarder chaque traduction dans le fichier temp
            for (let i = 0; i < batch.items.length; i++) {
              const item = batch.items[i];
              const translation = translations[i] || '';
              saveTempTranslation(sessionId, fileIndex, item.text, translation, item.originalIndices);
              
              // Incrémenter les compteurs
              fileProcessedTexts++;
              globalProcessedUnique++;
            }

            fileProcessedBatches++;
            
            // Log de progression toutes les 100 batches
            if (fileProcessedBatches % 100 === 0 || fileProcessedBatches === 1) {
              console.log(`[Progression] ${fileProcessedBatches}/${batches.length} batches, ${globalProcessedUnique}/${globalTotalUnique} uniques (${Math.round((globalProcessedUnique / globalTotalUnique) * 100)}%)`);
            }
            
            // Envoyer update de progression à chaque batch complété
            const stats = llmProvider === 'openai' ? getOpenAIStats() : getCacheStats();
            const percentComplete = Math.round((globalProcessedUnique / globalTotalUnique) * 100);
            sendSSE(sessionId, {
              type: 'progress',
              fileIndex,
              fileName,
              fileProcessedTexts,
              fileTotalTexts: dedup.totalUnique,
              globalProcessedUnique,
              globalTotalUnique,
              globalProcessedLines: Math.round((globalProcessedUnique / globalTotalUnique) * globalTotalOriginal),
              globalTotalLines: globalTotalOriginal,
              percentComplete,
              batchesCompleted: fileProcessedBatches,
              totalBatches: batches.length,
              llmProvider,
              cacheStats: stats
            });

          } catch (error) {
            console.error(`[Batch ${batchIndex}] Erreur:`, error.message);
            // En cas d'erreur, sauvegarder avec message d'erreur
            for (const item of batch.items) {
              saveTempTranslation(sessionId, fileIndex, item.text, `[ERREUR: ${error.message}]`, item.originalIndices);
              fileProcessedTexts++;
              globalProcessedUnique++;
            }
          }
        })
      );

      // Attendre que tous les batches soient traités
      await Promise.all(batchPromises);

      // Forcer une update SSE finale pour ce fichier (pas throttled)
      sendSSE(sessionId, {
        type: 'progress',
        fileIndex,
        fileName,
        fileProcessedTexts: dedup.totalUnique,
        fileTotalTexts: dedup.totalUnique,
        globalProcessedUnique,
        globalTotalUnique,
        globalProcessedLines: Math.round((globalProcessedUnique / globalTotalUnique) * globalTotalOriginal),
        globalTotalLines: globalTotalOriginal,
        percentComplete: Math.round((globalProcessedUnique / globalTotalUnique) * 100),
        cacheStats: getCacheStats()
      });

      // Charger les traductions depuis le fichier temp
      const translationsMap = loadTempTranslations(sessionId, fileIndex);

      // Insérer les traductions dans les rows
      insertTranslations(rows, translationsMap);

      // Post-traitement : normaliser + dédoublonner les handles (colonne C == "handle")
      normalizeAndDeduplicateHandles(rows);

      // Générer le CSV traduit
      const translatedCSV = await generateCSV(rows);

      // Nom du fichier avec suffixe test si applicable
      const suffix = testMode ? `_TEST_${targetLanguage}` : `_${targetLanguage}`;
      
      results.push({
        originalName: fileName,
        translatedName: fileName.replace('.csv', `${suffix}.csv`),
        content: translatedCSV,
        linesTranslated: dedup.totalOriginal,
        uniqueTranslated: dedup.totalUnique
      });

      sendSSE(sessionId, {
        type: 'file_complete',
        fileIndex,
        fileName
      });
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalStats = llmProvider === 'openai' ? getOpenAIStats() : getCacheStats();

    if (llmProvider === 'openai') {
      console.log(`[Traduction] Terminé en ${duration}s - OpenAI - Coût: $${finalStats.estimatedCost} - Dédup: ${globalTotalOriginal} → ${globalTotalUnique}`);
    } else {
      console.log(`[Traduction] Terminé en ${duration}s - DeepSeek - Cache hit: ${finalStats.hitRate}% - Dédup: ${globalTotalOriginal} → ${globalTotalUnique}`);
    }

    sendSSE(sessionId, {
      type: 'complete',
      duration,
      llmProvider,
      cacheStats: finalStats,
      deduplication: {
        original: globalTotalOriginal,
        unique: globalTotalUnique,
        saved: globalTotalOriginal - globalTotalUnique
      }
    });

    // Nettoyer les fichiers temporaires et le throttle
    cleanupTempFiles(sessionId);
    activeSessions.delete(sessionId);
    sseThrottles.delete(sessionId);

    // Si un seul fichier, retourner directement le CSV
    if (results.length === 1) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${results[0].translatedName}"`);
      return res.send(results[0].content);
    }

    // Plusieurs fichiers : retourner un ZIP
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="traductions_${targetLanguage}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const result of results) {
      archive.append(result.content, { name: result.translatedName });
    }

    await archive.finalize();

  } catch (error) {
    console.error('[Traduction] Erreur globale:', error);
    
    sendSSE(sessionId, {
      type: 'error',
      message: error.message
    });

    // Nettoyer en cas d'erreur aussi
    cleanupTempFiles(sessionId);
    activeSessions.delete(sessionId);
    sseThrottles.delete(sessionId);

    res.status(500).json({ error: error.message });
  }
});

/**
 * Route pour télécharger le fichier temporaire en cours de traduction
 * GET /api/translate/temp/:sessionId/:fileIndex
 */
router.get('/temp/:sessionId/:fileIndex', (req, res) => {
  const { sessionId, fileIndex } = req.params;
  const tempFile = path.join(TEMP_DIR, `${sessionId}_${fileIndex}.jsonl`);
  
  if (!fs.existsSync(tempFile)) {
    return res.status(404).json({ error: 'Fichier temporaire non trouvé' });
  }
  
  // Lire et convertir en format lisible
  const content = fs.readFileSync(tempFile, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  
  const translations = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
  
  res.json({
    sessionId,
    fileIndex: parseInt(fileIndex),
    translationsCount: translations.length,
    translations: translations.slice(-50) // Dernières 50 traductions
  });
});

/**
 * Route pour obtenir le statut d'une session
 * GET /api/translate/status/:sessionId
 */
router.get('/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session non trouvée ou terminée' });
  }
  
  // Compter les traductions dans les fichiers temp
  const tempFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(sessionId));
  let totalTranslations = 0;
  
  for (const file of tempFiles) {
    const content = fs.readFileSync(path.join(TEMP_DIR, file), 'utf-8');
    totalTranslations += content.split('\n').filter(l => l.trim()).length;
  }
  
  res.json({
    ...session,
    tempFiles: tempFiles.length,
    translationsCompleted: totalTranslations,
    elapsedSeconds: Math.round((Date.now() - session.startTime) / 1000)
  });
});

/**
 * Route pour récupérer la liste des langues
 */
router.get('/languages', (req, res) => {
  res.json(LANGUAGES);
});

/**
 * Route pour récupérer les infos sur les tiers OpenAI
 */
router.get('/openai-tiers', (req, res) => {
  res.json({
    tiers: TIER_LIMITS,
    model: 'gpt-4o-mini',
    pricing: {
      input: 0.15,  // $ par million tokens
      output: 0.60  // $ par million tokens
    }
  });
});

/**
 * Route pour estimer le coût avant traduction
 */
router.post('/estimate', upload.array('files'), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Aucun fichier uploadé' });
    }

    let totalLines = 0;
    let totalChars = 0;

    for (const file of files) {
      const { sourceTexts } = await parseCSV(file.buffer);
      totalLines += sourceTexts.length;
      totalChars += sourceTexts.reduce((sum, item) => sum + item.text.length, 0);
    }

    // Estimation tokens (1 token ≈ 4 caractères pour du texte occidental)
    const estimatedInputTokens = Math.ceil(totalChars / 4);
    const estimatedOutputTokens = estimatedInputTokens; // Sortie similaire à l'entrée

    // Coût estimé (en supposant 70% cache hit après les premiers batches)
    const cacheHitTokens = estimatedInputTokens * 0.7;
    const cacheMissTokens = estimatedInputTokens * 0.3;
    
    const costCacheHit = (cacheHitTokens / 1_000_000) * 0.028;
    const costCacheMiss = (cacheMissTokens / 1_000_000) * 0.28;
    const costOutput = (estimatedOutputTokens / 1_000_000) * 0.42;
    const totalCost = costCacheHit + costCacheMiss + costOutput;

    // Estimation temps (environ 50 lignes/seconde avec parallélisation)
    const estimatedSeconds = Math.ceil(totalLines / 50);
    const estimatedMinutes = Math.ceil(estimatedSeconds / 60);

    res.json({
      totalFiles: files.length,
      totalLines,
      totalChars,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCost: parseFloat(totalCost.toFixed(4)),
      estimatedTimeMinutes: estimatedMinutes
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
