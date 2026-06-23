/**
 * controllers/watchlist.controller.js
 */
const db     = require('../config/db');
const logger = require('../utils/logger');
const axios  = require('axios');

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
        const YF_MAP = {
            'XAU/USD': 'GC=F',     'XAG/USD': 'SI=F',
            'OIL/USD': 'CL=F',     'EUR/USD':  'EURUSD=X',
            'GBP/USD': 'GBPUSD=X', 'USD/JPY':  'JPY=X',
            'USD/CHF': 'CHF=X',    'AUD/USD':  'AUDUSD=X',
            'SPY':     'SPY',       'QQQ':      'QQQ',
            'NGAS':    'NG=F',
        };
        const yfSym = YF_MAP[symbol] || symbol;
        const yahooFinance = require('yahoo-finance2').default;
        const quote = await yahooFinance.quote(yfSym);
        return {
            price:   quote.regularMarketPrice        || 0,
            change:  quote.regularMarketChangePercent || 0,
            high24h: quote.regularMarketDayHigh       || 0,
            low24h:  quote.regularMarketDayLow        || 0,
            volume:  quote.regularMarketVolume         || 0,
        };
    } catch {
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

// ── GET /api/watchlist ─────────────────────────────────────
async function getWatchlist(req, res) {
    try {
        const { rows } = await db.query(
            'SELECT symbol FROM watchlist WHERE user_id = $1',
            [req.user.id]
        );

        const stocks = await Promise.all(
            rows.map(async r => {
                const [priceData, sigRow] = await Promise.all([
                    getLivePrice(r.symbol),
                    db.query(
                        `SELECT signal, confidence FROM signals
                         WHERE symbol = $1
                         ORDER BY created_at DESC LIMIT 1`,
                        [toDisplaySymbol(r.symbol)]
                    ),
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

        const cleanSymbol = symbol.toUpperCase().trim();

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