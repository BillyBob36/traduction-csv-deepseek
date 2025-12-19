/**
 * Service de stockage persistant pour les traductions
 * Utilise le disque Render (/var/data) ou un dossier local
 * Garde un historique des 10 dernières traductions
 */

const fs = require('fs');
const path = require('path');

// Répertoire de stockage persistant (disque Render ou local)
const STORAGE_DIR = process.env.STORAGE_DIR || '/var/data/translations';
const HISTORY_FILE = path.join(STORAGE_DIR, 'history.json');
const MAX_HISTORY = 10;

// Initialiser le répertoire de stockage
function initStorage() {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
      console.log(`[Storage] Répertoire créé: ${STORAGE_DIR}`);
    }
    
    // Créer le fichier d'historique s'il n'existe pas
    if (!fs.existsSync(HISTORY_FILE)) {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
      console.log(`[Storage] Fichier historique créé: ${HISTORY_FILE}`);
    }
    
    console.log(`[Storage] Initialisé sur: ${STORAGE_DIR}`);
    return true;
  } catch (error) {
    console.error(`[Storage] Erreur initialisation:`, error.message);
    return false;
  }
}

/**
 * Sauvegarde une traduction terminée
 * @param {string} sessionId - ID de la session
 * @param {Object} data - Données de traduction {results, targetLanguage, stats, duration}
 */
function saveTranslation(sessionId, data) {
  try {
    const sessionDir = path.join(STORAGE_DIR, sessionId);
    
    // Créer le dossier de la session
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    // Sauvegarder chaque fichier traduit
    const savedFiles = [];
    for (let i = 0; i < data.results.length; i++) {
      const result = data.results[i];
      const filePath = path.join(sessionDir, result.translatedName);
      fs.writeFileSync(filePath, result.content, 'utf-8');
      savedFiles.push({
        index: i,
        name: result.translatedName,
        size: Buffer.byteLength(result.content, 'utf8'),
        linesTranslated: result.linesTranslated,
        isPartOfSplit: result.isPartOfSplit || false,
        totalParts: result.totalParts || 1
      });
    }
    
    // Sauvegarder les métadonnées
    const metadata = {
      sessionId,
      targetLanguage: data.targetLanguage,
      createdAt: Date.now(),
      duration: data.duration,
      stats: data.stats,
      files: savedFiles,
      totalFiles: savedFiles.length
    };
    
    fs.writeFileSync(
      path.join(sessionDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );
    
    // Mettre à jour l'historique
    updateHistory(metadata);
    
    console.log(`[Storage] Traduction sauvegardée: ${sessionId} (${savedFiles.length} fichiers)`);
    return true;
  } catch (error) {
    console.error(`[Storage] Erreur sauvegarde:`, error.message);
    return false;
  }
}

/**
 * Met à jour l'historique des traductions (max 10)
 */
function updateHistory(metadata) {
  try {
    let history = [];
    
    if (fs.existsSync(HISTORY_FILE)) {
      const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
      history = JSON.parse(content);
    }
    
    // Ajouter en début de liste
    history.unshift({
      sessionId: metadata.sessionId,
      targetLanguage: metadata.targetLanguage,
      createdAt: metadata.createdAt,
      duration: metadata.duration,
      totalFiles: metadata.totalFiles,
      files: metadata.files.map(f => ({ name: f.name, size: f.size }))
    });
    
    // Garder seulement les MAX_HISTORY dernières
    if (history.length > MAX_HISTORY) {
      const toDelete = history.slice(MAX_HISTORY);
      history = history.slice(0, MAX_HISTORY);
      
      // Supprimer les anciennes sessions du disque
      for (const old of toDelete) {
        deleteSession(old.sessionId);
      }
    }
    
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    return true;
  } catch (error) {
    console.error(`[Storage] Erreur mise à jour historique:`, error.message);
    return false;
  }
}

/**
 * Supprime une session du disque
 */
function deleteSession(sessionId) {
  try {
    const sessionDir = path.join(STORAGE_DIR, sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[Storage] Session supprimée: ${sessionId}`);
    }
    return true;
  } catch (error) {
    console.error(`[Storage] Erreur suppression session:`, error.message);
    return false;
  }
}

/**
 * Récupère l'historique des traductions
 */
function getHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }
    const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`[Storage] Erreur lecture historique:`, error.message);
    return [];
  }
}

/**
 * Récupère les données d'une session
 */
function getSession(sessionId) {
  try {
    const sessionDir = path.join(STORAGE_DIR, sessionId);
    const metadataPath = path.join(sessionDir, 'metadata.json');
    
    if (!fs.existsSync(metadataPath)) {
      return null;
    }
    
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    return metadata;
  } catch (error) {
    console.error(`[Storage] Erreur lecture session:`, error.message);
    return null;
  }
}

/**
 * Récupère le contenu d'un fichier traduit
 */
function getFileContent(sessionId, fileName) {
  try {
    const filePath = path.join(STORAGE_DIR, sessionId, fileName);
    
    if (!fs.existsSync(filePath)) {
      return null;
    }
    
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`[Storage] Erreur lecture fichier:`, error.message);
    return null;
  }
}

/**
 * Vérifie si le stockage persistant est disponible
 */
function isStorageAvailable() {
  try {
    const testFile = path.join(STORAGE_DIR, '.test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  initStorage,
  saveTranslation,
  getHistory,
  getSession,
  getFileContent,
  deleteSession,
  isStorageAvailable,
  STORAGE_DIR
};
