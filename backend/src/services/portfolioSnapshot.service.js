/**
 * src/services/portfolioSnapshot.service.js — AtlasQuant AI
 * Takes daily portfolio value snapshot for all users
 */

const db     = require('../config/db');
const logger = require('../utils/logger');
const { getLivePrices } = require('./livePrices.service');

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

      // ✅ Fix — market value now uses live prices (same approach as
      // dashboard.controller.js), not the stored current_price column,
      // which is only refreshed when the user visits the Portfolio page
      // and can be stale by days. Without this, the equity curve
      // (built from these snapshots) drifted apart from the
      // portfolioValue KPI on the Dashboard, which already uses live
      // prices — today's snapshot point wouldn't match today's KPI.
      const { rows: portfolioRows } = await db.query(
        `SELECT symbol, amount, current_price FROM portfolio WHERE user_id = $1`,
        [user.id]
      );
      const symbols    = [...new Set(portfolioRows.map(p => p.symbol))];
      const livePrices = symbols.length > 0 ? await getLivePrices(symbols) : {};

      const marketValue = portfolioRows.reduce((sum, p) => {
        const live  = livePrices[p.symbol];
        // Fallback to the DB's last-known price if the live fetch
        // failed for this symbol (delisted, provider down, etc).
        const price = live?.price ?? parseFloat(p.current_price) ?? 0;
        return sum + parseFloat(p.amount) * price;
      }, 0);

      // Closed trades PnL
      const { rows: [trades] } = await db.query(`
        SELECT COALESCE(SUM(pnl), 0) AS total_pnl
        FROM trades WHERE user_id = $1 AND status = 'closed'
      `, [user.id]);
      const pnl = parseFloat(trades?.total_pnl || 0);

      // ✅ Fix — `cash + marketValue + pnl || 10000` evaluates as
      // `(cash + marketValue + pnl) || 10000` because `||` binds looser
      // than `+`. A user with a legitimately empty/zeroed-out portfolio
      // (sum === 0) got silently snapshotted at $10,000 instead of $0,
      // masking the real state. Only fall back to 10000 when the sum
      // isn't a valid number (e.g. a NaN slipped through upstream).
      const rawTotal = cash + marketValue + pnl;
      const totalValue = Number.isFinite(rawTotal) ? rawTotal : 10000;

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