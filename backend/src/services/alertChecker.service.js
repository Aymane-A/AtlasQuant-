/**
 * src/services/alertChecker.service.js — AtlasQuant AI
 * Cron: checks prices every minute, triggers alerts + email + telegram (per user prefs)
 * ✅ Feature: email_frequency par alerte — 'instant' (comportement historique) envoie
 * direct; 'digest' file l'alerte dans alert_digest_queue, flushée 1x/jour par
 * runDailyDigest() (voir cron séparé dans server.js / app.js).
 */

const db                                    = require('../config/db');
const logger                                = require('../utils/logger');
const { sendAlertEmail, sendDigestEmail }   = require('./email.service');
const { sendTelegramAlert }                 = require('./telegram.service');

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
             a.notify_email, a.notify_telegram, a.email_frequency,
             u.id AS user_id, u.email, u.name
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

        // Email — instant (envoi direct) vs digest (mise en queue)
        if (alert.notify_email) {
          if (alert.email_frequency === 'digest') {
            try {
              await db.query(`
                INSERT INTO alert_digest_queue
                  (user_id, alert_id, symbol, type, condition, target, current_price)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
              `, [alert.user_id, alert.id, symbol, alert.type, alert.condition, alert.target, currentPrice]);
            } catch (e) {
              logger.error(`[alertChecker] Digest queue insert failed: ${e.message}`);
            }
          } else {
            try {
              await sendAlertEmail({ to: alert.email, ...payload });
            } catch (e) {
              logger.error(`[alertChecker] Email failed: ${e.message}`);
            }
          }
        }

        // Telegram — reste toujours instant, pas concerné par le mode digest
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

// ── Daily digest flush — à lancer 1x/jour (cron séparé, voir app.js) ──
async function runDailyDigest() {
  try {
    const { rows: users } = await db.query(`
      SELECT DISTINCT u.id, u.email, u.name
      FROM alert_digest_queue q
      JOIN users u ON u.id = q.user_id
      WHERE q.sent = false
    `);

    if (users.length === 0) {
      logger.info('[alertChecker] Digest: nothing to send today.');
      return;
    }

    for (const user of users) {
      const { rows: items } = await db.query(`
        SELECT id, symbol, type, condition, target, current_price, triggered_at
        FROM alert_digest_queue
        WHERE user_id = $1 AND sent = false
        ORDER BY triggered_at ASC
      `, [user.id]);

      if (items.length === 0) continue;

      try {
        await sendDigestEmail({ to: user.email, name: user.name, items });

        const ids = items.map(i => i.id);
        await db.query(`UPDATE alert_digest_queue SET sent = true WHERE id = ANY($1)`, [ids]);

        logger.info(`[alertChecker] Digest sent → ${user.email} (${items.length} alert(s))`);
      } catch (e) {
        logger.error(`[alertChecker] Digest send failed for ${user.email}: ${e.message}`);
      }
    }
  } catch (err) {
    logger.error(`[alertChecker] Digest error: ${err.message}`);
  }
}

module.exports = { checkAlerts, runDailyDigest };