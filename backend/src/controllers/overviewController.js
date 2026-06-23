/**
 * controllers/overviewController.js
 */
const db = require('../config/db');
const logger = require('../utils/logger');

async function getQuantumOverview(req, res) {
    try {
        const userId = req.user.id;

        // تجميع البيانات الأساسية للمستخدم (Dashboard Analytics)
        // استخدام Parallel Execution لتسريع الاستجابة
        const [portfolio, signals, performance] = await Promise.all([
            db.query('SELECT total_value, daily_change FROM portfolio WHERE user_id = $1', [userId]),
            db.query('SELECT symbol, ai_confidence FROM signals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 3', [userId]),
            db.query('SELECT win_rate, total_trades FROM statistics WHERE user_id = $1', [userId])
        ]);

        res.status(200).json({
            success: true,
            data: {
                portfolio: portfolio.rows[0] || { total_value: 0, daily_change: 0 },
                quantumSignals: signals.rows,
                metrics: performance.rows[0] || { win_rate: 0, total_trades: 0 }
            }
        });

    } catch (err) {
        logger.error(`[overviewController] Error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Quantum overview data temporarily unavailable' });
    }
}

module.exports = { getQuantumOverview };