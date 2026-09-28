/**
 * services/benchmarkComparison.service.js — AtlasQuant AI
 * Extracted from portfolioController.js so Dashboard and Portfolio share the
 * exact same date-alignment logic instead of two copies that can silently
 * drift apart over time.
 */
function toDateKey(d) {
  const dt = new Date(d);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildBenchmarkCurve(equityCurve, benchmarkCandles) {
  if (!benchmarkCandles.length || !equityCurve.length) return { curve: [], alpha: null };

  const byDate = new Map(benchmarkCandles.map(c => [toDateKey(c.date), c.close]));

  let lastKnownClose = null;
  for (const c of benchmarkCandles) {
    const d = toDateKey(c.date);
    if (d <= equityCurve[0].date) lastKnownClose = c.close;
    else break;
  }

  const firstPortfolio = equityCurve[0].v;
  let firstBenchmark = null;

  const curve = equityCurve.map(point => {
    if (byDate.has(point.date)) lastKnownClose = byDate.get(point.date);
    if (firstBenchmark === null && lastKnownClose != null) firstBenchmark = lastKnownClose;

    return {
      t: point.t,
      portfolio: firstPortfolio > 0 ? ((point.v - firstPortfolio) / firstPortfolio) * 100 : 0,
      benchmark: (lastKnownClose != null && firstBenchmark)
        ? ((lastKnownClose - firstBenchmark) / firstBenchmark) * 100
        : null,
    };
  });

  const last = curve.at(-1);
  const alpha = (last && last.benchmark != null) ? (last.portfolio - last.benchmark) : null;

  return { curve, alpha };
}

module.exports = { toDateKey, buildBenchmarkCurve };