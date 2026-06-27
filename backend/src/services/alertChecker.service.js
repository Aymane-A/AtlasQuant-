/**
 * src/services/alertChecker.service.js — AtlasQuant AI
 * Cron: checks prices every minute, triggers alerts + email + telegram (per user prefs)
 */

const db                    = require('../config/db');
const logger                = require('../utils/logger');
const { sendAlertEmail }    = require('./email.service');
const { sendTelegramAlert } = require('./telegram.service');

async function fetchPrice(symbol) {
  try {
    const YahooFinance = require('yahoo-finance2').default;
    const yf    = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
    const quote = await yf.quote(symbol);
    if (quote?.regularMarketPrice) return quote.regularMarketPrice;
  } catch {}
  try {
    const res  = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
    const data = await res.json();
    if (data?.price) return parseFloat(data.price);
  } catch {}
  return null;
}

function conditionMet(condition, currentPrice, target) {
  const t = parseFloat(target);
  if (condition === 'above') return currentPrice >= t;
  if (condition === 'below') return currentPrice <= t;
  if (condition === 'equal') return Math.abs(currentPrice - t) / t < 0.001;
  return false;
}

async function checkAlerts() {
  try {
    const { rows: alerts } = await db.query(`
      SELECT a.id, a.symbol, a.type, a.condition, a.target,
             a.notify_email, a.notify_telegram,
             u.email, u.name
      FROM alerts a
      JOIN users u ON u.id = a.user_id
      WHERE a.triggered = false AND a.paused = false
    `);

    if (alerts.length === 0) return;

    logger.info(`[alertChecker] Checking ${alerts.length} active alert(s)...`);

    const symbolMap = {};
    for (const alert of alerts) {
      if (!symbolMap[alert.symbol]) symbolMap[alert.symbol] = [];
      symbolMap[alert.symbol].push(alert);
    }

    for (const [symbol, symbolAlerts] of Object.entries(symbolMap)) {
      const currentPrice = await fetchPrice(symbol);
      if (!currentPrice) {
        logger.warn(`[alertChecker] No price for ${symbol}`);
        continue;
      }

      for (const alert of symbolAlerts) {
        if (!conditionMet(alert.condition, currentPrice, alert.target)) continue;

        // Mark triggered
        await db.query(`
          UPDATE alerts SET triggered = true, triggered_at = NOW()
          WHERE id = $1
        `, [alert.id]);

        logger.info(`[alertChecker] 🔔 ${symbol} ${alert.condition} ${alert.target} (cur: ${currentPrice})`);

        const payload = {
          symbol,
          type:         alert.type,
          condition:    alert.condition,
          target:       alert.target,
          currentPrice,
        };

        // Email — only if user enabled it
        if (alert.notify_email) {
          try {
            await sendAlertEmail({ to: alert.email, ...payload });
          } catch (e) {
            logger.error(`[alertChecker] Email failed: ${e.message}`);
          }
        }

        // Telegram — only if user enabled it
        if (alert.notify_telegram) {
          try {
            await sendTelegramAlert(payload);
          } catch (e) {
            logger.error(`[alertChecker] Telegram failed: ${e.message}`);
          }
        }
      }
    }
  } catch (err) {
    logger.error(`[alertChecker] Error: ${err.message}`);
  }
}

module.exports = { checkAlerts };