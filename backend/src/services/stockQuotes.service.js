/**
 * src/services/stockQuotes.service.js — AtlasQuant AI
 *
 * Source unique des cotations actions (yahoo-finance2) : cache 5 min,
 * dédup des requêtes en vol, batches pour ne pas saturer Yahoo.
 *
 * ✅ Audit 3: ce code vivait dans routes/prices.routes.js. portfolioController
 * l'appelait en HTTP sur localhost, et la route ne gardait que 9 symboles
 * (ALLOWED_SYMBOLS) en ignorant le reste en silence : 31 des 40 tickers du
 * portfolio n'avaient jamais de prix live. Maintenant : appel direct, et la
 * liste blanche reste uniquement une protection de la route publique.
 */
const YahooFinance = require('yahoo-finance2').default;
const logger = require('../utils/logger');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const CACHE_TTL_MS   = 5 * 60 * 1000;
const BATCH_SIZE     = 5;
const BATCH_DELAY_MS = 300;
const MAX_SYMBOLS    = 60;                       // garde-fou par appel
const SYMBOL_RE      = /^[A-Z][A-Z0-9.\-]{0,9}$/;

// Hardcoded demo prices are NEVER served as quotes unless explicitly enabled
// (PRICES_DEMO_MODE=true) — and then every such quote is flagged isDemo:true.
const DEMO_STATIC = process.env.PRICES_DEMO_MODE === 'true';

const STATIC = {
  AAPL:  { symbol: 'AAPL',  name: 'Apple Inc.',             price: 189.30, change: 0, up: true  },
  MSFT:  { symbol: 'MSFT',  name: 'Microsoft Corp.',        price: 415.50, change: 0, up: true  },
  NVDA:  { symbol: 'NVDA',  name: 'NVIDIA Corp.',           price: 875.40, change: 0, up: true  },
  AMZN:  { symbol: 'AMZN',  name: 'Amazon.com Inc.',        price: 183.75, change: 0, up: true  },
  META:  { symbol: 'META',  name: 'Meta Platforms',         price: 492.10, change: 0, up: true  },
  GOOGL: { symbol: 'GOOGL', name: 'Alphabet Inc.',          price: 175.20, change: 0, up: true  },
  TSLA:  { symbol: 'TSLA',  name: 'Tesla Inc.',             price: 177.90, change: 0, up: false },
  AMD:   { symbol: 'AMD',   name: 'Advanced Micro Devices', price: 155.60, change: 0, up: true  },
  PLTR:  { symbol: 'PLTR',  name: 'Palantir Technologies',  price: 22.80,  change: 0, up: true  },
};

const quoteCache = new Map();   // symbol → { data, cachedAt }
const inFlight   = new Map();   // "A,B,C" → Promise

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getCached(symbol) {
  const item = quoteCache.get(symbol);
  if (!item) return null;
  if (Date.now() - item.cachedAt > CACHE_TTL_MS) { quoteCache.delete(symbol); return null; }
  return item.data;
}
function setCache(symbol, data) { quoteCache.set(symbol, { data, cachedAt: Date.now() }); }
function clearCache() { const n = quoteCache.size; quoteCache.clear(); return n; }

function normalize(q) {
  const change = q.regularMarketChangePercent ?? 0;
  return {
    symbol:     q.symbol,
    name:       q.shortName || q.longName || q.symbol,
    price:      q.regularMarketPrice ?? null,
    change:     parseFloat(change.toFixed(2)),
    volume:     q.regularMarketVolume ?? null,
    marketCap:  q.marketCap ?? null,
    dayHigh:    q.regularMarketDayHigh ?? null,
    dayLow:     q.regularMarketDayLow ?? null,
    week52High: q.fiftyTwoWeekHigh ?? null,
    week52Low:  q.fiftyTwoWeekLow ?? null,
    up:         change >= 0,
  };
}

async function fetchBatch(symbols) {
  const key = [...symbols].sort().join(',');
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    try {
      const results = await Promise.all(symbols.map(async (symbol) => {
        try {
          const q = await yf.quote(symbol, {}, { validateResult: false });
          if (q?.regularMarketPrice !== undefined) {
            const data = normalize(q);
            setCache(symbol, data);
            return data;
          }
          return null;
        } catch (err) {
          logger.warn(`[stockQuotes] ${symbol}: ${err.message}`);
          return null;
        }
      }));
      return results.filter(Boolean);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * @param {string[]} rawSymbols
 * @returns {Promise<{ quotes: object[], cacheHits: number, staticFalls: number }>}
 *   quote = { symbol, price, change, ..., fromCache, isStale?, isDemo? }
 */
async function getStockQuotes(rawSymbols) {
  const symbols = [...new Set(
    (rawSymbols || []).map((s) => String(s).trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s))
  )].slice(0, MAX_SYMBOLS);

  const cached = {}, toFetch = [];
  for (const s of symbols) {
    const hit = getCached(s);
    if (hit) cached[s] = hit; else toFetch.push(s);
  }

  const fresh = {};
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(BATCH_DELAY_MS);
    const result = await fetchBatch(toFetch.slice(i, i + BATCH_SIZE));
    result.forEach((q) => { fresh[q.symbol] = q; });
  }

  let cacheHits = 0, staticFalls = 0;
  const quotes = symbols.map((s) => {
    if (fresh[s])  return { ...fresh[s],  fromCache: false };
    if (cached[s]) { cacheHits++;   return { ...cached[s], fromCache: true }; }
    if (DEMO_STATIC && STATIC[s]) {
      staticFalls++;
      return { ...STATIC[s], fromCache: false, isStale: true, isDemo: true };
    }
    return null;
  }).filter(Boolean);

  return { quotes, cacheHits, staticFalls };
}

module.exports = { getStockQuotes, clearCache, MAX_SYMBOLS, SYMBOL_RE, _internals: { quoteCache, normalize } };
