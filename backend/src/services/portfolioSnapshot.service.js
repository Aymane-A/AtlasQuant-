/**
 * src/services/portfolioSnapshot.service.js — AtlasQuant AI
 * Takes daily portfolio value snapshot for all users
 */

const db     = require('../config/db');
const logger = require('../utils/logger');

async function takePortfolioSnapshot() {
  try {
    // Get all users with portfolio or account
    const { rows: users } = await db.query(`
      SELECT DISTINCT u.id
      FROM users u
      LEFT JOIN accounts a ON a.user_id = u.id
    `);

    for (const user of users) {
      // Cash balance
      const { rows: [acc] } = await db.query(
        `SELECT cash_balance FROM accounts WHERE user_id = $1`,
        [user.id]
      );
      const cash = parseFloat(acc?.cash_balance || 0);

      // Portfolio market value (amount * current_price)
      const { rows: [port] } = await db.query(`
        SELECT COALESCE(SUM(amount * current_price), 0) AS market_value
        FROM portfolio WHERE user_id = $1
      `, [user.id]);
      const marketValue = parseFloat(port?.market_value || 0);

      // Closed trades PnL
      const { rows: [trades] } = await db.query(`
        SELECT COALESCE(SUM(pnl), 0) AS total_pnl
        FROM trades WHERE user_id = $1 AND status = 'closed'
      `, [user.id]);
      const pnl = parseFloat(trades?.total_pnl || 0);

      const totalValue = cash + marketValue + pnl || 10000;

      // Upsert snapshot for today
      await db.query(`
        INSERT INTO portfolio_snapshots (user_id, snapshot_date, total_value)
        VALUES ($1, CURRENT_DATE, $2)
        ON CONFLICT (user_id, snapshot_date)
        DO UPDATE SET total_value = EXCLUDED.total_value
      `, [user.id, totalValue]);

      logger.info(`[snapshot] User ${user.id} → $${totalValue.toFixed(2)}`);
    }
  } catch (err) {
    logger.error(`[snapshot] Error: ${err.message}`);
    throw err;
  }
}

module.exports = { takePortfolioSnapshot };