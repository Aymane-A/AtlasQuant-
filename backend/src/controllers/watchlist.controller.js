/**
 * controllers/watchlist.controller.js
 */
const db     = require('../config/db');
const logger = require('../utils/logger');
const axios  = require('axios');

// yahoo-finance2 v3+ requires explicit instantiation — the old
// `require('yahoo-finance2').default` singleton pattern (v2) no
// longer works and throws "Call `new YahooFinance()` first."
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── Symbol mapping (Binance → Display) ────────────────────
function toDisplaySymbol(sym) {
    const MAP = {
        'BTCUSDT':'BTC/USDT',   'ETHUSDT':'ETH/USDT',   'BNBUSDT':'BNB/USDT',
        'SOLUSDT':'SOL/USDT',   'XRPUSDT':'XRP/USDT',   'ADAUSDT':'ADA/USDT',
        'AVAXUSDT':'AVAX/USDT', 'DOGEUSDT':'DOGE/USDT',  'LINKUSDT':'LINK/USDT',
        'UNIUSDT':'UNI/USDT',   'AAVEUSDT':'AAVE/USDT',  'MATICUSDT':'MATIC/USDT',
        'ARBUSDT':'ARB/USDT',   'OPUSDT':'OP/USDT',      'SHIBUSDT':'SHIB/USDT',
        'PEPEUSDT':'PEPE/USDT',
    };
    return MAP[sym] || sym;
}

// ── Normalize forex/commodity symbols ──────────────────────
// Handles cases where symbol was stored without a slash
// (e.g. "EURUSD" instead of "EUR/USD"), so YF_MAP lookups
// don't silently fail and fall through to a raw invalid ticker.
function normalizeForexSymbol(sym) {
    if (!sym) return sym;
    const clean = sym.toUpperCase().trim();

    if (clean.includes('/')) return clean;

    // Known 6-letter forex pairs without slash (EURUSD → EUR/USD)
    const KNOWN_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD'];
    if (KNOWN_PAIRS.includes(clean)) {
        return clean.slice(0, 3) + '/' + clean.slice(3);
    }

    // Known commodity aliases without slash
    const COMMODITY_ALIASES = {
        'XAUUSD': 'XAU/USD',
        'XAGUSD': 'XAG/USD',
        'OILUSD': 'OIL/USD',
        'GOLD':   'XAU/USD',
        'SILVER': 'XAG/USD',
    };
    if (COMMODITY_ALIASES[clean]) return COMMODITY_ALIASES[clean];

    return clean;
}

// ── Forex/Commodity symbol → Yahoo Finance ticker map ───────
// Kept at module scope so both getLivePrice() and getSparklineData()
// share the same mapping instead of duplicating it.
const YF_MAP = {
    'XAU/USD': 'GC=F',     'XAG/USD': 'SI=F',
    'OIL/USD': 'CL=F',     'EUR/USD':  'EURUSD=X',
    'GBP/USD': 'GBPUSD=X', 'USD/JPY':  'JPY=X',
    'USD/CHF': 'CHF=X',    'AUD/USD':  'AUDUSD=X',
    'SPY':     'SPY',       'QQQ':      'QQQ',
    'NGAS':    'NG=F',
};

// ── Live price fetcher ─────────────────────────────────────
async function getLivePrice(symbol) {
    try {
        // Crypto (Binance)
        if (!symbol.includes('/') && (symbol.endsWith('USDT') || symbol.endsWith('BTC'))) {
            const { data } = await axios.get(
                `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
                { timeout: 5000 }
            );
            return {
                price:   parseFloat(data.lastPrice),
                change:  parseFloat(data.priceChangePercent),
                high24h: parseFloat(data.highPrice),
                low24h:  parseFloat(data.lowPrice),
                volume:  parseFloat(data.quoteVolume),
            };
        }

        // Forex / Commodities (Yahoo Finance)
        const normalizedSymbol = normalizeForexSymbol(symbol);
        const yfSym = YF_MAP[normalizedSymbol] || YF_MAP[symbol] || normalizedSymbol;

        const quote = await yahooFinance.quote(yfSym);

        // Yahoo can resolve a ticker but return no market price (e.g. delisted/closed market)
        if (!quote || quote.regularMarketPrice === undefined) {
            logger.error(`[watchlist] getLivePrice(${symbol}): yfSym="${yfSym}" returned no regularMarketPrice`);
        }

        return {
            price:   quote?.regularMarketPrice        || 0,
            change:  quote?.regularMarketChangePercent || 0,
            high24h: quote?.regularMarketDayHigh       || 0,
            low24h:  quote?.regularMarketDayLow        || 0,
            volume:  quote?.regularMarketVolume         || 0,
        };
    } catch (err) {
        logger.error(`[watchlist] getLivePrice(${symbol}): ${err.message}`);
        return { price: 0, change: 0, high24h: 0, low24h: 0, volume: 0 };
    }
}

// ── Format volume ──────────────────────────────────────────
function fmtVolume(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v?.toString() || '—';
}

// ── Sparkline data (last ~24 points for mini chart) ─────────
async function getSparklineData(symbol) {
    try {
        // Crypto (Binance) — hourly closes over the last 24h
        if (!symbol.includes('/') && (symbol.endsWith('USDT') || symbol.endsWith('BTC'))) {
            const { data } = await axios.get(
                `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=24`,
                { timeout: 5000 }
            );
            return data.map(k => parseFloat(k[4])); // close price is index 4
        }

        // Forex / Commodities (Yahoo Finance) — 15m closes over the last day
        const normalizedSymbol = normalizeForexSymbol(symbol);
        const yfSym = YF_MAP[normalizedSymbol] || YF_MAP[symbol] || normalizedSymbol;

        const now     = new Date();
        const period1 = new Date(now);
        period1.setDate(period1.getDate() - 1);

        const result = await yahooFinance.chart(yfSym, {
            period1:  period1.toISOString().split('T')[0],
            period2:  now.toISOString().split('T')[0],
            interval: '15m',
        });

        if (!result?.quotes?.length) return [];

        return result.quotes
            .filter(q => q.close)
            .slice(-24)
            .map(q => q.close);
    } catch (err) {
        logger.error(`[watchlist] getSparklineData(${symbol}): ${err.message}`);
        return []; // frontend already handles empty sparkline gracefully
    }
}

// ── GET /api/watchlist ─────────────────────────────────────
async function getWatchlist(req, res) {
    try {
        const { rows } = await db.query(
            'SELECT symbol FROM watchlist WHERE user_id = $1',
            [req.user.id]
        );

        const stocks = await Promise.all(
            rows.map(async r => {
                const [priceData, sigRow, sparkline] = await Promise.all([
                    getLivePrice(r.symbol),
                    db.query(
                        `SELECT signal, confidence FROM signals
                         WHERE symbol = $1
                         ORDER BY created_at DESC LIMIT 1`,
                        [toDisplaySymbol(r.symbol)]
                    ),
                    getSparklineData(r.symbol),
                ]);

                const sig = sigRow.rows[0];

                return {
                    sym:        r.symbol,
                    symbol:     r.symbol,
                    price:      priceData.price,
                    change:     priceData.change,
                    high24h:    priceData.high24h,
                    low24h:     priceData.low24h,
                    volume:     fmtVolume(priceData.volume),
                    signal:     sig?.signal     || null,
                    confidence: sig?.confidence || null,
                    sparkline,
                };
            })
        );

        res.json({ success: true, stocks });
    } catch (err) {
        logger.error(`[watchlist] getWatchlist: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

// ── POST /api/watchlist ────────────────────────────────────
async function addSymbol(req, res) {
    try {
        const { symbol } = req.body;
        if (!symbol) return res.status(400).json({ success: false, error: 'Symbol required' });

        // Normalize before storing so forex/commodity symbols are
        // saved consistently (e.g. always "EUR/USD", not "EURUSD").
        const cleanSymbol = normalizeForexSymbol(symbol.toUpperCase().trim());

        await db.query(
            'INSERT INTO watchlist (user_id, symbol) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [req.user.id, cleanSymbol]
        );
        res.json({ success: true, message: 'Symbole ajouté' });
    } catch (err) {
        logger.error(`[watchlist] addSymbol: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

// ── DELETE /api/watchlist/:sym ─────────────────────────────
async function removeSymbol(req, res) {
    try {
        const symbol = decodeURIComponent(req.params.sym).toUpperCase();
        await db.query(
            'DELETE FROM watchlist WHERE user_id = $1 AND symbol = $2',
            [req.user.id, symbol]
        );
        res.json({ success: true, message: 'Symbole supprimé' });
    } catch (err) {
        logger.error(`[watchlist] removeSymbol: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

module.exports = { getWatchlist, addSymbol, removeSymbol };