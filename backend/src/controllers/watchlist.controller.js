/**
 * controllers/watchlist.controller.js
 */
const db     = require('../config/db');
const logger = require('../utils/logger');
const axios  = require('axios');

// yahoo-finance2 v3+ requires explicit instantiation — the old
// `require('yahoo-finance2').default` singleton pattern (v2) no
// longer works and throws "Call `new YahooFinance()` first."
// Still needed here for getSparklineData() (historical chart data,
// which lives outside the live-price service — see note below).
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const { getLivePrices } = require('../services/livePrices.service');

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
// (e.g. "EURUSD" instead of "EUR/USD"), so lookups
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
// Kept at module scope — still used by getSparklineData() to resolve
// chart tickers (Yahoo's chart() endpoint needs its own ticker format,
// same as before).
const YF_MAP = {
    'XAU/USD': 'GC=F',     'XAG/USD': 'SI=F',
    'OIL/USD': 'CL=F',     'EUR/USD':  'EURUSD=X',
    'GBP/USD': 'GBPUSD=X', 'USD/JPY':  'JPY=X',
    'USD/CHF': 'CHF=X',    'AUD/USD':  'AUDUSD=X',
    'SPY':     'SPY',       'QQQ':      'QQQ',
    'NGAS':    'NG=F',
};

// ── DB symbol format → livePrices.service bare-symbol format ──
// Watchlist stores symbols the way each source naturally names them
// ("BTCUSDT" for crypto pairs, "EUR/USD" for forex/commodities,
// "SPY" for ETFs). livePrices.service works with bare tickers
// ("BTC", "EURUSD", "SPY") and does its own asset-type detection —
// this bridges the two formats in both directions.
function toBaseSymbol(dbSymbol) {
    if (!dbSymbol) return dbSymbol;
    const s = dbSymbol.toUpperCase().trim();
    if (s.includes('/')) return s.replace('/', '');   // EUR/USD  -> EURUSD
    if (s.endsWith('USDT')) return s.slice(0, -4);     // BTCUSDT  -> BTC
    return s;                                          // SPY, AAPL, etc — already bare
}

// ── Format volume ──────────────────────────────────────────
function fmtVolume(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v?.toString() || '—';
}

// ── Sparkline data (last ~24 points for mini chart) ─────────
// NOTE: intentionally NOT part of livePrices.service — that service
// is a single current price/change snapshot per symbol (5min cache),
// while this needs a short historical series per symbol. Different
// shape, different caching needs (chart candles shouldn't be cached
// the same way a live quote is). Kept here, calling Binance/Yahoo
// directly as before.
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

        if (rows.length === 0) {
            return res.json({ success: true, stocks: [] });
        }

        // ── Single batched call for ALL watchlist symbols ──
        // Before: one Binance/Yahoo request PER symbol PER row (via
        // Promise.all -> getLivePrice). Now: one call to the shared
        // service, which itself batches per-provider and uses its
        // 5min cache — so a watchlist shared across pages (Watchlist,
        // Dashboard, Screener...) hits Binance/Yahoo far less often.
        const dbSymbols   = rows.map(r => r.symbol);
        const baseSymbols = dbSymbols.map(toBaseSymbol);
        const livePrices  = await getLivePrices(baseSymbols);

        const stocks = await Promise.all(
            rows.map(async r => {
                const priceData = livePrices[toBaseSymbol(r.symbol)] || {};

                const [sigRow, sparkline] = await Promise.all([
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
                    price:      priceData.price   ?? 0,
                    change:     priceData.changeRaw ?? 0,
                    high24h:    priceData.high24h ?? 0,
                    low24h:     priceData.low24h  ?? 0,
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