/**
 * src/controllers/symbols.controller.js — AtlasQuant AI
 * Expose resolveSymbol() au frontend pour la correction de typos côté
 * client (Trading page symbol input / TradingView widget), sans dupliquer
 * la logique de résolution en JS frontend.
 */
const logger = require('../utils/logger');
const { resolveSymbol } = require('../services/symbolResolver.service');

// GET /api/symbols/resolve?q=<input>
async function resolve(req, res) {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, error: 'q (query param) requis' });

    const result = await resolveSymbol(q);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error(`[symbols.resolve] ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { resolve };