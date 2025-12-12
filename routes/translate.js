/**
 * Routes de traduction CSV
 * Gère l'upload multiple, le traitement parallèle et les SSE pour la progression
 */

const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const router = express.Router();

const { parseCSV, insertTranslations, generateCSV, createBatches } = require('../services/csv');
const { translateBatch, resetCacheStats, getCacheStats, ParallelController } = require('../services/deepseek');
const LANGUAGES = require('../config/languages');

// Configuration multer pour upload en mémoire (streaming)
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
 * Route principale de traduction
 * POST /api/translate
 */
router.post('/', upload.array('files'), async (req, res) => {
  const startTime = Date.now();
  const sessionId = req.body.sessionId || `session_${Date.now()}`;
  const targetLanguage = req.body.targetLanguage;
  const files = req.files;

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

  console.log(`[Traduction] Début - ${files.length} fichier(s), langue: ${targetLanguage}`);

  // Réinitialiser les stats de cache
  resetCacheStats();

  try {
    const results = [];
    const parallelController = new ParallelController(30); // 30 requêtes max simultanées
    
    let globalTotalLines = 0;
    let globalProcessedLines = 0;

    // Première passe : compter le total de lignes
    const filesData = [];
    for (const file of files) {
      const { rows, sourceTexts } = await parseCSV(file.buffer);
      filesData.push({ file, rows, sourceTexts });
      globalTotalLines += sourceTexts.length;
    }

    sendSSE(sessionId, {
      type: 'init',
      totalFiles: files.length,
      totalLines: globalTotalLines
    });

    // Traitement de chaque fichier
    for (let fileIndex = 0; fileIndex < filesData.length; fileIndex++) {
      const { file, rows, sourceTexts } = filesData[fileIndex];
      const fileName = file.originalname;

      console.log(`[Fichier ${fileIndex + 1}/${files.length}] ${fileName} - ${sourceTexts.length} lignes à traduire`);

      sendSSE(sessionId, {
        type: 'file_start',
        fileIndex,
        fileName,
        linesToTranslate: sourceTexts.length
      });

      // Créer les batches de 50 lignes
      const batches = createBatches(sourceTexts, 50);
      const translationsMap = new Map();
      let fileProcessedBatches = 0;

      // Traiter les batches en parallèle
      const batchPromises = batches.map((batch, batchIndex) => 
        parallelController.execute(async () => {
          const texts = batch.map(item => item.text);
          
          try {
            const { translations } = await translateBatch(texts, targetLanguage, apiKey);
            
            // Mapper les traductions aux index originaux
            batch.forEach((item, i) => {
              translationsMap.set(item.index, translations[i] || '');
            });

            fileProcessedBatches++;
            globalProcessedLines += batch.length;

            // Envoyer la progression
            sendSSE(sessionId, {
              type: 'progress',
              fileIndex,
              fileName,
              fileBatchesProcessed: fileProcessedBatches,
              fileTotalBatches: batches.length,
              globalProcessedLines,
              globalTotalLines,
              percentComplete: Math.round((globalProcessedLines / globalTotalLines) * 100),
              cacheStats: getCacheStats()
            });

          } catch (error) {
            console.error(`[Batch ${batchIndex}] Erreur:`, error.message);
            // En cas d'erreur, on laisse les traductions vides
            batch.forEach(item => {
              translationsMap.set(item.index, `[ERREUR: ${error.message}]`);
            });
            globalProcessedLines += batch.length;
          }
        })
      );

      // Attendre que tous les batches soient traités
      await Promise.all(batchPromises);

      // Insérer les traductions dans les rows
      insertTranslations(rows, translationsMap);

      // Générer le CSV traduit
      const translatedCSV = await generateCSV(rows);

      results.push({
        originalName: fileName,
        translatedName: fileName.replace('.csv', `_${targetLanguage}.csv`),
        content: translatedCSV,
        linesTranslated: sourceTexts.length
      });

      sendSSE(sessionId, {
        type: 'file_complete',
        fileIndex,
        fileName
      });
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalStats = getCacheStats();

    console.log(`[Traduction] Terminé en ${duration}s - Cache hit: ${finalStats.hitRate}%`);

    sendSSE(sessionId, {
      type: 'complete',
      duration,
      cacheStats: finalStats
    });

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

    res.status(500).json({ error: error.message });
  }
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
