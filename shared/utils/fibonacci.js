/**
 * WHAT IS FIBONACCI RETRACEMENT?
 * When price moves up or down strongly, it often "retraces"
 * (pulls back) to specific levels before continuing.
 *
 * These levels are based on the Fibonacci sequence:
 *   0.236 (23.6%) → weak support/resistance
 *   0.382 (38.2%) → moderate support/resistance
 *   0.500 (50.0%) → strong support/resistance (psychological)
 *   0.618 (61.8%) → strongest level — "golden ratio"
 *   0.786 (78.6%) → last support before full reversal
 *
 * HOW TRADERS USE IT:
 *   Price drops to 0.618 level and bounces → strong BUY signal
 *   Price fails to break 0.382 level       → SELL signal
 *   Price between levels                   → HOLD, wait
 *
 * EXAMPLE:
 *   BTC moves from $60,000 (low) to $70,000 (high)
 *   Range = $10,000
 *   0.382 level = $70,000 - ($10,000 × 0.382) = $66,180
 *   0.618 level = $70,000 - ($10,000 × 0.618) = $63,820
 *   If BTC retraces to $63,820 → strong buy zone
 */

const FIB_LEVELS = [0.236, 0.382, 0.500, 0.618, 0.786];

/**
 * Calculate Fibonacci retracement levels
 *
 * @param {number[]} highs  - array of high prices
 * @param {number[]} lows   - array of low prices
 * @returns {Object} Fibonacci levels + current price position
 */
const calculateFibonacci = (highs, lows) => {
  if (!highs.length || !lows.length) return null;

  // Find the highest and lowest points in our data
  const swingHigh = Math.max(...highs);
  const swingLow  = Math.min(...lows);
  const range     = swingHigh - swingLow;

  if (range === 0) return null;

  // Calculate each Fibonacci level
  // For uptrend: levels go DOWN from the high (retracement)
  const levels = {};
  FIB_LEVELS.forEach(fib => {
    levels[`fib_${(fib * 100).toFixed(1)}%`] = parseFloat(
      (swingHigh - range * fib).toFixed(8)
    );
  });

  return {
    swingHigh:  parseFloat(swingHigh.toFixed(8)),
    swingLow:   parseFloat(swingLow.toFixed(8)),
    range:      parseFloat(range.toFixed(8)),
    levels,
  };
};

/**
 * Get Fibonacci signal based on where current price sits
 *
 * @param {number[]} highs         - array of high prices
 * @param {number[]} lows          - array of low prices
 * @param {number}   currentPrice  - latest closing price
 * @returns {Object} signal + nearest Fibonacci level
 */
const getFibonacciSignal = (highs, lows, currentPrice) => {
  const fib = calculateFibonacci(highs, lows);
  if (!fib) return { signal: "HOLD", reason: "Not enough data" };

  const { levels, swingHigh, swingLow, range } = fib;

  // Find which Fibonacci zone the price is currently in
  const levelValues = Object.entries(levels).sort((a, b) => b[1] - a[1]);

  let nearestLevel  = null;
  let nearestName   = null;
  let minDistance   = Infinity;

  for (const [name, value] of levelValues) {
    const distance = Math.abs(currentPrice - value);
    if (distance < minDistance) {
      minDistance  = distance;
      nearestLevel = value;
      nearestName  = name;
    }
  }

  // How close is the price to the nearest Fibonacci level? (as %)
  const proximityPct = (minDistance / currentPrice) * 100;

  // Price near a Fibonacci level = potential signal
  let signal = "HOLD";
  let reason = "";

  if (proximityPct < 1.5) {
    // Price is within 1.5% of a key Fibonacci level
    if (currentPrice <= nearestLevel) {
      signal = "BUY";
      reason = `Price near Fibonacci ${nearestName} support at $${nearestLevel.toFixed(2)} — potential bounce`;
    } else {
      signal = "SELL";
      reason = `Price near Fibonacci ${nearestName} resistance at $${nearestLevel.toFixed(2)} — potential rejection`;
    }
  } else {
    reason = `Price between Fibonacci levels — nearest: ${nearestName} at $${nearestLevel?.toFixed(2)}`;
  }

  return {
    signal,
    reason,
    currentPrice,
    nearestLevel,
    nearestLevelName: nearestName,
    proximityPct:     parseFloat(proximityPct.toFixed(2)),
    allLevels:        levels,
    swingHigh,
    swingLow,
  };
};

module.exports = { calculateFibonacci, getFibonacciSignal, FIB_LEVELS };