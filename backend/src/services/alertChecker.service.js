/**
 * src/services/alertChecker.service.js — AtlasQuant AI
 * Cron job: checks live prices every minute, triggers alerts + sends emails
 */

const db                 = require('../config/db');
const logger             = require('../utils/logger');
const { sendAlertEmail } = require('./email.service');

// ── Fetch current price (Yahoo Finance) ──────────────────
async function fetchPrice(symbol) {
  try {
    const YahooFinance = require('yahoo-finance2').default;
    const yf = new YahooFinance();
    const quote = await yf.quote(symbol);
    return quote?.regularMarketPrice || null;
  } catch {
    // Try as crypto via Binance public API
    try {
      const res  = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
      const data = await res.json();
      return data?.price ? parseFloat(data.price) : null;
    } catch {
      return null;
    }
  }
}

// ── Check if condition is met ─────────────────────────────
function conditionMet(condition, currentPrice, target) {
  const t = parseFloat(target);
  if (condition === 'above') return currentPrice >= t;
  if (condition === 'below') return currentPrice <= t;
  if (condition === 'equal') return Math.abs(currentPrice - t) / t < 0.001; // 0.1% tolerance
  return false;
}

// ── Main checker ──────────────────────────────────────────
async function checkAlerts() {
  try {
    // Get all active (non-triggered, non-paused) alerts with user emails
    const { rows: alerts } = await db.query(`
      SELECT 
        a.id, a.symbol, a.type, a.condition, a.target,
        u.email, u.name
      FROM alerts a
      JOIN users u ON u.id = a.user_id
      WHERE a.triggered = false 
        AND a.paused    = false
    `);

    if (alerts.length === 0) return;

    logger.info(`[alertChecker] Checking ${alerts.length} active alert(s)...`);

    // Group by symbol to minimize API calls
    const symbolMap = {};
    for (const alert of alerts) {
      if (!symbolMap[alert.symbol]) symbolMap[alert.symbol] = [];
      symbolMap[alert.symbol].push(alert);
    }

    for (const [symbol, symbolAlerts] of Object.entries(symbolMap)) {
      const currentPrice = await fetchPrice(symbol);

      if (!currentPrice) {
        logger.warn(`[alertChecker] Could not fetch price for ${symbol}`);
        continue;
      }

      for (const alert of symbolAlerts) {
        if (!conditionMet(alert.condition, currentPrice, alert.target)) continue;

        // ── Trigger the alert ──
        await db.query(`
          UPDATE alerts 
          SET triggered = true, triggered_at = NOW()
          WHERE id = $1
        `, [alert.id]);

        logger.info(`[alertChecker] 🔔 Alert triggered: ${symbol} ${alert.condition} ${alert.target} (current: ${currentPrice})`);

        // ── Send email ──
        try {
          await sendAlertEmail({
            to:           alert.email,
            symbol,
            type:         alert.type,
            condition:    alert.condition,
            target:       alert.target,
            currentPrice,
          });
        } catch (emailErr) {
          logger.error(`[alertChecker] Email failed for alert ${alert.id}: ${emailErr.message}`);
        }
      }
    }
  } catch (err) {
    logger.error(`[alertChecker] Error: ${err.message}`);
  }
}

module.exports = { checkAlerts };