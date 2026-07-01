/**
 * src/services/signalGenerator.service.js — AtlasQuant AI
 * Generates BUY/SELL/HOLD signals using technical indicators
 * Uses: indicators.service.js + marketData.service.js
 */

const logger = require('../utils/logger');

// ── Lazy load heavy deps to avoid circular deps + heap crashes ──
function getIndicators() {
  return require('./indicators.service');
}
function getMarketData() {
  return require('./marketData.service');
}

// ── Symbols to scan (expanded — top liquid Binance USDT pairs) ──
const CRYPTO_SYMBOLS = [
  'BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','XRP/USDT',
  'ADA/USDT','AVAX/USDT','DOGE/USDT','LINK/USDT','UNI/USDT',
  'AAVE/USDT','MATIC/USDT','ARB/USDT','OP/USDT','SHIB/USDT',
  'PEPE/USDT','LTC/USDT','BCH/USDT','ATOM/USDT','NEAR/USDT',
  'INJ/USDT','SUI/USDT','TON/USDT','TRX/USDT','FIL/USDT',
  'APT/USDT','DOT/USDT','ICP/USDT','ETC/USDT','RNDR/USDT',
];

// ── Generate signal for one symbol ───────────────────────
async function generateSignal(symbol, interval = '4h') {
  const { computeAllIndicators } = getIndicators();
  const { getCandles }           = getMarketData();

  try {
    const candles = await getCandles(symbol.replace('/', ''), interval, 200);
    if (!candles || candles.length < 50) {
      logger.warn(`[signalGen] Not enough candles for ${symbol}`);
      return null;
    }

    const indicators = computeAllIndicators(candles);
    const price      = candles[candles.length - 1].close;

    // ── Score system ─────────────────────────────────────
    let bullScore = 0;
    let bearScore = 0;

    const rsi = indicators.rsi.value;
    if (rsi < 30)       bullScore += 3;
    else if (rsi < 45)  bullScore += 1;
    else if (rsi > 70)  bearScore += 3;
    else if (rsi > 55)  bearScore += 1;

    if (indicators.macd.crossover === 'BULLISH_CROSS') bullScore += 3;
    else if (indicators.macd.trend === 'BUY')          bullScore += 1;
    else if (indicators.macd.crossover === 'BEARISH_CROSS') bearScore += 3;
    else if (indicators.macd.trend === 'SELL')         bearScore += 1;

    if (indicators.bollinger.signal === 'OVERSOLD')    bullScore += 2;
    else if (indicators.bollinger.signal === 'UPPER_HALF') bullScore += 1;
    if (indicators.bollinger.signal === 'OVERBOUGHT')  bearScore += 2;
    else if (indicators.bollinger.signal === 'LOWER_HALF') bearScore += 1;

    if (indicators.ema.crossover === 'GOLDEN_CROSS')   bullScore += 3;
    else if (indicators.ema.signal === 'BUY')           bullScore += 1;
    if (indicators.ema.crossover === 'DEATH_CROSS')    bearScore += 3;
    else if (indicators.ema.signal === 'SELL')          bearScore += 1;

    if (indicators.fibonacci.trend === 'BUY')          bullScore += 2;
    else if (indicators.fibonacci.trend === 'SELL')    bearScore += 2;

    if (['HIGH_VOLUME','EXTREME_SURGE'].includes(indicators.volume.signal)) {
      bullScore += (bullScore > bearScore) ? 2 : 0;
      bearScore += (bearScore > bullScore) ? 2 : 0;
    }

    const total      = bullScore + bearScore;
    const bullPct    = total > 0 ? bullScore / total : 0.5;
    const confidence = Math.round(50 + Math.abs(bullPct - 0.5) * 80 + Math.random() * 5);

    let signal;
    if      (bullScore > bearScore + 2) signal = 'BUY';
    else if (bearScore > bullScore + 2) signal = 'SELL';
    else                                signal = 'HOLD';

    const atr = (indicators.bollinger.upper - indicators.bollinger.lower) * 0.25;

    let entry, stop_loss, take_profit, risk_reward;
    if (signal === 'BUY') {
      entry       = price;
      stop_loss   = parseFloat((price - atr).toFixed(8));
      take_profit = parseFloat((price + atr * 2).toFixed(8));
      risk_reward = '1:2';
    } else if (signal === 'SELL') {
      entry       = price;
      stop_loss   = parseFloat((price + atr).toFixed(8));
      take_profit = parseFloat((price - atr * 2).toFixed(8));
      risk_reward = '1:2';
    } else {
      entry       = price;
      stop_loss   = null;
      take_profit = null;
      risk_reward = null;
    }

    const parts = [];
    if (indicators.macd.crossover !== 'NONE') parts.push(`The MACD histogram is at ${indicators.macd.histogram.toFixed(8)}, indicating a ${indicators.macd.crossover.toLowerCase().replace('_',' ')}.`);
    if (rsi < 40 || rsi > 60) parts.push(`The RSI(14) at ${rsi.toFixed(2)} indicates ${rsi < 40 ? 'an oversold' : 'an overbought'} condition.`);
    parts.push(`The EMA20 (${indicators.ema.ema20?.toFixed(4)}) is ${indicators.ema.position?.toLowerCase().replace('_',' ')} EMA50 (${indicators.ema.ema50?.toFixed(4)}).`);
    parts.push(`The nearest Fibonacci level at $${indicators.fibonacci.nearestLevel?.toFixed(8)} ${indicators.fibonacci.interpretation}.`);

    const rawSymbol = symbol.replace('/', '');

    return {
      symbol:      rawSymbol,
      asset_class: 'Crypto',
      signal,
      confidence:  Math.min(confidence, 95),
      price,
      entry,
      stop_loss,
      take_profit,
      risk_reward,
      reasoning:   parts.join(' '),
      indicators,
      score: { bullish: bullScore, bearish: bearScore },
    };
  } catch (err) {
    logger.error(`[signalGen] Error for ${symbol}: ${err.message}`);
    return null;
  }
}

// ── Scan all crypto symbols ───────────────────────────────
async function scanAll(interval = '4h') {
  logger.info(`[signalGen] Scanning ${CRYPTO_SYMBOLS.length} crypto symbols (${interval})...`);

  const results = [];
  for (const symbol of CRYPTO_SYMBOLS) {
    const sig = await generateSignal(symbol, interval);
    if (sig) results.push(sig);
    await new Promise(r => setTimeout(r, 400)); // rate limit
  }

  logger.info(`[signalGen] Done — ${results.length} signals generated`);
  return { signals: results };
}

module.exports = { scanAll, generateSignal, CRYPTO_SYMBOLS };