/**
 * src/services/backtestEngine.service.js
 *
 * Moteur de backtest générique — la logique d'entrée/sortie vient
 * maintenant de backtestStrategies.service.js (registry). Ce fichier
 * gère uniquement ce qui est commun à TOUTES les stratégies :
 * bookkeeping des trades, equity curve, position sizing, métriques,
 * et agrégation multi-symbole (portefeuille équipondéré).
 *
 * FIX (audit multi-asset) :
 *   - `params.maxPositions` était accepté mais totalement ignoré : une
 *     seule variable `position` (singulier) limitait chaque symbole à
 *     UNE position ouverte à la fois, quelle que soit la valeur du champ
 *     "Max Pos" côté UI. Le moteur gère maintenant un tableau
 *     `positions[]` et autorise jusqu'à `params.maxPositions` entrées
 *     concurrentes par symbole (pyramiding), chacune avec son propre
 *     stop loss et sa propre sortie.
 *   - Trade Log "#" dupliqués : chaque symbole a son propre compteur
 *     `n` local (issu de sa propre simulation isolée). En multi-symbole,
 *     `aggregatePortfolio` faisait un `flatMap` + `slice(-10)` sans
 *     jamais renuméroter → deux trades de symboles différents pouvaient
 *     afficher le même "#" dans le tableau "Last 10 trades" (ex: #3 SPY
 *     ET #3 AAPL). `renumberTrades()` corrige ça en réassignant 1..N
 *     après le tri/slice final, pour les deux chemins (single ET
 *     multi-symbole).
 *
 * FIX (audit unité de durée) :
 *   - `dur` était calculé comme `${exitIndex - position.entryIndex}c`,
 *     c'est-à-dire un nombre de BOUGIES suffixé "c" en dur, sans jamais
 *     tenir compte du timeframe réel des bougies. Problème : le fallback
 *     4H→Daily (voir backtestMarketRouter.service.js) s'applique PAR
 *     SYMBOLE selon la date de début demandée — dans un même backtest
 *     multi-symbole, un symbole peut tourner en 4H pendant qu'un autre
 *     est tombé en Daily, et les deux affichaient quand même "173c",
 *     "31c"... comme si c'était la même unité. `avgHold` (métriques)
 *     avait le même problème : moyenne arithmétique de nombres de
 *     bougies d'unités potentiellement différentes.
 *     Le moteur ne connaît de toute façon pas nativement le timeframe
 *     (il n'est pas passé dans params) — plutôt que de le propager
 *     depuis le controller, on calcule la durée réelle à partir de
 *     `entryDate`/`exitDate` (déjà disponibles sur chaque trade), ce
 *     qui est correct quel que soit le timeframe et même si deux
 *     symboles d'un même backtest utilisent des granularités
 *     différentes. `durationDays()` / `formatDurationDays()` gèrent ça,
 *     et `avgHold` fait maintenant la moyenne sur les jours (float)
 *     avant de reformater, au lieu de faire la moyenne sur des chaînes
 *     à unité mixte.
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
 * Durée réelle entre deux dates (float, en jours). Indépendant du
 * timeframe des bougies — fonctionne même si deux symboles d'un même
 * backtest tournent sur des granularités différentes (fallback Daily
 * appliqué à l'un et pas à l'autre, par ex.).
 */
function durationDays(entryDate, exitDate) {
  const ms = new Date(exitDate).getTime() - new Date(entryDate).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

/**
 * Formate une durée en jours vers un libellé lisible : "Xd" à partir
 * d'un jour, sinon "Xh" (minimum 1h affiché pour éviter "0h").
 */
function formatDurationDays(days) {
  if (days >= 1) return `${Math.round(days)}d`;
  const hours = Math.max(1, Math.round(days * 24));
  return `${hours}h`;
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
 * Construit l'objet trade final à partir d'une position fermée.
 * Partagé entre la sortie "normale" (en cours de boucle) et la clôture
 * forcée en fin de période, pour éviter la duplication.
 */
function buildTradeRecord(position, exitPrice, exitDate, exitIndex, tradeNumber, params) {
  const pnl = (exitPrice - position.entryPrice) * position.quantity;
  const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
  const days = durationDays(position.entryDate, exitDate);

  return {
    n: tradeNumber,
    sym: position.symbol,
    type: 'LONG',
    entry: position.entryPrice.toFixed(2),
    exit: exitPrice.toFixed(2),
    pnl: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
    pnlRaw: pnl,
    rr: `1:${Math.abs(pnlPct / params.stopLossPct).toFixed(1)}`,
    isW: pnl >= 0,
    dur: formatDurationDays(days),
    durDays: days, // FIX: valeur numérique en jours, utilisée pour la moyenne (avgHold) — le champ `dur` ci-dessus n'est qu'un libellé formaté ("3d"/"12h") et ne doit plus être parsé pour un calcul.
    entryDate: position.entryDate,
    exitDate,
    qc: params.quoteCurrency,
  };
}

/**
 * Lance la simulation. Générique : la logique d'entrée/sortie est
 * déléguée à la stratégie sélectionnée via params.strategyId.
 */
function runSimulation(candles, initialCapital = 100000, userParams = {}, symbol = 'N/A') {
  const params = { ...DEFAULT_PARAMS, ...userParams };
  const strategy = STRATEGIES[params.strategyId] || STRATEGIES.rsi_momentum;
  const maxPositions = Math.max(1, parseInt(params.maxPositions, 10) || 1);

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
  let positions = []; // FIX: tableau au lieu d'une position unique → maxPositions concurrentes

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

    // ── Sorties (on évalue chaque position ouverte indépendamment) ──
    if (positions.length > 0) {
      const stillOpen = [];
      for (const position of positions) {
        const exitDecision = strategy.shouldExit(ctx, position);
        if (exitDecision.exit) {
          cash += position.quantity * exitDecision.exitPrice;
          trades.push(buildTradeRecord(
            position, exitDecision.exitPrice, candles[i].date, i, trades.length + 1, params
          ));
        } else {
          stillOpen.push(position);
        }
      }
      positions = stillOpen;
    }

    // ── Entrée (uniquement si on a encore de la marge sous maxPositions) ──
    if (positions.length < maxPositions && strategy.shouldEnter(ctx)) {
      const allocation = Math.min(computePositionAllocation(cash, params, trades), cash);
      if (allocation > 0) {
        const quantity = allocation / price;
        cash -= quantity * price;
        positions.push({ symbol, entryPrice: price, entryIndex: i, quantity, entryDate: candles[i].date });
      }
    }

    // ── Courbes ──
    const positionValue = positions.reduce((sum, p) => sum + p.quantity * price, 0);
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

  // Clôture forcée de toute position encore ouverte à la fin de la période
  if (positions.length > 0) {
    const lastIndex = candles.length - 1;
    const lastPrice = closes[lastIndex];
    const lastDate = candles[lastIndex].date;

    for (const position of positions) {
      cash += position.quantity * lastPrice;
      trades.push(buildTradeRecord(
        position, lastPrice, lastDate, lastIndex, trades.length + 1, params
      ));
    }
    positions = [];
  }

  const finalEquity = equityCurve[equityCurve.length - 1] || initialCapital;
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

  const wins = trades.filter(t => t.isW);
  const losses = trades.filter(t => !t.isW);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlRaw, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlRaw, 0) / losses.length : 0;
  const avgRRRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
  // FIX: moyenne sur `durDays` (nombre de jours, float) au lieu de
  // `parseInt(t.dur)` — l'ancien code parsait un libellé du type "173c"
  // en assumant que "c" (bougies) était une unité commune à tous les
  // trades, ce qui n'est plus vrai depuis que `dur` peut être "3d" ou
  // "12h" selon le trade.
  const avgHoldDays = trades.length > 0
    ? trades.reduce((s, t) => s + t.durDays, 0) / trades.length : 0;

  const metrics = {
    totalReturn: `${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(1)}%`,
    sharpe: calculateSharpe(periodReturns).toFixed(2),
    maxDrawdown: `-${calculateMaxDrawdown(equityCurve).toFixed(1)}%`,
    winRate: `${winRate.toFixed(1)}%`,
    avgRR: `1:${avgRRRatio.toFixed(1)}`,
    totalTrades: String(trades.length),
    avgWin: `+${avgWin.toFixed(0)}`,
    avgLoss: `-${Math.abs(avgLoss).toFixed(0)}`,
    avgHold: formatDurationDays(avgHoldDays),
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
 * Réassigne les "#" de trades séquentiellement (1..N) sur la fenêtre
 * finale affichée. Nécessaire car chaque symbole a son propre compteur
 * local — sans ça, deux trades de symboles différents peuvent partager
 * le même "#" une fois combinés dans le Trade Log "Last 10 trades".
 */
function renumberTrades(trades) {
  return trades.map((t, idx) => ({ ...t, n: idx + 1 }));
}

/**
 * Combine plusieurs runSimulation() (multi-symbole) en un résultat
 * "portefeuille".
 */
async function aggregatePortfolio(perSymbolResults, initialCapitalTotal, targetCurrency, convertAmount, warningsSink) {  if (perSymbolResults.length === 1) {
    const r = perSymbolResults[0];
    return { metrics: r.metrics, charts: r.charts, trades: renumberTrades(r.trades.slice(-10)) };
  }

  const maxLen = Math.max(...perSymbolResults.map(r => r.charts.stratData.length));

  const padToLength = (arr, len) => {
    if (arr.length === 0) return new Array(len).fill(0);
    if (arr.length >= len) return arr;
    const last = arr[arr.length - 1];
    return [...arr, ...new Array(len - arr.length).fill(last)];
  };

    // FIX: normalisation cross-currency — chaque symbole peut avoir une
  // quoteCurrency différente (ex: SPY en USD, un forex en JPY). Sans ça,
  // sumSeries() additionnait des unités monétaires différentes comme si
  // c'était la même devise.
  const convertedResults = await Promise.all(
    perSymbolResults.map(async r => {
      const symCurrency = r.metrics.quoteCurrency;
      if (symCurrency === targetCurrency) return r;
        const rate = await convertAmount(1, symCurrency, targetCurrency, warningsSink).catch(() => 1);      return {
        ...r,
        charts: {
          ...r.charts,
          stratData: r.charts.stratData.map(v => v * rate),
          bhData: r.charts.bhData.map(v => v * rate),
        },
      };
    })
  );
  perSymbolResults = convertedResults;

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
  // FIX: idem runSimulation — moyenne sur `durDays`, pas sur un `parseInt(dur)`
  // à unité mixte (certains trades peuvent être en 4H, d'autres retombés en
  // Daily via le fallback par-symbole de backtestMarketRouter.service.js).
  const avgHoldDays = allTrades.length > 0
    ? allTrades.reduce((s, t) => s + t.durDays, 0) / allTrades.length : 0;

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
      avgHold: formatDurationDays(avgHoldDays),
      quoteCurrency: targetCurrency,
      strategyId: perSymbolResults[0].metrics.strategyId,
      strategyLabel: perSymbolResults[0].metrics.strategyLabel,
    },
    charts: { stratData, bhData, ddData, annualReturns },
    trades: renumberTrades(allTrades.slice(-10)),
  };
}

module.exports = { runSimulation, aggregatePortfolio, DEFAULT_PARAMS };