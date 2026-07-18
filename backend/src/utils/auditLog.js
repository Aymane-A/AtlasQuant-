/**
 * utils/auditLog.js
 * ✅ Feature: journal d'activité — trace les événements sensibles du compte
 * (connexions, changement de mot de passe, 2FA, clés API...). Append-only.
 * Échec silencieux si l'insert plante — ne bloque jamais l'action principale.
 */
const db     = require('../config/db');
const logger = require('./logger');

const EVENT_TYPES = [
  'login_success', 'login_failed', 'password_changed',
  '2fa_enabled', '2fa_disabled', 'api_key_created', 'api_key_revoked',
  'email_changed',
];

async function logAuditEvent(userId, eventType, req, metadata = null) {
  try {
    const ip = req?.ip || req?.headers?.['x-forwarded-for'] || null;
    const userAgent = req?.headers?.['user-agent'] || null;
    await db.query(
      `INSERT INTO audit_log (user_id, event_type, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, eventType, ip, userAgent, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    logger.error(`[auditLog] ${err.message}`);
  }
}

module.exports = { logAuditEvent, EVENT_TYPES };