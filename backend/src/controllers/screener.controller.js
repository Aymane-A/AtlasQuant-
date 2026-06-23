/**
 * src/controllers/screener.controller.js
 */
const db = require('../config/db');
const logger = require('../utils/logger');

async function runScreen(req, res) {
    try {
        const userId = req.user.id;
        const { criteria, market } = req.body;

        // 1. Validation: التأكد من معايير الفلترة
        if (!criteria || !market) {
            return res.status(400).json({ success: false, error: 'Invalid screen parameters' });
        }

        logger.info(`[Screener] User ${userId} running screen on ${market}`);

        // 2. منطق الـ Screener:
        // هنا ستقوم باستعلام قاعدة البيانات أو الـ Service الخاصة بك لاستخراج الأصول
        // التي تطابق المعايير (مثلاً: RSI < 30 أو Volume > 1M)
        const results = await performScreeningLogic(market, criteria);

        // 3. الحفظ (اختياري): حفظ آخر عملية بحث للمستخدم
        await db.query(
            'INSERT INTO screen_history (user_id, criteria, results_count) VALUES ($1, $2, $3)',
            [userId, JSON.stringify(criteria), results.length]
        );

        res.status(200).json({
            success: true,
            count: results.length,
            data: results
        });

    } catch (err) {
        logger.error(`[screener.controller] Error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Screening process failed' });
    }
}

// دالة وهمية لمحاكاة المنطق (استبدلها باللوجيك الفعلي)
async function performScreeningLogic(market, criteria) {
    // مثال: هنا يتم دمج الفلاتر الرياضية
    return [{ symbol: 'BTCUSDT', score: 95 }, { symbol: 'ETHUSDT', score: 88 }];
}

module.exports = { runScreen };