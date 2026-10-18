/**
 * src/services/idempotency.service.js — AtlasQuant AI
 *
 * Clés d'idempotence pour l'envoi d'ordres. Le client envoie `Idempotency-Key`
 * (unique par intention : un clic, pas par tentative réseau). Même clé :
 *   - même requête, déjà terminée   → on REJOUE la réponse d'origine (aucun 2e ordre) ;
 *   - même requête, encore en cours → 409 IDEMPOTENCY_IN_PROGRESS ;
 *   - requête DIFFÉRENTE            → 422 IDEMPOTENCY_KEY_REUSED.
 *
 * Le claim est un INSERT … ON CONFLICT DO NOTHING (atomique côté Postgres) : de
 * deux requêtes simultanées avec la même clé, une seule peut gagner.
 * Une clé reste « in_progress » si le process meurt en plein ordre : on NE la
 * rejoue PAS automatiquement (un ordre live a pu partir) — elle expire (24 h) et
 * le client doit vérifier ses ordres avant de ressayer avec une nouvelle clé.
 */
const crypto = require('crypto');
const db = require('../config/db');

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;
const TTL_HOURS = 24;

function validKey(k) { return typeof k === 'string' && KEY_RE.test(k); }

/** Empreinte stable de la requête (clés triées) pour détecter une clé réutilisée avec un autre contenu. */
function hashRequest(scope, payload) {
  const canon = (v) => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => (o[k] = canon(v[k]), o), {})
    : v;
  return crypto.createHash('sha256').update(JSON.stringify([scope, canon(payload)])).digest('hex');
}

/** @returns {{state:'new'}|{state:'replay',status:number,body:any}|{state:'in_progress'}|{state:'conflict'}} */
async function claim(userId, scope, key, requestHash) {
  // Ménage opportuniste (index sur created_at) : borné, jamais bloquant pour le claim.
  db.query(`DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '${TTL_HOURS} hours'`).catch(() => {});

  const ins = await db.query(
    `INSERT INTO idempotency_keys (user_id, scope, key, request_hash, status)
     VALUES ($1, $2, $3, $4, 'in_progress')
     ON CONFLICT (user_id, scope, key) DO NOTHING
     RETURNING key`,
    [userId, scope, key, requestHash]
  );
  if (ins.rows.length) return { state: 'new' };

  const { rows } = await db.query(
    `SELECT request_hash, status, response_status, response_body
       FROM idempotency_keys WHERE user_id = $1 AND scope = $2 AND key = $3`,
    [userId, scope, key]
  );
  const row = rows[0];
  if (!row) return { state: 'in_progress' };           // supprimée entre-temps (ménage) : on refuse prudemment
  if (row.request_hash !== requestHash) return { state: 'conflict' };
  if (row.status === 'completed') return { state: 'replay', status: row.response_status, body: row.response_body };
  return { state: 'in_progress' };
}

async function complete(userId, scope, key, status, body) {
  await db.query(
    `UPDATE idempotency_keys
        SET status = 'completed', response_status = $4, response_body = $5::jsonb, completed_at = NOW()
      WHERE user_id = $1 AND scope = $2 AND key = $3`,
    [userId, scope, key, status, JSON.stringify(body ?? null)]
  );
}

module.exports = { claim, complete, hashRequest, validKey, KEY_RE, TTL_HOURS };
