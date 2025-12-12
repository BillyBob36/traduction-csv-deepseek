/**
 * Service OpenAI pour la traduction
 * Alternative à DeepSeek avec gestion des rate limits par tier
 */

const SYSTEM_PROMPTS = require('../config/prompts');

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// Configuration des rate limits par tier pour gpt-4o-mini
const TIER_LIMITS = {
  1: { rpm: 500, tpm: 200000, maxParallel: 30, delayBetweenBatches: 150 },
  2: { rpm: 500, tpm: 2000000, maxParallel: 50, delayBetweenBatches: 150 },
  3: { rpm: 5000, tpm: 4000000, maxParallel: 200, delayBetweenBatches: 20 },
  4: { rpm: 10000, tpm: 10000000, maxParallel: 300, delayBetweenBatches: 10 },
  5: { rpm: 30000, tpm: 150000000, maxParallel: 500, delayBetweenBatches: 5 }
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

  const userContent = texts.map((text, i) => `${i + 1}. ${text}`).join('\n');
  const tierLimits = getTierLimits(tier);

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
  const splitRegex = /(?:^|\n)(\d+)[\.\)]\s*/g;
  
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

module.exports = {
  translateBatchOpenAI,
  resetOpenAIStats,
  getOpenAIStats,
  getTierLimits,
  TIER_LIMITS
};
