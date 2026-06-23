/**
 * WHAT IS RSI?
 * RSI = Relative Strength Index
 * A number between 0 and 100 that tells you:
 *   Below 30 = OVERSOLD   → price dropped too much → possible BUY
 *   Above 70 = OVERBOUGHT → price rose too much    → possible SELL
 *   30 to 70 = NEUTRAL    → no clear signal        → HOLD
 *
 * HOW IT WORKS:
 * It compares average gains vs average losses over 14 candles.
 * If price went up more than down → RSI is high
 * If price went down more than up → RSI is low
 */

const calculateRSI = (closes, period = 14) => {
  // closes = array of closing prices
  // Example: [67200, 67540, 67100, 68200, ...]
  // period = 14 candles (standard setting used by all traders)

  if (closes.length < period + 1) {
    // Not enough data to calculate RSI
    return null;
  }

  // Step 1: Calculate gains and losses between each candle
  // If price went UP   → it's a gain
  // If price went DOWN → it's a loss (stored as positive number)
  const gains  = [];
  const losses = [];

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);   // gain if positive
    losses.push(change < 0 ? -change : 0); // loss if negative
  }

  // Step 2: Calculate first average gain and loss (simple average)
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Step 3: Smooth the averages using Wilder's smoothing method
  // This is what makes RSI accurate
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  // Step 4: Calculate RS (Relative Strength)
  if (avgLoss === 0) return 100; // No losses = maximum strength

  const rs  = avgGain / avgLoss;

  // Step 5: Convert RS to RSI (0-100 scale)
  const rsi = 100 - (100 / (1 + rs));

  return parseFloat(rsi.toFixed(2));
};

/**
 * Get RSI signal from a value
 * Returns: "BUY" | "SELL" | "HOLD" + explanation
 */
const getRSISignal = (rsi) => {
  if (rsi === null) return { signal: "HOLD", reason: "Not enough data" };

  if (rsi < 30) return {
    signal: "BUY",
    reason: `RSI ${rsi} — oversold (below 30), price likely to bounce up`,
    strength: rsi < 20 ? "STRONG" : "NORMAL",
  };

  if (rsi > 70) return {
    signal: "SELL",
    reason: `RSI ${rsi} — overbought (above 70), price likely to drop`,
    strength: rsi > 80 ? "STRONG" : "NORMAL",
  };

  return {
    signal: "HOLD",
    reason: `RSI ${rsi} — neutral zone (30-70), no clear signal`,
    strength: "NEUTRAL",
  };
};

module.exports = { calculateRSI, getRSISignal };