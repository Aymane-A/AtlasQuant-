/**
 * controllers/watchlist.controller.js
 */
const db     = require('../config/db');
const logger = require('../utils/logger');
const axios  = require('axios');

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const { getLivePrices } = require('../services/livePrices.service');
const { resolveSymbol } = require('../services/symbolResolver.service');

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

function normalizeForexSymbol(sym) {
    if (!sym) return sym;
    const clean = sym.toUpperCase().trim();

    if (clean.includes('/')) return clean;

    const KNOWN_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD'];
    if (KNOWN_PAIRS.includes(clean)) {
        return clean.slice(0, 3) + '/' + clean.slice(3);
    }

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

const YF_MAP = {
    'XAU/USD': 'GC=F',     'XAG/USD': 'SI=F',
    'OIL/USD': 'CL=F',     'EUR/USD':  'EURUSD=X',
    'GBP/USD': 'GBPUSD=X', 'USD/JPY':  'JPY=X',
    'USD/CHF': 'CHF=X',    'AUD/USD':  'AUDUSD=X',
    'SPY':     'SPY',       'QQQ':      'QQQ',
    'NGAS':    'NG=F',
};

function toBaseSymbol(dbSymbol) {
    if (!dbSymbol) return dbSymbol;
    const s = dbSymbol.toUpperCase().trim();
    if (s.includes('/')) return s.replace('/', '');
    if (s.endsWith('USDT')) return s.slice(0, -4);
    return s;
}

function fmtVolume(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v?.toString() || '—';
}

async function getSparklineData(symbol) {
    try {
        if (!symbol.includes('/') && (symbol.endsWith('USDT') || symbol.endsWith('BTC'))) {
            const { data } = await axios.get(
                `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=24`,
                { timeout: 5000 }
            );
            return data.map(k => parseFloat(k[4]));
        }

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
        return [];
    }
}

async function getWatchlist(req, res) {
    try {
        const { rows } = await db.query(
            'SELECT symbol FROM watchlist WHERE user_id = $1',
            [req.user.id]
        );

        if (rows.length === 0) {
            return res.json({ success: true, stocks: [] });
        }

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

        // ✅ Fix — 2026-09-26: résolution fuzzy AVANT normalizeForexSymbol.
        // Corrige les fautes de frappe (crypto/forex/commodity/indices/
        // equities) avant que le symbole n'entre dans le pipeline existant.
        // Si resolveSymbol ne trouve rien d'assez proche (matchType
        // 'unresolved'), on garde le comportement d'origine tel quel —
        // aucune régression sur les symboles déjà corrects.
        const resolution   = await resolveSymbol(symbol);
        const symbolToUse  = resolution.matchType !== 'unresolved' ? resolution.resolved : symbol;

        const cleanSymbol = normalizeForexSymbol(symbolToUse.toUpperCase().trim());
        const baseSymbol   = toBaseSymbol(cleanSymbol);

        const livePrices = await getLivePrices([baseSymbol]);
        const priceData  = livePrices[baseSymbol];

        if (!priceData || !priceData.price) {
            return res.status(400).json({
                success: false,
                error: `"${symbol}" n'est pas un symbole reconnu (Crypto/Forex/Commodity/Equity)`,
            });
        }

        await db.query(
            'INSERT INTO watchlist (user_id, symbol) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [req.user.id, cleanSymbol]
        );

        const wasCorrected = resolution.matchType === 'fuzzy' || resolution.matchType === 'search';

        res.json({
            success: true,
            message: wasCorrected ? `Symbole ajouté (corrigé : "${symbol}" → "${cleanSymbol}")` : 'Symbole ajouté',
            suggestion: wasCorrected ? { from: symbol.toUpperCase().trim(), to: cleanSymbol } : null,
        });
    } catch (err) {
        logger.error(`[watchlist] addSymbol: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

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