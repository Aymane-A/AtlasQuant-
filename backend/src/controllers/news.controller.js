/**
 * controllers/news.controller.js
 */
const { fetchAllNews } = require('../services/newsFeed.service');
const logger = require('../utils/logger');

async function getNews(req, res) {
  try {
    const articles = await fetchAllNews();
    res.json({ success: true, articles });
  } catch (err) {
    logger.error(`[news.controller] ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getNews };