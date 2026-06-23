/**
 * WHAT IS A MOVING AVERAGE?
 * It smooths out price noise by averaging the last N candles.
 * Shows you the TREND — is the market going up or down overall?
 *
 * TWO TYPES WE USE:
 *
 * SMA (Simple Moving Average):
 *   Average of the last N prices
 *   Example SMA(3): [100, 110, 120] → (100+110+120)/3 = 110
 *
 * EMA (Exponential Moving Average):
 *   Like SMA but gives MORE weight to recent prices
 *   Reacts faster to price changes → better for trading signals
 *
 * HOW TRADERS USE IT:
 *   Price ABOVE moving average → uptrend  → bullish
 *   Price BELOW moving average → downtrend → bearish
 *   Short MA crosses ABOVE long MA → BUY signal (Golden Cross)
 *   Short MA crosses BELOW long MA → SELL signal (Death Cross)
 */

/**
 * Calculate Simple Moving Average (SMA)
 * @param {number[]} closes - array of closing prices
 * @param {number}   period - number of candles to average
 * @returns {number|null} the SMA value
 */
const calculateSMA = (closes, period = 20) => {
  if (closes.length < period) return null;

  // Take the last N prices and average them
  const slice = closes.slice(-period);
  const sum   = slice.reduce((a, b) => a + b, 0);
  return parseFloat((sum / period).toFixed(8));
};

/**
 * Calculate Exponential Moving Average (EMA)
 * More accurate than SMA for trading signals
 *
 * @param {number[]} closes - array of closing prices
 * @param {number}   period - number of candles (common: 12, 26, 50, 200)
 * @returns {number|null} the EMA value
 */
const calculateEMA = (closes, period = 20) => {
  if (closes.length < period) return null;

  // Multiplier — how much weight to give recent prices
  // Higher multiplier = reacts faster to price changes
  const multiplier = 2 / (period + 1);

  // Start with SMA as the first EMA value
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Apply EMA formula to each subsequent price
  // EMA = (Price × multiplier) + (Previous EMA × (1 - multiplier))
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
  }

  return parseFloat(ema.toFixed(8));
};

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 *
 * WHAT IS MACD?
 * MACD shows the relationship between two EMAs.
 * It tells you: is momentum increasing or decreasing?
 *
 * THREE COMPONENTS:
 *   MACD Line   = EMA(12) - EMA(26)   ← fast minus slow
 *   Signal Line = EMA(9) of MACD Line ← smoothed MACD
 *   Histogram   = MACD - Signal       ← difference
 *
 * SIGNALS:
 *   MACD crosses ABOVE signal → BUY  (bullish crossover)
 *   MACD crosses BELOW signal → SELL (bearish crossover)
 *   Histogram growing         → momentum increasing
 *   Histogram shrinking       → momentum decreasing
 */
const calculateMACD = (closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) => {
  if (closes.length < slowPeriod + signalPeriod) return null;

  // Step 1: Calculate fast and slow EMAs
  const ema12 = calculateEMA(closes, fastPeriod);
  const ema26 = calculateEMA(closes, slowPeriod);

  if (!ema12 || !ema26) return null;

  // Step 2: MACD line = fast EMA - slow EMA
  const macdLine = ema12 - ema26;

  // Step 3: Signal line = EMA(9) of MACD values
  // We need to build the MACD history first
  const macdHistory = [];
  for (let i = slowPeriod; i <= closes.length; i++) {
    const slice    = closes.slice(0, i);
    const fastEMA  = calculateEMA(slice, fastPeriod);
    const slowEMA  = calculateEMA(slice, slowPeriod);
    if (fastEMA && slowEMA) macdHistory.push(fastEMA - slowEMA);
  }

  const signalLine = calculateEMA(macdHistory, signalPeriod);
  if (!signalLine) return null;

  // Step 4: Histogram = MACD - Signal
  const histogram = macdLine - signalLine;

  // Step 5: Determine signal
  let signal = "HOLD";
  let reason = "";

  if (macdLine > signalLine && histogram > 0) {
    signal = "BUY";
    reason = "MACD above signal line — bullish momentum";
  } else if (macdLine < signalLine && histogram < 0) {
    signal = "SELL";
    reason = "MACD below signal line — bearish momentum";
  } else {
    reason = "MACD near signal line — no clear direction";
  }

  return {
    macd:      parseFloat(macdLine.toFixed(8)),
    signal:    parseFloat(signalLine.toFixed(8)),
    histogram: parseFloat(histogram.toFixed(8)),
    action:    signal,
    reason,
  };
};

/**
 * Get Moving Average signal
 * Compares current price to MA to determine trend direction
 */
const getMASignal = (closes, period = 20) => {
  const ma           = calculateEMA(closes, period);
  const currentPrice = closes[closes.length - 1];

  if (!ma) return { signal: "HOLD", reason: "Not enough data" };

  const pctDiff = ((currentPrice - ma) / ma) * 100;

  if (currentPrice > ma) return {
    signal: "BUY",
    reason: `Price $${currentPrice} is ${pctDiff.toFixed(2)}% above EMA${period} — uptrend`,
    ma, currentPrice, pctDiff: parseFloat(pctDiff.toFixed(2)),
  };

  return {
    signal: "SELL",
    reason: `Price $${currentPrice} is ${Math.abs(pctDiff).toFixed(2)}% below EMA${period} — downtrend`,
    ma, currentPrice, pctDiff: parseFloat(pctDiff.toFixed(2)),
  };
};

module.exports = { calculateSMA, calculateEMA, calculateMACD, getMASignal };