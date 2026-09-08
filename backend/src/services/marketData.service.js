const axios  = require("axios");
const logger = require("../utils/logger");
const env    = require("../config/env");
const YahooFinance  = require("yahoo-finance2").default;
const yahooFinance  = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── API clients ────────────────────────────────────────────
const coinGeckoClient = axios.create({
  baseURL: env.COINGECKO_URL, timeout: 20000,
  headers: env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {},
});

const cmcClient = axios.create({
  baseURL: env.CMC_URL, timeout: 20000,
  headers: { "X-CMC_PRO_API_KEY": env.CMC_API_KEY, Accept: "application/json" },
});

const blockchainClient = axios.create({ baseURL: env.BLOCKCHAIN_URL, timeout: 20000 });

// ── Shared Binance exchange instance (singleton-promise pattern) ──
let _exchange        = null;
let _exchangePromise = null;

async function createBinanceExchange() {
  const ccxt = require("ccxt");
  const ex = new ccxt.binance({
    apiKey: env.BINANCE_API_KEY,
    secret: env.BINANCE_API_SECRET,
    options: {
      defaultType:             "spot",
      // ✅ Fix: ccxt's Binance loadMarkets() fetches spot AND futures (fapi/dapi)
      // exchangeInfo by default, regardless of defaultType — unless fetchMarkets
      // is restricted explicitly. This app only ever uses spot data, and the
      // dapi.binance.com (coin-margined futures) endpoint was timing out on every
      // call (10s each), spamming logs and slowing down every ticker fetch that
      // triggered a market reload. Restricting to spot avoids contacting fapi/dapi
      // entirely.
      fetchMarkets:            ["spot"],
      adjustForTimeDifference: true,
      recvWindow:              60000,
    },
    enableRateLimit: true,
  });
  try {
    await ex.loadTimeDifference();
  } catch (e) {
    logger.warn(`[marketData] Time sync warning: ${e.message}`);
  }
  return ex;
}

async function getBinanceExchange() {
  if (_exchange) return _exchange;
  if (_exchangePromise) return _exchangePromise;

  _exchangePromise = createBinanceExchange()
    .then(ex => {
      _exchange = ex;
      _exchangePromise = null;
      return ex;
    })
    .catch(err => {
      _exchangePromise = null;
      throw err;
    });

  return _exchangePromise;
}

function resetBinanceExchange() {
  _exchange = null;
  _exchangePromise = null;
}

const isTimestampError = (err) =>
  /timestamp/i.test(err?.message || "") || err?.message?.includes("-1021");

// FIX (crypto historical fetch) : mapping timeframe interne → durée en
// ms, utilisé pour avancer `since` d'une page à l'autre sans re-fetcher
// la dernière bougie déjà récupérée.
const TIMEFRAME_MS = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
  "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000, "1w": 604_800_000,
};

// ── 1. BINANCE (Crypto) ─────────────────────────────────────
const fetchOHLCV = async (symbol = "BTC/USDT", timeframe = "1h", limit = 200) => {
  try {
    const exchange = await getBinanceExchange();
    const raw = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    const candles = raw.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp, open, high, low, close, volume,
      date: new Date(timestamp).toISOString(),
    }));
    logger.info(`📊 ${symbol} (${timeframe}) — ${candles.length} candles, latest: $${candles.at(-1).close}`);
    return candles;
  } catch (error) {
    logger.error(`❌ Binance fetchOHLCV error: ${error.message}`);
    if (isTimestampError(error)) resetBinanceExchange();
    return [];
  }
};

/**
 * FIX (crypto historical fetch) : `fetchOHLCV` récupère seulement les N
 * dernières bougies à partir de MAINTENANT (ccxt sans `since`), quelle
 * que soit la période demandée. `fetchOHLCVRange` pagine avec
 * `since`/`until` explicites pour couvrir réellement la période.
 */
const fetchOHLCVRange = async (symbol = "BTC/USDT", timeframe = "1h", sinceMs, untilMs, pageLimit = 1000) => {
  try {
    const exchange = await getBinanceExchange();
    const tfMs = TIMEFRAME_MS[timeframe] || 3_600_000;
    const until = untilMs ?? Date.now();
    let since = sinceMs;
    const all = [];
    const MAX_PAGES = 200;

    let page = 0;
    while (since <= until && page < MAX_PAGES) {
      const raw = await exchange.fetchOHLCV(symbol, timeframe, since, pageLimit);
      if (!raw || raw.length === 0) break;

      let progressed = false;
      for (const [timestamp, open, high, low, close, volume] of raw) {
        if (timestamp > until) continue;
        all.push({ timestamp, open, high, low, close, volume, date: new Date(timestamp).toISOString() });
        progressed = true;
      }

      const lastTs = raw[raw.length - 1][0];
      if (lastTs < since) break;
      since = lastTs + tfMs;
      page++;
      if (!progressed && lastTs > until) break;
    }

    logger.info(
      `📊 ${symbol} (${timeframe}) — ${all.length} candles fetched from ${new Date(sinceMs).toISOString().slice(0, 10)} to ${new Date(until).toISOString().slice(0, 10)}`
    );
    return all;
  } catch (error) {
    logger.error(`❌ Binance fetchOHLCVRange error: ${error.message}`);
    if (isTimestampError(error)) resetBinanceExchange();
    return [];
  }
};

const fetchTicker = async (symbol = "BTC/USDT") => {
  try {
    const exchange = await getBinanceExchange();
    const ticker   = await exchange.fetchTicker(symbol);
    return {
      symbol,
      price:     ticker.last,
      change24h: parseFloat((ticker.percentage || 0).toFixed(2)),
      high24h:   ticker.high,
      low24h:    ticker.low,
      volume24h: ticker.baseVolume,
    };
  } catch (error) {
    logger.error(`❌ fetchTicker error (${symbol}): ${error.message}`);
    if (isTimestampError(error)) resetBinanceExchange();
    return null;
  }
};

// ── Batch ticker fetch (single round-trip instead of N) ────
const fetchMultipleTickers = async (symbols, _isRetry = false) => {
  try {
    const exchange = await getBinanceExchange();
    const tickers  = await exchange.fetchTickers(symbols);
    const results  = {};
    for (const [sym, ticker] of Object.entries(tickers)) {
      results[sym] = {
        symbol:     sym,
        price:      ticker.last,
        change24h:  parseFloat((ticker.percentage || 0).toFixed(2)),
        high24h:    ticker.high,
        low24h:     ticker.low,
        volume24h:  ticker.baseVolume,
      };
    }
    return results;
  } catch (error) {
    logger.error(`❌ fetchMultipleTickers (batch) error: ${error.message}`);
    if (isTimestampError(error)) {
      resetBinanceExchange();
      if (!_isRetry) {
        await new Promise(r => setTimeout(r, 300));
        return fetchMultipleTickers(symbols, true);
      }
    }
    return {};
  }
};

const toExchangeSymbol = (symbol = "BTCUSDT") => {
  if (symbol.includes("/")) return symbol;
  if (symbol.endsWith("USDT")) return `${symbol.slice(0, -4)}/USDT`;
  if (symbol.endsWith("USD"))  return `${symbol.slice(0, -3)}/USD`;
  return symbol;
};

const toRawSymbol = (symbol = "BTC/USDT") => symbol.replace("/", "");

const getCandles = async (symbol = "BTCUSDT", interval = "1h", limit = 200) => {
  return fetchOHLCV(toExchangeSymbol(symbol), interval, limit);
};

/**
 * FIX (crypto historical fetch) : variante de getCandles() qui couvre
 * une fenêtre explicite sinceMs/untilMs (pagination), à utiliser pour
 * tout besoin de données historiques (ex: backtestMarketRouter.service.js).
 */
const getCandlesRange = async (symbol = "BTCUSDT", interval = "1h", sinceMs, untilMs) => {
  return fetchOHLCVRange(toExchangeSymbol(symbol), interval, sinceMs, untilMs);
};

const get24hrStats = async (symbol = "BTCUSDT") => {
  const stats = await fetchTicker(toExchangeSymbol(symbol));
  if (!stats) {
    return { symbol, price: 0, changePct: 0, high24h: 0, low24h: 0, quoteVolume: 0 };
  }
  return {
    symbol:      toRawSymbol(stats.symbol),
    price:       stats.price,
    changePct:   stats.change24h,
    high24h:     stats.high24h,
    low24h:      stats.low24h,
    quoteVolume: stats.volume24h,
  };
};

const getMultiplePrices = async (symbols) => {
  const tickers = await fetchMultipleTickers(symbols.map(toExchangeSymbol));
  return Object.fromEntries(
    Object.entries(tickers).map(([symbol, ticker]) => [
      toRawSymbol(symbol),
      {
        symbol:      toRawSymbol(symbol),
        price:       ticker.price,
        changePct:   ticker.change24h,
        high24h:     ticker.high24h,
        low24h:      ticker.low24h,
        quoteVolume: ticker.volume24h,
      },
    ])
  );
};

// ── 2. COINGECKO ───────────────────────────────────────────
const fetchLowCapGems = async (top = 10, maxMarketCap = 500_000_000) => {
  try {
    logger.info("🔍 Scanning for low-cap gems...");
    const { data } = await coinGeckoClient.get("/coins/markets", {
      params: {
        vs_currency: "usd", order: "volume_desc",
        per_page: 250, page: 1, sparkline: false,
        price_change_percentage: "24h,7d",
      },
    });

    const gems = data
      .filter(coin => {
        const mcap = coin.market_cap || 0;
        const vol  = coin.total_volume || 0;
        if (mcap <= 100_000 || mcap > maxMarketCap) return false;
        return (vol / mcap) >= 0.15;
      })
      .map(coin => {
        const mcap      = coin.market_cap;
        const vol       = coin.total_volume;
        const change24h = coin.price_change_percentage_24h || 0;
        const change7d  = coin.price_change_percentage_7d_in_currency || 0;
        const volRatio  = vol / mcap;
        const score     = volRatio * (1 + Math.max(change24h, 0) / 100);
        return {
          symbol:       coin.symbol.toUpperCase() + "USDT",
          name:         coin.name,
          price:        coin.current_price,
          marketCap:    mcap,
          volume24h:    vol,
          volMcapRatio: parseFloat(volRatio.toFixed(3)),
          change24h:    parseFloat(change24h.toFixed(2)),
          change7d:     parseFloat(change7d.toFixed(2)),
          score:        parseFloat(score.toFixed(4)),
          image:        coin.image,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, top);

    logger.info(`💎 Found ${gems.length} low-cap gems`);
    return gems;
  } catch (error) {
    logger.error(`❌ CoinGecko gem screener error: ${error.message}`);
    return [];
  }
};

const fetchGlobalMarket = async () => {
  try {
    const { data } = await coinGeckoClient.get("/global");
    const d = data.data;
    return {
      totalMarketCap:     d.total_market_cap.usd,
      totalVolume24h:     d.total_volume.usd,
      btcDominance:       parseFloat(d.market_cap_percentage.btc.toFixed(2)),
      ethDominance:       parseFloat(d.market_cap_percentage.eth.toFixed(2)),
      marketCapChange24h: parseFloat(d.market_cap_change_percentage_24h_usd.toFixed(2)),
    };
  } catch (error) {
    logger.error(`❌ CoinGecko global market error: ${error.message}`);
    return null;
  }
};

// ── 3. COINMARKETCAP ───────────────────────────────────────
const fetchTrendingCMC = async (limit = 10) => {
  if (!env.CMC_API_KEY) {
    logger.warn("⚠️  CMC_API_KEY not set — skipping");
    return [];
  }
  try {
    const { data } = await cmcClient.get("/cryptocurrency/listings/latest", {
      params: { limit, sort: "percent_change_24h", sort_dir: "desc" },
    });
    return data.data.map(coin => ({
      name:      coin.name,
      symbol:    coin.symbol,
      price:     coin.quote.USD.price,
      change24h: parseFloat(coin.quote.USD.percent_change_24h.toFixed(2)),
      marketCap: coin.quote.USD.market_cap,
      cmcRank:   coin.cmc_rank,
    }));
  } catch (error) {
    logger.error(`❌ CoinMarketCap error: ${error.message}`);
    return [];
  }
};

// ✅ Fix: fetchFearGreedIndex n'avait aucun cache — chaque appel à
// fetchAllMarkets() (déclenché en boucle par le polling websocket) refaisait
// un appel réseau vers alternative.me. Quand cette API externe est down/rate-
// limited (502), ça spamme les logs à chaque cycle de poll et ça ajoute une
// latence réseau inutile pour une donnée qui ne change qu'une fois par jour.
// On ajoute : (1) un cache TTL de 30 min (largement suffisant, l'index F&G
// est mis à jour ~1×/jour), (2) un fallback sur la dernière valeur connue si
// l'API échoue (mieux qu'un widget vide), (3) un throttle des logs d'erreur
// pour ne pas noyer la console si l'API reste down longtemps.
const FNG_TTL = 30 * 60 * 1000; // 30 min
let fngCache        = null;
let fngCacheStamp   = 0;
let fngLastErrorLog = 0;
const FNG_ERROR_LOG_INTERVAL = 5 * 60 * 1000; // ne log l'erreur qu'une fois toutes les 5 min

const fetchFearGreedIndex = async () => {
  const isFresh = fngCache && (Date.now() - fngCacheStamp < FNG_TTL);
  if (isFresh) return fngCache;

  try {
    const { data } = await axios.get("https://api.alternative.me/fng/?limit=7", { timeout: 10000 });
    const latest = data.data[0];
    const result = {
      value:   parseInt(latest.value),
      label:   latest.value_classification,
      history: data.data.map(d => ({
        value: parseInt(d.value),
        label: d.value_classification,
        date:  new Date(parseInt(d.timestamp) * 1000).toISOString().split("T")[0],
      })),
    };
    fngCache      = result;
    fngCacheStamp = Date.now();
    return result;
  } catch (error) {
    if (Date.now() - fngLastErrorLog > FNG_ERROR_LOG_INTERVAL) {
      logger.error(`❌ Fear & Greed error: ${error.message} (silencié ${FNG_ERROR_LOG_INTERVAL / 60000}min)`);
      fngLastErrorLog = Date.now();
    }
    // Fallback : mieux vaut une valeur périmée qu'un widget vide
    return fngCache || null;
  }
};

// ── 4. BLOCKCHAIN.COM ──────────────────────────────────────
const fetchBitcoinOnChain = async () => {
  try {
    const { data } = await blockchainClient.get("/stats?format=json");
    return {
      marketPriceUSD:    data.market_price_usd,
      marketCap:         data.market_cap_usd,
      hashRate:          data.hash_rate,
      difficulty:        data.difficulty,
      txPerDay:          data.n_tx,
      totalBitcoins:     data.totalbc / 1e8,
      avgTransactionFee: data.cost_per_transaction,
      fetchedAt:         new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`❌ Blockchain.com error: ${error.message}`);
    return null;
  }
};

// ── 5. YAHOO FINANCE (Forex + Commodities) ─────────────────
const FOREX_PAIRS = {
  EURUSD: "EURUSD=X", GBPUSD: "GBPUSD=X", USDJPY: "USDJPY=X",
  USDCHF: "USDCHF=X", AUDUSD: "AUDUSD=X", USDCAD: "USDCAD=X",
  NZDUSD: "NZDUSD=X", EURGBP: "EURGBP=X", EURJPY: "EURJPY=X",
  GBPJPY: "GBPJPY=X", USDCNY: "USDCNY=X", USDMXN: "USDMXN=X",
  USDZAR: "USDZAR=X", USDTRY: "USDTRY=X",
};

const COMMODITY_PAIRS = {
  XAUUSD:  "GC=F",
  XAGUSD:  "SI=F",
  WTI:     "CL=F",
  BRENT:   "BZ=F",
  NATGAS:  "NG=F",
  COPPER:  "HG=F",
  XPTUSD:  "PL=F",
  XPDUSD:  "PA=F",
  CORN:    "ZC=F",
  WHEAT:   "ZW=F",
  SOYBEAN: "ZS=F",
  COFFEE:  "KC=F",
  COTTON:  "CT=F",
  SUGAR:   "SB=F",
};

const fetchYahooTicker = async (displaySymbol, yahooSymbol) => {
  try {
    const q = await yahooFinance.quote(yahooSymbol);
    return {
      symbol:      displaySymbol,
      price:       q.regularMarketPrice,
      changePct:   parseFloat((q.regularMarketChangePercent || 0).toFixed(2)),
      high24h:     q.regularMarketDayHigh,
      low24h:      q.regularMarketDayLow,
      quoteVolume: q.regularMarketVolume || 0,
    };
  } catch (error) {
    logger.error(`❌ Yahoo fetchTicker error (${yahooSymbol}): ${error.message}`);
    return null;
  }
};

// ── Batch Yahoo fetch (single round-trip instead of N) ─────
const fetchMultipleYahooTickers = async (pairMap) => {
  try {
    const entries      = Object.entries(pairMap);
    const yahooSymbols = entries.map(([, ySym]) => ySym);
    const quotes       = await yahooFinance.quote(yahooSymbols);
    const quoteArr     = Array.isArray(quotes) ? quotes : [quotes];

    const bySymbol = Object.fromEntries(quoteArr.filter(Boolean).map(q => [q.symbol, q]));

    const out = {};
    for (const [displaySymbol, yahooSymbol] of entries) {
      const q = bySymbol[yahooSymbol];
      if (!q) continue;
      out[displaySymbol] = {
        symbol:      displaySymbol,
        price:       q.regularMarketPrice,
        changePct:   parseFloat((q.regularMarketChangePercent || 0).toFixed(2)),
        high24h:     q.regularMarketDayHigh,
        low24h:      q.regularMarketDayLow,
        quoteVolume: q.regularMarketVolume || 0,
      };
    }
    return out;
  } catch (error) {
    logger.error(`❌ Yahoo fetchMultipleTickers (batch) error: ${error.message}`);
    return {};
  }
};

const getForexPrices      = () => fetchMultipleYahooTickers(FOREX_PAIRS);
const getCommodityPrices  = () => fetchMultipleYahooTickers(COMMODITY_PAIRS);

const YAHOO_INTERVAL_MAP = { "15m": "15m", "1h": "60m", "4h": "60m", "1d": "1d" };

const aggregateTo4h = (hourly) => {
  const out = [];
  for (let i = 0; i < hourly.length; i += 4) {
    const chunk = hourly.slice(i, i + 4);
    if (!chunk.length) continue;
    out.push({
      timestamp: chunk[0].timestamp,
      date:      chunk[0].date,
      open:      chunk[0].open,
      high:      Math.max(...chunk.map(c => c.high)),
      low:       Math.min(...chunk.map(c => c.low)),
      close:     chunk.at(-1).close,
      volume:    chunk.reduce((s, c) => s + (c.volume || 0), 0),
    });
  }
  return out;
};

const fetchYahooCandles = async (yahooSymbol, interval = "1d", limit = 200) => {
  try {
    const yInterval   = YAHOO_INTERVAL_MAP[interval] || "1d";
    const isIntraday  = yInterval !== "1d";
    const period1 = new Date();
    period1.setDate(period1.getDate() - (isIntraday ? 7 : Math.max(limit, 30)));

    const result = await yahooFinance.chart(yahooSymbol, {
      period1, period2: new Date(), interval: yInterval,
    });

    let candles = (result.quotes || [])
      .filter(q => q.close != null)
      .map(q => ({
        timestamp: new Date(q.date).getTime(),
        date:      new Date(q.date).toISOString(),
        open: q.open, high: q.high, low: q.low, close: q.close,
        volume: q.volume || 0,
      }));

    if (interval === "4h") candles = aggregateTo4h(candles);
    return candles.slice(-limit);
  } catch (error) {
    logger.error(`❌ Yahoo fetchCandles error (${yahooSymbol}): ${error.message}`);
    return [];
  }
};

const getBenchmarkHistory = async (
    symbol,
    limit = 30
) => {

    const clean = symbol.toUpperCase().replace("/", "");

    let yahooSymbol;

    if (clean === "BTC")
        yahooSymbol = "BTC-USD";
    else if (clean === "SPY")
        yahooSymbol = "SPY";
    else if (FOREX_PAIRS[clean])
        yahooSymbol = FOREX_PAIRS[clean];
    else if (COMMODITY_PAIRS[clean])
        yahooSymbol = COMMODITY_PAIRS[clean];
    else
        throw new Error(`Unsupported benchmark ${symbol}`);

    const candles = await fetchYahooCandles(
        yahooSymbol,
        "1d",
        limit
    );

    return candles;
};


// ── 6. UNIFIED ASSET ROUTER (crypto / forex / commodity) ───
const detectAssetType = (symbol = "") => {
  const clean = symbol.toUpperCase().replace("/", "");
  if (FOREX_PAIRS[clean])     return "forex";
  if (COMMODITY_PAIRS[clean]) return "commodity";
  return "crypto";
};

const getUnifiedCandles = async (symbol, interval = "1h", limit = 200) => {
  const clean = symbol.toUpperCase().replace("/", "");
  const type  = detectAssetType(clean);
  if (type === "forex")     return fetchYahooCandles(FOREX_PAIRS[clean], interval, limit);
  if (type === "commodity") return fetchYahooCandles(COMMODITY_PAIRS[clean], interval, limit);
  return getCandles(symbol, interval, limit);
};

const getUnifiedStats = async (symbol) => {
  const clean = symbol.toUpperCase().replace("/", "");
  const type  = detectAssetType(clean);
  if (type === "forex")     return fetchYahooTicker(clean, FOREX_PAIRS[clean]);
  if (type === "commodity") return fetchYahooTicker(clean, COMMODITY_PAIRS[clean]);
  return get24hrStats(symbol);
};

// ── MASTER FUNCTION ────────────────────────────────────────
const fetchAllMarkets = async () => {
  logger.info("🌐 Refreshing all market data...");
  const [btc, eth, sol, global, fearGreed, onChain] = await Promise.allSettled([
    fetchOHLCV("BTC/USDT", "1h", 200),
    fetchOHLCV("ETH/USDT", "1h", 200),
    fetchOHLCV("SOL/USDT", "1h", 200),
    fetchGlobalMarket(),
    fetchFearGreedIndex(),
    fetchBitcoinOnChain(),
  ]);
  const gems     = await fetchLowCapGems(10);
  const trending = await fetchTrendingCMC(10);
  return {
    candles: {
      "BTC/USDT": btc.status      === "fulfilled" ? btc.value      : [],
      "ETH/USDT": eth.status      === "fulfilled" ? eth.value      : [],
      "SOL/USDT": sol.status      === "fulfilled" ? sol.value      : [],
    },
    global:    global.status    === "fulfilled" ? global.value    : null,
    fearGreed: fearGreed.status === "fulfilled" ? fearGreed.value : null,
    onChain:   onChain.status   === "fulfilled" ? onChain.value   : null,
    gems, trending,
    fetchedAt: new Date().toISOString(),
  };
};



module.exports = {
  getCandles, getCandlesRange, get24hrStats, getMultiplePrices,
  fetchOHLCV, fetchOHLCVRange, fetchTicker, fetchMultipleTickers,
  fetchLowCapGems, fetchGlobalMarket,
  fetchTrendingCMC, fetchFearGreedIndex,
  fetchBitcoinOnChain, fetchAllMarkets,
  FOREX_PAIRS, COMMODITY_PAIRS,
  getForexPrices, getCommodityPrices,
  detectAssetType, getUnifiedCandles, getUnifiedStats,
  getBenchmarkHistory,
};