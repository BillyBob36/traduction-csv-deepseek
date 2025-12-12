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

const { parseCSV, insertTranslations, generateCSV, createBatches } = require('../services/csv');
const { translateBatch, resetCacheStats, getCacheStats, ParallelController } = require('../services/deepseek');
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Enregistrer le client SSE
  sseClients.set(sessionId, res);

  // Envoyer un ping initial
  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);

  // Nettoyage à la déconnexion
  req.on('close', () => {
    sseClients.delete(sessionId);
  });
});

/**
 * Envoie un événement SSE à un client
 */
function sendSSE(sessionId, data) {
  const client = sseClients.get(sessionId);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
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

  console.log(`[Debug] testMode: ${testMode}, testLines: ${testLines}`);

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

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Clé API DeepSeek non configurée' });
  }

  console.log(`[Traduction] Début - ${files.length} fichier(s), langue: ${targetLanguage}${testMode ? ` (MODE TEST: ${testLines} lignes max)` : ' (COMPLET)'}`);

  // Réinitialiser les stats de cache
  resetCacheStats();

  // Enregistrer la session active
  activeSessions.set(sessionId, {
    status: 'running',
    startTime,
    targetLanguage,
    files: files.map(f => f.originalname)
  });

  try {
    const results = [];
    // DeepSeek n'a PAS de rate limit - parallélisation massive
    // 300 requêtes simultanées (limité par RAM Render 512MB, pas par l'API)
    const parallelController = new ParallelController(300);
    
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

      sendSSE(sessionId, {
        type: 'file_start',
        fileIndex,
        fileName,
        linesToTranslate: dedup.totalOriginal,
        uniqueToTranslate: dedup.totalUnique
      });

      // Créer les batches de 25 textes uniques
      const batches = createBatches(
        uniqueTexts.map((u, i) => ({ index: i, text: u.text, indices: u.indices })), 
        25
      );
      let fileProcessedBatches = 0;
      let fileProcessedTexts = 0;

      // Traiter les batches en parallèle
      const batchPromises = batches.map((batch, batchIndex) => 
        parallelController.execute(async () => {
          const texts = batch.map(item => item.text);
          
          try {
            const { translations } = await translateBatch(texts, targetLanguage, apiKey);
            
            // Sauvegarder chaque traduction dans le fichier temp
            for (let i = 0; i < batch.length; i++) {
              const item = batch[i];
              const translation = translations[i] || '';
              const originalIndices = uniqueTexts[item.index].indices;
              saveTempTranslation(sessionId, fileIndex, item.text, translation, originalIndices);
              
              // Incrémenter les compteurs
              fileProcessedTexts++;
              globalProcessedUnique++;
              
              // Calculer les lignes originales correspondantes
              const linesForThisText = originalIndices.length;
              
              // Envoyer update de progression (throttled)
              sendSSEThrottled(sessionId, {
                type: 'progress',
                fileIndex,
                fileName,
                fileProcessedTexts,
                fileTotalTexts: dedup.totalUnique,
                globalProcessedUnique,
                globalTotalUnique,
                globalProcessedLines: Math.round((globalProcessedUnique / globalTotalUnique) * globalTotalOriginal),
                globalTotalLines: globalTotalOriginal,
                percentComplete: Math.round((globalProcessedUnique / globalTotalUnique) * 100),
                cacheStats: getCacheStats()
              });
            }

            fileProcessedBatches++;

          } catch (error) {
            console.error(`[Batch ${batchIndex}] Erreur:`, error.message);
            // En cas d'erreur, sauvegarder avec message d'erreur
            for (const item of batch) {
              const originalIndices = uniqueTexts[item.index].indices;
              saveTempTranslation(sessionId, fileIndex, item.text, `[ERREUR: ${error.message}]`, originalIndices);
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
    const finalStats = getCacheStats();

    console.log(`[Traduction] Terminé en ${duration}s - Cache hit: ${finalStats.hitRate}% - Dédup: ${globalTotalOriginal} → ${globalTotalUnique}`);

    sendSSE(sessionId, {
      type: 'complete',
      duration,
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
