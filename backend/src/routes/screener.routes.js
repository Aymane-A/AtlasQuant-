/**
 * routes/screener.routes.js — AtlasQuant AI
 *
 * GET    /api/screener/presets      → list saved filter presets
 * POST   /api/screener/presets      → save a new preset
 * DELETE /api/screener/presets/:id  → delete a preset
 */
const express = require('express');
const router  = express.Router();
const { listPresets, savePreset, deletePreset } = require('../controllers/screener.controller');
const { rateLimiter } = require('../middleware/rateLimit.middleware');
const { protect } = require('../middleware/auth.middleware');

router.use(protect);

router.get('/presets',        rateLimiter(30), listPresets);
router.post('/presets',       rateLimiter(15), savePreset);
router.delete('/presets/:id', rateLimiter(15), deletePreset);

module.exports = router;