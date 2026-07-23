/**
 * src/services/alertChecker.service.js — AtlasQuant AI
 * Cron: checks prices every minute, triggers alerts + email + telegram (per user prefs)
 * ✅ Feature: email_frequency par alerte — 'instant' (comportement historique) envoie
 * direct; 'digest' file l'alerte dans alert_digest_queue, flushée 1x/jour par
 * runDailyDigest() (voir cron séparé dans server.js / app.js).
 *
 * ✅ Feature: enforcement des Quiet Hours (Settings → Notifications → Quiet
 * Hours). Si l'user est dans sa plage horaire silencieuse (comparée dans SON
 * fuseau, via user_settings.timezone) au moment où une alerte se déclenche :
 *   - Email : mis en file dans alert_digest_queue (peu importe email_frequency)
 *     — l'alerte n'est pas perdue, elle arrive avec le prochain digest quotidien.
 *   - Telegram : suspendu pour ce cycle, pas de mécanisme de file d'attente
 *     équivalent — l'alerte reste tracée dans les logs mais n'est pas renvoyée.
 *
 * ✅ Fix: fetchPrice() n'avait aucun timeout — un Yahoo/Binance lent bloquait
 * checkAlerts() pendant des dizaines de secondes (boucle for...of séquentielle
 * sur les symboles), retardant d'autant la libération des connexions pg
 * utilisées plus bas dans la même fonction.
 * ✅ Fix: garde anti-chevauchement exportée (isCheckAlertsRunning) — à utiliser
 * dans le fichier qui planifie ce cron (app.js / cron bootstrap) pour éviter
 * que deux cycles de checkAlerts() tournent en même temps.
 */

const db                                    = require('../config/db');
const logger                                = require('../utils/logger');
const { sendAlertEmail, sendDigestEmail }   = require('./email.service');
const { sendTelegramAlert }                 = require('./telegram.service');

const PRICE_FETCH_TIMEOUT_MS = 6000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

async function fetchPrice(symbol) {
  try {
    const YahooFinance = require('yahoo-finance2').default;
    const yf    = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
    const quote = await withTimeout(yf.quote(symbol), PRICE_FETCH_TIMEOUT_MS, 'yahoo');
    if (quote?.regularMarketPrice) return quote.regularMarketPrice;
  } catch (e) {
    logger.warn(`[alertChecker] Yahoo fetch failed for ${symbol}: ${e.message}`);
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), PRICE_FETCH_TIMEOUT_MS);
    const res  = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`, {
      signal: controller.signal,
    });
    clearTimeout(t);
    const data = await res.json();
    if (data?.price) return parseFloat(data.price);
  } catch (e) {
    logger.warn(`[alertChecker] Binance fetch failed for ${symbol}: ${e.message}`);
  }
  return null;
}

function conditionMet(condition, currentPrice, target) {
  const t = parseFloat(target);
  if (condition === 'above') return currentPrice >= t;
  if (condition === 'below') return currentPrice <= t;
  if (condition === 'equal') return Math.abs(currentPrice - t) / t < 0.001;
  return false;
}

// ✅ Feature: compare l'heure locale actuelle de l'user (via son fuseau) à sa
// plage de quiet hours. Gère le cas "overnight" (ex. 23:00 → 07:00, où start
// > end) en plus du cas classique (ex. 09:00 → 17:00, où start < end).
function isWithinQuietHours(enabled, start, end, timezone) {
  if (!enabled) return false;
  try {
    const tz = timezone || 'UTC';
    const localTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date()); // "HH:MM"

    const toMinutes = (hhmm) => {
      const [h, m] = String(hhmm).split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };

    const nowMin   = toMinutes(localTime);
    const startMin = toMinutes(start);
    const endMin   = toMinutes(end);

    if (startMin === endMin) return false; // plage nulle → traité comme désactivé

    if (startMin < endMin) {
      // plage classique dans la même journée, ex. 09:00 → 17:00
      return nowMin >= startMin && nowMin < endMin;
    }
    // plage "overnight", ex. 23:00 → 07:00
    return nowMin >= startMin || nowMin < endMin;
  } catch (e) {
    logger.warn(`[alertChecker] isWithinQuietHours failed (tz=${timezone}): ${e.message}`);
    return false;
  }
}

// ✅ Fix: garde anti-chevauchement — exportée pour que le fichier qui
// planifie ce cron (app.js / cron.js) puisse la vérifier avant de relancer
// checkAlerts(). Voir exemple de wiring en bas de ce fichier.
let isCheckAlertsRunning = false;
function isRunning() { return isCheckAlertsRunning; }

async function checkAlerts() {
  if (isCheckAlertsRunning) {
    logger.warn('[alertChecker] previous checkAlerts() run still in progress — skipping this tick');
    return;
  }
  isCheckAlertsRunning = true;

  try {
    // ✅ Feature: LEFT JOIN user_settings pour récupérer les préférences de
    // quiet hours + le fuseau horaire de chaque user. LEFT JOIN (pas JOIN)
    // car un user peut ne pas encore avoir de ligne dans user_settings —
    // dans ce cas COALESCE applique les mêmes défauts que settings.controller.js.
    const { rows: alerts } = await db.query(`
      SELECT a.id, a.symbol, a.type, a.condition, a.target,
             a.notify_email, a.notify_telegram, a.email_frequency,
             u.id AS user_id, u.email, u.name,
             COALESCE(us.quiet_hours_enabled, false)   AS quiet_hours_enabled,
             COALESCE(us.quiet_hours_start, '23:00')   AS quiet_hours_start,
             COALESCE(us.quiet_hours_end, '07:00')     AS quiet_hours_end,
             COALESCE(us.timezone, 'UTC')              AS timezone
      FROM alerts a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN user_settings us ON us.user_id = u.id
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

        const inQuietHours = isWithinQuietHours(
          alert.quiet_hours_enabled, alert.quiet_hours_start, alert.quiet_hours_end, alert.timezone
        );

        // Email — instant / digest / quiet hours (queue systématique)
        if (alert.notify_email) {
          if (inQuietHours) {
            // ✅ Quiet hours actives : on ne réveille pas l'user — l'alerte
            // part dans la même file que le digest quotidien, peu importe
            // son email_frequency habituel. Elle arrivera au prochain
            // runDailyDigest() plutôt que d'être perdue.
            try {
              await db.query(`
                INSERT INTO alert_digest_queue
                  (user_id, alert_id, symbol, type, condition, target, current_price)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
              `, [alert.user_id, alert.id, symbol, alert.type, alert.condition, alert.target, currentPrice]);
              logger.info(`[alertChecker] Quiet hours active for user ${alert.user_id} — ${symbol} email queued for digest`);
            } catch (e) {
              logger.error(`[alertChecker] Digest queue insert (quiet hours) failed: ${e.message}`);
            }
          } else if (alert.email_frequency === 'digest') {
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

        // Telegram — suspendu pendant les quiet hours (pas de file d'attente
        // équivalente au digest email ; l'alerte reste tracée dans triggered_at
        // mais le message Telegram n'est simplement pas envoyé ce cycle-ci).
        if (alert.notify_telegram) {
          if (inQuietHours) {
            logger.info(`[alertChecker] Quiet hours active for user ${alert.user_id} — ${symbol} Telegram suppressed`);
          } else {
            try {
              await sendTelegramAlert(payload);
            } catch (e) {
              logger.error(`[alertChecker] Telegram failed: ${e.message}`);
            }
          }
        }
      }
    }
  } catch (err) {
    logger.error(`[alertChecker] Error: ${err.message}`);
  } finally {
    isCheckAlertsRunning = false;
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

module.exports = { checkAlerts, runDailyDigest, isRunning };