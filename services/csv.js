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
const FIELD_TYPE_COLUMN_INDEX = 2; // Colonne C

function slugifyHandle(value) {
  const raw = (value ?? '').toString().trim().toLowerCase();
  if (!raw) return '';

  const noAccents = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const cleaned = noAccents
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return cleaned;
}

/**
 * Post-traitement des handles :
 * - cible uniquement les lignes où colonne C == "handle"
 * - normalise la colonne H (target) en slug (sans accents, sans chars spéciaux, '-' autorisé)
 * - garantit l'unicité en ajoutant un suffixe -001/-002/... si doublon
 */
function normalizeAndDeduplicateHandles(rows) {
  const used = new Set();
  const baseCounters = new Map();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    while (row.length <= TARGET_COLUMN_INDEX) {
      row.push('');
    }

    const fieldType = (row[FIELD_TYPE_COLUMN_INDEX] ?? '').toString().trim().toLowerCase();
    if (fieldType !== 'handle') continue;

    const base = slugifyHandle(row[TARGET_COLUMN_INDEX]);
    const safeBase = base || 'handle';

    let candidate = safeBase;
    if (used.has(candidate)) {
      let counter = baseCounters.get(safeBase) ?? 0;
      while (true) {
        counter += 1;
        const suffix = String(counter).padStart(3, '0');
        const attempt = `${safeBase}-${suffix}`;
        if (!used.has(attempt)) {
          candidate = attempt;
          baseCounters.set(safeBase, counter);
          break;
        }
      }
    }

    used.add(candidate);
    row[TARGET_COLUMN_INDEX] = candidate;
  }

  return rows;
}

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

/**
 * Découpe un CSV en plusieurs parties si > maxSizeBytes
 * Respecte les lignes CSV logiques (champs multi-lignes entre guillemets)
 * @param {string} csvContent - Contenu CSV complet
 * @param {string} baseFileName - Nom de base du fichier (sans extension)
 * @param {string} targetLanguage - Code langue cible
 * @param {number} maxSizeBytes - Taille max par fichier (défaut 9.5 Mo)
 * @returns {Array} - [{name: string, content: string}]
 */
function splitCSVIfNeeded(csvContent, baseFileName, targetLanguage, maxSizeBytes = 9.5 * 1024 * 1024) {
  const contentSize = Buffer.byteLength(csvContent, 'utf8');
  
  // Si le fichier est assez petit, retourner tel quel
  if (contentSize <= maxSizeBytes) {
    // S'assurer que le contenu se termine par un \n
    const finalContent = csvContent.endsWith('\n') ? csvContent : csvContent + '\n';
    return [{
      name: `${baseFileName}_${targetLanguage}.csv`,
      content: finalContent
    }];
  }
  
  console.log(`[Split] Fichier ${baseFileName} fait ${(contentSize / 1024 / 1024).toFixed(2)} Mo, découpage en cours...`);
  
  // Parser correctement le CSV pour respecter les lignes logiques (champs multi-lignes)
  const csvLines = parseCSVLines(csvContent);
  
  if (csvLines.length === 0) {
    return [{
      name: `${baseFileName}_${targetLanguage}.csv`,
      content: csvContent
    }];
  }
  
  const headerLine = csvLines[0];
  const headerSize = Buffer.byteLength(headerLine + '\n', 'utf8');
  
  const parts = [];
  let currentPart = [];
  let currentSize = headerSize; // Commencer avec la taille du header
  let partNumber = 1;
  
  // Parcourir toutes les lignes CSV logiques (sauf le header)
  for (let i = 1; i < csvLines.length; i++) {
    const line = csvLines[i];
    if (!line.trim()) continue; // Ignorer les lignes vides
    
    const lineSize = Buffer.byteLength(line + '\n', 'utf8');
    
    // Si ajouter cette ligne dépasse la limite, sauvegarder la partie actuelle
    if (currentSize + lineSize > maxSizeBytes && currentPart.length > 0) {
      parts.push({
        name: `${baseFileName}_part${partNumber}_${targetLanguage}.csv`,
        content: headerLine + '\n' + currentPart.join('\n') + '\n'
      });
      partNumber++;
      currentPart = [];
      currentSize = headerSize;
    }
    
    currentPart.push(line);
    currentSize += lineSize;
  }
  
  // Ajouter la dernière partie
  if (currentPart.length > 0) {
    parts.push({
      name: `${baseFileName}_part${partNumber}_${targetLanguage}.csv`,
      content: headerLine + '\n' + currentPart.join('\n') + '\n'
    });
  }
  
  console.log(`[Split] Fichier découpé en ${parts.length} parties`);
  
  return parts;
}

/**
 * Parse un contenu CSV et retourne les lignes logiques complètes
 * Gère correctement les champs multi-lignes entre guillemets
 * @param {string} csvContent - Contenu CSV brut
 * @returns {Array<string>} - Tableau des lignes CSV logiques
 */
function parseCSVLines(csvContent) {
  const lines = [];
  let currentLine = '';
  let insideQuotes = false;
  
  for (let i = 0; i < csvContent.length; i++) {
    const char = csvContent[i];
    const nextChar = csvContent[i + 1];
    
    if (char === '"') {
      // Guillemet échappé "" -> reste dans le champ
      if (insideQuotes && nextChar === '"') {
        currentLine += '""';
        i++; // Sauter le prochain guillemet
      } else {
        // Bascule l'état inside/outside quotes
        insideQuotes = !insideQuotes;
        currentLine += char;
      }
    } else if (char === '\n' && !insideQuotes) {
      // Fin de ligne logique (pas à l'intérieur d'un champ quoté)
      if (currentLine.trim()) {
        lines.push(currentLine);
      }
      currentLine = '';
    } else if (char === '\r' && nextChar === '\n' && !insideQuotes) {
      // Gestion CRLF Windows
      if (currentLine.trim()) {
        lines.push(currentLine);
      }
      currentLine = '';
      i++; // Sauter le \n
    } else {
      currentLine += char;
    }
  }
  
  // Ajouter la dernière ligne si non vide
  if (currentLine.trim()) {
    lines.push(currentLine);
  }
  
  return lines;
}

module.exports = {
  parseCSV,
  parseCSVStreaming,
  insertTranslations,
  normalizeAndDeduplicateHandles,
  generateCSV,
  createBatches,
  splitCSVIfNeeded,
  SOURCE_COLUMN_INDEX,
  TARGET_COLUMN_INDEX,
  FIELD_TYPE_COLUMN_INDEX
};
