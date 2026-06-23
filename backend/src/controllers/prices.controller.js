/**
 * controllers/prices.controller.js
 */
const axios = require('axios');
const logger = require('../utils/logger');

// دالة لجلب الأسعار
async function getStockPrices(req, res) {
    try {
        const symbols = req.query.symbols || 'AAPL,MSFT,NVDA';
        
        // 1. طلب الداتا من Yahoo Finance
        const { data } = await axios.get(
            `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );

        // 2. تحويل الداتا للشكل اللي كيبغيه الـ Frontend (Normalization)
        const formattedData = data.quoteResponse.result.map(q => ({
            symbol: q.symbol,
            price: q.regularMarketPrice,
            change: q.regularMarketChangePercent?.toFixed(2) + '%',
            isPositive: q.regularMarketChangePercent >= 0
        }));

        // 3. إرسال الرد
        res.status(200).json({ success: true, data: formattedData });

    } catch (err) {
        logger.error(`[PricesController] Error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Impossible de charger les prix' });
    }
}

module.exports = { getStockPrices };