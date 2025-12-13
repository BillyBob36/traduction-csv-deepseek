/**
 * Service OpenAI pour la traduction
 * Alternative à DeepSeek avec gestion des rate limits par tier
 */

const SYSTEM_PROMPTS = require('../config/prompts');

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// Configuration des rate limits par tier pour gpt-4o-mini
// batchSize réduit pour éviter troncation des réponses longues
// rampUp: démarrage progressif pour éviter les 502
const TIER_LIMITS = {
  1: { rpm: 500, tpm: 200000, maxParallel: 30, batchSize: 8, rampUp: { initial: 10, delay: 2000, step: 10 } },
  2: { rpm: 500, tpm: 2000000, maxParallel: 50, batchSize: 10, rampUp: { initial: 15, delay: 1500, step: 15 } },
  3: { rpm: 5000, tpm: 4000000, maxParallel: 100, batchSize: 10, rampUp: { initial: 30, delay: 1000, step: 30 } },
  4: { rpm: 10000, tpm: 10000000, maxParallel: 150, batchSize: 12, rampUp: { initial: 40, delay: 800, step: 40 } },
  5: { rpm: 30000, tpm: 150000000, maxParallel: 250, batchSize: 15, rampUp: { initial: 60, delay: 500, step: 60 } }
};

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
 * Envoie un batch de textes à traduire à OpenAI
 */
async function translateBatchOpenAI(texts, targetLanguage, apiKey, tier = 3) {
  const systemPrompt = SYSTEM_PROMPTS[targetLanguage];
  
  if (!systemPrompt) {
    throw new Error(`Langue non supportée: ${targetLanguage}`);
  }

  const userContent = texts.map((text, i) => `[${i + 1}] ${text}`).join('\n');
  const tierLimits = getTierLimits(tier);

  const payload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: 0.1,
    max_tokens: 16384
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
      const translations = parseTranslations(responseText, texts.length);

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
  RampUpController
};
