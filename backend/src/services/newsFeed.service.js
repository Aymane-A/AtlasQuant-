/**
 * services/newsFeed.service.js
 *
 * Agrège des flux RSS financiers publics (crypto, forex/macro, commodities).
 * Pas de clé API requise — flux RSS publics standards.
 */

const Parser = require('rss-parser');
const logger = require('../utils/logger');

const parser = new Parser({ timeout: 10000 });

const TTL = 10 * 60 * 1000; // 10 min
let cache = null;
let cacheStamp = 0;

const FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', category: 'Crypto'    },
  { url: 'https://www.forexlive.com/feed/news',              category: 'Forex'     },
  { url: 'https://www.investing.com/rss/news_301.rss',       category: 'Commodity' },
];

async function fetchOneFeed({ url, category }) {
  try {
    const feed = await parser.parseURL(url);
    return (feed.items || []).slice(0, 8).map(item => ({
      title:     item.title,
      link:      item.link,
      source:    feed.title || category,
      category,
      publishedAt: item.isoDate || item.pubDate || null,
    }));
  } catch (err) {
    logger.error(`[newsFeed] ${category} feed error: ${err.message}`);
    return [];
  }
}

async function fetchAllNews() {
  if (cache && (Date.now() - cacheStamp < TTL)) {
    return cache;
  }

  const results = await Promise.allSettled(FEEDS.map(fetchOneFeed));
  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(item => item.publishedAt)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 20);

  cache = all;
  cacheStamp = Date.now();
  logger.info(`[newsFeed] ${all.length} articles chargés`);
  return all;
}

module.exports = { fetchAllNews };