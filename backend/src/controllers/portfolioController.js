/**
 * src/controllers/portfolioController.js
 */
const db = require('../config/db');
const logger = require('../utils/logger');

async function getPortfolioData(req, res) {
    try {
        const userId = req.user.id;

        // جلب تفاصيل المحفظة
        // ربط المحفظة بـ userId لضمان الخصوصية التامة
        const query = `
            SELECT 
                symbol, 
                amount, 
                average_entry, 
                current_value 
            FROM portfolio 
            WHERE user_id = $1
        `;
        
        const { rows } = await db.query(query, [userId]);

        // حساب القيمة الإجمالية للمحفظة برمجياً لضمان الدقة
        const totalValue = rows.reduce((acc, asset) => acc + parseFloat(asset.current_value), 0);

        res.status(200).json({ 
            success: true, 
            data: {
                assets: rows,
                totalPortfolioValue: totalValue.toFixed(2)
            }
        });

    } catch (err) {
        logger.error(`[portfolio.controller] Error: ${err.message}`);
        res.status(500).json({ success: false, error: 'Impossible de récupérer les données du portefeuille' });
    }
}

module.exports = { getPortfolioData };