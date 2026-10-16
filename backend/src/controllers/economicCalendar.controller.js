/**
 * controllers/economicCalendar.controller.js
 */
const { fetchEconomicCalendar } = require('../services/economicCalendar.service');
const logger = require('../utils/logger');
const { sendServerError } = require('../utils/httpError');

async function getCalendar(req, res) {
  try {
    const events = await fetchEconomicCalendar();
    res.json({ success: true, events });
  } catch (err) {
    logger.error(`[economicCalendar.controller] ${err.message}`);
    sendServerError(res, err);
  }
}

module.exports = { getCalendar };