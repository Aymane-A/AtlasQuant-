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
  if (password.length < 6) {
    return res.status(400).json({ success: false, error: 'Mot de passe : 6 caractères minimum' });
  }
  if (!email.includes('@')) {
    return res.status(400).json({ success: false, error: 'Email invalide' });
  }

  try {
    // Vérifier si l'email existe déjà
    const existing = await query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
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
      [name?.trim() || '', email.toLowerCase(), hashed]
    );

    const user  = result.rows[0];
    const token = signToken(user.id, user.email, user.plan);

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
// ─────────────────────────────────────────────────────────
async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email et mot de passe requis' });
  }

  try {
    // Chercher l'utilisateur
    const result = await query(
      'SELECT id, name, email, password, plan, created_at FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      // Réponse volontairement vague pour éviter l'énumération d'emails
      return res.status(401).json({ success: false, error: 'Email ou mot de passe incorrect' });
    }

    const user = result.rows[0];

    // Vérifier le mot de passe
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Email ou mot de passe incorrect' });
    }

    const token = signToken(user.id, user.email, user.plan);

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
    // Vérifier l'ancien token (même s'il est expiré de peu)
    const decoded = jwt.verify(oldToken, env.JWT_SECRET, { ignoreExpiration: true });

    // Vérifier que l'utilisateur existe encore en base
    const result = await query(
      'SELECT id, email, plan FROM users WHERE id = $1',
      [decoded.id]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Utilisateur introuvable' });
    }

    const user     = result.rows[0];
    const newToken = signToken(user.id, user.email, user.plan);

    res.json({ success: true, token: newToken });

  } catch (err) {
    logger.error(`[auth] refreshToken error: ${err.message}`);
    res.status(401).json({ success: false, error: 'Token invalide' });
  }
}

module.exports = { register, login, getMe, logout, refreshToken };