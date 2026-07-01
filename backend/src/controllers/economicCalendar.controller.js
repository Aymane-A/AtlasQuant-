/**
 * controllers/economicCalendar.controller.js
 */
const { fetchEconomicCalendar } = require('../services/economicCalendar.service');
const logger = require('../utils/logger');

async function getCalendar(req, res) {
  try {
    const events = await fetchEconomicCalendar();
    res.json({ success: true, events });
  } catch (err) {
    logger.error(`[economicCalendar.controller] ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getCalendar };