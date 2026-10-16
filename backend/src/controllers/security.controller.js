/**
 * controllers/security.controller.js
 * 2FA (TOTP), Active Sessions, API Keys
 */
const speakeasy = require('speakeasy');
const qrcode     = require('qrcode');
const crypto     = require('crypto');
const db         = require('../config/db');
const logger     = require('../utils/logger');
const { logAuditEvent } = require('../utils/auditLog');
const { sendServerError } = require('../utils/httpError');
const { encryptTotpSecret, decryptTotpSecret } = require('../utils/secretBox');

// ═══════════════════════════════════════════════════════════
// 2FA (TOTP)
// ═══════════════════════════════════════════════════════════

// POST /api/security/2fa/setup — génère un secret + QR code, PAS ENCORE activé
async function setup2FA(req, res) {
  try {
    const userId = req.user.id;

    const secret = speakeasy.generateSecret({
      name: `AtlasQuant AI (${req.user.email})`,
      length: 20,
    });

    // ✅ On stocke le secret en attente ; twofa_enabled reste false tant que
    // l'utilisateur n'a pas confirmé un code valide (évite le lockout).
    await db.query(
      'UPDATE users SET twofa_secret = $1 WHERE id = $2',
      [encryptTotpSecret(secret.base32), userId]
    );

    const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);

    res.json({ success: true, qrCode: qrDataUrl, secret: secret.base32 });
  } catch (err) {
    logger.error(`[security] setup2FA: ${err.message}`);
    sendServerError(res, err);
  }
}

// POST /api/security/2fa/verify — confirme le code et ACTIVE le 2FA
async function verify2FA(req, res) {
  try {
    const userId = req.user.id;
    const { token } = req.body;

    if (!token) return res.status(400).json({ success: false, error: 'Code requis' });

    const { rows } = await db.query('SELECT twofa_secret FROM users WHERE id = $1', [userId]);
    const stored = rows[0]?.twofa_secret;
    const secret = stored ? decryptTotpSecret(stored) : null;
    if (!secret) return res.status(400).json({ success: false, error: 'Lancez d\'abord la configuration 2FA' });

    const isValid = speakeasy.totp.verify({
      secret, encoding: 'base32', token, window: 1, // window:1 tolère un léger décalage horloge
    });

    if (!isValid) return res.status(400).json({ success: false, error: 'Code invalide' });

    // Génère 8 codes de secours à usage unique
    const backupCodes = Array.from({ length: 8 }, () =>
      crypto.randomBytes(5).toString('hex')
    );
    const hashedBackupCodes = backupCodes.map(c =>
      crypto.createHash('sha256').update(c).digest('hex')
    );

    await db.query(
      'UPDATE users SET twofa_enabled = true, twofa_backup_codes = $1 WHERE id = $2',
      [JSON.stringify(hashedBackupCodes), userId]
    );

    await logAuditEvent(userId, '2fa_enabled', req);

    // ⚠ Les codes de secours en clair ne sont retournés qu'une seule fois ici.
    res.json({ success: true, message: '2FA activé', backupCodes });
  } catch (err) {
    logger.error(`[security] verify2FA: ${err.message}`);
    sendServerError(res, err);
  }
}

// POST /api/security/2fa/disable — nécessite le mot de passe actuel
async function disable2FA(req, res) {
  try {
    const userId = req.user.id;
    const { password } = req.body;
    const bcrypt = require('bcryptjs');

    const { rows } = await db.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Utilisateur introuvable' });

    const isMatch = await bcrypt.compare(password || '', rows[0].password);
    if (!isMatch) return res.status(401).json({ success: false, error: 'Mot de passe incorrect' });

    await db.query(
      'UPDATE users SET twofa_enabled = false, twofa_secret = NULL, twofa_backup_codes = \'[]\' WHERE id = $1',
      [userId]
    );

    await logAuditEvent(userId, '2fa_disabled', req);

    res.json({ success: true, message: '2FA désactivé' });
  } catch (err) {
    logger.error(`[security] disable2FA: ${err.message}`);
    sendServerError(res, err);
  }
}

// GET /api/security/2fa/status
async function get2FAStatus(req, res) {
  try {
    const { rows } = await db.query('SELECT twofa_enabled FROM users WHERE id = $1', [req.user.id]);
    res.json({ success: true, enabled: rows[0]?.twofa_enabled || false });
  } catch (err) {
    logger.error(`[security] get2FAStatus: ${err.message}`);
    sendServerError(res, err);
  }
}

// ═══════════════════════════════════════════════════════════
// Sessions actives
// ═══════════════════════════════════════════════════════════

// Helper à appeler depuis auth.controller.js au moment du login/refresh
async function recordSession(userId, refreshToken, req) {
  const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await db.query(
    `INSERT INTO user_sessions (user_id, refresh_hash, ip_address, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [userId, refreshHash, req.ip, req.headers['user-agent'] || null]
  );
}

// GET /api/security/sessions
async function listSessions(req, res) {
  try {
    const userId = req.user.id;
    const currentHash = req.currentSessionHash || null; // set par le middleware d'auth si dispo

    const { rows } = await db.query(
      `SELECT id, ip_address, user_agent, created_at, last_active, refresh_hash
       FROM user_sessions
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY last_active DESC`,
      [userId]
    );

    const sessions = rows.map(s => ({
      id: s.id,
      ip: s.ip_address,
      userAgent: s.user_agent,
      createdAt: s.created_at,
      lastActive: s.last_active,
      isCurrent: currentHash ? s.refresh_hash === currentHash : false,
    })).map(({ ...rest }) => { delete rest.refresh_hash; return rest; });

    res.json({ success: true, sessions });
  } catch (err) {
    logger.error(`[security] listSessions: ${err.message}`);
    sendServerError(res, err);
  }
}

// DELETE /api/security/sessions/:id — révoque une session précise
async function revokeSession(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { rowCount } = await db.query(
      `UPDATE user_sessions SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [id, userId]
    );

    if (!rowCount) return res.status(404).json({ success: false, error: 'Session introuvable' });
    res.json({ success: true, message: 'Session révoquée' });
  } catch (err) {
    logger.error(`[security] revokeSession: ${err.message}`);
    sendServerError(res, err);
  }
}

// DELETE /api/security/sessions — révoque tout SAUF la session courante
async function revokeAllOtherSessions(req, res) {
  try {
    const userId = req.user.id;
    const currentHash = req.currentSessionHash || null;

    await db.query(
      `UPDATE user_sessions SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL
       ${currentHash ? 'AND refresh_hash != $2' : ''}`,
      currentHash ? [userId, currentHash] : [userId]
    );

    res.json({ success: true, message: 'Toutes les autres sessions ont été déconnectées' });
  } catch (err) {
    logger.error(`[security] revokeAllOtherSessions: ${err.message}`);
    sendServerError(res, err);
  }
}

// ═══════════════════════════════════════════════════════════
// API Keys (accès programmatique à l'API AtlasQuant)
// ═══════════════════════════════════════════════════════════

// GET /api/security/api-keys
async function listApiKeys(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, key_prefix, scopes, last_used_at, created_at
       FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, keys: rows });
  } catch (err) {
    logger.error(`[security] listApiKeys: ${err.message}`);
    sendServerError(res, err);
  }
}

// POST /api/security/api-keys — crée une clé, retournée EN CLAIR une seule fois
async function createApiKey(req, res) {
  try {
    const userId = req.user.id;
    const { name, scopes } = req.body;

    if (!name || !name.trim())
      return res.status(400).json({ success: false, error: 'Un nom est requis' });

    // ✅ Audit 3: seules les clés en lecture seule sont supportées. Une clé
    // "trade" donnerait un accès d'exécution sans 2FA ni confirmation : refusée
    // plutôt que créée en silence avec un scope qui ne fait rien.
    if (Array.isArray(scopes) && scopes.includes('trade')) {
      return res.status(400).json({ success: false, error: 'Trade-scoped API keys are not supported yet. API keys are read-only.', code: 'API_KEY_SCOPE_UNSUPPORTED' });
    }
    const cleanScopes = ['read'];

    const rawKey = `aq_live_${crypto.randomBytes(24).toString('hex')}`;
    const prefix = rawKey.slice(0, 12);
    const hash   = crypto.createHash('sha256').update(rawKey).digest('hex');

    const { rows } = await db.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, key_prefix, scopes, created_at`,
      [userId, name.trim(), prefix, hash, JSON.stringify(cleanScopes)]
    );

    await logAuditEvent(userId, 'api_key_created', req, { name: name.trim(), scopes: cleanScopes });

    // ⚠ rawKey n'est JAMAIS stockée ni récupérable après cette réponse.
    res.json({ success: true, key: rawKey, meta: rows[0] });
  } catch (err) {
    logger.error(`[security] createApiKey: ${err.message}`);
    sendServerError(res, err);
  }
}

// DELETE /api/security/api-keys/:id
async function revokeApiKey(req, res) {
  try {
    const { id } = req.params;
    const { rowCount } = await db.query(
      `UPDATE api_keys SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ success: false, error: 'Clé introuvable' });

    await logAuditEvent(req.user.id, 'api_key_revoked', req, { keyId: id });

    res.json({ success: true, message: 'Clé révoquée' });
  } catch (err) {
    logger.error(`[security] revokeApiKey: ${err.message}`);
    sendServerError(res, err);
  }
}

module.exports = {
  setup2FA, verify2FA, disable2FA, get2FAStatus,
  recordSession, listSessions, revokeSession, revokeAllOtherSessions,
  listApiKeys, createApiKey, revokeApiKey,
};