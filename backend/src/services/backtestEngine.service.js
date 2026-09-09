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
 *
 * FIX (audit currency mixing — avgWin/avgLoss) :
 *   `t.pnlRaw` de chaque trade reste dans la devise native de SON
 *   symbole (JPY pour un forex, USD pour une action...). L'agrégation
 *   portfolio sommait ces montants bruts tels quels entre symboles de
 *   devises différentes puis affichait le résultat sous l'étiquette
 *   `$` de `targetCurrency` — un P&L moyen en JPY (grandeur ~10 000-
 *   50 000) écrasait un P&L moyen en USD (grandeur ~100-500). Chaque
 *   `pnlRaw` est maintenant converti vers `targetCurrency` via le rate
 *   de son symbole (`rateBySymbol`) avant la moyenne. Le Trade Log
 *   affiché à l'utilisateur (trade.pnl / trade.qc) n'est PAS touché —
 *   il continue d'afficher chaque trade dans sa devise native, ce qui
 *   est correct.
 *
 * FIX (audit alignement temporel — sumSeries) :
 *   `sumSeries` sommait `charts.stratData[i]` de chaque symbole en
 *   assumant que l'index `i` correspond à la MÊME date pour tous les
 *   symboles. C'est faux dès que deux symboles n'ont pas exactement le
 *   même calendrier — timeframe différent après fallback par-symbole
 *   (`needsDailyFallback` dépend de la date de début demandée, pas de
 *   l'asset class : un symbole peut rester en 4H pendant qu'un autre
 *   retombe en Daily dans le MÊME backtest), jours de bourse différents
 *   (NYSE fermé le week-end vs crypto 24/7), ou simplement des séries
 *   de longueurs différentes pour d'autres raisons. L'ancien
 *   `padToLength` répétait juste la dernière valeur par index, ce qui
 *   alignait silencieusement des points de dates complètement
 *   différentes (equity curve, drawdown, annual returns et total
 *   return faussés sans aucun avertissement).
 *
 *   Chaque série est maintenant alignée sur l'UNION triée des dates
 *   réelles (`equityDates`) de tous les symboles, avec un forward-fill
 *   explicite : à une date donnée, la valeur d'un symbole est sa
 *   dernière valeur connue à cette date ou avant. Avant sa toute
 *   première date (le symbole n'a pas encore commencé à trader — ex.
 *   `minCandles` plus tardif après fallback), on utilise son capital
 *   assigné (converti dans `targetCurrency`) plutôt que 0, pour ne pas
 *   créer un faux creux dans l'equity curve du portefeuille.
 *   `annualReturns` utilise maintenant cette même union de dates
 *   (`mergedDates`) au lieu des dates du symbole le plus long
 *   (`longest.equityDates`), qui n'était qu'une approximation.
 *
 * FIX (audit direction — SHORT manquant) :
 *   `buildTradeRecord` posait `type: 'LONG'` en dur, sans aucune
 *   condition — aucune position SHORT n'était jamais ouverte, quelle
 *   que soit la stratégie ou les conditions de marché (le frontend a
 *   pourtant un style dédié pour `tr.type === 'SHORT'` dans le Trade
 *   Log, jamais atteint). Chaque position porte maintenant un
 *   `direction: 'LONG' | 'SHORT'`, choisi via `strategy.shouldEnter` /
 *   `strategy.shouldEnterShort` (si la stratégie l'expose — sinon
 *   comportement inchangé, LONG uniquement). Le sens du cash-flow,
 *   de la valorisation de position (equity), du P&L et du stop loss
 *   sont inversés pour un SHORT :
 *     - Entrée LONG  : cash -= qty*prix (achat) ; entrée SHORT : cash += qty*prix (vente à découvert)
 *     - Valorisation : +qty*prix pour un LONG ouvert, -qty*prix pour un SHORT ouvert
 *     - Sortie LONG  : cash += qty*prix (vente) ; sortie SHORT : cash -= qty*prix (rachat)
 *     - P&L LONG = (exit-entry)*qty ; P&L SHORT = (entry-exit)*qty
 *     - Stop loss LONG : prix qui baisse de stopLossPct% ; SHORT : prix qui monte de stopLossPct%
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

/**
 * Déduit periodsPerYear directement des dates réelles des candles
 * (médiane de l'écart entre dates consécutives), au lieu d'une valeur
 * fixe (252) ou d'une table de correspondance timeframe/assetClass —
 * fonctionne correctement quel que soit le timeframe (Daily/4H/1H/15M)
 * et quel que soit l'asset (crypto 24/7, equity avec weekends fermés,
 * forex...), puisque le calcul part de l'espacement RÉEL des données,
 * pas d'une hypothèse codée en dur.
 */
function inferPeriodsPerYear(dates) {
  if (!dates || dates.length < 2) return 252; // fallback minimal, données insuffisantes pour inférer
  const gaps = [];
  for (let i = 1; i < dates.length; i++) {
    const gap = new Date(dates[i]).getTime() - new Date(dates[i - 1]).getTime();
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 252;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const medianGapMs = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  return medianGapMs > 0 ? msPerYear / medianGapMs : 252;
}

function calculateSharpe(returns, periodsPerYear) {
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
 *
 * FIX (audit direction — SHORT) : pnl/pnlPct sont maintenant calculés
 * selon `position.direction` — un SHORT gagne quand exitPrice < entryPrice,
 * l'inverse d'un LONG. `type` reflète la direction réelle de la position
 * au lieu d'être toujours 'LONG'.
 */
function buildTradeRecord(position, exitPrice, exitDate, exitIndex, tradeNumber, params) {
  const isShort = position.direction === 'SHORT';
  const pnl = isShort
    ? (position.entryPrice - exitPrice) * position.quantity
    : (exitPrice - position.entryPrice) * position.quantity;
  const pnlPct = isShort
    ? ((position.entryPrice - exitPrice) / position.entryPrice) * 100
    : ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
  const days = durationDays(position.entryDate, exitDate);

  return {
    n: tradeNumber,
    sym: position.symbol,
    type: position.direction,
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
    // FIX (audit direction — SHORT) : la fonction de sortie appelée
    // dépend de la direction de la position (shouldExit pour un LONG,
    // shouldExitShort pour un SHORT). Rachat (cash -= qty*prix) au lieu
    // de vente (cash += qty*prix) pour clôturer un SHORT.
    if (positions.length > 0) {
      const stillOpen = [];
      for (const position of positions) {
        const isShort = position.direction === 'SHORT';
        const exitDecision = isShort
          ? (strategy.shouldExitShort ? strategy.shouldExitShort(ctx, position) : { exit: false })
          : strategy.shouldExit(ctx, position);
        if (exitDecision.exit) {
          if (isShort) {
            cash -= position.quantity * exitDecision.exitPrice; // rachat pour clôturer le short
          } else {
            cash += position.quantity * exitDecision.exitPrice; // vente pour clôturer le long
          }
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
    // FIX (audit direction — SHORT) : on tente d'abord une entrée LONG,
    // puis — seulement si aucune entrée LONG n'a eu lieu ce candle et si
    // la stratégie expose shouldEnterShort — une entrée SHORT. Vente à
    // découvert (cash += qty*prix, on reçoit le produit de la vente) au
    // lieu d'achat (cash -= qty*prix) pour ouvrir un SHORT.
    if (positions.length < maxPositions) {
      if (strategy.shouldEnter(ctx)) {
        const allocation = Math.min(computePositionAllocation(cash, params, trades), cash);
        if (allocation > 0) {
          const quantity = allocation / price;
          cash -= quantity * price;
          positions.push({ symbol, direction: 'LONG', entryPrice: price, entryIndex: i, quantity, entryDate: candles[i].date });
        }
      } else if (strategy.shouldEnterShort && strategy.shouldEnterShort(ctx)) {
        const allocation = Math.min(computePositionAllocation(cash, params, trades), cash);
        if (allocation > 0) {
          const quantity = allocation / price;
          cash += quantity * price;
          positions.push({ symbol, direction: 'SHORT', entryPrice: price, entryIndex: i, quantity, entryDate: candles[i].date });
        }
      }
    }

    // ── Courbes ──
    // FIX (audit direction — SHORT) : la valorisation d'une position
    // ouverte est +qty*prix pour un LONG (actif détenu) mais -qty*prix
    // pour un SHORT (passif à racheter, marked-to-market).
    const positionValue = positions.reduce(
      (sum, p) => sum + (p.direction === 'SHORT' ? -1 : 1) * p.quantity * price,
      0
    );
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
  // FIX (audit direction — SHORT) : rachat (cash -=) pour un SHORT
  // encore ouvert, vente (cash +=) pour un LONG — même logique que la
  // sortie normale ci-dessus.
  if (positions.length > 0) {
    const lastIndex = candles.length - 1;
    const lastPrice = closes[lastIndex];
    const lastDate = candles[lastIndex].date;

    for (const position of positions) {
      if (position.direction === 'SHORT') {
        cash -= position.quantity * lastPrice;
      } else {
        cash += position.quantity * lastPrice;
      }
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
    sharpe: calculateSharpe(periodReturns, inferPeriodsPerYear(equityDates)).toFixed(2),
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
async function aggregatePortfolio(perSymbolResults, initialCapitalTotal, targetCurrency, convertAmount, warningsSink) {
  if (perSymbolResults.length === 1) {
    const r = perSymbolResults[0];
    return { metrics: r.metrics, charts: r.charts, trades: renumberTrades(r.trades.slice(-10)) };
  }

  // FIX (currency mixing — avgWin/avgLoss) : mapping symbole → rate
  // (quoteCurrency du symbole → targetCurrency), réutilisé plus bas pour
  // convertir chaque trade.pnlRaw avant l'agrégation, et pour convertir
  // le capital assigné à un symbole avant qu'il ait commencé à trader
  // (voir alignToMergedDates ci-dessous).
  const rateBySymbol = new Map();

  const convertedResults = await Promise.all(
    perSymbolResults.map(async r => {
      const symCurrency = r.metrics.quoteCurrency;
      const rate = symCurrency === targetCurrency
        ? 1
        : await convertAmount(1, symCurrency, targetCurrency, warningsSink).catch(() => 1);
      rateBySymbol.set(r.symbol, rate);
      if (symCurrency === targetCurrency) return r;
      return {
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

  // FIX (alignement temporel) : union triée des dates réelles de tous
  // les symboles — voir commentaire détaillé en tête de fichier.
  const allTimestamps = new Set();
  for (const r of perSymbolResults) {
    for (const d of r.equityDates || []) allTimestamps.add(new Date(d).getTime());
  }
  const mergedTimestamps = [...allTimestamps].sort((a, b) => a - b);
  const mergedDates = mergedTimestamps.map(t => new Date(t).toISOString());

  /**
   * Aligne charts[key] d'UN symbole sur `mergedTimestamps` par
   * forward-fill : pour chaque date fusionnée, prend la dernière valeur
   * connue du symbole à cette date ou avant. Avant sa toute première
   * date, utilise son capital assigné (déjà converti dans
   * targetCurrency) plutôt que 0.
   */
  const alignToMergedDates = (r, key) => {
    const symTimestamps = (r.equityDates || []).map(d => new Date(d).getTime());
    const values = r.charts[key];
    const rate = rateBySymbol.get(r.symbol) ?? 1;
    const beforeStart = (r.initialCapitalUsed || 0) * rate;

    const out = new Array(mergedTimestamps.length);
    let ptr = 0;
    let lastVal = beforeStart;
    for (let i = 0; i < mergedTimestamps.length; i++) {
      const t = mergedTimestamps[i];
      while (ptr < symTimestamps.length && symTimestamps[ptr] <= t) {
        lastVal = values[ptr];
        ptr++;
      }
      out[i] = lastVal;
    }
    return out;
  };

  const sumSeries = key => {
    const series = new Array(mergedTimestamps.length).fill(0);
    for (const r of perSymbolResults) {
      const aligned = alignToMergedDates(r, key);
      for (let i = 0; i < series.length; i++) series[i] += aligned[i];
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

  // FIX : utilise l'union réelle des dates (mergedDates) au lieu des
  // dates du symbole le plus long (longest.equityDates), qui n'était
  // qu'une approximation pouvant décaler le regroupement par année.
  const annualReturns = calculateAnnualReturns(stratData, mergedDates, initialCapitalTotal);

  const allTrades = perSymbolResults
    .flatMap(r => r.trades)
    .sort((a, b) => new Date(a.exitDate) - new Date(b.exitDate));

  const wins = allTrades.filter(t => t.isW);
  const losses = allTrades.filter(t => !t.isW);
  const winRate = allTrades.length > 0 ? (wins.length / allTrades.length) * 100 : 0;
  // FIX : pnlRaw de chaque trade converti vers targetCurrency via le
  // rate de SON symbole (rateBySymbol) avant la moyenne — voir
  // commentaire sur rateBySymbol ci-dessus. `t.pnlRaw`/`t.pnl`/`t.qc`
  // du trade lui-même restent inchangés (utilisés tels quels par le
  // Trade Log, qui affiche à raison chaque trade dans sa propre devise).
  const convertedPnl = t => t.pnlRaw * (rateBySymbol.get(t.sym) ?? 1);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + convertedPnl(t), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + convertedPnl(t), 0) / losses.length : 0;
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

  return {
    metrics: {
      totalReturn: `${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(1)}%`,
      sharpe: calculateSharpe(periodReturns, inferPeriodsPerYear(mergedDates)).toFixed(2),
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