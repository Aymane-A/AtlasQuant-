/**
 * controllers/dashboard.controller.js — AtlasQuant AI
 * Thin wrapper — the actual query logic lives in dashboardData.service.js,
 * shared with dashboardSocket.server.js so REST and WebSocket never drift.
 */
const logger = require('../utils/logger');
const { buildDashboardPayload } = require('../services/dashboardData.service');

async function getDashboardData(req, res) {
  try {
    const userId = req.user.id;
    const payload = await buildDashboardPayload(userId, {
      range:           req.query.range,
      benchmarkSymbol: req.query.benchmark,
      activityLimit:   req.query.activityLimit,
      activityOffset:  req.query.activityOffset,
      includeBenchmark: true,
    });
    res.json({ success: true, ...payload });
  } catch (err) {
    logger.error(`[dashboard] Error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getDashboardData };