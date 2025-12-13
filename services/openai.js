/**
 * Service OpenAI pour la traduction
 * - Cellules HTML : 1 par appel (prompt simple)
 * - Cellules texte simple : batch max 2000 caractères (prompt batch avec [1], [2])
 */

const { SYSTEM_PROMPTS, BATCH_PROMPTS } = require('../config/prompts');

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_BATCH_CHARS = 2000; // Max caractères par batch pour texte simple

// Configuration des rate limits par tier pour gpt-4o-mini
// maxParallel basé sur RPM : on vise ~80% du RPM max pour avoir de la marge
// Avec latence moyenne ~500ms par requête, maxParallel = RPM/60 * 0.5 * 0.8
const TIER_LIMITS = {
  1: { rpm: 500, tpm: 200000, maxParallel: 8, rampUp: { initial: 3, delay: 5000, step: 2 } },
  2: { rpm: 500, tpm: 2000000, maxParallel: 10, rampUp: { initial: 4, delay: 4000, step: 3 } },
  3: { rpm: 5000, tpm: 4000000, maxParallel: 80, rampUp: { initial: 20, delay: 2000, step: 20 } },
  4: { rpm: 10000, tpm: 10000000, maxParallel: 150, rampUp: { initial: 40, delay: 1500, step: 40 } },
  5: { rpm: 30000, tpm: 150000000, maxParallel: 400, rampUp: { initial: 80, delay: 1000, step: 80 } }
};

/**
 * Détecte si un texte contient du HTML
 */
function containsHTML(text) {
  return text.includes('<') && text.includes('>');
}

/**
 * Sépare les textes en HTML (1 par appel) et texte simple (batches de max 2000 chars)
 * @returns {Array} - Liste de batches, chaque batch = {texts: [], isHTML: boolean, indices: []}
 */
function createSmartBatches(uniqueTexts) {
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
  
  console.log(`[SmartBatch] ${htmlTexts.length} cellules HTML (1/appel), ${simpleTexts.length} textes simples → ${batches.length - htmlTexts.length} batches`);
  
  return batches;
}

// Stats pour le coût
let openaiStats = {
  inputTokens: 0,
  outputTokens: 0,
  requestCount: 0
};

function resetOpenAIStats() {
  openaiStats = {
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0
  };
}

function getOpenAIStats() {
  // Prix gpt-4o-mini : $0.15/M input, $0.60/M output
  const inputCost = (openaiStats.inputTokens / 1_000_000) * 0.15;
  const outputCost = (openaiStats.outputTokens / 1_000_000) * 0.60;
  const totalCost = inputCost + outputCost;

  return {
    inputTokens: openaiStats.inputTokens,
    outputTokens: openaiStats.outputTokens,
    requestCount: openaiStats.requestCount,
    estimatedCost: parseFloat(totalCost.toFixed(4))
  };
}

function getTierLimits(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS[1];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Envoie un batch à traduire à OpenAI
 * @param {string[]} texts - Textes à traduire
 * @param {string} targetLanguage - Langue cible
 * @param {string} apiKey - Clé API
 * @param {number} tier - Tier OpenAI
 * @param {boolean} isHTML - Si true, utilise le prompt simple (1 cellule HTML)
 */
async function translateBatchOpenAI(texts, targetLanguage, apiKey, tier = 3, isHTML = false) {
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
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: 0.1,
    max_tokens: 8192
  };

  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        
        // Rate limit : attendre et retry
        if (response.status === 429) {
          // Extraire le temps d'attente du header si disponible
          const retryAfter = response.headers.get('retry-after');
          const delay = retryAfter ? parseInt(retryAfter) * 1000 : BASE_DELAY_MS * Math.pow(2, attempt);
          console.log(`[OpenAI] Rate limit atteint, retry dans ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        
        if (response.status >= 500) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.log(`[OpenAI] Erreur ${response.status}, retry dans ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        
        throw new Error(`API OpenAI erreur ${response.status}: ${errorBody}`);
      }

      const data = await response.json();
      
      // Mise à jour des stats
      if (data.usage) {
        openaiStats.inputTokens += data.usage.prompt_tokens || 0;
        openaiStats.outputTokens += data.usage.completion_tokens || 0;
        openaiStats.requestCount++;
      }

      const responseText = data.choices[0]?.message?.content || '';
      
      // HTML ou 1 seul texte : réponse directe. Sinon : parsing [1], [2], [3]
      const translations = (isHTML || texts.length === 1) 
        ? [responseText.trim()] 
        : parseTranslations(responseText, texts.length);

      return { translations, usage: data.usage };

    } catch (error) {
      lastError = error;
      
      if (error.name === 'TypeError' || error.code === 'ECONNRESET') {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[OpenAI] Erreur réseau, retry dans ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      
      throw error;
    }
  }

  throw lastError || new Error('Échec après tous les retries');
}

/**
 * Parse la réponse pour extraire les traductions (même logique que DeepSeek)
 */
function parseTranslations(responseText, expectedCount) {
  const translations = [];
  
  // Regex pour le format [1], [2], [3], etc.
  const splitRegex = /(?:^|\n)\[(\d+)\]\s*/g;
  
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
  
  if (matches.length === 0) {
    const trimmed = responseText.trim();
    if (trimmed) {
      translations.push(trimmed);
    }
  } else {
    for (let i = 0; i < matches.length; i++) {
      const currentMatch = matches[i];
      const startIndex = currentMatch.index + currentMatch.fullMatchLength;
      const endIndex = (i + 1 < matches.length) 
        ? matches[i + 1].index 
        : responseText.length;
      
      const content = responseText.substring(startIndex, endIndex).trim();
      translations.push(content);
    }
  }

  while (translations.length < expectedCount) {
    translations.push('');
  }

  return translations.slice(0, expectedCount);
}

/**
 * Contrôleur de parallélisation avec ramp-up progressif
 * Démarre avec peu de connexions puis monte progressivement
 */
class RampUpController {
  constructor(tierConfig) {
    this.maxConcurrent = tierConfig.maxParallel;
    this.currentLimit = tierConfig.rampUp.initial;
    this.rampUpDelay = tierConfig.rampUp.delay;
    this.rampUpStep = tierConfig.rampUp.step;
    this.running = 0;
    this.queue = [];
    this.lastRampUp = Date.now();
    this.totalProcessed = 0;
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
          this.totalProcessed++;
          this.processQueue();
        }
      };

      // Ramp-up progressif : augmenter la limite si délai écoulé
      this.checkRampUp();

      if (this.running < this.currentLimit) {
        task();
      } else {
        this.queue.push(task);
      }
    });
  }

  checkRampUp() {
    const now = Date.now();
    if (this.currentLimit < this.maxConcurrent && now - this.lastRampUp >= this.rampUpDelay) {
      const oldLimit = this.currentLimit;
      this.currentLimit = Math.min(this.currentLimit + this.rampUpStep, this.maxConcurrent);
      this.lastRampUp = now;
      if (this.currentLimit !== oldLimit) {
        console.log(`[RampUp] Parallélisation: ${oldLimit} → ${this.currentLimit}/${this.maxConcurrent}`);
      }
    }
  }

  processQueue() {
    this.checkRampUp();
    while (this.queue.length > 0 && this.running < this.currentLimit) {
      const nextTask = this.queue.shift();
      nextTask();
    }
  }

  getStats() {
    return {
      running: this.running,
      queued: this.queue.length,
      currentLimit: this.currentLimit,
      maxLimit: this.maxConcurrent,
      totalProcessed: this.totalProcessed
    };
  }
}

module.exports = {
  translateBatchOpenAI,
  resetOpenAIStats,
  getOpenAIStats,
  getTierLimits,
  TIER_LIMITS,
  RampUpController,
  createSmartBatches
};
