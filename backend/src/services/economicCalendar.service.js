/**
 * services/economicCalendar.service.js
 *
 * Calendrier économique — source : flux JSON public ForexFactory
 * (pas de clé API requise). Le champ "date" du flux est une chaîne
 * ISO 8601 complète (ex: "2026-07-02T12:30:00-04:00"), pas un champ
 * date + un champ time séparés.
 */

const axios  = require('axios');
const logger = require('../utils/logger');

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const TTL    = 15 * 60 * 1000; // 15 min — le calendrier ne change pas souvent

let cache = null;
let cacheStamp = 0;

const IMPACT_COLOR = {
  High:   'var(--red)',
  Medium: 'var(--amber)',
  Low:    'var(--text-secondary)',
  Holiday:'var(--purple-bright)',
};

async function fetchEconomicCalendar() {
  if (cache && (Date.now() - cacheStamp < TTL)) {
    return cache;
  }

  try {
    const { data } = await axios.get(FF_URL, { timeout: 15000 });
    if (!Array.isArray(data)) throw new Error('Format de réponse inattendu');

    const now = new Date();

    const events = data
      .map(e => {
        const dt = e.date ? new Date(e.date) : null;
        const valid = dt && !isNaN(dt.getTime());
        return {
          title:       e.title,
          country:     e.country,
          impact:      e.impact || 'Low',
          impactColor: IMPACT_COLOR[e.impact] || IMPACT_COLOR.Low,
          forecast:    e.forecast || null,
          previous:    e.previous || null,
          actual:      e.actual   || null,
          datetime:    valid ? dt.toISOString() : null,
        };
      })
      .filter(e => e.datetime && new Date(e.datetime) >= new Date(now.getTime() - 60 * 60 * 1000)) // garde les events passés depuis < 1h (résultats "actual" frais)
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
      .slice(0, 20);

    cache = events;
    cacheStamp = Date.now();
    logger.info(`[economicCalendar] ${events.length} événements chargés`);
    return events;
  } catch (err) {
    logger.error(`[economicCalendar] fetch error: ${err.message}`);
    return cache || [];
  }
}

module.exports = { fetchEconomicCalendar };