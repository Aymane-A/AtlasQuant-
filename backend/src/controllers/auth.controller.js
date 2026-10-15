/**
 * controllers/auth.controller.js — AtlasQuant AI
 *
 * Pas de dossier models/ — les queries PostgreSQL sont
 * faites directement via db.query() pour rester simple.
 *
 * npm install bcryptjs jsonwebtoken
 */

const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query } = require('../config/db');
const env     = require('../config/env');
const logger  = require('../utils/logger');
const { logAuditEvent } = require('../utils/auditLog');
const { recordSession } = require('./security.controller');
const crypto  = require('crypto');
const speakeasy = require('speakeasy');
const { isSessionRevoked } = require('../middleware/auth.middleware');

const PASSWORD_MIN = 8;

// Account lockout: too many failed logins (password OR 2FA code) for one email.
const LOCK_MAX_FAILURES = 5;
const LOCK_WINDOW_MIN   = 15;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── Helper : générer un JWT ───────────────────────────────
function signToken(userId, email, plan) {
  return jwt.sign(
    { id: userId, email, plan },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

// ── Helper : réponse utilisateur (sans le mot de passe) ──
function safeUser(row) {
  return {
    id:         row.id,
    name:       row.name,
    email:      row.email,
    plan:       row.plan,
    created_at: row.created_at,
  };
}

// ─────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────
async function register(req, res) {
  const { name, email, password } = req.body;

  // Validation basique
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email et mot de passe requis' });
  }
  if (typeof password === 'string' && password.length < PASSWORD_MIN) {
    return res.status(400).json({ success: false, error: `Mot de passe : ${PASSWORD_MIN} caractères minimum` });
  }
  if (typeof email !== 'string' || typeof password !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ success: false, error: 'Email invalide' });
  }
  if (password.length > 128) {
    // bcrypt only uses the first 72 bytes; cap input to avoid abuse
    return res.status(400).json({ success: false, error: 'Mot de passe trop long' });
  }

  try {
    // Vérifier si l'email existe déjà
    const existing = await query(
      'SELECT id FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Cet email est déjà utilisé' });
    }

    // Hasher le mot de passe
    const hashed = await bcrypt.hash(password, 12);

    // Insérer l'utilisateur
    const result = await query(
      `INSERT INTO users (name, email, password, plan)
       VALUES ($1, $2, $3, 'free')
       RETURNING id, name, email, plan, created_at`,
      [name?.trim() || '', email.trim().toLowerCase(), hashed]
    );

    const user  = result.rows[0];
    const token = signToken(user.id, user.email, user.plan);

    // ✅ Fix: on trace cette session dans user_sessions dès la création du
    // compte — sans cet appel, l'onglet Sessions de Settings restait vide
    // indéfiniment (recordSession n'était jamais invoqué). On hash le JWT
    // lui-même comme identifiant de session (pas de refresh token distinct
    // dans ce système d'auth stateless).
    await recordSession(user.id, token, req);

    logger.info(`[auth] Nouveau compte : ${user.email}`);

    res.status(201).json({
      success: true,
      message: 'Compte créé avec succès',
      token,
      user: safeUser(user),
    });

  } catch (err) {
    logger.error(`[auth] register error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Erreur serveur lors de l\'inscription' });
  }
}

// ─────────────────────────────────────────────────────────
// POST /api/auth/login
// ✅ Feature: journalisation des tentatives de connexion (login_success /
// login_failed) dans audit_log — alimente l'Activity Log de Settings.
// login_failed utilise user_id = null quand l'email n'existe pas (identité
// pas confirmée), ou l'id réel si le mot de passe est faux — dans les deux
// cas l'email tenté est tracé dans metadata.
// ─────────────────────────────────────────────────────────
async function login(req, res) {
  const { email, password, totp, backupCode } = req.body;

  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: 'Email et mot de passe requis' });
  }

  try {
    // Brute-force protection per account (the IP rate limiter alone doesn't stop
    // a distributed attack, and it also bounds guesses of 2FA codes).
    const emailNorm = email.trim().toLowerCase();
    const { rows: fails } = await query(
      `SELECT COUNT(*)::int AS n FROM audit_log
       WHERE event_type IN ('login_failed', 'login_2fa_failed')
         AND created_at > NOW() - make_interval(mins => $2)
         AND metadata->>'email' = $1`,
      [emailNorm, LOCK_WINDOW_MIN]
    );
    if ((fails[0]?.n || 0) >= LOCK_MAX_FAILURES) {
      return res.status(429).json({
        success: false,
        error: `Trop de tentatives échouées. Réessayez dans ${LOCK_WINDOW_MIN} minutes.`,
      });
    }

    const result = await query(
      `SELECT id, name, email, password, plan, created_at,
              twofa_enabled, twofa_secret, twofa_backup_codes
       FROM users WHERE email = $1`,
      [email.trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      // Réponse volontairement vague pour éviter l'énumération d'emails
      await logAuditEvent(null, 'login_failed', req, { email: email.trim().toLowerCase() });
      return res.status(401).json({ success: false, error: 'Email ou mot de passe incorrect' });
    }

    const user = result.rows[0];

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      await logAuditEvent(user.id, 'login_failed', req, { email: user.email });
      return res.status(401).json({ success: false, error: 'Email ou mot de passe incorrect' });
    }

    // ── 2FA challenge ─────────────────────────────────────
    // Password is correct but 2FA is on: no token until a valid TOTP code
    // (or a one-time backup code) is provided.
    if (user.twofa_enabled) {
      if (!totp && !backupCode) {
        return res.json({ success: true, requires2FA: true, message: 'Code 2FA requis' });
      }

      let ok = false;

      if (totp && user.twofa_secret) {
        ok = speakeasy.totp.verify({
          secret: user.twofa_secret, encoding: 'base32',
          token: String(totp).replace(/\s/g, ''), window: 1,
        });
      }

      if (!ok && backupCode) {
        const hash  = crypto.createHash('sha256').update(String(backupCode).trim().toLowerCase()).digest('hex');
        const codes = Array.isArray(user.twofa_backup_codes) ? user.twofa_backup_codes : [];
        const idx   = codes.indexOf(hash);
        if (idx !== -1) {
          ok = true;
          codes.splice(idx, 1); // single use
          await query('UPDATE users SET twofa_backup_codes = $1 WHERE id = $2', [JSON.stringify(codes), user.id]);
          await logAuditEvent(user.id, '2fa_backup_code_used', req, { remaining: codes.length });
        }
      }

      if (!ok) {
        await logAuditEvent(user.id, 'login_2fa_failed', req, { email: user.email });
        return res.status(401).json({ success: false, error: 'Code 2FA invalide' });
      }
    }

    const token = signToken(user.id, user.email, user.plan);
    await recordSession(user.id, token, req);

    await logAuditEvent(user.id, 'login_success', req);
    logger.info(`[auth] Connexion : ${user.email}`);

    res.json({
      success: true,
      message: 'Connexion réussie',
      token,
      user: safeUser(user),
    });

  } catch (err) {
    logger.error(`[auth] login error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Erreur serveur lors de la connexion' });
  }
}

// ─────────────────────────────────────────────────────────
// GET /api/auth/me  (protégé par JWT)
// ─────────────────────────────────────────────────────────
async function getMe(req, res) {
  try {
    // req.user est injecté par auth.middleware.js
    const result = await query(
      'SELECT id, name, email, plan, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Utilisateur introuvable' });
    }

    res.json({ success: true, user: safeUser(result.rows[0]) });

  } catch (err) {
    logger.error(`[auth] getMe error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
}

// ─────────────────────────────────────────────────────────
// POST /api/auth/logout  (protégé)
// Les JWT sont stateless — on informe juste le client
// de supprimer son token côté frontend.
// ─────────────────────────────────────────────────────────
function logout(req, res) {
  logger.info(`[auth] Déconnexion : ${req.user.email}`);
  res.json({ success: true, message: 'Déconnecté — supprimez le token côté client' });
}

// ─────────────────────────────────────────────────────────
// POST /api/auth/refresh
// Renouveler le token sans re-saisir le mot de passe
// ─────────────────────────────────────────────────────────
async function refreshToken(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Token manquant' });
  }

  const oldToken = authHeader.split(' ')[1];

  try {
    // Signature must be valid; expiry is checked manually so we can allow a
    // short grace window (REFRESH_GRACE_SECONDS) — NOT an unlimited one.
    const decoded = jwt.verify(oldToken, env.JWT_SECRET, { ignoreExpiration: true });

    const now = Math.floor(Date.now() / 1000);
    if (!decoded.exp || now > decoded.exp + env.REFRESH_GRACE_SECONDS) {
      return res.status(401).json({ success: false, error: 'Token expiré — reconnectez-vous' });
    }

    // A revoked session (logout-all, "revoke" in Settings) can never refresh.
    if (await isSessionRevoked(decoded.id, oldToken)) {
      return res.status(401).json({ success: false, error: 'Session révoquée' });
    }

    const result = await query(
      'SELECT id, email, plan FROM users WHERE id = $1',
      [decoded.id]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Utilisateur introuvable' });
    }

    const user     = result.rows[0];
    const newToken = signToken(user.id, user.email, user.plan);
    await recordSession(user.id, newToken, req);

    res.json({ success: true, token: newToken });

  } catch (err) {
    logger.error(`[auth] refreshToken error: ${err.message}`);
    res.status(401).json({ success: false, error: 'Token invalide' });
  }
}

module.exports = { register, login, getMe, logout, refreshToken };