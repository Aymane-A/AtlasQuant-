/**
 * src/controllers/alerts.controller.js — AtlasQuant AI
 * With live prices, delete, pause/unpause, notify channels
 */

const db     = require('../config/db');
const logger = require('../utils/logger');

const TYPE_MAP = {
  typePrice:  'price',
  typeRsi:    'rsi',
  typeMacd:   'macd',
  typeVolume: 'volume',
  typePct:    'percent',
};

const TYPE_LABELS = {
  price:   'typePrice',
  rsi:     'typeRsi',
  macd:    'typeMacd',
  volume:  'typeVolume',
  percent: 'typePct',
};

const COLORS = {
  price:   'var(--cyan)',
  rsi:     'var(--amber)',
  macd:    'var(--purple)',
  volume:  'var(--green)',
  percent: 'var(--red)',
};

async function fetchPrice(symbol) {
  try {
    const YahooFinance = require('yahoo-finance2').default;
    const yf    = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
    const quote = await yf.quote(symbol);
    if (quote?.regularMarketPrice) return quote.regularMarketPrice;
  } catch {}
  try {
    const res  = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
    const data = await res.json();
    if (data?.price) return parseFloat(data.price);
  } catch {}
  return null;
}

function calcPct(condition, currentPrice, target) {
  const t = parseFloat(target);
  if (!currentPrice || !t) return 0;
  if (condition === 'above') return Math.min(Math.round((currentPrice / t) * 100), 100);
  if (condition === 'below') return Math.min(Math.round((t / currentPrice) * 100), 100);
  return 50;
}

function isNear(condition, currentPrice, target) {
  const t = parseFloat(target);
  if (!currentPrice || !t) return false;
  return Math.abs(currentPrice - t) / t <= 0.02;
}

// ── GET /api/alerts ───────────────────────────────────────
async function getAlerts(req, res) {
  try {
    const userId = req.user.id;

    const { rows: alerts } = await db.query(`
      SELECT id, symbol, type, condition, target, triggered, paused,
             notify_email, notify_telegram, triggered_at, created_at
      FROM alerts WHERE user_id = $1 ORDER BY created_at DESC
    `, [userId]);

    const { rows: [s] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE triggered = false AND paused = false) AS active,
        COUNT(*) FILTER (WHERE triggered = true)                     AS triggered,
        COUNT(*) FILTER (WHERE paused    = true)                     AS paused
      FROM alerts WHERE user_id = $1
    `, [userId]);

    const { rows: triggered } = await db.query(`
      SELECT symbol, type, condition, target, triggered_at
      FROM alerts WHERE user_id = $1 AND triggered = true
      ORDER BY triggered_at DESC LIMIT 10
    `, [userId]);

    const notifications = triggered.map(r => ({
      title:  `${r.symbol} alert triggered`,
      desc:   `${TYPE_LABELS[r.type] || r.type} ${r.condition} ${r.target}`,
      time:   r.triggered_at
        ? new Date(r.triggered_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : '—',
      unread: true,
      icon:   '🔔',
      bg:     'rgba(251,191,36,0.12)',
      color:  'var(--amber)',
    }));

    const activeAlerts  = alerts.filter(a => !a.triggered && !a.paused);
    const uniqueSymbols = [...new Set(activeAlerts.map(a => a.symbol))];
    const priceMap      = {};
    await Promise.allSettled(
      uniqueSymbols.map(async (sym) => { priceMap[sym] = await fetchPrice(sym); })
    );

    let nearCount = 0;
    const alertCards = activeAlerts.map(a => {
      const target       = parseFloat(a.target) || 0;
      const currentPrice = priceMap[a.symbol]   || null;
      const pct          = calcPct(a.condition, currentPrice, target);
      const near         = isNear(a.condition, currentPrice, target);
      if (near) nearCount++;
      const condSymbol   = a.condition === 'above' ? '>' : a.condition === 'below' ? '<' : '=';
      return {
        id:              a.id,
        sym:             a.symbol,
        typeKey:         TYPE_LABELS[a.type] || a.type,
        cur:             currentPrice
          ? `$${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : '—',
        target:          `${condSymbol} $${target.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        pct,
        color:           COLORS[a.type] || 'var(--cyan)',
        near,
        notifyEmail:     a.notify_email,
        notifyTelegram:  a.notify_telegram,
      };
    });

    res.json({
      success: true,
      stats: {
        active:    parseInt(s.active,    10) || 0,
        triggered: parseInt(s.triggered, 10) || 0,
        near:      nearCount,
        paused:    parseInt(s.paused,    10) || 0,
      },
      notifications,
      alerts: alertCards,
    });
  } catch (err) {
    logger.error(`[alerts.controller] Get Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to fetch alerts' });
  }
}

// ── POST /api/alerts ──────────────────────────────────────
async function createAlert(req, res) {
  try {
    const userId = req.user.id;
    const { symbol, type, condition, value, channels = [] } = req.body;
    const dbType = TYPE_MAP[type] || type;

    if (!symbol || !dbType || !value) {
      return res.status(400).json({ success: false, error: 'symbol, type, and value are required' });
    }

    const notifyEmail    = channels.includes('email');
    const notifyTelegram = channels.includes('telegram');

    const { rows } = await db.query(`
      INSERT INTO alerts (user_id, symbol, type, condition, target, notify_email, notify_telegram)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, symbol, type, condition, target, notify_email, notify_telegram, triggered, created_at
    `, [userId, symbol.toUpperCase(), dbType, condition || 'above', value, notifyEmail, notifyTelegram]);

    res.status(201).json({ success: true, alert: rows[0] });
  } catch (err) {
    logger.error(`[alerts.controller] Create Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to create alert' });
  }
}

// ── DELETE /api/alerts/:id ────────────────────────────────
async function deleteAlert(req, res) {
  try {
    const userId  = req.user.id;
    const alertId = parseInt(req.params.id, 10);

    const { rowCount } = await db.query(
      `DELETE FROM alerts WHERE id = $1 AND user_id = $2`,
      [alertId, userId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }

    res.json({ success: true, message: 'Alert deleted' });
  } catch (err) {
    logger.error(`[alerts.controller] Delete Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to delete alert' });
  }
}

// ── PATCH /api/alerts/:id/pause ───────────────────────────
async function togglePause(req, res) {
  try {
    const userId  = req.user.id;
    const alertId = parseInt(req.params.id, 10);

    const { rows, rowCount } = await db.query(`
      UPDATE alerts SET paused = NOT paused
      WHERE id = $1 AND user_id = $2
      RETURNING paused
    `, [alertId, userId]);

    if (rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }

    res.json({ success: true, paused: rows[0].paused });
  } catch (err) {
    logger.error(`[alerts.controller] Pause Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to toggle pause' });
  }
}

module.exports = { getAlerts, createAlert, deleteAlert, togglePause };