/**
 * Service de parsing et écriture CSV
 * Utilise des streams pour gérer les gros fichiers sans surcharge mémoire
 */

const { parse } = require('csv-parse');
const { stringify } = require('csv-stringify');
const { Readable, Transform } = require('stream');

// Index des colonnes (0-based)
const SOURCE_COLUMN_INDEX = 6; // Colonne G
const TARGET_COLUMN_INDEX = 7; // Colonne H

/**
 * Parse un CSV en streaming et extrait les données nécessaires
 * @param {Buffer} fileBuffer - Contenu du fichier CSV
 * @returns {Promise<{rows: Array, headers: Array, sourceTexts: Array<{index: number, text: string}>}>}
 */
async function parseCSV(fileBuffer) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const sourceTexts = [];
    let headers = null;
    let rowIndex = 0;

    const parser = parse({
      relax_column_count: true, // Tolère les lignes avec nombre de colonnes variable
      skip_empty_lines: false,
      relax_quotes: true,
      escape: '"',
      quote: '"'
    });

    parser.on('readable', function() {
      let record;
      while ((record = parser.read()) !== null) {
        // Première ligne = headers
        if (rowIndex === 0) {
          headers = record;
          // S'assurer que la colonne H existe dans les headers
          while (headers.length <= TARGET_COLUMN_INDEX) {
            headers.push('');
          }
        } else {
          // S'assurer que la ligne a assez de colonnes
          while (record.length <= TARGET_COLUMN_INDEX) {
            record.push('');
          }

          // Extraire le texte de la colonne G si non vide
          const sourceText = record[SOURCE_COLUMN_INDEX] || '';
          if (sourceText.trim()) {
            sourceTexts.push({
              index: rowIndex,
              text: sourceText
            });
          }
        }
        
        rows.push(record);
        rowIndex++;
      }
    });

    parser.on('error', (err) => {
      reject(new Error(`Erreur parsing CSV: ${err.message}`));
    });

    parser.on('end', () => {
      resolve({ rows, headers, sourceTexts });
    });

    // Créer un stream depuis le buffer et le piper vers le parser
    const readable = Readable.from(fileBuffer);
    readable.pipe(parser);
  });
}

/**
 * Parse un CSV très volumineux en streaming avec callback par batch
 * Pour les fichiers > 50MB, utilise moins de mémoire
 * @param {Buffer} fileBuffer - Contenu du fichier CSV
 * @param {number} batchSize - Taille des batches
 * @param {Function} onBatch - Callback appelé pour chaque batch
 */
async function parseCSVStreaming(fileBuffer, batchSize, onBatch) {
  return new Promise((resolve, reject) => {
    const allRows = [];
    let headers = null;
    let rowIndex = 0;
    let currentBatch = [];
    let batchStartIndex = 1; // Commence après les headers

    const parser = parse({
      relax_column_count: true,
      skip_empty_lines: false,
      relax_quotes: true,
      escape: '"',
      quote: '"'
    });

    parser.on('readable', async function() {
      let record;
      while ((record = parser.read()) !== null) {
        // S'assurer que la ligne a assez de colonnes
        while (record.length <= TARGET_COLUMN_INDEX) {
          record.push('');
        }

        if (rowIndex === 0) {
          headers = record;
        } else {
          const sourceText = record[SOURCE_COLUMN_INDEX] || '';
          if (sourceText.trim()) {
            currentBatch.push({
              index: rowIndex,
              text: sourceText
            });

            // Batch complet
            if (currentBatch.length >= batchSize) {
              try {
                await onBatch([...currentBatch], batchStartIndex);
              } catch (err) {
                // Continue malgré l'erreur
                console.error(`Erreur batch à l'index ${batchStartIndex}:`, err.message);
              }
              currentBatch = [];
              batchStartIndex = rowIndex + 1;
            }
          }
        }

        allRows.push(record);
        rowIndex++;
      }
    });

    parser.on('error', (err) => {
      reject(new Error(`Erreur parsing CSV: ${err.message}`));
    });

    parser.on('end', async () => {
      // Traiter le dernier batch s'il reste des éléments
      if (currentBatch.length > 0) {
        try {
          await onBatch(currentBatch, batchStartIndex);
        } catch (err) {
          console.error(`Erreur dernier batch:`, err.message);
        }
      }
      resolve({ rows: allRows, headers });
    });

    const readable = Readable.from(fileBuffer);
    readable.pipe(parser);
  });
}

/**
 * Insère les traductions dans la colonne H des rows
 * @param {Array} rows - Toutes les lignes du CSV
 * @param {Map} translationsMap - Map index -> traduction
 */
function insertTranslations(rows, translationsMap) {
  for (const [index, translation] of translationsMap) {
    if (rows[index]) {
      // S'assurer que la ligne a assez de colonnes
      while (rows[index].length <= TARGET_COLUMN_INDEX) {
        rows[index].push('');
      }
      rows[index][TARGET_COLUMN_INDEX] = translation;
    }
  }
  return rows;
}

/**
 * Génère un CSV à partir des rows
 * @param {Array} rows - Lignes du CSV incluant headers
 * @returns {Promise<string>} - Contenu CSV
 */
async function generateCSV(rows) {
  return new Promise((resolve, reject) => {
    stringify(rows, {
      quoted: true,
      quoted_empty: true
    }, (err, output) => {
      if (err) {
        reject(new Error(`Erreur génération CSV: ${err.message}`));
      } else {
        resolve(output);
      }
    });
  });
}

/**
 * Crée des batches à partir des textes sources
 * @param {Array} sourceTexts - Tableau de {index, text}
 * @param {number} batchSize - Taille de chaque batch
 * @returns {Array} - Tableau de batches
 */
function createBatches(sourceTexts, batchSize = 50) {
  const batches = [];
  for (let i = 0; i < sourceTexts.length; i += batchSize) {
    batches.push(sourceTexts.slice(i, i + batchSize));
  }
  return batches;
}

module.exports = {
  parseCSV,
  parseCSVStreaming,
  insertTranslations,
  generateCSV,
  createBatches,
  SOURCE_COLUMN_INDEX,
  TARGET_COLUMN_INDEX
};
