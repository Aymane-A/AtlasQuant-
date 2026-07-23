/**
 * middleware/auth.middleware.js — AtlasQuant AI
 * Verifies JWT on protected routes.
 * npm install jsonwebtoken
 */
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const env    = require('../config/env');
const logger = require('../utils/logger');

/**
 * protect — require valid JWT
 * Add to any route: router.get('/protected', protect, handler)
 *
 * ✅ Fix: on calcule req.currentSessionHash = sha256(token) ici, avec le
 * même algorithme que recordSession() dans security.controller.js. Ça
 * permet à listSessions() de savoir laquelle des lignes de user_sessions
 * correspond à la requête en cours, et d'afficher le badge "This device"
 * dans Settings → Sessions.
 */
function protect(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, env.JWT_SECRET);
    req.currentSessionHash = crypto.createHash('sha256').update(token).digest('hex');
    next();
  } catch (err) {
    logger.warn(`[auth.middleware] Invalid token: ${err.message}`);
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

/**
 * optionalAuth — attach user if token present, continue either way
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      req.user = jwt.verify(token, env.JWT_SECRET);
      req.currentSessionHash = crypto.createHash('sha256').update(token).digest('hex');
    }
    catch { /* no-op */ }
  }
  next();
}

module.exports = { protect, optionalAuth };