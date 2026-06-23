/**
 * routes/prices.routes.js — AtlasQuant AI
 * * هاد الـ route كيجيب أسعار الأسهم من Yahoo Finance
 * ومحمي بـ Rate Limiter باش نحميو السيرفر ديالنا والـ API Provider
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();
const { rateLimiter } = require('../middleware/rateLimit.middleware');

// الرموز الافتراضية
const DEFAULT_SYMBOLS = 'AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,PLTR';

router.get('/stocks', rateLimiter(10), async (req, res) => {
  try {
    // 1. تنظيف المدخلات (Sanitization)
    const symbols = (req.query.symbols || DEFAULT_SYMBOLS).replace(/[^a-zA-Z,]/g, '');
    
    // 2. طلب البيانات من المصدر
    const { data } = await axios.get(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`,
      { 
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5000 // حماية ضد التعليق (Timeout)
      }
    );

    // 3. التحقق من صحة الاستجابة
    if (!data.quoteResponse?.result) {
      return res.status(404).json({ success: false, error: 'No data found for these symbols' });
    }

    // 4. معالجة البيانات (Mapping)
    const quotes = data.quoteResponse.result.map(q => ({
      symbol: q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChangePercent,
      up: q.regularMarketChangePercent >= 0,
    }));

    res.status(200).json({ success: true, data: quotes });

  } catch (err) {
    // 5. تسجيل الخطأ بشكل احترافي
    console.error(`[PricesRoute Error]: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to fetch market data' });
  }
});

module.exports = router;