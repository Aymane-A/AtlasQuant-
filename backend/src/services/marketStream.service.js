/**
 * src/services/marketStream.service.js
 *
 * RÔLE DE CE FICHIER :
 * Agrège toutes les données nécessaires à la page Markets en un seul
 * snapshot — crypto, indices/forex/commodities, et performance
 * sectorielle (via ETFs SPDR représentatifs).
 *
 * Tous les prix live (crypto + tout ce qui passe par Yahoo) viennent
 * maintenant d'UN SEUL appel batché à livePrices.service — plus de
 * ~28 requêtes individuelles par page load, et bénéficie du cache
 * 5min partagé avec Portfolio/Dashboard/Watchlist/etc.
 *
 * Seule exception : les sparklines (historique de prix), qui restent
 * une requête chart() séparée — ce n'est pas un "live price snapshot",
 * c'est une série temporelle, donc hors du scope de livePrices.service.
 */

const logger = require('../utils/logger');
const { fetchFearGreedIndex } = require('./marketData.service');
const { getLivePrices } = require('./livePrices.service');

// ── Yahoo Finance instantiation (v3 compatible) ──────────────────
// Toujours nécessaire ici pour fetchSparkline() (chart() historique) —
// c'est le seul appel Yahoo direct qui reste dans ce fichier.
let yahooFinance = null;
try {
  const YahooFinance = require('yahoo-finance2').default;
  yahooFinance = new YahooFinance();
} catch (err) {
  logger.warn('[marketStream] yahoo-finance2 unavailable:', err.message);
}

// ── Crypto suivis ─────────────────────────────────────────────────
const CRYPTO_SYMBOLS = [
  'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT',
  'XRP/USDT', 'ADA/USDT', 'AVAX/USDT', 'DOGE/USDT',
];

// ── Indices mondiaux ──────────────────────────────────────────────
const INDICES = [
  { yahoo: '^GSPC',    region: 'USA', name: 'S&P 500'    },
  { yahoo: '^IXIC',    region: 'USA', name: 'NASDAQ'     },
  { yahoo: '^DJI',     region: 'USA', name: 'Dow Jones'  },
  { yahoo: '^FTSE',    region: 'UK',  name: 'FTSE 100'   },
  { yahoo: '^GDAXI',   region: 'GER', name: 'DAX'        },
  { yahoo: '^N225',    region: 'JPN', name: 'Nikkei 225' },
  { yahoo: '000001.SS',region: 'CHN', name: 'Shanghai'   },
  { yahoo: '^HSI',     region: 'HKG', name: 'Hang Seng'  },
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

// ── Commodities ───────────────────────────────────────────────────
const COMMODITIES = [
  { yahoo: 'GC=F', name: 'Gold',        sym: 'XAU/USD' },
  { yahoo: 'SI=F', name: 'Silver',      sym: 'XAG/USD' },
  { yahoo: 'CL=F', name: 'Crude Oil',   sym: 'WTI'     },
  { yahoo: 'BZ=F', name: 'Brent',       sym: 'BRENT'   },
  { yahoo: 'NG=F', name: 'Natural Gas', sym: 'NG'      },
  { yahoo: 'HG=F', name: 'Copper',      sym: 'HG'      },
];

// ── Sectors — ETFs SPDR ───────────────────────────────────────────
const SECTOR_ETFS = [
  { yahoo: 'XLK',  name: 'Technology'  },
  { yahoo: 'XLE',  name: 'Energy'      },
  { yahoo: 'XLV',  name: 'Healthcare'  },
  { yahoo: 'XLF',  name: 'Financials'  },
  { yahoo: 'XLY',  name: 'Consumer'    },
  { yahoo: 'XLRE', name: 'Real Estate' },
  { yahoo: 'XLU',  name: 'Utilities'   },
  { yahoo: 'XLB',  name: 'Materials'   },
];

// ── Helpers ───────────────────────────────────────────────────────
function fmtPct(value) {
  const sign = value >= 0 ? '+' : '−';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function fmtPrice(value, decimals = 2) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function parsePct(str) {
  if (!str) return 0;
  const negative = str.startsWith('−') || str.startsWith('-');
  const num = parseFloat(str.replace(/[+−\-%]/g, ''));
  return negative ? -num : num;
}

function cryptoBaseSymbol(pairSymbol) {
  return pairSymbol.split('/')[0]; // 'BTC/USDT' -> 'BTC'
}

// ── Sparkline (historique — séparé de livePrices.service, voir en-tête) ──
async function fetchSparkline(yahooSymbol, points = 7) {
  if (!yahooFinance) return [];
  try {
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 14);
    const result = await yahooFinance.chart(yahooSymbol, {
      period1:  start.toISOString().slice(0, 10),
      period2:  end.toISOString().slice(0, 10),
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

// ── Builders ──────────────────────────────────────────────────────
// Tous prennent `livePriceMap` (résultat du seul appel getLivePrices())
// au lieu de fetcher chacun de leur côté.

async function buildIndices(livePriceMap) {
  const results = await Promise.allSettled(
    INDICES.map(async idx => {
      const live = livePriceMap[idx.yahoo];
      if (!live) throw new Error(`no live price for ${idx.yahoo}`);

      const spark = await fetchSparkline(idx.yahoo);
      return {
        region: idx.region,
        name:   idx.name,
        val:    fmtPrice(live.price),
        ch:     fmtPct(live.changeRaw),
        up:     live.changeRaw >= 0,
        spark:  spark.length > 0 ? spark : [live.price],
      };
    })
  );
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

function buildForex(livePriceMap) {
  return FOREX_PAIRS
    .map(pair => {
      const live = livePriceMap[pair.yahoo];
      if (!live) return null;
      return {
        p:  pair.label,
        v:  fmtPrice(live.price, 4),
        ch: fmtPct(live.changeRaw),
        up: live.changeRaw >= 0,
      };
    })
    .filter(Boolean);
}

function buildCommodities(livePriceMap) {
  return COMMODITIES
    .map(c => {
      const live = livePriceMap[c.yahoo];
      if (!live) return null;
      return {
        n:   c.name,
        sym: c.sym,
        v:   `$${fmtPrice(live.price, 3)}`,
        ch:  fmtPct(live.changeRaw),
        up:  live.changeRaw >= 0,
      };
    })
    .filter(Boolean);
}

function buildSectors(livePriceMap) {
  return SECTOR_ETFS
    .map(sector => {
      const live = livePriceMap[sector.yahoo];
      if (!live) return null;
      return {
        name:      sector.name,
        ch:        fmtPct(live.changeRaw),
        v:         '',
        intensity: Math.max(-1, Math.min(1, live.changeRaw / 3)),
      };
    })
    .filter(Boolean);
}

function buildCrypto(livePriceMap) {
  return CRYPTO_SYMBOLS
    .map(pairSymbol => {
      const base = cryptoBaseSymbol(pairSymbol);
      const live = livePriceMap[base];
      if (!live) return null;
      return {
        s:  base,
        v:  `$${fmtPrice(live.price)}`,
        c:  fmtPct(live.changeRaw),
        up: live.changeRaw >= 0,
      };
    })
    .filter(Boolean);
}

async function buildTicks(cryptos, indices, forex, commodities) {
  const ticks = [];
  if (indices[0])     ticks.push({ s: 'SPY',  v: indices[0].val,                          c: indices[0].ch,      u: indices[0].up });
  if (indices[1])     ticks.push({ s: 'QQQ',  v: indices[1].val,                          c: indices[1].ch,      u: indices[1].up });
  cryptos.slice(0, 2).forEach(c => ticks.push({ s: c.s, v: c.v.replace('$', ''),          c: c.c,                u: c.up }));
  if (commodities[0]) ticks.push({ s: 'GOLD', v: commodities[0].v.replace('$', ''),       c: commodities[0].ch,  u: commodities[0].up });
  if (commodities[2]) ticks.push({ s: 'OIL',  v: commodities[2].v.replace('$', ''),       c: commodities[2].ch,  u: commodities[2].up });
  if (forex[0])       ticks.push({ s: forex[0].p, v: forex[0].v,                          c: forex[0].ch,        u: forex[0].up });
  return ticks;
}

function computeTopMovers({ indices, forex, commodities, cryptos, sectors }) {
  const pool = [
    ...indices.map(i     => ({ symbol: i.name,  category: 'Index',     changePct: parsePct(i.ch) })),
    ...forex.map(f       => ({ symbol: f.p,      category: 'Forex',     changePct: parsePct(f.ch) })),
    ...commodities.map(c => ({ symbol: c.n,      category: 'Commodity', changePct: parsePct(c.ch) })),
    ...cryptos.map(c     => ({ symbol: c.s,      category: 'Crypto',    changePct: parsePct(c.c)  })),
    ...sectors.map(s     => ({ symbol: s.name,   category: 'Sector',    changePct: parsePct(s.ch) })),
  ];
  const sorted = [...pool].sort((a, b) => b.changePct - a.changePct);
  return {
    gainers: sorted.slice(0, 5),
    losers:  sorted.slice(-5).reverse(),
  };
}

async function buildMarketSnapshot() {
  // ── Un seul batch: crypto (bare symbols) + tout le reste (tickers Yahoo tels quels) ──
  const symbols = [
    ...CRYPTO_SYMBOLS.map(cryptoBaseSymbol),
    ...INDICES.map(i => i.yahoo),
    ...FOREX_PAIRS.map(f => f.yahoo),
    ...COMMODITIES.map(c => c.yahoo),
    ...SECTOR_ETFS.map(s => s.yahoo),
  ];

  const [livePriceMap, fearGreed] = await Promise.all([
    getLivePrices(symbols),
    fetchFearGreedIndex().catch(err => { logger.error(`[marketStream] fearGreed: ${err.message}`); return null; }),
  ]);

  const [indices, forex, commodities, sectors] = await Promise.all([
    buildIndices(livePriceMap)     .catch(err => { logger.error(`[marketStream] indices: ${err.message}`);     return []; }),
    Promise.resolve(buildForex(livePriceMap))      .catch(err => { logger.error(`[marketStream] forex: ${err.message}`);       return []; }),
    Promise.resolve(buildCommodities(livePriceMap)).catch(err => { logger.error(`[marketStream] commodities: ${err.message}`); return []; }),
    Promise.resolve(buildSectors(livePriceMap))    .catch(err => { logger.error(`[marketStream] sectors: ${err.message}`);     return []; }),
  ]);
  const cryptos = buildCrypto(livePriceMap);

  const ticks     = await buildTicks(cryptos, indices, forex, commodities);
  const topMovers = computeTopMovers({ indices, forex, commodities, cryptos, sectors });
  const sp500     = indices.find(i => i.name === 'S&P 500');

  return {
    ticks,
    indices,
    sectors,
    comms:          commodities,
    forex,
    cryptos,
    sp500Intraday:  sp500?.spark || [],
    fearGreed:      fearGreed ? { value: fearGreed.value, label: fearGreed.label } : null,
    topMovers,
    fetchedAt:      new Date().toISOString(),
  };
}

module.exports = { buildMarketSnapshot };