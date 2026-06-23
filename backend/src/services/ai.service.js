/**
 * services/ai.service.js — AtlasQuant AI
 * Calls Groq API (LLaMA 3.3-70B) to generate trading reasoning.
 */

const axios  = require('axios');
const env    = require('../config/env');
const logger = require('../utils/logger');

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

/**
 * generateReasoning
 * @param {string} symbol      e.g. 'BTC/USDT'
 * @param {number} price       current price
 * @param {object} indicators  { rsi, macd, bollinger, ema, fibonacci, volume }
 * @returns {object} { signal, confidence, entry, stopLoss, takeProfit, riskReward, reasoning, ... }
 */
async function generateReasoning(symbol, price, indicators) {
  if (!env.GROQ_API_KEY) {
    logger.warn('[ai.service] No GROQ_API_KEY — using fallback');
    return ruleBasedFallback(price, indicators);
  }

  const { rsi, macd, bollinger, ema, fibonacci, volume } = indicators;

  const prompt = `You are AtlasQuant AI, a professional crypto trading analyst. Be concise and data-driven.

Analyze ${symbol} at $${price.toLocaleString()}:

INDICATORS:
- RSI(14): ${rsi.value} → ${rsi.signal}
- MACD: ${macd.trend} | Histogram: ${macd.histogram} | Crossover: ${macd.crossover}
- Bollinger: ${bollinger.signal} | %B: ${bollinger.pctB} | Width: ${bollinger.bandwidth}%
- EMA20(${ema.ema20?.toFixed(2)}) ${ema.position} EMA50(${ema.ema50?.toFixed(2)}) → ${ema.crossover !== 'NONE' ? ema.crossover : ema.signal}
- Fibonacci: Nearest ${fibonacci.nearestPct}% level at $${fibonacci.nearestLevel} | ${fibonacci.trend}
- Volume: ${volume.ratio}× avg → ${volume.signal}

Respond ONLY with this JSON (no markdown, no explanation outside the JSON):
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": <0-100>,
  "timeframe": "Intraday" | "Swing (1-5d)" | "Position (1-4w)",
  "entry": <number>,
  "stopLoss": <number>,
  "takeProfit": <number>,
  "riskReward": "<e.g. 1:2.4>",
  "reasoning": "<2 sentences with specific indicator values>",
  "keyLevel": "<most important price level>",
  "invalidation": "<what would cancel this signal>"
}`;

  try {
    const { data } = await axios.post(
      GROQ_URL,
      {
        model:       GROQ_MODEL,
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens:  400,
      },
      {
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );

    const raw     = data.choices[0]?.message?.content?.trim() || '';
    // Strip markdown fences if Groq wraps the response
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed  = JSON.parse(cleaned);

    logger.info(`[ai.service] ${symbol} → ${parsed.signal} (${parsed.confidence}%)`);
    return parsed;

  } catch (err) {
    logger.error(`[ai.service] Groq failed: ${err.message} — using fallback`);
    return ruleBasedFallback(price, indicators);
  }
}

/**
 * ruleBasedFallback — deterministic signal when Groq is unavailable
 */
function ruleBasedFallback(price, { rsi, macd, ema, volume }) {
  let bull = 0, bear = 0;
  if (rsi.value <= 35)                   bull += 2;
  if (rsi.value >= 65)                   bear += 2;
  if (macd.trend === 'BUY')              bull++;
  if (macd.trend === 'SELL')             bear++;
  if (macd.crossover === 'BULLISH_CROSS') bull += 2;
  if (macd.crossover === 'BEARISH_CROSS') bear += 2;
  if (ema.signal === 'BUY')              bull++;
  if (ema.signal === 'SELL')             bear++;
  if (ema.crossover === 'GOLDEN_CROSS')  bull += 2;
  if (ema.crossover === 'DEATH_CROSS')   bear += 2;
  if (volume.ratio >= 1.5) { bull > bear ? bull++ : bear++; }

  const total      = bull + bear || 1;
  const signal     = bull - bear >= 3 ? 'BUY' : bear - bull >= 3 ? 'SELL' : 'HOLD';
  const confidence = Math.round(Math.max(bull, bear) / total * 100);

  const sl = signal === 'BUY'  ? parseFloat((price * 0.97).toFixed(4)) : parseFloat((price * 1.03).toFixed(4));
  const tp = signal === 'BUY'  ? parseFloat((price * 1.07).toFixed(4)) : parseFloat((price * 0.93).toFixed(4));

  return {
    signal, confidence,
    timeframe:   'Swing (1-5d)',
    entry:       price, stopLoss: sl, takeProfit: tp,
    riskReward:  '1:2.3',
    reasoning:   `Rule-based: RSI ${rsi.value} (${rsi.signal}), MACD ${macd.trend}${macd.crossover !== 'NONE' ? ' with ' + macd.crossover : ''}, EMA20 ${ema.position} EMA50. ${bull} bullish vs ${bear} bearish signals.`,
    keyLevel:    String(price.toFixed(4)),
    invalidation: signal === 'BUY' ? `Close below $${sl}` : `Close above $${sl}`,
  };
}

module.exports = { generateReasoning };