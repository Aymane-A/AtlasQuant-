/**
 * src/services/portfolioSnapshot.service.js — AtlasQuant AI
 * Takes a daily portfolio value snapshot for all users.
 *
 * Equity = cash_balance + Σ side * amount * livePrice   (long = +, short = −)
 * Realised P&L is NOT added: it already lives inside cash_balance (addPosition /
 * removePosition move cash), so adding it again double-counted it.
 * Same formula as the Portfolio page hero → last curve point matches the KPI.
 * (Exchange-synced balances are not included here; the cron has no exchange keys loop.)
 */

const db     = require('../config/db');
const logger = require('../utils/logger');
const { getLivePrices } = require('./livePrices.service');

async function snapshotUser(userId) {
  const { rows: [acc] } = await db.query(
    `SELECT cash_balance FROM accounts WHERE user_id = $1`,
    [userId]
  );
  const { rows: portfolioRows } = await db.query(
    `SELECT symbol, side, amount, current_price FROM portfolio WHERE user_id = $1`,
    [userId]
  );

  // Nothing to track for this user
  if (!acc && portfolioRows.length === 0) return;

  const cash       = parseFloat(acc?.cash_balance || 0);
  const symbols    = [...new Set(portfolioRows.map(p => p.symbol))];
  const livePrices = symbols.length > 0 ? await getLivePrices(symbols) : {};

  const signedValue = portfolioRows.reduce((sum, p) => {
    const live  = livePrices[p.symbol];
    const price = live?.price > 0 ? live.price : (parseFloat(p.current_price) || 0);
    const sgn   = p.side === 'short' ? -1 : 1;
    return sum + sgn * parseFloat(p.amount) * price;
  }, 0);

  const totalValue = cash + signedValue;
  if (!Number.isFinite(totalValue)) {
    logger.warn(`[snapshot] User ${userId} skipped — non-finite total`);
    return;
  }

  await db.query(`
    INSERT INTO portfolio_snapshots (user_id, snapshot_date, total_value)
    VALUES ($1, CURRENT_DATE, $2)
    ON CONFLICT (user_id, snapshot_date)
    DO UPDATE SET total_value = EXCLUDED.total_value
  `, [userId, totalValue]);

  logger.info(`[snapshot] User ${userId} → $${totalValue.toFixed(2)}`);
}

async function takePortfolioSnapshot() {
  try {
    const { rows: users } = await db.query(`SELECT id FROM users`);
    for (const user of users) {
      try {
        await snapshotUser(user.id);
      } catch (err) {
        // one bad user must not stop everyone else's snapshot
        logger.error(`[snapshot] User ${user.id} failed: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[snapshot] Error: ${err.message}`);
    throw err;
  }
}

module.exports = { takePortfolioSnapshot };