/**
 * controllers/news.controller.js
 */
const { fetchAllNews } = require('../services/newsFeed.service');
const logger = require('../utils/logger');
const { sendServerError } = require('../utils/httpError');

async function getNews(req, res) {
  try {
    const articles = await fetchAllNews();
    res.json({ success: true, articles });
  } catch (err) {
    logger.error(`[news.controller] ${err.message}`);
    sendServerError(res, err);
  }
}

module.exports = { getNews };