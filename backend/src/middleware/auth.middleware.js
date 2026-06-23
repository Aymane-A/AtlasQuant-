/**
 * middleware/auth.middleware.js — AtlasQuant AI
 * Verifies JWT on protected routes.
 * npm install jsonwebtoken
 */
const jwt    = require('jsonwebtoken');
const env    = require('../config/env');
const logger = require('../utils/logger');

/**
 * protect — require valid JWT
 * Add to any route: router.get('/protected', protect, handler)
 */
function protect(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, env.JWT_SECRET);
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
    try { req.user = jwt.verify(authHeader.split(' ')[1], env.JWT_SECRET); }
    catch { /* no-op */ }
  }
  next();
}

module.exports = { protect, optionalAuth };