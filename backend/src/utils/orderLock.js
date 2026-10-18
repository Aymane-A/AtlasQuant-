/**
 * src/utils/orderLock.js — AtlasQuant AI
 *
 * Réservation atomique d'exposition : sérialise, PAR UTILISATEUR, la séquence
 * « vérifier les limites de risque → écrire la position ».
 * Sans ça, 10 ordres simultanés de 18 % lisaient tous « 0 % ouvert », passaient
 * tous le plafond d'exposition, puis s'insèrent tous : 180 % d'exposition.
 *
 * Mécanisme : une transaction Postgres prend pg_advisory_xact_lock(7001, hash(user))
 * puis exécute `fn(q)` ; `q` est le client DE CETTE TRANSACTION. Les lectures de
 * risque et l'INSERT de la position doivent passer par `q` : le lock est relâché
 * au COMMIT, donc l'ordre suivant voit la position déjà écrite.
 * (Les passer par le pool, sur une autre connexion, ferait aussi attendre le pool
 * pendant qu'on le détient : risque de blocage. D'où `q`.)
 *
 * Limites : le lock est par utilisateur et par base. Il ne couvre PAS les ordres
 * live, dont l'exposition n'est pas suivie (voir docs).
 */
const db = require('../config/db');

const LOCK_CLASS = 7001;
const LOCK_TIMEOUT_MS = Number(process.env.ORDER_LOCK_TIMEOUT_MS) || 10000;

async function withUserOrderLock(userId, fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // SET LOCAL ne prend pas de paramètres : valeur numérique validée, jamais d'entrée utilisateur.
    await client.query(`SET LOCAL lock_timeout = ${Math.trunc(LOCK_TIMEOUT_MS)}`);
    try {
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_CLASS, String(userId)]);
    } catch (err) {
      if (err && err.code === '55P03') {            // lock_not_available
        const e = new Error('Another order for this account is being processed. Retry in a moment.');
        e.status = 503; e.expose = true; e.code = 'ORDER_BUSY';
        throw e;
      }
      throw err;
    }
    const result = await fn((sql, params) => client.query(sql, params));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connexion déjà cassée */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withUserOrderLock, LOCK_CLASS };
