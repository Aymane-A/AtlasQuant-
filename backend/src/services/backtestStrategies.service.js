/**
 * src/services/backtestStrategies.service.js
 *
 * REGISTRY DES STRATÉGIES DE BACKTEST
 *
 * Chaque stratégie expose une interface commune utilisée par
 * backtestEngine.service.js#runSimulation (générique, agnostique de
 * la stratégie) :
 *
 *   - minCandles(params)         → nb de bougies minimum avant de pouvoir trader
 *   - prepare(candles, params)   → précalcul optionnel (séries d'indicateurs)
 *   - initState()                → état interne optionnel (ex: valeur précédente
 *                                   d'un indicateur, pour détecter un croisement)
 *   - onCandle(ctx)               → hook appelé une fois par bougie AVANT
 *                                   shouldEnter/shouldExit (met à jour `state`)
 *   - shouldEnter(ctx)            → bool
 *   - shouldExit(ctx, position)   → { exit: bool, exitPrice?: number }
 *
 * `ctx` = { i, candles, closes, precomputed, params, state }
 *
 * Pour ajouter une nouvelle stratégie : dupliquer un des deux blocs
 * ci-dessous, l'ajouter à STRATEGIES, et l'ajouter aussi côté frontend
 * dans Backtester.jsx (STRATEGY_OPTIONS) — pas d'endpoint dynamique pour
 * l'instant, la liste est dupliquée frontend/backend par simplicité tant
 * qu'il n'y a que 2-3 stratégies.
 */

const { calculateRSI } = require('../utils/calculateRSI');
const { calculateEMA } = require('../utils/movingAverage');

// ── Helpers génériques ──────────────────────────────────────────────

function avgVolume(candles, endIndex, lookback) {
  const start = Math.max(0, endIndex - lookback);
  const slice = candles.slice(start, endIndex);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, c) => sum + (c.volume || 0), 0) / slice.length;
}

/**
 * EMA calculée sur toute la série en une passe (O(n)), contrairement à
 * calculateEMA (utils/movingAverage.js) qui ne renvoie que la dernière
 * valeur pour une sous-série donnée. Utilisée par les stratégies qui ont
 * besoin de l'historique complet de l'indicateur (ex: MACD, dont la ligne
 * signal est elle-même une EMA de la ligne MACD).
 */
function computeEMASeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;

  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// ── STRATÉGIE 1 : RSI Momentum Reversion (comportement inchangé) ────
// Entrée : RSI(14) sort de survente + prix > EMA(200) (avec tolérance)
// Sortie : RSI(14) entre en surachat, OU stop loss -5%

const rsiMomentumStrategy = {
  id: 'rsi_momentum',
  label: 'RSI Momentum Reversion',
  entryRules: [
    { dot: 'green', text: 'RSI(14) crosses above 30' },
    { dot: 'green', text: 'Price above EMA(200)' },
    { dot: 'green', text: 'Volume > 1.5× 20-day avg' },
  ],
  exitRules: [
    { dot: 'red', text: 'RSI(14) crosses above 70' },
    { dot: 'red', text: 'Stop loss: −5% from entry' },
  ],

  minCandles: (params) => Math.max(params.emaPeriod, params.rsiPeriod) + 1,

  initState: () => ({ rsi: null, prevRsi: null, ema: null, volAvg: 0 }),

  onCandle(ctx) {
    const { i, closes, candles, params, state } = ctx;
    const closesSoFar = closes.slice(0, i + 1);
    state.prevRsi = state.rsi;
    state.rsi = calculateRSI(closesSoFar, params.rsiPeriod);
    state.ema = calculateEMA(closesSoFar, params.emaPeriod);
    state.volAvg = avgVolume(candles, i, params.volumeLookback);
  },

  shouldEnter(ctx) {
    const { i, candles, params, state } = ctx;
    if (state.rsi == null || state.ema == null) return false;

    const price = candles[i].close;
    const vol = candles[i].volume || 0;

    const rsiCrossUp30 = state.prevRsi !== null && state.prevRsi <= params.rsiOversold && state.rsi > params.rsiOversold;
    const aboveEma = price > state.ema * (1 - params.emaTolerancePct / 100);
    const volSpike = state.volAvg > 0 && vol > state.volAvg * params.volumeMultiplier;
    const volumeOk = params.requireVolumeConfirmation ? volSpike : true;

    return rsiCrossUp30 && aboveEma && volumeOk;
  },

  shouldExit(ctx, position) {
    const { i, candles, params, state } = ctx;
    const price = candles[i].close;
    const stopPrice = position.entryPrice * (1 - params.stopLossPct / 100);
    const rsiCrossUp70 = state.prevRsi !== null && state.prevRsi <= params.rsiOverbought && state.rsi > params.rsiOverbought;
    const hitStop = price <= stopPrice;

    if (rsiCrossUp70 || hitStop) {
      return { exit: true, exitPrice: hitStop ? stopPrice : price };
    }
    return { exit: false };
  },
};

// ── STRATÉGIE 2 : MACD Crossover (nouvelle) ──────────────────────────
// Entrée : MACD(12,26) croise au-dessus de sa ligne signal(9) + prix > EMA(200)
// Sortie : MACD croise en-dessous de sa ligne signal, OU stop loss -5%

const macdCrossoverStrategy = {
  id: 'macd_crossover',
  label: 'MACD Crossover',
  entryRules: [
    { dot: 'green', text: 'MACD(12,26) crosses above Signal(9)' },
    { dot: 'green', text: 'Price above EMA(200)' },
  ],
  exitRules: [
    { dot: 'red', text: 'MACD(12,26) crosses below Signal(9)' },
    { dot: 'red', text: 'Stop loss: −5% from entry' },
  ],

  minCandles: (params) => Math.max(params.emaPeriod, params.macdSlow + params.macdSignal) + 5,

  prepare(candles, params) {
    const closes = candles.map(c => c.close);
    const emaFast = computeEMASeries(closes, params.macdFast);
    const emaSlow = computeEMASeries(closes, params.macdSlow);

    const macdLine = closes.map((_, i) =>
      emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
    );

    // La ligne signal (EMA9 de la ligne MACD) ne peut se calculer que sur
    // la portion où macdLine est définie — on l'extrait, on calcule dessus,
    // puis on la remappe à la longueur d'origine (nulls en tête).
    const firstValidIdx = macdLine.findIndex(v => v !== null);
    const macdValidSeries = macdLine.slice(firstValidIdx);
    const signalValidSeries = computeEMASeries(macdValidSeries, params.macdSignal);

    const signalLine = new Array(candles.length).fill(null);
    for (let i = 0; i < signalValidSeries.length; i++) {
      signalLine[firstValidIdx + i] = signalValidSeries[i];
    }

    const emaTrend = computeEMASeries(closes, params.emaPeriod);

    return { macdLine, signalLine, emaTrend };
  },

  shouldEnter(ctx) {
    const { i, candles, precomputed, params } = ctx;
    const macd = precomputed.macdLine[i], prevMacd = precomputed.macdLine[i - 1];
    const signal = precomputed.signalLine[i], prevSignal = precomputed.signalLine[i - 1];
    const trendEma = precomputed.emaTrend[i];

    if (macd == null || signal == null || prevMacd == null || prevSignal == null || trendEma == null) return false;

    const bullishCross = prevMacd <= prevSignal && macd > signal;
    const price = candles[i].close;
    const aboveTrend = price > trendEma * (1 - params.emaTolerancePct / 100);

    return bullishCross && aboveTrend;
  },

  shouldExit(ctx, position) {
    const { i, candles, precomputed, params } = ctx;
    const price = candles[i].close;
    const stopPrice = position.entryPrice * (1 - params.stopLossPct / 100);

    const macd = precomputed.macdLine[i], prevMacd = precomputed.macdLine[i - 1];
    const signal = precomputed.signalLine[i], prevSignal = precomputed.signalLine[i - 1];
    const bearishCross = macd != null && signal != null && prevMacd != null && prevSignal != null &&
      prevMacd >= prevSignal && macd < signal;
    const hitStop = price <= stopPrice;

    if (bearishCross || hitStop) {
      return { exit: true, exitPrice: hitStop ? stopPrice : price };
    }
    return { exit: false };
  },
};

// ── Registry ──────────────────────────────────────────────────────

const STRATEGIES = {
  [rsiMomentumStrategy.id]: rsiMomentumStrategy,
  [macdCrossoverStrategy.id]: macdCrossoverStrategy,
};

function listStrategies() {
  return Object.values(STRATEGIES).map(s => ({
    id: s.id, label: s.label, entryRules: s.entryRules, exitRules: s.exitRules,
  }));
}

module.exports = { STRATEGIES, listStrategies };