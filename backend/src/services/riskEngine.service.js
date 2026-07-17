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
 *   - Répartition sectorielle + concentration
 */

const logger = require('../utils/logger');
const { fetchCandlesForBacktest } = require('./backtestMarketRouter.service');

const BENCHMARK_SYMBOL = 'SPY';
const TRADING_DAYS_PER_YEAR = 252;
const VAR_CONFIDENCE = 0.95; // VaR à 95% — standard dans l'industrie

const HIGH_SECTOR_CONCENTRATION_THRESHOLD = 0.60;

// ── Classification sectorielle (mapping manuel) ─────────────────
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

// ✅ Perf: cache en mémoire des closes journaliers par symbole, TTL 5min.
const CLOSES_CACHE_TTL_MS = 5 * 60 * 1000;
const closesCache = new Map();

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

function annualizedVolatility(dailyReturns) {
  return stdDev(dailyReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function calculateBeta(assetReturns, benchmarkReturns) {
  const n = Math.min(assetReturns.length, benchmarkReturns.length);
  if (n < 2) return 1;

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

function calculateHistoricalVaR(portfolioReturns, confidence = VAR_CONFIDENCE) {
  if (portfolioReturns.length === 0) return 0;
  const sorted = [...portfolioReturns].sort((a, b) => a - b);
  const index = Math.floor((1 - confidence) * sorted.length);
  return sorted[Math.max(0, index)];
}

function calculateCVaR(portfolioReturns, confidence = VAR_CONFIDENCE) {
  if (portfolioReturns.length === 0) return 0;
  const sorted = [...portfolioReturns].sort((a, b) => a - b);
  const cutoff = Math.max(1, Math.floor((1 - confidence) * sorted.length));
  const tail = sorted.slice(0, cutoff);
  return mean(tail);
}

function calculateRiskScore({ beta, volatility, maxWeight }) {
  const betaScore = Math.min(Math.abs(beta) / 2, 1) * 35;
  const volScore = Math.min(volatility / 0.5, 1) * 35;
  const concentrationScore = Math.min(maxWeight / 0.5, 1) * 30;
  return Math.round(betaScore + volScore + concentrationScore);
}

function calculateDiversificationScore(weights, sectors = []) {
  const n = weights.length;
  if (n <= 1) return 0;

  const weightHHI = weights.reduce((sum, w) => sum + w * w, 0);
  const minHHI = 1 / n;
  const weightScore = ((1 - weightHHI) / (1 - minHHI)) * 100;

  if (!sectors || sectors.length !== weights.length) {
    return Math.round(Math.max(0, Math.min(100, weightScore)));
  }

  const sectorWeights = {};
  weights.forEach((w, i) => {
    const s = sectors[i] || 'Other';
    sectorWeights[s] = (sectorWeights[s] || 0) + w;
  });
  const sectorHHI = Object.values(sectorWeights).reduce((sum, w) => sum + w * w, 0);
  const sectorScore = (1 - sectorHHI) * 100;

  const finalScore = weightScore * 0.4 + sectorScore * 0.6;
  return Math.round(Math.max(0, Math.min(100, finalScore)));
}

const HORIZON_DAYS = { '1D': 1, '1W': 5, '1M': 21 };

function scaleToHorizon(dailyValue, horizon) {
  const days = HORIZON_DAYS[horizon] || 1;
  return dailyValue * Math.sqrt(days);
}

function getPositionSizingSuggestion(positionWeight, positionBeta, portfolioBeta, marginalRisk) {
  if (marginalRisk === 'high') {
    const suggestedWeight = positionWeight * 0.75;
    return {
      action: 'REDUCE',
      suggestedWeightPct: parseFloat((suggestedWeight * 100).toFixed(1)),
      reason: `Beta (${positionBeta.toFixed(2)}) nettement supérieur au beta du portefeuille (${portfolioBeta.toFixed(2)}) — contribue disproportionnellement au risque total.`,
    };
  }

  if (marginalRisk === 'low') {
    const suggestedWeight = Math.min(positionWeight * 1.15, 0.35);
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

async function fetchDailyCloses(symbol, lookbackDays = 252) {
  const cacheKey = symbol.trim().toUpperCase();
  const cached = closesCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < CLOSES_CACHE_TTL_MS) {
    return cached.closes;
  }

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);

  const { candles } = await fetchCandlesForBacktest(
    symbol,
    'Daily',
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10)
  );

  const closes = candles.map(c => c.close);
  closesCache.set(cacheKey, { closes, fetchedAt: Date.now() });
  return closes;
}

async function computeRiskMatrix(positions, horizon = '1D') {
  if (!positions || positions.length === 0) {
    return null;
  }

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

  const benchmarkCloses = closesBySymbol[BENCHMARK_SYMBOL] || [];
  const benchmarkReturns = calculateDailyReturns(benchmarkCloses);

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

  for (const p of positionDetails) {
    p.weight = totalValue > 0 ? p.marketValue / totalValue : 0;
  }

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

  const portfolioBeta = positionDetails.reduce((sum, p) => sum + p.beta * p.weight, 0);
  const portfolioVolatility = annualizedVolatility(portfolioReturns);
  const dailyVaRPct = calculateHistoricalVaR(portfolioReturns);
  const cvarPct = calculateCVaR(portfolioReturns);

  const scaledVaRPct = scaleToHorizon(dailyVaRPct, horizon);
  const scaledCVaRPct = scaleToHorizon(cvarPct, horizon);
  const dailyVaRDollar = scaledVaRPct * totalValue;
  const cvarDollar = scaledCVaRPct * totalValue;

  const maxWeight = Math.max(...positionDetails.map(p => p.weight), 0);
  const riskScore = calculateRiskScore({ beta: portfolioBeta, volatility: portfolioVolatility, maxWeight });

  const diversificationScore = calculateDiversificationScore(
    positionDetails.map(p => p.weight),
    positionDetails.map(p => p.sector)
  );

  for (const p of positionDetails) {
    p.contribVarDollar = dailyVaRDollar * p.weight;
    p.marginalRisk = p.beta > portfolioBeta * 1.15 ? 'high'
                    : p.beta < portfolioBeta * 0.85 ? 'low'
                    : 'med';
    p.sizingSuggestion = getPositionSizingSuggestion(p.weight, p.beta, portfolioBeta, p.marginalRisk);

    const suggestedValueDollar = (p.sizingSuggestion.suggestedWeightPct / 100) * totalValue;
    p.sizingSuggestion.suggestedValueDollar = parseFloat(suggestedValueDollar.toFixed(2));
    p.sizingSuggestion.deltaDollar = parseFloat((suggestedValueDollar - p.marketValue).toFixed(2));
  }

  const correlationMatrix = positionDetails.map(rowP =>
    positionDetails.map(colP => parseFloat(pearsonCorrelation(rowP.returns, colP.returns).toFixed(2)))
  );

  const STRESS_SCENARIOS = [
    { name: 'COVID Crash 2020',        marketShock: -0.339 },
    { name: '2022 Rate Hike Cycle',    marketShock: -0.182 },
    { name: '2008 Financial Crisis',   marketShock: -0.483 },
    { name: 'Tech Sector -30%',        marketShock: -0.30, sectorFocus: 'Technology' },
    { name: 'Flash Crash Scenario',    marketShock: -0.07 },
    { name: 'Bull Market +20%',        marketShock: 0.20 },
  ];

  const stressTests = STRESS_SCENARIOS.map(scenario => {
    let impact;
    if (scenario.sectorFocus) {
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

  const sectorWeights = {};
  for (const p of positionDetails) {
    sectorWeights[p.sector] = (sectorWeights[p.sector] || 0) + p.weight;
  }

  const sectorEntries = Object.entries(sectorWeights).sort((a, b) => b[1] - a[1]);
  const topSector = sectorEntries[0] || null;
  const sectorConcentration = topSector
    ? {
        sector: topSector[0],
        pct: parseFloat((topSector[1] * 100).toFixed(1)),
        isHighConcentration: topSector[1] >= HIGH_SECTOR_CONCENTRATION_THRESHOLD,
      }
    : null;

  // ✅ Fix: le graphique de distribution utilisait toujours les rendements
  // journaliers bruts, peu importe l'horizon sélectionné (1D/1W/1M) — il ne
  // bougeait jamais quand l'utilisateur changeait d'horizon, contrairement à
  // VaR/CVaR juste au-dessus qui eux se remettent à l'échelle. On applique la
  // même mise à l'échelle racine-du-temps (scaleToHorizon) à chaque rendement
  // individuel avant de construire l'histogramme, pour rester cohérent avec
  // les KPIs affichés au-dessus.
  const scaledReturnsForHistogram = portfolioReturns.map(r => scaleToHorizon(r, horizon));
  const returnDistribution = buildReturnHistogram(scaledReturnsForHistogram);

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
    sectorConcentration,
    positions: positionDetails.map(p => ({
      symbol: p.symbol,
      marketValue: parseFloat(p.marketValue.toFixed(2)),
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
 * Construit un histogramme des rendements du portefeuille pour le graphique
 * de distribution.
 *
 * ✅ Fix: l'ancienne version utilisait des buckets FIXES de 5% de large
 * (-25% à +25%). Les rendements journaliers d'un portefeuille tournent
 * typiquement entre ±0.5% et ±2% — quasiment toutes les valeurs tombaient
 * donc dans un seul bucket ("0" ou "-5"), tous les autres restant vides.
 * Résultat visuel : une seule barre géante, le reste du graphique plat —
 * ça ressemblait à un bug d'affichage plutôt qu'à une vraie distribution.
 *
 * Les buckets sont maintenant dynamiques : la largeur est dérivée de
 * l'amplitude réelle des rendements observés (± la valeur absolue max,
 * avec une marge de 15% pour ne pas coller les extrêmes au bord), répartie
 * sur 11 buckets centrés sur 0. Les décimales des labels s'adaptent à
 * l'échelle (2 décimales si amplitude < 2%, 1 décimale si < 10%, sinon 0).
 */
function buildReturnHistogram(portfolioReturns) {
  const NUM_BUCKETS = 11;

  if (portfolioReturns.length === 0) {
    const labels = Array.from({ length: NUM_BUCKETS }, (_, i) => (i - Math.floor(NUM_BUCKETS / 2)).toString());
    return { labels, counts: new Array(NUM_BUCKETS).fill(0) };
  }

  const pctReturns = portfolioReturns.map(r => r * 100);
  const maxAbs = Math.max(...pctReturns.map(Math.abs), 0.05); // évite une largeur de bucket nulle si tous les rendements sont ~0
  const range = maxAbs * 1.15;
  const bucketWidth = (2 * range) / NUM_BUCKETS;
  const decimals = range < 2 ? 2 : range < 10 ? 1 : 0;

  const labels = [];
  for (let i = 0; i < NUM_BUCKETS; i++) {
    const bucketCenter = -range + bucketWidth * i + bucketWidth / 2;
    labels.push(bucketCenter.toFixed(decimals));
  }

  const counts = new Array(NUM_BUCKETS).fill(0);
  for (const pct of pctReturns) {
    let idx = Math.floor((pct + range) / bucketWidth);
    idx = Math.max(0, Math.min(NUM_BUCKETS - 1, idx));
    counts[idx]++;
  }

  return { labels, counts };
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