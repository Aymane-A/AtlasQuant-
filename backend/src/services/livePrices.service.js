/**
 * livePrices.service.js
 * ----------------------------------------------------------------
 * SOURCE WA7DA dyal live prices f AtlasQuant AI.
 *
 * Controllers li kayn3iyto:
 *   Portfolio, Dashboard, Analytics, Watchlist, Risk, Trading,
 *   AI, Alerts, Market Stream
 *
 * Kolhom khass yst3mlo:  getLivePrices(symbols)
 * Machi Binance/Yahoo direct.
 *
 * Providers dyal l'youm:
 *   - Crypto                -> Binance (ccxt)
 *   - Stocks / ETF / Forex / Commodity -> Yahoo Finance (yahoo-finance2)
 *
 * Future providers (Polygon, Finnhub, AlphaVantage, IEX) ghadi
 * ykono just implementations jdod dyal `fetchXxxBatch()`, bla ma
 * tbddl wa7ed men l'controllers li kayst3mlo l'API dyal had service.
 * ----------------------------------------------------------------
 */

const ccxt = require('ccxt');

// yahoo-finance2 v3+ requires explicit instantiation — the old
// `require('yahoo-finance2').default` singleton pattern (v2) no
// longer works and throws "Call `new YahooFinance()` first."
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });


// ==================================================================
// 1) CONFIG
// ==================================================================

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Known ETF tickers (mzid feha ila bghiti)
const ETF_SYMBOLS = new Set([
  'SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'ARKK', 'GLD', 'SLV',
  'XLK', 'XLF', 'XLE', 'EEM', 'EFA', 'TLT', 'HYG',
]);

// Known crypto base symbols (fallback ila ccxt.markets mzal ma t7ml)
const CRYPTO_SYMBOLS = new Set([
  'BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE', 'BNB', 'AVAX', 'DOT',
  'MATIC', 'LTC', 'LINK', 'TRX', 'SHIB', 'ATOM', 'UNI', 'ETC', 'BCH',
]);

// Commodities -> Yahoo futures ticker mapping
const COMMODITY_YAHOO_MAP = {
  XAUUSD: 'GC=F',   // Gold
  XAGUSD: 'SI=F',   // Silver
  WTI: 'CL=F',      // WTI Crude
  BRENT: 'BZ=F',    // Brent Crude
  NATGAS: 'NG=F',   // Natural Gas
  COPPER: 'HG=F',
  XPTUSD: 'PL=F',   // Platinum
  XPDUSD: 'PA=F',   // Palladium
};

// Currency codes used bach n-detect-iw forex pairs automatiquement (EURUSD, GBPJPY...)
const FOREX_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNH', 'MXN',
]);

const ASSET_TYPES = {
  CRYPTO: 'crypto',
  STOCK: 'stock',
  ETF: 'etf',
  FOREX: 'forex',
  COMMODITY: 'commodity',
};

// ==================================================================
// 2) CACHE (in-memory, TTL 5min) — wa7da l l'application kamla
// ==================================================================

class PriceCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.store = new Map(); // symbol -> { data, expiresAt }
  }

  get(symbol) {
    const entry = this.store.get(symbol);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(symbol);
      return null;
    }
    return entry.data;
  }

  set(symbol, data) {
    this.store.set(symbol, { data, expiresAt: Date.now() + this.ttlMs });
  }

  // Utile l debugging / endpoint dyal cache stats
  stats() {
    return { size: this.store.size, ttlMs: this.ttlMs };
  }
}

const cache = new PriceCache(CACHE_TTL_MS);

// ==================================================================
// 3) ASSET DETECTION (automatique, ma-kayn walo hardcoded per-controller)
// ==================================================================

function detectAssetType(rawSymbol) {
  const symbol = rawSymbol.toUpperCase().trim();

  // Commodity (list explicite, priorité qبل forex bحال XAUUSD)
  if (COMMODITY_YAHOO_MAP[symbol]) return ASSET_TYPES.COMMODITY;

  // ETF
  if (ETF_SYMBOLS.has(symbol)) return ASSET_TYPES.ETF;

  // Crypto (list connue OU heuristique: base symbol 3-5 caractères
  // bla ma ykoun m3rouf f les autres catégories)
  if (CRYPTO_SYMBOLS.has(symbol)) return ASSET_TYPES.CRYPTO;

  // Forex: 6 caractères = deux codes devise connus (EURUSD, GBPJPY...)
  if (symbol.length === 6) {
    const base = symbol.slice(0, 3);
    const quote = symbol.slice(3, 6);
    if (FOREX_CURRENCIES.has(base) && FOREX_CURRENCIES.has(quote)) {
      return ASSET_TYPES.FOREX;
    }
  }

  // Default -> Stock (AAPL, MSFT, NVDA, w koulchi akhor)
  return ASSET_TYPES.STOCK;
}

// ==================================================================
// 4) PROVIDER: CRYPTO (Binance via ccxt)
// ==================================================================

let binanceClient = null;
function getBinanceClient() {
  if (!binanceClient) {
    binanceClient = new ccxt.binance({ enableRateLimit: true });
  }
  return binanceClient;
}

async function fetchCryptoBatch(symbols) {
  if (symbols.length === 0) return {};

  const exchange = getBinanceClient();
  const pairs = symbols.map((s) => `${s}/USDT`);
  const result = {};

  try {
    const tickers = await exchange.fetchTickers(pairs);
    for (const symbol of symbols) {
      const ticker = tickers[`${symbol}/USDT`];
      if (ticker) {
        result[symbol] = {
          price: ticker.last,
          changeRaw: ticker.percentage ?? 0,
          high24h: ticker.high ?? null,
          low24h: ticker.low ?? null,
          volume: ticker.quoteVolume ?? ticker.baseVolume ?? null,
        };
      } else {
        result[symbol] = null;
      }
    }
  } catch (err) {
    console.error('[livePrices] Binance batch fetch failed:', err.message);
    symbols.forEach((s) => { result[s] = null; });
  }

  return result;
}

// ==================================================================
// 5) PROVIDER: STOCKS / ETF / FOREX / COMMODITY (Yahoo Finance)
// ==================================================================

function toYahooTicker(symbol, assetType) {
  if (assetType === ASSET_TYPES.FOREX) return `${symbol}=X`;
  if (assetType === ASSET_TYPES.COMMODITY) return COMMODITY_YAHOO_MAP[symbol] || symbol;
  return symbol; // stock / etf
}

async function fetchYahooBatch(symbolsWithType) {
  if (symbolsWithType.length === 0) return {};

  const result = {};
  const yahooTickers = symbolsWithType.map(({ symbol, assetType }) =>
    toYahooTicker(symbol, assetType)
  );

  try {
    const quotes = await yahooFinance.quote(yahooTickers);
    const quotesArray = Array.isArray(quotes) ? quotes : [quotes];
    const quoteByTicker = new Map(quotesArray.map((q) => [q.symbol, q]));

    for (const { symbol, assetType } of symbolsWithType) {
      const yTicker = toYahooTicker(symbol, assetType);
      const q = quoteByTicker.get(yTicker);
      if (q && typeof q.regularMarketPrice === 'number') {
        result[symbol] = {
          price: q.regularMarketPrice,
          changeRaw: q.regularMarketChangePercent ?? 0,
          high24h: q.regularMarketDayHigh ?? null,
          low24h: q.regularMarketDayLow ?? null,
          volume: q.regularMarketVolume ?? null,
        };
      } else {
        result[symbol] = null;
      }
    }
  } catch (err) {
    console.error('[livePrices] Yahoo batch fetch failed:', err.message);
    // Fallback: haweel wa7ed wa7ed bach ma tt-block-ch l batch kamla
    for (const { symbol, assetType } of symbolsWithType) {
      try {
        const q = await yahooFinance.quote(toYahooTicker(symbol, assetType));
        result[symbol] = q
          ? {
              price: q.regularMarketPrice,
              changeRaw: q.regularMarketChangePercent ?? 0,
              high24h: q.regularMarketDayHigh ?? null,
              low24h: q.regularMarketDayLow ?? null,
              volume: q.regularMarketVolume ?? null,
            }
          : null;
      } catch {
        result[symbol] = null;
      }
    }
  }

  return result;
}

// ==================================================================
// 6) MAIN ENTRY POINT — hada wahed li ghay3eyto l controllers
// ==================================================================

/**
 * @param {string[]} symbols  ex: ['BTC','ETH','AAPL','SPY','EURUSD','XAUUSD']
 * @returns {Promise<Object>} { SYMBOL: { price, changeRaw } | null }
 */
async function getLivePrices(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return {};

  const uniqueSymbols = [...new Set(symbols.map((s) => s.toUpperCase().trim()))];
  const output = {};
  const toFetch = { crypto: [], yahoo: [] };

  // 1. Check cache dyal kol symbol
  for (const symbol of uniqueSymbols) {
    const cached = cache.get(symbol);
    if (cached) {
      output[symbol] = cached;
      continue;
    }

    const assetType = detectAssetType(symbol);
    if (assetType === ASSET_TYPES.CRYPTO) {
      toFetch.crypto.push(symbol);
    } else {
      toFetch.yahoo.push({ symbol, assetType });
    }
  }

  // 2. Fetch li ma kanch f cache, f parallel
  const [cryptoResults, yahooResults] = await Promise.all([
    fetchCryptoBatch(toFetch.crypto),
    fetchYahooBatch(toFetch.yahoo),
  ]);

  // 3. Merge + cache
  for (const [symbol, data] of Object.entries({ ...cryptoResults, ...yahooResults })) {
    output[symbol] = data;
    if (data) cache.set(symbol, data);
  }

  return output;
}

module.exports = {
  getLivePrices,
  detectAssetType, // exported for unit tests / debugging
  _cache: cache,    // exported for a /debug/cache-stats endpoint if bghiti
};