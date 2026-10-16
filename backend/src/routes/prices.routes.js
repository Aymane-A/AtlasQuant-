/**
 * routes/prices.routes.js — AtlasQuant AI
 * yahoo-finance2 + cache + in-flight dedup
 */

const express = require('express');
const router = express.Router();

const { rateLimiter } = require('../middleware/rateLimit.middleware');
const stockQuotes = require('../services/stockQuotes.service');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const DEFAULT_SYMBOLS =
  'AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,PLTR';



// Supported stock universe for this PUBLIC route. Override with
// PRICES_ALLOWED_SYMBOLS=AAPL,MSFT,... (comma-separated). It only protects the
// Yahoo rate limit for anonymous callers: authenticated server-side code
// (portfolio) calls services/stockQuotes.service directly, with no 9-symbol cap.
const ALLOWED_SYMBOLS = new Set(
  (process.env.PRICES_ALLOWED_SYMBOLS || DEFAULT_SYMBOLS)
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);

// ─────────────────────────────────────────────
// GET /api/prices/stocks
// ─────────────────────────────────────────────

router.get('/stocks', rateLimiter(10), async (req, res) => {
  try {
    const rawSymbols = String(req.query.symbols || DEFAULT_SYMBOLS)
      .replace(/[^a-zA-Z,]/g, '')
      .toUpperCase();

    const symbols = [...new Set(rawSymbols.split(',').filter(s => ALLOWED_SYMBOLS.has(s)))];

    const { quotes, cacheHits, staticFalls } = await stockQuotes.getStockQuotes(symbols);

    if (!quotes.length) {
      return res.status(503).json({ success: false, error: 'Market data temporarily unavailable' });
    }

    res.json({
      success: true,
      data: quotes,
      meta: {
        total:     quotes.length,
        cached:    cacheHits,
        static:    staticFalls,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[PricesRoute Error]', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch market data' });
  }
});

// dev cache clear
if (process.env.NODE_ENV === 'development') {
  router.delete('/stocks/cache', (req, res) => {
    res.json({ success: true, message: `Cleared ${stockQuotes.clearCache()} cached quotes` });
  });
}

module.exports = router;
