/**
 * src/services/backtestEngine.service.js
 *
 * Moteur de backtest générique — la logique d'entrée/sortie vient
 * maintenant de backtestStrategies.service.js (registry). Ce fichier
 * gère uniquement ce qui est commun à TOUTES les stratégies :
 * bookkeeping des trades, equity curve, position sizing, métriques,
 * et agrégation multi-symbole (portefeuille équipondéré).
 */

const { STRATEGIES } = require('./backtestStrategies.service');
const logger = require('../utils/logger');

const DEFAULT_PARAMS = {
  // ── Stratégie ──
  strategyId: 'rsi_momentum',

  // Params RSI Momentum Reversion
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  emaPeriod: 200,
  volumeMultiplier: 1.5,
  volumeLookback: 20,
  requireVolumeConfirmation: false,
  emaTolerancePct: 12,

  // Params MACD Crossover
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  // Risque partagé entre toutes les stratégies
  stopLossPct: 5,
  maxPositions: 5,

  // ── Position sizing ──
  positionSizeMode: 'fixed_pct',   // 'fixed_pct' | 'fixed_dollar' | 'kelly'
  positionSizePct: 10,
  positionSizeDollar: 1000,
  kellyMinTrades: 5,
  kellyMaxFraction: 25,

  quoteCurrency: 'USD',
};

function calculateSharpe(returns, periodsPerYear = 252) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return parseFloat(((mean / stdDev) * Math.sqrt(periodsPerYear)).toFixed(2));
}

function calculateAnnualReturns(equityCurve, equityDates, initialCapital) {
  if (equityCurve.length === 0) return [];

  const yearGroups = new Map();
  for (let i = 0; i < equityDates.length; i++) {
    const year = new Date(equityDates[i]).getFullYear();
    if (!yearGroups.has(year)) yearGroups.set(year, { firstIdx: i, lastIdx: i });
    else yearGroups.get(year).lastIdx = i;
  }

  const years = [...yearGroups.keys()].sort((a, b) => a - b);
  const results = [];

  years.forEach((year, idx) => {
    const { lastIdx } = yearGroups.get(year);
    const startEquity = idx === 0 ? initialCapital : equityCurve[yearGroups.get(years[idx - 1]).lastIdx];
    const endEquity = equityCurve[lastIdx];
    if (startEquity <= 0) return;
    const returnPct = ((endEquity - startEquity) / startEquity) * 100;
    results.push({ year: String(year), returnPct: parseFloat(returnPct.toFixed(1)) });
  });

  return results;
}

function calculateMaxDrawdown(equityCurve) {
  let peak = equityCurve[0] || 0;
  let maxDD = 0;
  for (const value of equityCurve) {
    if (value > peak) peak = value;
    const dd = peak > 0 ? ((peak - value) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return parseFloat(maxDD.toFixed(2));
}

/**
 * Position sizing — indépendant de la stratégie de trading.
 */
function computePositionAllocation(cash, params, closedTrades) {
  if (params.positionSizeMode === 'fixed_dollar') {
    return Math.min(params.positionSizeDollar, cash);
  }

  if (params.positionSizeMode === 'kelly') {
    if (closedTrades.length >= params.kellyMinTrades) {
      const wins = closedTrades.filter(t => t.isW);
      const losses = closedTrades.filter(t => !t.isW);
      const winRate = wins.length / closedTrades.length;
      const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlRaw, 0) / wins.length : 0;
      const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnlRaw, 0) / losses.length) : 0;

      if (avgLoss > 0) {
        const rr = avgWin / avgLoss;
        let fraction = Math.max(0, (winRate - (1 - winRate) / rr) * 0.5); // half-Kelly
        fraction = Math.min(fraction, params.kellyMaxFraction / 100);
        return cash * fraction;
      }
    }
    return cash * (params.positionSizePct / 100);
  }

  return cash * (params.positionSizePct / 100);
}

/**
 * Lance la simulation. Générique : la logique d'entrée/sortie est
 * déléguée à la stratégie sélectionnée via params.strategyId.
 */
function runSimulation(candles, initialCapital = 100000, userParams = {}, symbol = 'N/A') {
  const params = { ...DEFAULT_PARAMS, ...userParams };
  const strategy = STRATEGIES[params.strategyId] || STRATEGIES.rsi_momentum;

  const minCandles = strategy.minCandles(params);
  if (candles.length < minCandles) {
    throw new Error(
      `Pas assez de données : ${candles.length} bougies reçues, ${minCandles} minimum requis pour la stratégie "${strategy.label}".`
    );
  }

  const closes = candles.map(c => c.close);
  const precomputed = strategy.prepare ? strategy.prepare(candles, params) : null;
  const state = strategy.initState ? strategy.initState() : {};

  let cash = initialCapital;
  let position = null;

  const trades = [];
  const equityCurve = [];
  const equityDates = [];
  const buyHoldCurve = [];
  const drawdownCurve = [];
  const periodReturns = [];

  const bhUnits = initialCapital / closes[minCandles - 1];
  let prevEquity = initialCapital;
  let peakEquity = initialCapital;

  for (let i = minCandles; i < candles.length; i++) {
    const ctx = { i, candles, closes, precomputed, params, state };
    if (strategy.onCandle) strategy.onCandle(ctx);

    const price = candles[i].close;

    // ── Sortie ──
    if (position) {
      const exitDecision = strategy.shouldExit(ctx, position);
      if (exitDecision.exit) {
        const exitPrice = exitDecision.exitPrice;
        const pnl = (exitPrice - position.entryPrice) * position.quantity;
        const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;

        cash += position.quantity * exitPrice;

        trades.push({
          n: trades.length + 1,
          sym: position.symbol,
          type: 'LONG',
          entry: position.entryPrice.toFixed(2),
          exit: exitPrice.toFixed(2),
          pnl: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
          pnlRaw: pnl,
          rr: `1:${Math.abs(pnlPct / params.stopLossPct).toFixed(1)}`,
          isW: pnl >= 0,
          dur: `${i - position.entryIndex}c`,
          entryDate: position.entryDate,
          exitDate: candles[i].date,
          qc: params.quoteCurrency,
        });

        position = null;
      }
    }

    // ── Entrée ──
    if (!position && strategy.shouldEnter(ctx)) {
      const allocation = Math.min(computePositionAllocation(cash, params, trades), cash);
      const quantity = allocation / price;

      cash -= quantity * price;
      position = { symbol, entryPrice: price, entryIndex: i, quantity, entryDate: candles[i].date };
    }

    // ── Courbes ──
    const positionValue = position ? position.quantity * price : 0;
    const equity = cash + positionValue;

    equityCurve.push(parseFloat(equity.toFixed(2)));
    equityDates.push(candles[i].date);
    buyHoldCurve.push(parseFloat((bhUnits * price).toFixed(2)));

    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    drawdownCurve.push(parseFloat((-dd).toFixed(2)));

    if (prevEquity > 0) periodReturns.push((equity - prevEquity) / prevEquity);
    prevEquity = equity;
  }

  // Clôture forcée d'une position encore ouverte à la fin de la période
  if (position) {
    const lastPrice = closes[closes.length - 1];
    const pnl = (lastPrice - position.entryPrice) * position.quantity;
    const pnlPct = ((lastPrice - position.entryPrice) / position.entryPrice) * 100;
    cash += position.quantity * lastPrice;

    trades.push({
      n: trades.length + 1,
      sym: position.symbol,
      type: 'LONG',
      entry: position.entryPrice.toFixed(2),
      exit: lastPrice.toFixed(2),
      pnl: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
      pnlRaw: pnl,
      rr: `1:${Math.abs(pnlPct / params.stopLossPct).toFixed(1)}`,
      isW: pnl >= 0,
      dur: `${candles.length - 1 - position.entryIndex}c`,
      entryDate: position.entryDate,
      exitDate: candles[candles.length - 1].date,
      qc: params.quoteCurrency,
    });
  }

  const finalEquity = equityCurve[equityCurve.length - 1] || initialCapital;
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

  const wins = trades.filter(t => t.isW);
  const losses = trades.filter(t => !t.isW);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlRaw, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlRaw, 0) / losses.length : 0;
  const avgRRRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
  const avgHoldCandles = trades.length > 0
    ? trades.reduce((s, t) => s + parseInt(t.dur), 0) / trades.length : 0;

  const metrics = {
    totalReturn: `${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(1)}%`,
    sharpe: calculateSharpe(periodReturns).toFixed(2),
    maxDrawdown: `-${calculateMaxDrawdown(equityCurve).toFixed(1)}%`,
    winRate: `${winRate.toFixed(1)}%`,
    avgRR: `1:${avgRRRatio.toFixed(1)}`,
    totalTrades: String(trades.length),
    avgWin: `+${avgWin.toFixed(0)}`,
    avgLoss: `-${Math.abs(avgLoss).toFixed(0)}`,
    avgHold: `${avgHoldCandles.toFixed(0)}c`,
    quoteCurrency: params.quoteCurrency,
    strategyId: strategy.id,
    strategyLabel: strategy.label,
  };

  const annualReturns = calculateAnnualReturns(equityCurve, equityDates, initialCapital);

  return {
    metrics,
    charts: { stratData: equityCurve, bhData: buyHoldCurve, ddData: drawdownCurve, annualReturns },
    equityDates,
    trades,
  };
}

/**
 * Combine plusieurs runSimulation() (multi-symbole) en un résultat
 * "portefeuille" — INCHANGÉ par rapport à la version précédente.
 */
function aggregatePortfolio(perSymbolResults, initialCapitalTotal) {
  if (perSymbolResults.length === 1) {
    const r = perSymbolResults[0];
    return { metrics: r.metrics, charts: r.charts, trades: r.trades.slice(-10) };
  }

  const maxLen = Math.max(...perSymbolResults.map(r => r.charts.stratData.length));

  const padToLength = (arr, len) => {
    if (arr.length === 0) return new Array(len).fill(0);
    if (arr.length >= len) return arr;
    const last = arr[arr.length - 1];
    return [...arr, ...new Array(len - arr.length).fill(last)];
  };

  const sumSeries = key => {
    const series = new Array(maxLen).fill(0);
    for (const r of perSymbolResults) {
      const padded = padToLength(r.charts[key], maxLen);
      for (let i = 0; i < maxLen; i++) series[i] += padded[i];
    }
    return series.map(v => parseFloat(v.toFixed(2)));
  };

  const stratData = sumSeries('stratData');
  const bhData = sumSeries('bhData');

  let peak = stratData[0] || 0;
  const ddData = stratData.map(v => {
    if (v > peak) peak = v;
    return peak > 0 ? parseFloat((-((peak - v) / peak) * 100).toFixed(2)) : 0;
  });

  const longest = perSymbolResults.reduce((a, b) =>
    (b.equityDates?.length || 0) > (a.equityDates?.length || 0) ? b : a
  );
  const annualReturns = calculateAnnualReturns(stratData, longest.equityDates || [], initialCapitalTotal);

  const allTrades = perSymbolResults
    .flatMap(r => r.trades)
    .sort((a, b) => new Date(a.exitDate) - new Date(b.exitDate));

  const wins = allTrades.filter(t => t.isW);
  const losses = allTrades.filter(t => !t.isW);
  const winRate = allTrades.length > 0 ? (wins.length / allTrades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlRaw, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlRaw, 0) / losses.length : 0;
  const avgRRRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
  const avgHoldCandles = allTrades.length > 0
    ? allTrades.reduce((s, t) => s + parseInt(t.dur), 0) / allTrades.length : 0;

  const finalEquity = stratData[stratData.length - 1] || initialCapitalTotal;
  const totalReturnPct = ((finalEquity - initialCapitalTotal) / initialCapitalTotal) * 100;

  const periodReturns = [];
  for (let i = 1; i < stratData.length; i++) {
    if (stratData[i - 1] > 0) periodReturns.push((stratData[i] - stratData[i - 1]) / stratData[i - 1]);
  }

  const currencies = new Set(perSymbolResults.map(r => r.metrics.quoteCurrency));

  return {
    metrics: {
      totalReturn: `${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(1)}%`,
      sharpe: calculateSharpe(periodReturns).toFixed(2),
      maxDrawdown: `-${calculateMaxDrawdown(stratData).toFixed(1)}%`,
      winRate: `${winRate.toFixed(1)}%`,
      avgRR: `1:${avgRRRatio.toFixed(1)}`,
      totalTrades: String(allTrades.length),
      avgWin: `+${avgWin.toFixed(0)}`,
      avgLoss: `-${Math.abs(avgLoss).toFixed(0)}`,
      avgHold: `${avgHoldCandles.toFixed(0)}c`,
      quoteCurrency: currencies.size === 1 ? [...currencies][0] : 'MIXED',
      strategyId: perSymbolResults[0].metrics.strategyId,
      strategyLabel: perSymbolResults[0].metrics.strategyLabel,
    },
    charts: { stratData, bhData, ddData, annualReturns },
    trades: allTrades.slice(-10),
  };
}

module.exports = { runSimulation, aggregatePortfolio, DEFAULT_PARAMS };