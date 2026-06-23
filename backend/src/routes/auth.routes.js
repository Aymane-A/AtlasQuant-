/**
 * routes/auth.routes.js — AtlasQuant AI
 *
 * POST /api/auth/register   → créer un compte
 * POST /api/auth/login      → connexion + JWT
 * GET  /api/auth/me         → profil (protégé)
 * POST /api/auth/logout     → déconnexion
 * POST /api/auth/refresh    → renouveler le token
 */

const express = require('express');
const router  = express.Router();

const {
  register,
  login,
  getMe,
  logout,
  refreshToken,
} = require('../controllers/auth.controller');

const { protect }     = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimit.middleware');

// Routes publiques — rate limit strict pour éviter le brute force
router.post('/register', rateLimiter(5),  register);
router.post('/login',    rateLimiter(10), login);
router.post('/refresh',  rateLimiter(10), refreshToken);

// Routes protégées — nécessite un JWT valide
router.get('/me',     protect, getMe);
router.post('/logout', protect, logout);

module.exports = router;