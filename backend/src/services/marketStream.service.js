/**
 * src/services/marketStream.service.js
 *
 * RÔLE DE CE FICHIER :
 * Agrège toutes les données nécessaires à la page Markets en un seul
 * snapshot — crypto (Binance), indices/forex/commodities (Yahoo Finance),
 * et performance sectorielle (via ETFs SPDR représentatifs).
 *
 * Ce service ne fait AUCUN appel réseau lui-même : il réutilise les
 * services existants (marketData.service.js pour Binance, yahooFinance
 * pour Yahoo) et assemble leur sortie dans le format attendu par
 * useMarketData.js côté frontend.
 */

const logger = require('../utils/logger');
const { fetchMultipleTickers, fetchOHLCV, fetchFearGreedIndex } = require('./marketData.service');
const yahooFinance = require('yahoo-finance2').default
  ? new (require('yahoo-finance2').default)()
  : null;

// ── Crypto suivis (ticker tape + grille crypto) ──────────────────
const CRYPTO_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'AVAX/USDT', 'DOGE/USDT'];

// ── Indices mondiaux (symbole Yahoo → libellé d'affichage) ───────
const INDICES = [
  { yahoo: '^GSPC',  region: 'USA', name: 'S&P 500'    },
  { yahoo: '^IXIC',  region: 'USA', name: 'NASDAQ'     },
  { yahoo: '^DJI',   region: 'USA', name: 'Dow Jones'  },
  { yahoo: '^FTSE',  region: 'UK',  name: 'FTSE 100'   },
  { yahoo: '^GDAXI', region: 'GER', name: 'DAX'        },
  { yahoo: '^N225',  region: 'JPN', name: 'Nikkei 225' },
  { yahoo: '000001.SS', region: 'CHN', name: 'Shanghai'  },
  { yahoo: '^HSI',   region: 'HKG', name: 'Hang Seng'  },
];

// ── Forex pairs ───────────────────────────────────────────────────
const FOREX_PAIRS = [
  { yahoo: 'EURUSD=X', label: 'EUR/USD' },
  { yahoo: 'GBPUSD=X', label: 'GBP/USD' },
  { yahoo: 'JPY=X',    label: 'USD/JPY' },
  { yahoo: 'AUDUSD=X', label: 'AUD/USD' },
  { yahoo: 'CAD=X',    label: 'USD/CAD' },
  { yahoo: 'CHF=X',    label: 'USD/CHF' },
];

// ── Commodities ────────────────────────────────────────────────────
const COMMODITIES = [
  { yahoo: 'GC=F', name: 'Gold',        sym: 'XAU/USD' },
  { yahoo: 'SI=F', name: 'Silver',      sym: 'XAG/USD' },
  { yahoo: 'CL=F', name: 'Crude Oil',   sym: 'WTI'     },
  { yahoo: 'BZ=F', name: 'Brent',       sym: 'BRENT'   },
  { yahoo: 'NG=F', name: 'Natural Gas', sym: 'NG'      },
  { yahoo: 'HG=F', name: 'Copper',      sym: 'HG'      },
];

// ── Sectors — ETFs SPDR représentatifs de chaque secteur ──────────
// Approche standard : ces ETFs suivent réellement la performance de
// leur secteur (utilisés par les pros comme proxy sectoriel), plutôt
// que de calculer une moyenne maison sur des actions individuelles.
const SECTOR_ETFS = [
  { yahoo: 'XLK', name: 'Technology'  },
  { yahoo: 'XLE', name: 'Energy'      },
  { yahoo: 'XLV', name: 'Healthcare'  },
  { yahoo: 'XLF', name: 'Financials'  },
  { yahoo: 'XLY', name: 'Consumer'    },
  { yahoo: 'XLRE', name: 'Real Estate' },
  { yahoo: 'XLU', name: 'Utilities'   },
  { yahoo: 'XLB', name: 'Materials'   },
];

function fmtPct(value) {
  const sign = value >= 0 ? '+' : '−';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function fmtPrice(value, decimals = 2) {
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * Récupère cours actuel + variation 24h pour un symbole Yahoo via le
 * module quote (plus léger qu'un chart complet pour juste un prix).
 */
async function fetchYahooQuote(yahooSymbol) {
  if (!yahooFinance) throw new Error('yahoo-finance2 non initialisé');
  const quote = await yahooFinance.quote(yahooSymbol);
  return {
    price: quote.regularMarketPrice,
    changePct: quote.regularMarketChangePercent,
  };
}

/**
 * Récupère les 7 derniers points de clôture (pour les sparklines des
 * cartes indices) — léger, daily, sur 10 jours pour avoir une marge.
 */
async function fetchSparkline(yahooSymbol, points = 7) {
  if (!yahooFinance) return [];
  try {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 14);
    const result = await yahooFinance.chart(yahooSymbol, {
      period1: start.toISOString().slice(0, 10),
      period2: end.toISOString().slice(0, 10),
      interval: '1d',
    });
    const closes = (result.quotes || [])
      .filter(q => q.close)
      .map(q => q.close);
    return closes.slice(-points);
  } catch {
    return [];
  }
}

async function buildIndices() {
  const results = await Promise.allSettled(
    INDICES.map(async idx => {
      const [quote, spark] = await Promise.all([
        fetchYahooQuote(idx.yahoo),
        fetchSparkline(idx.yahoo),
      ]);
      return {
        region: idx.region,
        name: idx.name,
        val: fmtPrice(quote.price),
        ch: fmtPct(quote.changePct),
        up: quote.changePct >= 0,
        spark: spark.length > 0 ? spark : [quote.price],
      };
    })
  );
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

async function buildForex() {
  const results = await Promise.allSettled(
    FOREX_PAIRS.map(async pair => {
      const quote = await fetchYahooQuote(pair.yahoo);
      return {
        p: pair.label,
        v: fmtPrice(quote.price, 4),
        ch: fmtPct(quote.changePct),
        up: quote.changePct >= 0,
      };
    })
  );
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

async function buildCommodities() {
  const results = await Promise.allSettled(
    COMMODITIES.map(async c => {
      const quote = await fetchYahooQuote(c.yahoo);
      return {
        n: c.name,
        sym: c.sym,
        v: `$${fmtPrice(quote.price, 3)}`,
        ch: fmtPct(quote.changePct),
        up: quote.changePct >= 0,
      };
    })
  );
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

async function buildSectors() {
  const results = await Promise.allSettled(
    SECTOR_ETFS.map(async sector => {
      const quote = await fetchYahooQuote(sector.yahoo);
      // Volume en dollars approximatif : non disponible via quote() simple,
      // on affiche donc le % seul de façon honnête plutôt que d'inventer un montant.
      return {
        name: sector.name,
        ch: fmtPct(quote.changePct),
        v: '', // pas de proxy fiable pour le flux $ sans données premium — laissé vide plutôt que falsifié
        intensity: Math.max(-1, Math.min(1, quote.changePct / 3)), // normalisé pour le heatmap
      };
    })
  );
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

async function buildCrypto() {
  try {
    const tickers = await fetchMultipleTickers(CRYPTO_SYMBOLS);
    return Object.entries(tickers).map(([symbol, t]) => ({
      s: symbol.split('/')[0],
      v: `$${fmtPrice(t.price)}`,
      c: fmtPct(t.change24h),
      up: t.change24h >= 0,
    }));
  } catch (err) {
    logger.error(`[marketStream] buildCrypto error: ${err.message}`);
    return [];
  }
}

async function buildTicks(cryptos, indices, forex, commodities) {
  // Ticker tape : mélange représentatif de quelques actifs de chaque catégorie
  const ticks = [];
  if (indices[0]) ticks.push({ s: 'SPY', v: indices[0].val, c: indices[0].ch, u: indices[0].up });
  if (indices[1]) ticks.push({ s: 'QQQ', v: indices[1].val, c: indices[1].ch, u: indices[1].up });
  cryptos.slice(0, 2).forEach(c => ticks.push({ s: c.s, v: c.v.replace('$', ''), c: c.c, u: c.up }));
  if (commodities[0]) ticks.push({ s: 'GOLD', v: commodities[0].v.replace('$', ''), c: commodities[0].ch, u: commodities[0].up });
  if (commodities[2]) ticks.push({ s: 'OIL', v: commodities[2].v.replace('$', ''), c: commodities[2].ch, u: commodities[2].up });
  if (forex[0]) ticks.push({ s: forex[0].p, v: forex[0].v, c: forex[0].ch, u: forex[0].up });
  return ticks;
}

/**
 * Parse un pourcentage formaté ("+1.24%", "−0.82%") vers un nombre signé.
 * Le symbole moins utilisé ailleurs dans le payload est le U+2212 (−),
 * pas le tiret ASCII standard — on gère les deux pour rester robuste.
 */
function parsePct(str) {
  if (!str) return 0;
  const negative = str.startsWith('−') || str.startsWith('-');
  const num = parseFloat(str.replace(/[+−\-%]/g, ''));
  return negative ? -num : num;
}

/**
 * Calcule les plus gros gagnants/perdants du jour, tous actifs confondus
 * (indices, forex, commodities, crypto, secteurs). Utilisé pour la
 * section "Top Movers" du frontend.
 */
function computeTopMovers({ indices, forex, commodities, cryptos, sectors }) {
  const pool = [
    ...indices.map(i => ({ symbol: i.name, category: 'Index', changePct: parsePct(i.ch) })),
    ...forex.map(f => ({ symbol: f.p, category: 'Forex', changePct: parsePct(f.ch) })),
    ...commodities.map(c => ({ symbol: c.n, category: 'Commodity', changePct: parsePct(c.ch) })),
    ...cryptos.map(c => ({ symbol: c.s, category: 'Crypto', changePct: parsePct(c.c) })),
    ...sectors.map(s => ({ symbol: s.name, category: 'Sector', changePct: parsePct(s.ch) })),
  ];

  const sorted = [...pool].sort((a, b) => b.changePct - a.changePct);

  return {
    gainers: sorted.slice(0, 5),
    losers: sorted.slice(-5).reverse(),
  };
}

/**
 * Assemble le snapshot complet envoyé au frontend via WebSocket.
 * Tolérant aux échecs partiels : si Yahoo échoue sur une catégorie,
 * les autres catégories sont quand même renvoyées (jamais de crash total).
 */
async function buildMarketSnapshot() {
  const [indices, forex, commodities, sectors, cryptos, fearGreed] = await Promise.all([
    buildIndices().catch(err => { logger.error(`[marketStream] indices: ${err.message}`); return []; }),
    buildForex().catch(err => { logger.error(`[marketStream] forex: ${err.message}`); return []; }),
    buildCommodities().catch(err => { logger.error(`[marketStream] commodities: ${err.message}`); return []; }),
    buildSectors().catch(err => { logger.error(`[marketStream] sectors: ${err.message}`); return []; }),
    buildCrypto(),
    fetchFearGreedIndex().catch(err => { logger.error(`[marketStream] fearGreed: ${err.message}`); return null; }),
  ]);

  const ticks = await buildTicks(cryptos, indices, forex, commodities);
  const topMovers = computeTopMovers({ indices, forex, commodities, cryptos, sectors });

  // Sparkline S&P 500 intraday : on réutilise les closes journaliers
  // de l'indice S&P déjà récupérés (approximation — un vrai intraday
  // demanderait un fetch séparé en intervalle court).
  const sp500 = indices.find(i => i.name === 'S&P 500');

  return {
    ticks,
    indices,
    sectors,
    comms: commodities,
    forex,
    cryptos,
    sp500Intraday: sp500?.spark || [],
    // fearGreed: null si l'API alternative.me est indisponible — le
    // frontend doit gérer ce cas (garder la valeur précédente affichée).
    fearGreed: fearGreed ? { value: fearGreed.value, label: fearGreed.label } : null,
    topMovers,
  };
}

module.exports = { buildMarketSnapshot };