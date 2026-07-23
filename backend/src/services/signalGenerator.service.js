/**
 * services/signalGenerator.service.js — AtlasQuant AI
 *
 * Crypto signal generation (Binance via marketData.service).
 * Mirrors exactly the pattern used in yahooFinance.service.js for
 * forex/commodities/indices, so both scans behave identically:
 *   - same indicator-scoring logic (bull/bear tally)
 *   - same ATR-based SL/TP
 *   - same local reasoning builder (no external AI call, no latency,
 *     no crash risk if ai.service export names drift)
 *   - same batched-parallel scanning with onProgress callback
 *
 * Exposes CRYPTO_SYMBOLS + scanAll(interval, onProgress) so that
 * controllers/signals.controller.js can do:
 *
 *   const { scanAll, CRYPTO_SYMBOLS } = require('./signalGenerator.service');
 *   const cryptoTotal = CRYPTO_SYMBOLS.length;
 *   const cryptoResult = await scanAll(interval, onProgress); // { signals: [...] }
 */

const logger = require('../utils/logger');
const { getCandles } = require('./marketData.service');
const { computeAllIndicators } = require('./indicators.service');

// Major pairs — extend freely, kept to a reasonable count to keep scan time down.
const CRYPTO_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  'MATICUSDT', 'LTCUSDT', 'TRXUSDT', 'ATOMUSDT', 'UNIUSDT',
  'ETCUSDT', 'BCHUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT',
];

const INTERVAL_MAP = { '1h': '1h', '4h': '4h', '1d': '1d' };

// Reward:Risk multiple appliqué au SL/TP calculé via ATR — même valeur
// que yahooFinance.service.js pour rester cohérent entre les deux scans.
const RR_MULTIPLE = 2;

// ── ATR (Average True Range) ──────────────────────────────
function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const cur  = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low  - prev.close)
    );
    trueRanges.push(tr);
  }

  const recent = trueRanges.slice(-period);
  const atr = recent.reduce((a, b) => a + b, 0) / recent.length;
  return atr > 0 ? atr : null;
}

function calcRiskLevels(price, candles, signal) {
  const atr = computeATR(candles) || price * 0.01;

  if (signal === 'BUY') {
    return {
      entry:       price,
      stop_loss:   price - atr,
      take_profit: price + atr * RR_MULTIPLE,
    };
  }
  if (signal === 'SELL') {
    return {
      entry:       price,
      stop_loss:   price + atr,
      take_profit: price - atr * RR_MULTIPLE,
    };
  }
  return { entry: price, stop_loss: null, take_profit: null };
}

// ── Local reasoning (no Groq) ─────────────────────────────
// Same shape as buildLocalSignal() in yahooFinance.service.js.
function buildLocalSignal(display, price, indicators, bull, bear) {
  const total      = bull + bear;
  const bullPct    = total > 0 ? bull / total : 0.5;
  const confidence = Math.min(Math.round(50 + Math.abs(bullPct - 0.5) * 80), 95);

  let signal;
  if      (bull > bear + 2) signal = 'BUY';
  else if (bear > bull + 2) signal = 'SELL';
  else                      signal = 'HOLD';

  const { rsi, macd, ema, bollinger, fibonacci } = indicators;
  const parts = [];

  if (macd?.crossover && macd.crossover !== 'NONE')
    parts.push(`MACD histogram at ${macd.histogram?.toFixed(4)}, indicating a ${macd.crossover.toLowerCase().replace(/_/g,' ')}.`);

  if (rsi?.value != null && (rsi.value < 40 || rsi.value > 60))
    parts.push(`RSI(14) at ${rsi.value.toFixed(2)} — ${rsi.value < 40 ? 'oversold' : 'overbought'} territory.`);

  if (ema?.ema20 != null && ema?.ema50 != null)
    parts.push(`EMA20 (${ema.ema20.toFixed(4)}) is ${(ema.position || '').toLowerCase().replace(/_/g,' ')} EMA50 (${ema.ema50.toFixed(4)}).`);

  if (bollinger?.signal && bollinger.signal !== 'NORMAL')
    parts.push(`Bollinger Bands signal: ${bollinger.signal.toLowerCase().replace(/_/g,' ')}.`);

  if (fibonacci?.nearestLevel != null)
    parts.push(`Nearest Fibonacci level at ${fibonacci.nearestLevel.toFixed(4)} — ${fibonacci.interpretation || ''}.`);

  if (!parts.length)
    parts.push(`${display} is trading at ${price.toFixed(4)} with mixed signals.`);

  return { signal, confidence, reasoning: parts.join(' ') };
}

// ── Single-symbol signal ───────────────────────────────────
async function generateCryptoSignal(symbol, interval = '4h') {
  logger.info(`[signalGenerator] Processing ${symbol} (${interval})...`);

  const yfInterval = INTERVAL_MAP[interval] || '4h';
  const candles = await getCandles(symbol, yfInterval, 200);

  if (!candles || candles.length < 30) {
    throw new Error(`Not enough candles for ${symbol}: ${candles?.length || 0}`);
  }

  const indicators = computeAllIndicators(candles);
  const price = candles[candles.length - 1].close;

  const { rsi, macd, ema, bollinger, volume } = indicators;
  let bull = 0, bear = 0;
  if (rsi.value <= 35)                    bull += 2;
  if (rsi.value >= 65)                    bear += 2;
  if (macd.trend === 'BUY')               bull++;
  if (macd.trend === 'SELL')              bear++;
  if (macd.crossover === 'BULLISH_CROSS') bull += 2;
  if (macd.crossover === 'BEARISH_CROSS') bear += 2;
  if (ema.signal === 'BUY')               bull++;
  if (ema.signal === 'SELL')              bear++;
  if (ema.crossover === 'GOLDEN_CROSS')   bull += 2;
  if (ema.crossover === 'DEATH_CROSS')    bear += 2;
  if (bollinger.signal === 'OVERSOLD')    bull++;
  if (bollinger.signal === 'OVERBOUGHT')  bear++;
  if (volume.ratio >= 1.5) { bull > bear ? bull++ : bear++; }

  const display = symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}/USDT` : symbol;

  const { signal, confidence, reasoning } = buildLocalSignal(
    display, price, indicators, bull, bear
  );

  logger.info(`[signalGenerator] ${display} → ${signal} (${confidence}%)`);

  const { entry, stop_loss, take_profit } = calcRiskLevels(price, candles, signal);

  return {
    id:          `${symbol}_${Date.now()}`,
    symbol:      display,
    rawSymbol:   symbol,
    asset_class: 'Crypto',
    category:    'Crypto',
    timestamp:   new Date().toISOString(),
    price,
    signal,
    confidence,
    reasoning,
    score:       { bullish: bull, bearish: bear },
    indicators,
    entry,
    stop_loss,
    take_profit,
    risk_reward: signal !== 'HOLD' ? `1:${RR_MULTIPLE}` : null,
  };
}

// ── Batched full scan ──────────────────────────────────────
// onProgress(symbol) called after each symbol completes (success or fail),
// same contract as scanAllYF() in yahooFinance.service.js.
const CRYPTO_BATCH_SIZE = 4;

async function scanAll(interval = '4h', onProgress = () => {}) {
  logger.info(`[signalGenerator] Scanning ${CRYPTO_SYMBOLS.length} crypto pairs...`);
  const results = [];

  for (let i = 0; i < CRYPTO_SYMBOLS.length; i += CRYPTO_BATCH_SIZE) {
    const batch   = CRYPTO_SYMBOLS.slice(i, i + CRYPTO_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(symbol => generateCryptoSignal(symbol, interval)));

    settled.forEach((outcome, idx) => {
      const symbol = batch[idx];
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        logger.error(`[signalGenerator] ${symbol} error: ${outcome.reason?.message}`);
      }
      try { onProgress(symbol); } catch { /* never let progress reporting break the scan */ }
    });

    if (i + CRYPTO_BATCH_SIZE < CRYPTO_SYMBOLS.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Wrapped in { signals } to match how signals.controller.js consumes it:
  // const [cryptoResult, yfResult] = await Promise.all([scanAll(...), scanAllYF(...)]);
  // const allSignals = [...cryptoResult.signals, ...yfResult];
  return { signals: results };
}

module.exports = { generateCryptoSignal, scanAll, CRYPTO_SYMBOLS };