/**
 * services/liveOrderReconciler.service.js — AtlasQuant AI
 *
 * live_orders ne stocke que l'ordre ENVOYÉ (quantité demandée, prix limite).
 * Pour calculer un P&L réel il faut ce qui a été EXÉCUTÉ: quantité remplie,
 * prix moyen, frais. Ce job interroge l'exchange (lecture seule: fetchOrder /
 * GET /orders/:id — aucun ordre n'est créé ni modifié) et complète les
 * colonnes filled_qty, avg_price, fee_cost, fee_currency, exchange_status.
 *
 * - Un ordre reste "à réconcilier" (fill_final = false) tant que l'exchange
 *   ne le déclare pas terminé (filled / canceled / expired / rejected).
 * - reconcile_attempts limite les tentatives (20 max ≈ 5h à 15 min) pour
 *   qu'un ordre impossible à retrouver (clé supprimée, ordre purgé) ne
 *   bloque pas les suivants.
 * - OANDA non géré (nécessite l'API transactions) → ignoré.
 */
const db     = require('../config/db');
const logger = require('../utils/logger');
const exchangesSvc = require('./exchanges.service');
const { getDecryptedCredentials, fetchOrderFill } = exchangesSvc;

const MAX_ATTEMPTS = 20;
const BATCH_LIMIT  = 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let running = false;

async function reconcileLiveOrders() {
  if (running) return { skipped: true, checked: 0, updated: 0, errors: 0 };
  running = true;
  const summary = { checked: 0, updated: 0, errors: 0 };

  try {
    const { rows } = await db.query(`
      SELECT id, user_id, exchange_id, exchange_order_id, symbol
      FROM live_orders
      WHERE fill_final = false
        AND exchange_order_id IS NOT NULL
        AND exchange_id <> 'oanda'
        AND reconcile_attempts < $1
      ORDER BY created_at ASC
      LIMIT $2
    `, [MAX_ATTEMPTS, BATCH_LIMIT]);

    const credCache = new Map();

    for (const o of rows) {
      summary.checked++;
      try {
        const ck = `${o.user_id}|${o.exchange_id}`;
        if (!credCache.has(ck)) credCache.set(ck, await getDecryptedCredentials(o.user_id, o.exchange_id));
        const creds = credCache.get(ck);

        let fill = null;
        if (creds) fill = await fetchOrderFill(o.exchange_id, creds, o.exchange_order_id, o.symbol);

        if (!fill) {
          // connexion supprimée ou exchange non géré: on compte la tentative
          await db.query(`UPDATE live_orders SET reconcile_attempts = reconcile_attempts + 1 WHERE id = $1`, [o.id]);
          continue;
        }

        await db.query(`
          UPDATE live_orders
             SET filled_qty = $2, avg_price = $3, fee_cost = $4, fee_currency = $5,
                 exchange_status = $6, fill_final = $7, reconciled_at = NOW(),
                 reconcile_attempts = reconcile_attempts + 1
           WHERE id = $1
        `, [o.id, fill.filledQty, fill.avgPrice, fill.feeCost, fill.feeCurrency, fill.status, fill.final]);
        summary.updated++;
      } catch (err) {
        summary.errors++;
        logger.warn(`[liveReconciler] order #${o.id} (${o.exchange_id}): ${String(err.message).slice(0, 200)}`);
        try {
          await db.query(`UPDATE live_orders SET reconcile_attempts = reconcile_attempts + 1 WHERE id = $1`, [o.id]);
        } catch { /* ignore */ }
      }
      await sleep(200);
    }

    return summary;
  } finally {
    running = false;
  }
}

// ─────────────────────────────────────────────────────────────
// Orders that were recorded but never got an exchange id: "pending" (the process died between the INSERT
// and the answer) or "unknown" (the answer was lost). We ask the exchange for the order by the client id
// that travelled with it. We NEVER guess:
//   found                          -> adopt the exchange id and state (the fill reconciler above takes over)
//   not found, younger than GRACE  -> leave it: a delayed request could still land
//   not found, older than GRACE    -> rejected ("never reached the exchange")
//   could not ask (network/auth)   -> leave it, count the error, keep it visible as "unknown"
// ─────────────────────────────────────────────────────────────
const PENDING_TO_UNKNOWN_SEC = 60;                                   // a "pending" row this old lost its answer
const NOT_FOUND_GRACE_MIN    = Number(process.env.ORDER_NOT_FOUND_GRACE_MIN) || 10;
const ESCALATE_AFTER_MIN     = 60;                                   // still unknown after this long: needs a human
let resolving = false;

async function resolveUnresolvedOrders() {
  if (resolving) return { skipped: true, checked: 0, resolved: 0, rejected: 0, errors: 0, stale: 0 };
  resolving = true;
  const summary = { checked: 0, resolved: 0, rejected: 0, errors: 0, stale: 0 };
  try {
    // 1) a "pending" row with no exchange id after 60 s is not pending any more: it is unknown
    await db.query(
      `UPDATE live_orders
          SET status = 'unknown', unknown_since = COALESCE(unknown_since, NOW()),
              status_note = COALESCE(status_note, 'no answer recorded (process stopped or reply lost)'), updated_at = NOW()
        WHERE status = 'pending' AND exchange_order_id IS NULL AND client_order_id IS NOT NULL
          AND created_at < NOW() - make_interval(secs => $1)`,
      [PENDING_TO_UNKNOWN_SEC]);

    // 2) ask the exchange about every unknown order
    const { rows } = await db.query(
      `SELECT id, user_id, exchange_id, symbol, client_order_id,
              EXTRACT(EPOCH FROM (NOW() - created_at)) / 60 AS age_min
         FROM live_orders
        WHERE status = 'unknown' AND exchange_order_id IS NULL AND client_order_id IS NOT NULL
        ORDER BY created_at ASC LIMIT $1`, [BATCH_LIMIT]);

    for (const o of rows) {
      summary.checked++;
      try {
        const creds = await getDecryptedCredentials(o.user_id, o.exchange_id);
        if (!creds) throw new Error('exchange connection no longer available');
        const r = await exchangesSvc.fetchOrderByClientId(o.exchange_id, creds, { clientOrderId: o.client_order_id, symbol: o.symbol });

        if (r.found) {
          await db.query(
            `UPDATE live_orders
                SET exchange_order_id = $1, status = $2, raw_response = COALESCE($3::jsonb, raw_response),
                    status_note = 'resolved by reconciler (found on the exchange by client id)', updated_at = NOW()
              WHERE id = $4`,
            [r.exchangeOrderId, r.status, r.raw ? JSON.stringify(r.raw) : null, o.id]);
          summary.resolved++;
          logger.warn(`[liveReconciler] order #${o.id} was UNKNOWN: it exists on ${o.exchange_id} (${r.exchangeOrderId}, ${r.status})`);
        } else if (Number(o.age_min) >= NOT_FOUND_GRACE_MIN) {
          await db.query(
            `UPDATE live_orders SET status = 'rejected',
                    status_note = $1, updated_at = NOW()
              WHERE id = $2 AND status = 'unknown'`,
            [`not found on the exchange ${NOT_FOUND_GRACE_MIN}+ min after sending: it never reached it`, o.id]);
          summary.rejected++;
          logger.warn(`[liveReconciler] order #${o.id} was UNKNOWN: not on ${o.exchange_id} after ${Math.round(o.age_min)} min => rejected`);
        }
      } catch (err) {
        summary.errors++;
        logger.error(`[liveReconciler] cannot resolve order #${o.id} (${o.exchange_id}): ${err.message}`);
      }
      await sleep(150);
    }

    // 3) anything that stays unknown for too long needs a human: shout
    const { rows: stale } = await db.query(
      `SELECT COUNT(*)::int AS n FROM live_orders
        WHERE status = 'unknown' AND unknown_since < NOW() - make_interval(mins => $1)`, [ESCALATE_AFTER_MIN]);
    summary.stale = stale[0] ? stale[0].n : 0;
    if (summary.stale > 0) {
      logger.error(`[liveReconciler] ${summary.stale} live order(s) UNKNOWN for more than ${ESCALATE_AFTER_MIN} min: check the exchange manually`);
    }
  } finally {
    resolving = false;
  }
  return summary;
}

module.exports = { reconcileLiveOrders, resolveUnresolvedOrders };