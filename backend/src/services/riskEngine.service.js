/**
 * src/services/riskEngine.service.js
 *
 * RÔLE DE CE FICHIER :
 * Calculs statistiques de risque de portefeuille, à partir de positions
 * réelles (table `trades`, status='open') et de données de prix
 * historiques récupérées via backtestMarketRouter.service.js.
 *
 * MÉTRIQUES CALCULÉES :
 *   - Daily returns (rendements journaliers) par position
 *   - Volatilité annualisée
 *   - Beta (sensibilité au marché, benchmark = SPY)
 *   - VaR historique 95% (Value at Risk)
 *   - CVaR / Expected Shortfall (perte moyenne au-delà du VaR)
 *   - Matrice de corrélation entre positions
 *   - Stress tests (impact estimé de scénarios historiques)
 *   - Répartition sectorielle
 */

const logger = require('../utils/logger');
const { fetchCandlesForBacktest } = require('./backtestMarketRouter.service');

const BENCHMARK_SYMBOL = 'SPY';
const TRADING_DAYS_PER_YEAR = 252;
const VAR_CONFIDENCE = 0.95; // VaR à 95% — standard dans l'industrie

// ── Classification sectorielle (mapping manuel) ─────────────────
// Couvre les symboles les plus courants. Tout symbole absent
// tombe dans "Other" plutôt que de faire planter le calcul.
const SECTOR_MAP = {
  // Technology
  AAPL: 'Technology', MSFT: 'Technology', NVDA: 'Technology', GOOGL: 'Technology',
  GOOG: 'Technology', META: 'Technology', AVGO: 'Technology', ORCL: 'Technology',
  CRM: 'Technology', ADBE: 'Technology', AMD: 'Technology', INTC: 'Technology',
  CSCO: 'Technology', IBM: 'Technology', QCOM: 'Technology', TXN: 'Technology',
  NOW: 'Technology', INTU: 'Technology', AMAT: 'Technology', MU: 'Technology',

  // Consumer (discretionary + staples)
  AMZN: 'Consumer', TSLA: 'Consumer', HD: 'Consumer', MCD: 'Consumer',
  NKE: 'Consumer', SBUX: 'Consumer', WMT: 'Consumer', COST: 'Consumer',
  PG: 'Consumer', KO: 'Consumer', PEP: 'Consumer', DIS: 'Consumer',

  // Financials
  JPM: 'Financials', BAC: 'Financials', WFC: 'Financials', GS: 'Financials',
  MS: 'Financials', V: 'Financials', MA: 'Financials', AXP: 'Financials',
  BLK: 'Financials', SCHW: 'Financials', C: 'Financials',

  // Healthcare
  UNH: 'Healthcare', JNJ: 'Healthcare', LLY: 'Healthcare', PFE: 'Healthcare',
  ABBV: 'Healthcare', MRK: 'Healthcare', TMO: 'Healthcare', ABT: 'Healthcare',
  DHR: 'Healthcare', BMY: 'Healthcare',

  // Energy
  XOM: 'Energy', CVX: 'Energy', COP: 'Energy', SLB: 'Energy', EOG: 'Energy',

  // Crypto (traité comme sa propre classe d'actifs, pas "Other")
  'BTC/USDT': 'Crypto', 'ETH/USDT': 'Crypto', 'SOL/USDT': 'Crypto',
  BTCUSDT: 'Crypto', ETHUSDT: 'Crypto', SOLUSDT: 'Crypto',

  // ETF / Index
  SPY: 'Index/ETF', QQQ: 'Index/ETF', DIA: 'Index/ETF', IWM: 'Index/ETF',
  VTI: 'Index/ETF', VOO: 'Index/ETF',
};

function getSector(symbol) {
  const clean = symbol.trim().toUpperCase();
  return SECTOR_MAP[clean] || 'Other';
}

/**
 * Calcule les rendements journaliers à partir d'une série de prix de clôture.
 * return[i] = (close[i] - close[i-1]) / close[i-1]
 */
function calculateDailyReturns(closes) {
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return returns;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, x) => sum + Math.pow(x - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Volatilité annualisée à partir de rendements journaliers.
 * On annualise en multipliant l'écart-type journalier par √252
 * (252 jours de bourse par an — convention standard).
 */
function annualizedVolatility(dailyReturns) {
  return stdDev(dailyReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Beta = Cov(actif, benchmark) / Var(benchmark)
 * Mesure la sensibilité d'un actif aux mouvements du marché.
 * Beta > 1 : plus volatil que le marché. Beta < 1 : moins volatil.
 */
function calculateBeta(assetReturns, benchmarkReturns) {
  const n = Math.min(assetReturns.length, benchmarkReturns.length);
  if (n < 2) return 1; // pas assez de données → on suppose neutre (beta marché)

  const a = assetReturns.slice(-n);
  const b = benchmarkReturns.slice(-n);
  const meanA = mean(a);
  const meanB = mean(b);

  let covariance = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i++) {
    covariance += (a[i] - meanA) * (b[i] - meanB);
    varianceB += Math.pow(b[i] - meanB, 2);
  }
  covariance /= (n - 1);
  varianceB /= (n - 1);

  if (varianceB === 0) return 1;
  return covariance / varianceB;
}

/**
 * Coefficient de corrélation de Pearson entre deux séries de rendements.
 * Renvoie une valeur entre -1 (anti-corrélé) et +1 (parfaitement corrélé).
 */
function pearsonCorrelation(returnsA, returnsB) {
  const n = Math.min(returnsA.length, returnsB.length);
  if (n < 2) return 0;

  const a = returnsA.slice(-n);
  const b = returnsB.slice(-n);
  const meanA = mean(a);
  const meanB = mean(b);

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    cov  += (a[i] - meanA) * (b[i] - meanB);
    varA += Math.pow(a[i] - meanA, 2);
    varB += Math.pow(b[i] - meanB, 2);
  }

  const denom = Math.sqrt(varA * varB);
  if (denom === 0) return 0;
  return cov / denom;
}

/**
 * VaR historique : on trie les rendements du portefeuille du pire au
 * meilleur, et on prend le rendement au percentile (1 - confidence).
 * Ex: VaR 95% = le rendement tel que 5% des jours sont pires que ça.
 */
function calculateHistoricalVaR(portfolioReturns, confidence = VAR_CONFIDENCE) {
  if (portfolioReturns.length === 0) return 0;
  const sorted = [...portfolioReturns].sort((a, b) => a - b);
  const index = Math.floor((1 - confidence) * sorted.length);
  return sorted[Math.max(0, index)];
}

/**
 * CVaR (Expected Shortfall) : moyenne des pertes au-delà du seuil VaR.
 * Répond à "si on est dans les pires 5% des cas, combien perd-on en moyenne ?"
 */
function calculateCVaR(portfolioReturns, confidence = VAR_CONFIDENCE) {
  if (portfolioReturns.length === 0) return 0;
  const sorted = [...portfolioReturns].sort((a, b) => a - b);
  const cutoff = Math.max(1, Math.floor((1 - confidence) * sorted.length));
  const tail = sorted.slice(0, cutoff);
  return mean(tail);
}

/**
 * Score de risque composite 0-100, dérivé du beta, de la volatilité
 * et de la concentration du portefeuille (poids max d'une position).
 * Formule heuristique simple, pas un standard académique — sert de
 * jauge visuelle synthétique pour l'utilisateur.
 */
function calculateRiskScore({ beta, volatility, maxWeight }) {
  const betaScore = Math.min(Math.abs(beta) / 2, 1) * 35;       // 0-35 pts
  const volScore = Math.min(volatility / 0.5, 1) * 35;           // 0-35 pts
  const concentrationScore = Math.min(maxWeight / 0.5, 1) * 30;  // 0-30 pts
  return Math.round(betaScore + volScore + concentrationScore);
}

/**
 * Indice de Herfindahl-Hirschman (HHI) appliqué aux poids du portefeuille.
 * Somme des poids au carré. Plus c'est élevé, plus le portefeuille est
 * concentré sur peu de positions.
 *   HHI = 1/N (équipondéré, N positions) → minimum, le plus diversifié
 *   HHI = 1   (tout sur une seule position) → maximum, aucune diversification
 *
 * On convertit en "Diversification Score" 0-100 (100 = parfaitement
 * diversifié) via : score = (1 - HHI) / (1 - 1/N) × 100, normalisé pour
 * que le score tienne compte du nombre de positions disponibles.
 */
function calculateDiversificationScore(weights) {
  const n = weights.length;
  if (n <= 1) return 0; // une seule position = aucune diversification possible

  const hhi = weights.reduce((sum, w) => sum + w * w, 0);
  const minHHI = 1 / n; // HHI si toutes les positions étaient égales
  const score = ((1 - hhi) / (1 - minHHI)) * 100;

  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * Met à l'échelle une VaR/CVaR journalière vers un autre horizon temporel.
 * Hypothèse standard (racine du temps) : pour des rendements i.i.d.,
 * l'écart-type sur N jours = écart-type journalier × √N.
 * C'est une approximation — elle suppose l'absence d'autocorrélation
 * des rendements, ce qui est raisonnable à court terme (1 jour à 1 mois).
 */
const HORIZON_DAYS = { '1D': 1, '1W': 5, '1M': 21 }; // 5 et 21 = jours de bourse

function scaleToHorizon(dailyValue, horizon) {
  const days = HORIZON_DAYS[horizon] || 1;
  return dailyValue * Math.sqrt(days);
}

/**
 * Recommandation de taille de position, basée sur le risque marginal.
 * Logique : une position avec un beta nettement supérieur au beta du
 * portefeuille contribue plus que sa part au risque total — on suggère
 * de la réduire. À l'inverse, une position à faible beta peut être
 * renforcée sans trop augmenter le risque global.
 *
 * Ce n'est PAS un conseil financier individualisé — c'est une heuristique
 * de rééquilibrage basée sur la contribution au risque, affichée comme
 * point de départ de réflexion pour l'utilisateur.
 */
function getPositionSizingSuggestion(positionWeight, positionBeta, portfolioBeta, marginalRisk) {
  if (marginalRisk === 'high') {
    const suggestedWeight = positionWeight * 0.75; // suggestion : -25%
    return {
      action: 'REDUCE',
      suggestedWeightPct: parseFloat((suggestedWeight * 100).toFixed(1)),
      reason: `Beta (${positionBeta.toFixed(2)}) nettement supérieur au beta du portefeuille (${portfolioBeta.toFixed(2)}) — contribue disproportionnellement au risque total.`,
    };
  }

  if (marginalRisk === 'low') {
    const suggestedWeight = Math.min(positionWeight * 1.15, 0.35); // +15%, plafonné à 35%
    return {
      action: 'INCREASE',
      suggestedWeightPct: parseFloat((suggestedWeight * 100).toFixed(1)),
      reason: `Beta (${positionBeta.toFixed(2)}) inférieur au beta du portefeuille — marge pour renforcer sans augmenter fortement le risque global.`,
    };
  }

  return {
    action: 'HOLD',
    suggestedWeightPct: parseFloat((positionWeight * 100).toFixed(1)),
    reason: 'Contribution au risque alignée avec le profil global du portefeuille.',
  };
}

/**
 * Récupère les closes journaliers des N derniers jours pour un symbole,
 * via le router existant (crypto → Binance, stock → Yahoo).
 */
async function fetchDailyCloses(symbol, lookbackDays = 252) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);

  const { candles } = await fetchCandlesForBacktest(
    symbol,
    'Daily',
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10)
  );

  return candles.map(c => c.close);
}

/**
 * Point d'entrée principal : calcule la matrice de risque complète
 * pour un ensemble de positions de portefeuille.
 *
 * @param {Array} positions - [{ symbol, quantity, entryPrice }, ...]
 * @param {string} horizon  - '1D' | '1W' | '1M' — horizon temporel pour VaR/CVaR
 * @returns {Object} toutes les métriques pour le frontend RiskMatrix
 */
async function computeRiskMatrix(positions, horizon = '1D') {
  if (!positions || positions.length === 0) {
    return null; // le controller décide comment représenter "pas de positions"
  }

  // Agréger les positions par symbole (un symbole peut avoir plusieurs trades ouverts)
  const aggregated = {};
  for (const p of positions) {
    if (!aggregated[p.symbol]) {
      aggregated[p.symbol] = { symbol: p.symbol, quantity: 0, costBasis: 0 };
    }
    aggregated[p.symbol].quantity += Number(p.quantity);
    aggregated[p.symbol].costBasis += Number(p.quantity) * Number(p.entryPrice);
  }
  const symbols = Object.keys(aggregated);

  // ── 1. Récupérer les prix historiques (positions + benchmark) ──
  const allSymbols = [...new Set([...symbols, BENCHMARK_SYMBOL])];
  const closesBySymbol = {};

  for (const symbol of allSymbols) {
    try {
      closesBySymbol[symbol] = await fetchDailyCloses(symbol);
    } catch (err) {
      logger.error(`[riskEngine] Échec récupération prix pour ${symbol}: ${err.message}`);
      closesBySymbol[symbol] = [];
    }
  }

  const benchmarkCloses = closesBySymbol[BENCHMARK_SYMBOL] || [];
  const benchmarkReturns = calculateDailyReturns(benchmarkCloses);

  // ── 2. Valeur actuelle de chaque position (au dernier prix connu) ──
  const positionDetails = symbols.map(symbol => {
    const closes = closesBySymbol[symbol] || [];
    const currentPrice = closes.length > 0 ? closes[closes.length - 1] : aggregated[symbol].costBasis / aggregated[symbol].quantity;
    const marketValue = aggregated[symbol].quantity * currentPrice;
    const returns = calculateDailyReturns(closes);
    const beta = calculateBeta(returns, benchmarkReturns);
    const volatility = annualizedVolatility(returns);

    return {
      symbol,
      quantity: aggregated[symbol].quantity,
      currentPrice,
      marketValue,
      returns,
      beta,
      volatility,
      sector: getSector(symbol),
    };
  });

  const totalValue = positionDetails.reduce((sum, p) => sum + p.marketValue, 0);

  // ── 3. Poids et contribution de chaque position ──
  for (const p of positionDetails) {
    p.weight = totalValue > 0 ? p.marketValue / totalValue : 0;
  }

  // ── 4. Rendements journaliers du portefeuille (pondérés) ──
  const maxLen = Math.max(...positionDetails.map(p => p.returns.length), 0);
  const portfolioReturns = [];
  for (let i = 0; i < maxLen; i++) {
    let dayReturn = 0;
    for (const p of positionDetails) {
      const r = p.returns[i] ?? 0;
      dayReturn += r * p.weight;
    }
    portfolioReturns.push(dayReturn);
  }

  // ── 5. Métriques agrégées du portefeuille ──
  const portfolioBeta = positionDetails.reduce((sum, p) => sum + p.beta * p.weight, 0);
  const portfolioVolatility = annualizedVolatility(portfolioReturns);
  const dailyVaRPct = calculateHistoricalVaR(portfolioReturns);
  const cvarPct = calculateCVaR(portfolioReturns);

  // VaR/CVaR mis à l'échelle de l'horizon demandé (1D par défaut).
  // dailyVaRPct est déjà journalier — on l'étire en racine du temps.
  const scaledVaRPct = scaleToHorizon(dailyVaRPct, horizon);
  const scaledCVaRPct = scaleToHorizon(cvarPct, horizon);
  const dailyVaRDollar = scaledVaRPct * totalValue;
  const cvarDollar = scaledCVaRPct * totalValue;

  const maxWeight = Math.max(...positionDetails.map(p => p.weight), 0);
  const riskScore = calculateRiskScore({ beta: portfolioBeta, volatility: portfolioVolatility, maxWeight });
  const diversificationScore = calculateDiversificationScore(positionDetails.map(p => p.weight));

  // ── 6. VaR contribution par position + suggestion de sizing ──
  for (const p of positionDetails) {
    p.contribVarDollar = dailyVaRDollar * p.weight;
    p.marginalRisk = p.beta > portfolioBeta * 1.15 ? 'high'
                    : p.beta < portfolioBeta * 0.85 ? 'low'
                    : 'med';
    p.sizingSuggestion = getPositionSizingSuggestion(p.weight, p.beta, portfolioBeta, p.marginalRisk);
  }

  // ── 7. Matrice de corrélation entre positions ──
  const correlationMatrix = positionDetails.map(rowP =>
    positionDetails.map(colP => parseFloat(pearsonCorrelation(rowP.returns, colP.returns).toFixed(2)))
  );

  // ── 8. Stress tests : impact estimé = beta_portefeuille × choc_marché ──
  const STRESS_SCENARIOS = [
    { name: 'COVID Crash 2020',        marketShock: -0.339 }, // S&P 500 réel : -33.9%
    { name: '2022 Rate Hike Cycle',    marketShock: -0.182 }, // S&P 500 réel ~2022
    { name: '2008 Financial Crisis',   marketShock: -0.483 }, // S&P 500 réel : -48.3%
    { name: 'Tech Sector -30%',        marketShock: -0.30, sectorFocus: 'Technology' },
    { name: 'Flash Crash Scenario',    marketShock: -0.07 },
    { name: 'Bull Market +20%',        marketShock: 0.20 },
  ];

  const stressTests = STRESS_SCENARIOS.map(scenario => {
    let impact;
    if (scenario.sectorFocus) {
      // Impact concentré sur les positions du secteur visé, reste du
      // portefeuille supposé stable pour isoler l'effet sectoriel.
      const sectorWeight = positionDetails
        .filter(p => p.sector === scenario.sectorFocus)
        .reduce((sum, p) => sum + p.weight, 0);
      impact = scenario.marketShock * sectorWeight;
    } else {
      impact = scenario.marketShock * portfolioBeta;
    }
    return {
      name: scenario.name,
      impactPct: parseFloat((impact * 100).toFixed(1)),
    };
  });

  // ── 9. Répartition sectorielle ──
  const sectorWeights = {};
  for (const p of positionDetails) {
    sectorWeights[p.sector] = (sectorWeights[p.sector] || 0) + p.weight;
  }

  // ── 10. Distribution des rendements (histogramme pour le frontend) ──
  const returnDistribution = buildReturnHistogram(portfolioReturns);

  return {
    totalValue: parseFloat(totalValue.toFixed(2)),
    horizon,
    kpis: {
      dailyVaR: parseFloat(dailyVaRDollar.toFixed(2)),
      dailyVaRPct: parseFloat((scaledVaRPct * 100).toFixed(2)),
      cvar: parseFloat(cvarDollar.toFixed(2)),
      cvarPct: parseFloat((scaledCVaRPct * 100).toFixed(2)),
      beta: parseFloat(portfolioBeta.toFixed(2)),
      volatility: parseFloat((portfolioVolatility * 100).toFixed(1)),
      riskScore,
      diversificationScore,
    },
    positions: positionDetails.map(p => ({
      symbol: p.symbol,
      weight: parseFloat((p.weight * 100).toFixed(1)),
      beta: parseFloat(p.beta.toFixed(2)),
      contribVar: parseFloat(p.contribVarDollar.toFixed(2)),
      marginalRisk: p.marginalRisk,
      sector: p.sector,
      sizing: p.sizingSuggestion,
    })),
    correlationMatrix: {
      symbols: positionDetails.map(p => p.symbol),
      matrix: correlationMatrix,
    },
    stressTests,
    sectorRisk: Object.entries(sectorWeights).map(([sector, weight]) => ({
      sector,
      weightPct: parseFloat((weight * 100).toFixed(1)),
    })),
    returnDistribution,
  };
}

/**
 * Calcule l'impact d'un scénario de stress personnalisé, défini par
 * l'utilisateur (% de choc de marché, optionnellement ciblé sur un secteur).
 * Réutilise positionDetails déjà calculés par computeRiskMatrix — voir
 * computeCustomStressTest() qui orchestre tout depuis les positions brutes.
 */
function applyCustomStressScenario(positionDetails, portfolioBeta, shockPct, sectorFocus) {
  const marketShock = shockPct / 100;

  let impact;
  if (sectorFocus && sectorFocus !== 'all') {
    const sectorWeight = positionDetails
      .filter(p => p.sector === sectorFocus)
      .reduce((sum, p) => sum + p.weight, 0);
    impact = marketShock * sectorWeight;
  } else {
    impact = marketShock * portfolioBeta;
  }

  return parseFloat((impact * 100).toFixed(2));
}

/**
 * Point d'entrée pour le stress test personnalisé (endpoint dédié).
 * Recalcule rapidement les positions/beta/secteurs à partir des positions
 * brutes — plus léger que computeRiskMatrix car il ne recalcule pas
 * VaR/CVaR/corrélation/distribution, qui ne sont pas nécessaires ici.
 *
 * @param {Array} positions  - [{ symbol, quantity, entryPrice }, ...]
 * @param {number} shockPct  - ex: -25 pour un choc de marché de -25%
 * @param {string} sectorFocus - secteur ciblé, ou 'all' / undefined pour le marché entier
 */
async function computeCustomStressTest(positions, shockPct, sectorFocus) {
  const aggregated = {};
  for (const p of positions) {
    if (!aggregated[p.symbol]) {
      aggregated[p.symbol] = { symbol: p.symbol, quantity: 0, costBasis: 0 };
    }
    aggregated[p.symbol].quantity += Number(p.quantity);
    aggregated[p.symbol].costBasis += Number(p.quantity) * Number(p.entryPrice);
  }
  const symbols = Object.keys(aggregated);
  const allSymbols = [...new Set([...symbols, BENCHMARK_SYMBOL])];

  const closesBySymbol = {};
  for (const symbol of allSymbols) {
    try {
      closesBySymbol[symbol] = await fetchDailyCloses(symbol);
    } catch (err) {
      logger.error(`[riskEngine] Échec récupération prix pour ${symbol}: ${err.message}`);
      closesBySymbol[symbol] = [];
    }
  }

  const benchmarkReturns = calculateDailyReturns(closesBySymbol[BENCHMARK_SYMBOL] || []);

  const positionDetails = symbols.map(symbol => {
    const closes = closesBySymbol[symbol] || [];
    const currentPrice = closes.length > 0 ? closes[closes.length - 1] : aggregated[symbol].costBasis / aggregated[symbol].quantity;
    const marketValue = aggregated[symbol].quantity * currentPrice;
    const returns = calculateDailyReturns(closes);
    return {
      symbol,
      marketValue,
      beta: calculateBeta(returns, benchmarkReturns),
      sector: getSector(symbol),
    };
  });

  const totalValue = positionDetails.reduce((sum, p) => sum + p.marketValue, 0);
  for (const p of positionDetails) {
    p.weight = totalValue > 0 ? p.marketValue / totalValue : 0;
  }

  const portfolioBeta = positionDetails.reduce((sum, p) => sum + p.beta * p.weight, 0);
  const impactPct = applyCustomStressScenario(positionDetails, portfolioBeta, shockPct, sectorFocus);

  return {
    shockPct,
    sectorFocus: sectorFocus || 'all',
    portfolioBeta: parseFloat(portfolioBeta.toFixed(2)),
    impactPct,
    impactDollar: parseFloat((totalValue * impactPct / 100).toFixed(2)),
    totalValue: parseFloat(totalValue.toFixed(2)),
  };
}

/**
 * Construit un histogramme des rendements journaliers du portefeuille,
 * regroupés en buckets de 5% (-25% à +25%), pour le graphique de
 * distribution affiché côté frontend.
 */
function buildReturnHistogram(portfolioReturns) {
  const buckets = ['-25', '-20', '-15', '-10', '-5', '0', '5', '10', '15', '20', '25'];
  const counts = new Array(buckets.length).fill(0);

  for (const r of portfolioReturns) {
    const pct = r * 100;
    // Trouver le bucket: chaque bucket représente [edge, edge+5)
    let idx = Math.floor((pct + 25) / 5);
    idx = Math.max(0, Math.min(buckets.length - 1, idx));
    counts[idx]++;
  }

  return { labels: buckets, counts };
}

module.exports = {
  computeRiskMatrix,
  computeCustomStressTest,
  getSector,
  calculateBeta,
  calculateHistoricalVaR,
  calculateCVaR,
  pearsonCorrelation,
  annualizedVolatility,
  calculateDiversificationScore,
};