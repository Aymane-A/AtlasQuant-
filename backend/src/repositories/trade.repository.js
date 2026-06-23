// repositories/trade.repository.js
const db = require('../config/db');

const TradeRepository = {
    async create(tradeData) {
        const query = `
            INSERT INTO trades (user_id, symbol, side, entry_price, quantity)
            VALUES ($1, $2, $3, $4, $5) RETURNING *;
        `;
        const values = [tradeData.userId, tradeData.symbol, tradeData.side, tradeData.entryPrice, tradeData.quantity];
        const { rows } = await db.query(query, values);
        return rows[0];
    },

    async closeTrade(tradeId, exitPrice, pnl) {
        const query = `
            UPDATE trades 
            SET exit_price = $1, pnl = $2, status = 'closed', closed_at = NOW()
            WHERE id = $3 RETURNING *;
        `;
        const { rows } = await db.query(query, [exitPrice, pnl, tradeId]);
        return rows[0];
    }
};

module.exports = TradeRepository;