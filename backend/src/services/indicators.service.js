/**
 * services/indicators.service.js — AtlasQuant AI
 * Computes all technical indicators using the shared utils.
 * Imports: calculateRSI, fibonacci, movingAverage from utils/
 */

const { calculateRSI, getRSISignal } = require('../utils/calculateRSI');
const { getFibonacciSignal }         = require('../utils/fibonacci');

// ── Helper ───────────────────────────────────────────────
const closes = (candles) => candles.map(c => c.close);
const highs  = (candles) => candles.map(c => c.high);
const lows   = (candles) => candles.map(c => c.low);
const mean   = (arr)     => arr.reduce((a, b) => a + b, 0) / arr.length;

function calcEMA(values, period = 20) {
  if (values.length < period) return values.map(() => null);

  const out = Array(period - 1).fill(null);
  const multiplier = 2 / (period + 1);
  let ema = mean(values.slice(0, period));
  out.push(parseFloat(ema.toFixed(8)));

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    out.push(parseFloat(ema.toFixed(8)));
  }

  return out;
}

function emaCross(values) {
  const ema20Series = calcEMA(values, 20);
  const ema50Series = calcEMA(values, 50);
  const last = values.length - 1;
  const prev = values.length - 2;
  const ema20 = ema20Series[last];
  const ema50 = ema50Series[last];
  const currentPrice = values[last];

  let crossover = 'NONE';
  if (ema20Series[prev] !== null && ema50Series[prev] !== null) {
    if (ema20Series[prev] <= ema50Series[prev] && ema20 > ema50) crossover = 'GOLDEN_CROSS';
    if (ema20Series[prev] >= ema50Series[prev] && ema20 < ema50) crossover = 'DEATH_CROSS';
  }

  const signal = currentPrice >= ema20 && ema20 >= ema50 ? 'BUY' : 'SELL';

  return {
    ema20,
    ema50,
    position: currentPrice >= ema20 ? 'ABOVE_EMA20' : 'BELOW_EMA20',
    signal,
    crossover,
    interpretation: crossover !== 'NONE'
      ? `${crossover.replace('_', ' ')} detected`
      : `Price is ${currentPrice >= ema20 ? 'above' : 'below'} EMA20`,
  };
}

// ─────────────────────────────────────────────────────────
// MACD (12, 26, 9)
// ─────────────────────────────────────────────────────────
function calcMACD(candles, fast = 12, slow = 26, signalPeriod = 9) {
  const px = closes(candles);
  if (px.length < slow + signalPeriod)
    throw new Error('Not enough candles for MACD');

  const emaFast = calcEMA(px, fast);
  const emaSlow = calcEMA(px, slow);

  const macdLine = px
    .map((_, i) => emaFast[i] !== null && emaSlow[i] !== null
      ? parseFloat((emaFast[i] - emaSlow[i]).toFixed(8)) : null)
    .filter(v => v !== null);

  const signalLine = calcEMA(macdLine, signalPeriod);
  const last       = signalLine.length - 1;

  const macdVal   = macdLine[last];
  const signalVal = signalLine[last];
  const histogram = parseFloat((macdVal - signalVal).toFixed(8));

  const prevMacd   = macdLine[last - 1];
  const prevSignal = signalLine[last - 1];

  let crossover = 'NONE';
  if (prevMacd <= prevSignal && macdVal > signalVal) crossover = 'BULLISH_CROSS';
  if (prevMacd >= prevSignal && macdVal < signalVal) crossover = 'BEARISH_CROSS';

  const trend = macdVal > signalVal ? 'BUY' : 'SELL';

  return {
    macd:      parseFloat(macdVal.toFixed(8)),
    signal:    parseFloat(signalVal.toFixed(8)),
    histogram: parseFloat(histogram.toFixed(8)),
    crossover,
    trend,
    interpretation: crossover !== 'NONE'
      ? `${crossover.replace('_', ' ')} detected`
      : `MACD ${trend === 'BUY' ? 'above' : 'below'} signal line`,
  };
}

// ─────────────────────────────────────────────────────────
// BOLLINGER BANDS (20, 2σ)
// ─────────────────────────────────────────────────────────
function calcBollingerBands(candles, period = 20, stdDevMult = 2) {
  const px = closes(candles);
  if (px.length < period) throw new Error('Not enough candles for Bollinger Bands');

  const slice    = px.slice(-period);
  const middle   = mean(slice);
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - middle, 2), 0) / period;
  const std      = Math.sqrt(variance);

  const upper = parseFloat((middle + stdDevMult * std).toFixed(8));
  const lower = parseFloat((middle - stdDevMult * std).toFixed(8));
  const mid   = parseFloat(middle.toFixed(8));

  const price     = px[px.length - 1];
  const bandwidth = parseFloat(((upper - lower) / mid * 100).toFixed(2));
  const pctB      = parseFloat(((price - lower) / (upper - lower)).toFixed(4));

  let signal;
  if      (price >= upper) signal = 'OVERBOUGHT';
  else if (price <= lower) signal = 'OVERSOLD';
  else if (pctB > 0.6)     signal = 'UPPER_HALF';
  else                     signal = 'LOWER_HALF';

  return {
    upper, middle: mid, lower, bandwidth, pctB, signal,
    currentPrice: parseFloat(price.toFixed(8)),
    interpretation: signal === 'OVERBOUGHT' ? 'Price at upper band — resistance zone'
      : signal === 'OVERSOLD' ? 'Price at lower band — support zone'
      : `Price in ${signal.replace('_', ' ').toLowerCase()} of bands`,
  };
}

// ─────────────────────────────────────────────────────────
// VOLUME ANALYSIS
// ─────────────────────────────────────────────────────────
function calcVolume(candles, period = 20) {
  const vols   = candles.slice(-period - 1).map(c => c.volume);
  const avgVol = mean(vols.slice(0, period));
  const curVol = vols[vols.length - 1];
  const ratio  = parseFloat((curVol / avgVol).toFixed(2));

  let signal;
  if      (ratio >= 3)   signal = 'EXTREME_SURGE';
  else if (ratio >= 2)   signal = 'HIGH_VOLUME';
  else if (ratio >= 1.5) signal = 'ABOVE_AVERAGE';
  else if (ratio < 0.7)  signal = 'LOW_VOLUME';
  else                   signal = 'NORMAL';

  return {
    avgVolume:     parseFloat(avgVol.toFixed(2)),
    currentVolume: parseFloat(curVol.toFixed(2)),
    ratio, signal,
    interpretation: `Volume is ${ratio}× the ${period}-period average`,
  };
}

// ─────────────────────────────────────────────────────────
// COMPUTE ALL — single call returns every indicator
// ─────────────────────────────────────────────────────────

/**
 * computeAllIndicators
 * @param {object[]} candles  Array of { open, high, low, close, volume }
 * @returns {object} { rsi, macd, bollinger, ema, fibonacci, volume }
 */
function computeAllIndicators(candles) {
  const px = closes(candles);
  const rsiValue = calculateRSI(px);
  const rsiSignal = getRSISignal(rsiValue);
  const fib = getFibonacciSignal(highs(candles), lows(candles), px[px.length - 1]);

  return {
    rsi: {
      value: rsiValue,
      signal: rsiSignal.signal,
      interpretation: rsiSignal.reason,
    },
    macd:     calcMACD(candles),
    bollinger: calcBollingerBands(candles),
    ema:      emaCross(px),
    fibonacci: {
      nearestLevel: fib.nearestLevel,
      nearestPct: fib.proximityPct,
      trend: fib.signal,
      interpretation: fib.reason,
    },
    volume:   calcVolume(candles),
  };
}

module.exports = { computeAllIndicators, calcMACD, calcBollingerBands, calcVolume };
