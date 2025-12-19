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

const { parseCSV, insertTranslations, normalizeAndDeduplicateHandles, generateCSV, createBatches, splitCSVIfNeeded } = require('../services/csv');
const { translateBatch: translateBatchDeepSeek, resetCacheStats, getCacheStats, ParallelController, createSmartBatchesDeepSeek } = require('../services/deepseek');
const { translateBatchOpenAI, resetOpenAIStats, getOpenAIStats, getTierLimits, TIER_LIMITS, RampUpController, createSmartBatches } = require('../services/openai');
const { initStorage, saveTranslation, getHistory, getSession, getFileContent, isStorageAvailable } = require('../services/storage');
const LANGUAGES = require('../config/languages');

// Initialiser le stockage persistant au démarrage
initStorage();

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

// Map pour stocker les résultats de traduction (pour téléchargement)
const translationResults = new Map();

// Nettoyage automatique des résultats après 1 heure
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [sessionId, data] of translationResults) {
    if (data.createdAt < oneHourAgo) {
      translationResults.delete(sessionId);
      console.log(`[Cleanup] Résultats expirés supprimés: ${sessionId}`);
    }
  }
}, 10 * 60 * 1000); // Vérifier toutes les 10 minutes

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
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Headers pour désactiver le buffering des proxies (Nginx/Render)
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'none');
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
 * Utilise flush() pour forcer l'envoi immédiat (contourne le buffering proxy)
 */
function sendSSE(sessionId, data) {
  const client = sseClients.get(sessionId);
  if (client) {
    try {
      client.write(`data: ${JSON.stringify(data)}\n\n`);
      // Forcer l'envoi immédiat pour contourner le buffering du proxy Render
      if (typeof client.flush === 'function') {
        client.flush();
      }
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

  // RÉPONSE IMMÉDIATE : le client utilise SSE pour suivre la progression
  res.json({
    success: true,
    sessionId,
    message: 'Traduction démarrée en arrière-plan',
    status: 'started'
  });

  // TRADUCTION EN ARRIÈRE-PLAN (ne bloque pas la réponse HTTP)
  runTranslationInBackground({
    sessionId, startTime, targetLanguage, files, testMode, testLines,
    llmProvider, apiKey, tierLimits, maxParallel, batchSize, openaiTier
  });
});

/**
 * Exécute la traduction en arrière-plan
 */
async function runTranslationInBackground(params) {
  const { sessionId, startTime, targetLanguage, files, testMode, testLines,
    llmProvider, apiKey, tierLimits, maxParallel, batchSize, openaiTier } = params;

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

      // Créer les batches selon le provider (même système pour les deux)
      // Smart batches : HTML 1/appel, texte simple max 2000 chars
      let batches;
      if (llmProvider === 'openai') {
        batches = createSmartBatches(uniqueTexts);
      } else {
        batches = createSmartBatchesDeepSeek(uniqueTexts);
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
            // Appeler le bon provider (même système: isHTML pour choisir le prompt)
            let translations;
            if (llmProvider === 'openai') {
              const result = await translateBatchOpenAI(batch.texts, targetLanguage, apiKey, openaiTier, batch.isHTML);
              translations = result.translations;
            } else {
              const result = await translateBatchDeepSeek(batch.texts, targetLanguage, apiKey, batch.isHTML);
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

      // Nom de base du fichier (sans extension)
      const baseName = fileName.replace('.csv', '') + (testMode ? '_TEST' : '');
      
      // Découper si > 10 Mo (utilise 9.5 Mo comme limite de sécurité)
      const fileParts = splitCSVIfNeeded(translatedCSV, baseName, targetLanguage);
      
      for (const part of fileParts) {
        results.push({
          originalName: fileName,
          translatedName: part.name,
          content: part.content,
          linesTranslated: dedup.totalOriginal,
          uniqueTranslated: dedup.totalUnique,
          isPartOfSplit: fileParts.length > 1,
          totalParts: fileParts.length
        });
      }

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

    // Stocker les résultats pour téléchargement ultérieur (en mémoire)
    translationResults.set(sessionId, {
      results,
      targetLanguage,
      createdAt: Date.now()
    });

    // SAUVEGARDER SUR DISQUE PERSISTANT (historique des 10 dernières traductions)
    saveTranslation(sessionId, {
      results,
      targetLanguage,
      duration,
      stats: finalStats
    });

    // Envoyer les infos de téléchargement via SSE (le frontend n'attend plus la réponse HTTP)
    sendSSE(sessionId, {
      type: 'complete',
      sessionId,
      duration,
      llmProvider,
      cacheStats: finalStats,
      deduplication: {
        original: globalTotalOriginal,
        unique: globalTotalUnique,
        saved: globalTotalOriginal - globalTotalUnique
      },
      // Infos pour le téléchargement
      files: results.map((r, i) => ({
        index: i,
        name: r.translatedName,
        size: Buffer.byteLength(r.content, 'utf8'),
        linesTranslated: r.linesTranslated,
        isPartOfSplit: r.isPartOfSplit || false,
        totalParts: r.totalParts || 1
      })),
      totalFiles: results.length
    });

    // Nettoyer les fichiers temporaires et le throttle
    cleanupTempFiles(sessionId);
    activeSessions.delete(sessionId);
    sseThrottles.delete(sessionId);

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
  }
}

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
 * Route pour télécharger un fichier individuel
 * GET /api/translate/download/:sessionId/:fileIndex
 */
router.get('/download/:sessionId/:fileIndex', (req, res) => {
  const { sessionId, fileIndex } = req.params;
  const data = translationResults.get(sessionId);
  
  if (!data) {
    return res.status(404).json({ error: 'Session expirée ou non trouvée' });
  }
  
  const index = parseInt(fileIndex);
  if (index < 0 || index >= data.results.length) {
    return res.status(404).json({ error: 'Fichier non trouvé' });
  }
  
  const file = data.results[index];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.translatedName}"`);
  res.send(file.content);
});

/**
 * Route pour télécharger tous les fichiers en ZIP
 * GET /api/translate/download-zip/:sessionId
 */
router.get('/download-zip/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const data = translationResults.get(sessionId);
  
  if (!data) {
    return res.status(404).json({ error: 'Session expirée ou non trouvée' });
  }
  
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="traductions_${data.targetLanguage}.zip"`);
  
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  
  for (const result of data.results) {
    archive.append(result.content, { name: result.translatedName });
  }
  
  await archive.finalize();
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
 * Prend en compte le provider (openai/deepseek) et le mode test (testLines)
 */
router.post('/estimate', upload.array('files'), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Aucun fichier uploadé' });
    }

    // Paramètres optionnels
    const llmProvider = req.body.llmProvider || 'deepseek';
    const testLines = parseInt(req.body.testLines) || 0;

    let totalLines = 0;
    let totalChars = 0;

    for (const file of files) {
      const { sourceTexts } = await parseCSV(file.buffer);
      
      // Si mode test, limiter les lignes
      const linesToCount = testLines > 0 ? sourceTexts.slice(0, testLines) : sourceTexts;
      totalLines += linesToCount.length;
      totalChars += linesToCount.reduce((sum, item) => sum + item.text.length, 0);
    }

    // Estimation tokens (1 token ≈ 3.5 caractères - plus réaliste)
    // + tokens du prompt système (~200 tokens par requête)
    const estimatedInputTokens = Math.ceil(totalChars / 3.5);
    const estimatedOutputTokens = Math.ceil(estimatedInputTokens * 1.1); // Output légèrement plus long
    
    // Estimation du nombre de requêtes (smart batching: ~15 textes/batch en moyenne)
    const estimatedRequests = Math.ceil(totalLines / 15);
    const promptTokensOverhead = estimatedRequests * 200; // ~200 tokens de prompt par requête
    const totalInputTokens = estimatedInputTokens + promptTokensOverhead;

    let totalCost;
    if (llmProvider === 'openai') {
      // Prix OpenAI gpt-4o-mini : $0.15/M input, $0.60/M output
      const inputCost = (totalInputTokens / 1_000_000) * 0.15;
      const outputCost = (estimatedOutputTokens / 1_000_000) * 0.60;
      totalCost = inputCost + outputCost;
    } else {
      // Prix DeepSeek (avec cache ~50% hit après warmup)
      const cacheHitTokens = totalInputTokens * 0.5;
      const cacheMissTokens = totalInputTokens * 0.5;
      const costCacheHit = (cacheHitTokens / 1_000_000) * 0.028;
      const costCacheMiss = (cacheMissTokens / 1_000_000) * 0.28;
      const costOutput = (estimatedOutputTokens / 1_000_000) * 0.42;
      totalCost = costCacheHit + costCacheMiss + costOutput;
    }

    // Estimation temps selon provider et tier
    // DeepSeek: ~150 lignes/sec, OpenAI: dépend du tier
    const openaiTier = parseInt(req.body.openaiTier) || 3;
    let linesPerSecond;
    if (llmProvider === 'openai') {
      // Vitesse basée sur le RPM du tier (avec marge de sécurité)
      // Tier 1-2: ~5 req/sec max, Tier 3: ~50 req/sec, Tier 4: ~100 req/sec, Tier 5: ~300 req/sec
      // Avec ~15 lignes/batch en moyenne
      const tierSpeeds = { 1: 30, 2: 40, 3: 150, 4: 250, 5: 400 };
      linesPerSecond = tierSpeeds[openaiTier] || 150;
    } else {
      linesPerSecond = 150; // DeepSeek avec haute parallélisation
    }
    
    const estimatedSeconds = Math.ceil(totalLines / linesPerSecond);
    const estimatedMinutes = Math.max(1, Math.ceil(estimatedSeconds / 60));

    res.json({
      totalFiles: files.length,
      totalLines,
      totalChars,
      estimatedInputTokens: totalInputTokens,
      estimatedOutputTokens,
      estimatedCost: parseFloat(totalCost.toFixed(2)),
      estimatedTimeMinutes: estimatedMinutes,
      llmProvider,
      openaiTier: llmProvider === 'openai' ? openaiTier : null
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Route pour récupérer l'historique des traductions
 * GET /api/translate/history
 */
router.get('/history', (req, res) => {
  const history = getHistory();
  res.json({
    success: true,
    count: history.length,
    maxHistory: 10,
    storageAvailable: isStorageAvailable(),
    history
  });
});

/**
 * Route pour récupérer une session depuis l'historique
 * GET /api/translate/history/:sessionId
 */
router.get('/history/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session non trouvée dans l\'historique' });
  }
  
  res.json({
    success: true,
    session
  });
});

/**
 * Route pour télécharger un fichier depuis l'historique
 * GET /api/translate/history/:sessionId/download/:fileName
 */
router.get('/history/:sessionId/download/:fileName', (req, res) => {
  const { sessionId, fileName } = req.params;
  const content = getFileContent(sessionId, fileName);
  
  if (!content) {
    return res.status(404).json({ error: 'Fichier non trouvé dans l\'historique' });
  }
  
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(content);
});

/**
 * Route pour télécharger tous les fichiers d'une session en ZIP depuis l'historique
 * GET /api/translate/history/:sessionId/download-zip
 */
router.get('/history/:sessionId/download-zip', async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session non trouvée dans l\'historique' });
  }
  
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="traductions_${session.targetLanguage}_${sessionId}.zip"`);
  
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  
  for (const file of session.files) {
    const content = getFileContent(sessionId, file.name);
    if (content) {
      archive.append(content, { name: file.name });
    }
  }
  
  await archive.finalize();
});

module.exports = router;
