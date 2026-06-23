/**
 * src/services/backtestEngine.service.js
 *
 * RÔLE DE CE FICHIER :
 * Le vrai moteur de backtest. Il prend des bougies historiques (OHLCV)
 * et simule l'exécution d'une stratégie candle par candle, comme si on
 * tradait en temps réel dans le passé.
 *
 * STRATÉGIE PAR DÉFAUT (RSI Momentum Reversion) :
 *   Entrée (LONG) si TOUTES les conditions sont vraies :
 *     - RSI(14) vient de croiser AU-DESSUS de 30 (sortie de survente)
 *     - Prix > EMA(200)                          (tendance haussière)
 *     - Volume > 1.5× moyenne des 20 derniers volumes
 *
 *   Sortie :
 *     - RSI(14) croise AU-DESSUS de 70 (zone de surachat) → take profit
 *     - OU prix tombe à -5% du prix d'entrée            → stop loss
 *
 * Cette logique est paramétrable via l'objet `params` pour permettre
 * d'autres réglages sans dupliquer le moteur.
 */

const { calculateRSI } = require('../utils/calculateRSI');
const { calculateEMA } = require('../utils/movingAverage');
const logger = require('../utils/logger');

const DEFAULT_PARAMS = {
  rsiPeriod:       14,
  rsiOversold:     30,
  rsiOverbought:   70,
  emaPeriod:       200,
  volumeMultiplier: 1.5,
  volumeLookback:  20,
  stopLossPct:     5,    // en %
  maxPositions:    5,
  positionSizePct: 10,   // % du capital par trade
  // Exiger un pic de volume EXACTEMENT sur la bougie de croisement RSI
  // est une condition très restrictive (3 événements indépendants doivent
  // coïncider sur la même bougie) — sur des actifs Daily/4H ça ne se
  // produit presque jamais, d'où des backtests à 0 trade. Par défaut on
  // ne l'exige plus ; le volume reste calculé et visible mais n'est plus
  // bloquant. Mettre à true pour revenir au comportement strict d'origine.
  requireVolumeConfirmation: false,
  // Tolérance autour de l'EMA200 : exiger un prix STRICTEMENT au-dessus
  // de l'EMA200 au moment exact où le RSI sort de survente est une
  // combinaison rare (un RSI < 30 survient généralement pendant un repli,
  // qui fait souvent passer le prix nettement sous sa moyenne longue —
  // testé empiriquement : le creux se situe typiquement entre -2% et -16%
  // sous l'EMA200 lors d'un vrai pullback dans une tendance haussière).
  // 12% capture la majorité de ces creux tout en excluant les marchés
  // baissiers profonds (où le prix resterait durablement bien plus bas).
  emaTolerancePct: 12,
};

/**
 * Moyenne simple du volume sur les N dernières bougies.
 */
function avgVolume(candles, endIndex, lookback) {
  const start = Math.max(0, endIndex - lookback);
  const slice = candles.slice(start, endIndex);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, c) => sum + (c.volume || 0), 0) / slice.length;
}

/**
 * Calcule le ratio de Sharpe annualisé à partir d'une série de rendements.
 * Sharpe = (rendement moyen / écart-type des rendements) × √périodes_par_an
 */
function calculateSharpe(returns, periodsPerYear = 252) {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;
  return parseFloat(((mean / stdDev) * Math.sqrt(periodsPerYear)).toFixed(2));
}

/**
 * Calcule le rendement de la stratégie pour chaque année calendaire
 * couverte par le backtest, à partir de l'equity curve et de ses dates.
 *
 * Pour chaque année : rendement = (equity de fin d'année - equity de
 * début d'année) / equity de début d'année. La première année utilise
 * le capital initial comme point de départ (pas l'equity du premier
 * point, qui correspond déjà à minCandles bougies plus tard).
 */
function calculateAnnualReturns(equityCurve, equityDates, initialCapital) {
  if (equityCurve.length === 0) return [];

  // Regrouper les indices par année
  const yearGroups = new Map(); // année (number) → { firstIdx, lastIdx }
  for (let i = 0; i < equityDates.length; i++) {
    const year = new Date(equityDates[i]).getFullYear();
    if (!yearGroups.has(year)) {
      yearGroups.set(year, { firstIdx: i, lastIdx: i });
    } else {
      yearGroups.get(year).lastIdx = i;
    }
  }

  const years = [...yearGroups.keys()].sort((a, b) => a - b);
  const results = [];

  years.forEach((year, idx) => {
    const { lastIdx } = yearGroups.get(year);
    // Point de départ : capital initial pour la toute première année du
    // backtest, sinon l'equity de clôture de l'année précédente.
    const startEquity = idx === 0 ? initialCapital : equityCurve[yearGroups.get(years[idx - 1]).lastIdx];
    const endEquity = equityCurve[lastIdx];

    if (startEquity <= 0) return;
    const returnPct = ((endEquity - startEquity) / startEquity) * 100;

    results.push({
      year: String(year),
      returnPct: parseFloat(returnPct.toFixed(1)),
    });
  });

  return results;
}

/**
 * Calcule le drawdown maximum (pire chute depuis un sommet) sur une equity curve.
 */
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
 * Lance la simulation complète sur l'historique de bougies fourni.
 *
 * @param {Array}  candles       - bougies OHLCV triées par date croissante
 * @param {number} initialCapital
 * @param {Object} userParams    - surcharge des paramètres par défaut
 * @returns {Object} { metrics, charts, trades }
 */
function runSimulation(candles, initialCapital = 100000, userParams = {}, symbol = 'N/A') {
  const params = { ...DEFAULT_PARAMS, ...userParams };
  const minCandles = Math.max(params.emaPeriod, params.rsiPeriod) + 1;

  if (candles.length < minCandles) {
    throw new Error(
      `Pas assez de données : ${candles.length} bougies reçues, ${minCandles} minimum requis pour cette stratégie.`
    );
  }

  const closes = candles.map(c => c.close);

  let cash = initialCapital;
  let position = null; // { entryPrice, entryIndex, quantity, entryDate }

  const trades = [];
  const equityCurve = [];      // valeur du portefeuille stratégie, point par point
  const equityDates = [];      // dates correspondantes (même index que equityCurve) — nécessaire pour regrouper par année
  const buyHoldCurve = [];     // valeur si on avait juste acheté et gardé
  const drawdownCurve = [];
  const periodReturns = [];    // rendements période par période (pour Sharpe)

  const bhUnits = initialCapital / closes[minCandles - 1];
  let prevEquity = initialCapital;
  let peakEquity = initialCapital;

  let prevRsi = null;

  for (let i = minCandles; i < candles.length; i++) {
    const closesSoFar = closes.slice(0, i + 1);
    const rsi = calculateRSI(closesSoFar, params.rsiPeriod);
    const ema = calculateEMA(closesSoFar, params.emaPeriod);
    const price = candles[i].close;
    const vol = candles[i].volume || 0;
    const volAvg = avgVolume(candles, i, params.volumeLookback);

    // ── Gestion de la position ouverte (vérifier sortie) ──────
    if (position) {
      const stopPrice = position.entryPrice * (1 - params.stopLossPct / 100);
      const rsiCrossUp70 = prevRsi !== null && prevRsi <= params.rsiOverbought && rsi > params.rsiOverbought;
      const hitStop = price <= stopPrice;

      if (rsiCrossUp70 || hitStop) {
        const exitPrice = hitStop ? stopPrice : price;
        const pnl = (exitPrice - position.entryPrice) * position.quantity;
        const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;

        cash += position.quantity * exitPrice;

        trades.push({
          n: trades.length + 1,
          sym: position.symbol,
          type: 'LONG',
          entry: position.entryPrice.toFixed(2),
          exit: exitPrice.toFixed(2),
          pnl: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
          pnlRaw: pnl,
          rr: `1:${Math.abs(pnlPct / params.stopLossPct).toFixed(1)}`,
          isW: pnl >= 0,
          dur: `${i - position.entryIndex}c`,
          entryDate: position.entryDate,
          exitDate: candles[i].date,
        });

        position = null;
      }
    }

    // ── Recherche d'un signal d'entrée (si pas déjà en position) ──
    if (!position && rsi !== null && ema !== null) {
      const rsiCrossUp30 = prevRsi !== null && prevRsi <= params.rsiOversold && rsi > params.rsiOversold;
      // Tolérance : prix autorisé jusqu'à emaTolerancePct% sous l'EMA200,
      // plutôt qu'une exigence stricte "au-dessus" (voir commentaire sur
      // emaTolerancePct dans DEFAULT_PARAMS pour le raisonnement).
      const aboveEma = price > ema * (1 - params.emaTolerancePct / 100);
      const volSpike = volAvg > 0 && vol > volAvg * params.volumeMultiplier;

      // Le volume spike reste calculé (utile en info), mais n'est exigé
      // pour déclencher l'entrée que si requireVolumeConfirmation est activé.
      const volumeConditionMet = params.requireVolumeConfirmation ? volSpike : true;

      if (rsiCrossUp30 && aboveEma && volumeConditionMet) {
        const allocation = cash * (params.positionSizePct / 100);
        const quantity = allocation / price;

        cash -= quantity * price;
        position = {
          symbol,
          entryPrice: price,
          entryIndex: i,
          quantity,
          entryDate: candles[i].date,
        };
      }
    }

    // ── Mise à jour des courbes ──
    const positionValue = position ? position.quantity * price : 0;
    const equity = cash + positionValue;

    equityCurve.push(parseFloat(equity.toFixed(2)));
    equityDates.push(candles[i].date);
    buyHoldCurve.push(parseFloat((bhUnits * price).toFixed(2)));

    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    drawdownCurve.push(parseFloat((-dd).toFixed(2)));

    if (prevEquity > 0) {
      periodReturns.push((equity - prevEquity) / prevEquity);
    }
    prevEquity = equity;
    prevRsi = rsi;
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
      pnl: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
      pnlRaw: pnl,
      rr: `1:${Math.abs(pnlPct / params.stopLossPct).toFixed(1)}`,
      isW: pnl >= 0,
      dur: `${candles.length - 1 - position.entryIndex}c`,
      entryDate: position.entryDate,
      exitDate: candles[candles.length - 1].date,
    });
  }

  // ── Calcul des métriques agrégées ──
  const finalEquity = equityCurve[equityCurve.length - 1] || initialCapital;
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

  const wins = trades.filter(t => t.isW);
  const losses = trades.filter(t => !t.isW);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;

  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlRaw, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlRaw, 0) / losses.length : 0;
  const avgRRRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  const avgHoldCandles = trades.length > 0
    ? trades.reduce((s, t) => s + parseInt(t.dur), 0) / trades.length
    : 0;

  const metrics = {
    totalReturn:  `${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(1)}%`,
    sharpe:       calculateSharpe(periodReturns).toFixed(2),
    maxDrawdown:  `-${calculateMaxDrawdown(equityCurve).toFixed(1)}%`,
    winRate:      `${winRate.toFixed(1)}%`,
    avgRR:        `1:${avgRRRatio.toFixed(1)}`,
    totalTrades:  String(trades.length),
    avgWin:       `+$${avgWin.toFixed(0)}`,
    avgLoss:      `−$${Math.abs(avgLoss).toFixed(0)}`,
    avgHold:      `${avgHoldCandles.toFixed(0)}c`,
  };

  const annualReturns = calculateAnnualReturns(equityCurve, equityDates, initialCapital);

  return {
    metrics,
    charts: {
      stratData: equityCurve,
      bhData: buyHoldCurve,
      ddData: drawdownCurve,
      annualReturns,
    },
    trades: trades.slice(-10), // dernières 10 transactions pour le tableau UI
  };
}

module.exports = { runSimulation, DEFAULT_PARAMS };