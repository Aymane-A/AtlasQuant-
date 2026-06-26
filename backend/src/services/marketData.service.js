const axios  = require("axios");
const logger = require("../utils/logger");
const env    = require("../config/env");

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

// ── Shared Binance exchange instance (lazy ccxt load) ──────
// ccxt is NOT required at the top level — it's ~50MB and crashes
// the heap if loaded at startup. It's required lazily here instead.
let _exchange = null;
async function getBinanceExchange() {
  if (!_exchange) {
    const ccxt = require("ccxt"); // ← lazy: only loaded on first actual use
    _exchange = new ccxt.binance({
      apiKey: env.BINANCE_API_KEY,
      secret: env.BINANCE_API_SECRET,
      options: {
        defaultType:             "spot",
        adjustForTimeDifference: true,
      },
      enableRateLimit: true,
    });
    try {
      await _exchange.loadTimeDifference();
    } catch (e) {
      logger.warn(`[marketData] Time sync warning: ${e.message}`);
    }
  }
  return _exchange;
}

// ── 1. BINANCE ─────────────────────────────────────────────
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
    _exchange = null;
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
    _exchange = null;
    return null;
  }
};

const fetchMultipleTickers = async (symbols) => {
  const results = {};
  for (const sym of symbols) {
    const ticker = await fetchTicker(sym);
    if (ticker) results[sym] = ticker;
    await new Promise(r => setTimeout(r, 300));
  }
  return results;
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

const fetchFearGreedIndex = async () => {
  try {
    const { data } = await axios.get("https://api.alternative.me/fng/?limit=7");
    const latest = data.data[0];
    return {
      value:   parseInt(latest.value),
      label:   latest.value_classification,
      history: data.data.map(d => ({
        value: parseInt(d.value),
        label: d.value_classification,
        date:  new Date(parseInt(d.timestamp) * 1000).toISOString().split("T")[0],
      })),
    };
  } catch (error) {
    logger.error(`❌ Fear & Greed error: ${error.message}`);
    return null;
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
  getCandles, get24hrStats, getMultiplePrices,
  fetchOHLCV, fetchTicker, fetchMultipleTickers,
  fetchLowCapGems, fetchGlobalMarket,
  fetchTrendingCMC, fetchFearGreedIndex,
  fetchBitcoinOnChain, fetchAllMarkets,
};