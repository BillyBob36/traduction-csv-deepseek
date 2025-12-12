/**
 * Service d'appel à l'API DeepSeek
 * Gère la parallélisation, le retry avec backoff exponentiel, et le monitoring du cache
 */

const SYSTEM_PROMPTS = require('../config/prompts');

// Configuration DeepSeek
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

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
 * @returns {Promise<{translations: string[], usage: object}>}
 */
async function translateBatch(texts, targetLanguage, apiKey) {
  const systemPrompt = SYSTEM_PROMPTS[targetLanguage];
  
  if (!systemPrompt) {
    throw new Error(`Langue non supportée: ${targetLanguage}`);
  }

  // Formatage des textes avec numérotation pour parsing fiable
  const userContent = texts.map((text, i) => `${i + 1}. ${text}`).join('\n');

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

  // Retry avec backoff exponentiel
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
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

      const data = await response.json();
      
      // Mise à jour des stats de cache
      if (data.usage) {
        cacheStats.totalHitTokens += data.usage.prompt_cache_hit_tokens || 0;
        cacheStats.totalMissTokens += data.usage.prompt_cache_miss_tokens || 0;
        cacheStats.totalOutputTokens += data.usage.completion_tokens || 0;
        cacheStats.requestCount++;
      }

      // Extraction des traductions depuis la réponse
      const responseText = data.choices[0]?.message?.content || '';
      const translations = parseTranslations(responseText, texts.length);

      return {
        translations,
        usage: data.usage || {}
      };

    } catch (error) {
      lastError = error;
      
      // Erreur réseau : retry
      if (error.name === 'TypeError' || error.code === 'ECONNRESET') {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[DeepSeek] Erreur réseau, retry dans ${delay}ms...`);
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
 * Gère le format numéroté (1. xxx, 2. yyy, etc.)
 */
function parseTranslations(responseText, expectedCount) {
  const lines = responseText.split('\n').filter(line => line.trim());
  const translations = [];

  // Expression régulière pour matcher "1. texte" ou "1) texte" ou juste le texte
  const numberedLineRegex = /^\d+[\.\)]\s*/;

  for (const line of lines) {
    // Retire le numéro de ligne si présent
    const cleanedLine = line.replace(numberedLineRegex, '').trim();
    if (cleanedLine) {
      translations.push(cleanedLine);
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
  ParallelController
};
