/**
 * controllers/screener.controller.js — AtlasQuant AI
 * Gère uniquement les presets de filtres (le filtrage lui-même
 * se fait côté client, sur les données déjà chargées via /signals
 * ou /market/forex|commodities/prices).
 */
const db     = require('../config/db');
const logger = require('../utils/logger');

/** GET /api/screener/presets */
async function listPresets(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, asset_type, filters, created_at
       FROM screener_presets WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, presets: rows });
  } catch (err) {
    logger.error(`[screener] listPresets: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

/** POST /api/screener/presets  { name, assetType, filters } */
async function savePreset(req, res) {
  try {
    const { name, assetType, filters } = req.body;
    if (!name || !filters) {
      return res.status(400).json({ success: false, error: 'name and filters are required' });
    }
    const { rows: [preset] } = await db.query(
      `INSERT INTO screener_presets (user_id, name, asset_type, filters)
       VALUES ($1, $2, $3, $4) RETURNING id, name, asset_type, filters, created_at`,
      [req.user.id, name.trim().slice(0, 100), assetType || 'crypto', JSON.stringify(filters)]
    );
    res.json({ success: true, preset });
  } catch (err) {
    logger.error(`[screener] savePreset: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

/** DELETE /api/screener/presets/:id */
async function deletePreset(req, res) {
  try {
    await db.query(
      `DELETE FROM screener_presets WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error(`[screener] deletePreset: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { listPresets, savePreset, deletePreset };