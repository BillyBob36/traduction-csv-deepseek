/**
 * Service d'appel à l'API DeepSeek
 * - Cellules HTML : 1 par appel (prompt simple SYSTEM_PROMPTS)
 * - Cellules texte simple : batch max 2000 caractères (prompt BATCH_PROMPTS avec [1], [2])
 * Gère la parallélisation, le retry avec backoff exponentiel, et le monitoring du cache
 */

const { SYSTEM_PROMPTS, BATCH_PROMPTS } = require('../config/prompts');

// Configuration DeepSeek
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_BATCH_CHARS = 2000; // Max caractères par batch pour texte simple

/**
 * Détecte si un texte contient du HTML
 */
function containsHTML(text) {
  return text.includes('<') && text.includes('>');
}

/**
 * Sépare les textes en HTML (1 par appel) et texte simple (batches de max 2000 chars)
 * @returns {Array} - Liste de batches, chaque batch = {texts: [], isHTML: boolean, items: []}
 */
function createSmartBatchesDeepSeek(uniqueTexts) {
  const batches = [];
  const htmlTexts = [];
  const simpleTexts = [];
  
  // Séparer HTML et texte simple
  for (let i = 0; i < uniqueTexts.length; i++) {
    const item = { index: i, text: uniqueTexts[i].text, originalIndices: uniqueTexts[i].indices };
    if (containsHTML(item.text)) {
      htmlTexts.push(item);
    } else {
      simpleTexts.push(item);
    }
  }
  
  // HTML : 1 par batch
  for (const item of htmlTexts) {
    batches.push({
      texts: [item.text],
      isHTML: true,
      items: [item]
    });
  }
  
  // Texte simple : batches de max 2000 caractères
  let currentBatch = { texts: [], isHTML: false, items: [], totalChars: 0 };
  for (const item of simpleTexts) {
    const textLength = item.text.length;
    
    if (currentBatch.totalChars + textLength > MAX_BATCH_CHARS && currentBatch.texts.length > 0) {
      // Sauvegarder le batch actuel et en créer un nouveau
      batches.push(currentBatch);
      currentBatch = { texts: [], isHTML: false, items: [], totalChars: 0 };
    }
    
    currentBatch.texts.push(item.text);
    currentBatch.items.push(item);
    currentBatch.totalChars += textLength;
  }
  
  // Ajouter le dernier batch s'il n'est pas vide
  if (currentBatch.texts.length > 0) {
    batches.push(currentBatch);
  }
  
  console.log(`[SmartBatch DeepSeek] ${htmlTexts.length} cellules HTML (1/appel), ${simpleTexts.length} textes simples → ${batches.length - htmlTexts.length} batches`);
  
  return batches;
}

// Stats globales de cache pour monitoring
let cacheStats = {
  totalHitTokens: 0,
  totalMissTokens: 0,
  totalOutputTokens: 0,
  requestCount: 0
};

/**
 * Réinitialise les stats de cache (appelé en début de traduction)
 */
function resetCacheStats() {
  cacheStats = {
    totalHitTokens: 0,
    totalMissTokens: 0,
    totalOutputTokens: 0,
    requestCount: 0
  };
}

/**
 * Retourne les stats de cache actuelles
 */
function getCacheStats() {
  const totalInputTokens = cacheStats.totalHitTokens + cacheStats.totalMissTokens;
  const hitRate = totalInputTokens > 0 
    ? ((cacheStats.totalHitTokens / totalInputTokens) * 100).toFixed(1) 
    : 0;
  
  // Calcul du coût estimé (prix DeepSeek)
  const costCacheHit = (cacheStats.totalHitTokens / 1_000_000) * 0.028;
  const costCacheMiss = (cacheStats.totalMissTokens / 1_000_000) * 0.28;
  const costOutput = (cacheStats.totalOutputTokens / 1_000_000) * 0.42;
  const totalCost = costCacheHit + costCacheMiss + costOutput;

  return {
    ...cacheStats,
    hitRate: parseFloat(hitRate),
    estimatedCost: parseFloat(totalCost.toFixed(4))
  };
}

/**
 * Pause utilitaire pour le backoff
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Envoie un batch de textes à traduire à DeepSeek
 * @param {string[]} texts - Tableau de textes à traduire
 * @param {string} targetLanguage - Code langue de destination (fr, en, de, etc.)
 * @param {string} apiKey - Clé API DeepSeek
 * @param {boolean} isHTML - Si true, utilise le prompt simple (1 cellule HTML)
 * @returns {Promise<{translations: string[], usage: object}>}
 */
async function translateBatch(texts, targetLanguage, apiKey, isHTML = false) {
  // Choisir le bon prompt selon le type
  const systemPrompt = isHTML || texts.length === 1 
    ? SYSTEM_PROMPTS[targetLanguage] 
    : BATCH_PROMPTS[targetLanguage];
  
  if (!systemPrompt) {
    throw new Error(`Langue non supportée: ${targetLanguage}`);
  }

  // HTML ou 1 seul texte : envoi direct. Sinon : format [1], [2], [3]
  const userContent = (isHTML || texts.length === 1) 
    ? texts[0] 
    : texts.map((text, i) => `[${i + 1}] ${text}`).join('\n');

  const payload = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: 0.1, // Basse température pour traduction cohérente
    max_tokens: 8192
  };

  let lastError = null;

  console.log(`[DeepSeek] Envoi batch de ${texts.length} textes...`);

  // Retry avec backoff exponentiel
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const fetchStart = Date.now();
      const response = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        
        // Rate limit ou surcharge : retry
        if (response.status === 429 || response.status >= 500) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.log(`[DeepSeek] Erreur ${response.status}, retry dans ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        
        throw new Error(`API DeepSeek erreur ${response.status}: ${errorBody}`);
      }

      // Lire la réponse en texte d'abord pour vérifier si c'est du JSON valide
      const responseBody = await response.text();
      
      // Vérifier si la réponse est du HTML (erreur proxy/CDN)
      if (responseBody.trim().startsWith('<') || responseBody.includes('<!DOCTYPE')) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[DeepSeek] Réponse HTML reçue au lieu de JSON, retry dans ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      
      let data;
      try {
        data = JSON.parse(responseBody);
      } catch (parseError) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[DeepSeek] Erreur parsing JSON, retry dans ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      
      console.log(`[DeepSeek] Réponse reçue en ${Date.now() - fetchStart}ms`);
      
      // Mise à jour des stats de cache
      if (data.usage) {
        cacheStats.totalHitTokens += data.usage.prompt_cache_hit_tokens || 0;
        cacheStats.totalMissTokens += data.usage.prompt_cache_miss_tokens || 0;
        cacheStats.totalOutputTokens += data.usage.completion_tokens || 0;
        cacheStats.requestCount++;
      }

      // Extraction des traductions depuis la réponse
      const responseText = data.choices[0]?.message?.content || '';
      
      // Si HTML ou 1 seul texte, retourner directement sans parsing
      const translations = (isHTML || texts.length === 1)
        ? [responseText.trim()]
        : parseTranslations(responseText, texts.length);

      return {
        translations,
        usage: data.usage || {}
      };

    } catch (error) {
      lastError = error;
      
      // Erreur réseau ou parsing JSON : retry
      if (error.name === 'TypeError' || error.code === 'ECONNRESET' || error.name === 'SyntaxError') {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[DeepSeek] Erreur réseau/parsing, retry dans ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      
      throw error;
    }
  }

  throw lastError || new Error('Échec après tous les retries');
}

/**
 * Parse la réponse DeepSeek pour extraire les traductions
 * Gère le format numéroté [1], [2], [3] avec contenu multiligne
 * Chaque traduction peut contenir du HTML avec des retours à la ligne
 */
function parseTranslations(responseText, expectedCount) {
  const translations = [];
  
  // Regex pour le format [1], [2], [3], etc.
  const splitRegex = /(?:^|\n)\[(\d+)\]\s*/g;
  
  // Trouver toutes les positions des numéros
  const matches = [];
  let match;
  while ((match = splitRegex.exec(responseText)) !== null) {
    matches.push({
      number: parseInt(match[1]),
      index: match.index,
      fullMatchLength: match[0].length
    });
  }
  
  if (matches.length === 0) {
    // Fallback: essayer l'ancien format 1., 2., 3.
    const oldRegex = /(?:^|\n)(\d+)[\.\)]\s*/g;
    while ((match = oldRegex.exec(responseText)) !== null) {
      matches.push({
        number: parseInt(match[1]),
        index: match.index,
        fullMatchLength: match[0].length
      });
    }
  }
  
  // Si aucun numéro trouvé, retourner le texte brut comme une seule traduction
  if (matches.length === 0) {
    const trimmed = responseText.trim();
    if (trimmed) {
      translations.push(trimmed);
    }
  } else {
    // Extraire le contenu entre chaque numéro
    for (let i = 0; i < matches.length; i++) {
      const currentMatch = matches[i];
      const startIndex = currentMatch.index + currentMatch.fullMatchLength;
      
      // Fin = début du prochain numéro ou fin du texte
      const endIndex = (i + 1 < matches.length) 
        ? matches[i + 1].index 
        : responseText.length;
      
      const content = responseText.substring(startIndex, endIndex).trim();
      translations.push(content);
    }
  }

  // Si on n'a pas assez de traductions, compléter avec des chaînes vides
  while (translations.length < expectedCount) {
    translations.push('');
  }

  // Si on en a trop, tronquer
  return translations.slice(0, expectedCount);
}

/**
 * Contrôleur de parallélisation - limite le nombre de requêtes simultanées
 */
class ParallelController {
  constructor(maxConcurrent = 30) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      const task = async () => {
        this.running++;
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.running--;
          this.processQueue();
        }
      };

      if (this.running < this.maxConcurrent) {
        task();
      } else {
        this.queue.push(task);
      }
    });
  }

  processQueue() {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const nextTask = this.queue.shift();
      nextTask();
    }
  }
}

module.exports = {
  translateBatch,
  resetCacheStats,
  getCacheStats,
  ParallelController,
  createSmartBatchesDeepSeek
};
