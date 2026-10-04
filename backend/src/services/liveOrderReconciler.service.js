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
const { getDecryptedCredentials, fetchOrderFill } = require('./exchanges.service');

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

module.exports = { reconcileLiveOrders };