/**
 * src/controllers/alerts.controller.js — AtlasQuant AI
 * Full version: live prices, delete, pause, reset, history
 */

const db     = require('../config/db');
const logger = require('../utils/logger');

// yahoo-finance2 v3+ requires explicit instantiation — instance kept
// at module scope instead of re-created on every fetchPrice() call.
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance  = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const TYPE_MAP = {
  typePrice:  'price',
  typeRsi:    'rsi',
  typeMacd:   'macd',
  typeVolume: 'volume',
  typePct:    'percent',
};

// ✅ Fix Bug 2: 'ai_signal' n'était listé nulle part ici — les alertes
// auto-générées par signalAlert.service.js tombaient dans le fallback
// `TYPE_LABELS[r.type] || r.type`, affichant le texte brut "ai_signal" sans
// couleur ni icône dédiées.
const TYPE_LABELS = {
  price:     'typePrice',
  rsi:       'typeRsi',
  macd:      'typeMacd',
  volume:    'typeVolume',
  percent:   'typePct',
  ai_signal: 'typeAiSignal',
};

const COLORS = {
  price:     'var(--cyan)',
  rsi:       'var(--amber)',
  macd:      'var(--purple)',
  volume:    'var(--green)',
  percent:   'var(--red)',
  ai_signal: 'var(--purple-bright)',
};

// ── Forex/Commodity symbol → Yahoo Finance ticker map ───────
// Same mapping as watchlist.controller.js — kept in sync manually
// for now (see refactor note at the bottom of this file).
const YF_MAP = {
  'XAU/USD': 'GC=F',     'XAG/USD': 'SI=F',
  'OIL/USD': 'CL=F',     'EUR/USD':  'EURUSD=X',
  'GBP/USD': 'GBPUSD=X', 'USD/JPY':  'JPY=X',
  'USD/CHF': 'CHF=X',    'AUD/USD':  'AUDUSD=X',
  'SPY':     'SPY',       'QQQ':      'QQQ',
  'NGAS':    'NG=F',
};

// Handles symbols stored without a slash (e.g. "EURUSD" → "EUR/USD")
// so YF_MAP lookups don't silently miss and fall through to an
// invalid raw ticker (this was causing forex/commodity alerts to
// always show "—" for current price).
function normalizeForexSymbol(sym) {
  if (!sym) return sym;
  const clean = sym.toUpperCase().trim();

  if (clean.includes('/')) return clean;

  const KNOWN_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD'];
  if (KNOWN_PAIRS.includes(clean)) {
    return clean.slice(0, 3) + '/' + clean.slice(3);
  }

  const COMMODITY_ALIASES = {
    'XAUUSD': 'XAU/USD',
    'XAGUSD': 'XAG/USD',
    'OILUSD': 'OIL/USD',
    'GOLD':   'XAU/USD',
    'SILVER': 'XAG/USD',
  };
  if (COMMODITY_ALIASES[clean]) return COMMODITY_ALIASES[clean];

  return clean;
}

async function fetchPrice(symbol) {
  // Try Yahoo Finance first (forex/commodities/indices/stocks)
  try {
    const normalized = normalizeForexSymbol(symbol);
    const yfSym       = YF_MAP[normalized] || YF_MAP[symbol] || normalized;
    const quote       = await yahooFinance.quote(yfSym);
    if (quote?.regularMarketPrice) return quote.regularMarketPrice;
  } catch (err) {
    logger.error(`[alerts] fetchPrice yahoo(${symbol}): ${err.message}`);
  }

  // Fallback: Binance (crypto)
  try {
    const res  = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
    const data = await res.json();
    if (data?.price) return parseFloat(data.price);
  } catch (err) {
    logger.error(`[alerts] fetchPrice binance(${symbol}): ${err.message}`);
  }

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

// ✅ Fix Bug 2: construit un message lisible pour une alerte, en tenant
// compte du cas particulier 'ai_signal' (utilise metadata.signal/confidence
// au lieu d'afficher "ai_signal above X" tel quel).
function buildNotificationContent(row) {
  const isAiSignal = row.type === 'ai_signal';
  const meta = row.metadata || {};

  if (isAiSignal) {
    const direction = meta.signal ? (meta.signal === 'BUY' ? 'BUY / LONG' : 'SELL / SHORT') : 'signal';
    const conf = meta.confidence != null ? `${meta.confidence}%` : '—';
    return {
      title: `${row.symbol} — AI ${direction} detected`,
      desc:  `Confidence ${conf} · Entry ≈ $${parseFloat(row.target).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`,
      icon:  '🤖',
      bg:    'rgba(167,139,250,0.12)',
      color: 'var(--purple-bright)',
    };
  }

  return {
    title: `${row.symbol} alert triggered`,
    desc:  `${TYPE_LABELS[row.type] || row.type} ${row.condition} ${row.target}`,
    icon:  '🔔',
    bg:    'rgba(251,191,36,0.12)',
    color: 'var(--amber)',
  };
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

    // ✅ Fix Bug 2: on récupère `metadata` pour pouvoir construire un message
    // lisible pour les alertes 'ai_signal' (direction + confidence).
    const { rows: triggered } = await db.query(`
      SELECT symbol, type, condition, target, triggered_at, metadata
      FROM alerts WHERE user_id = $1 AND triggered = true
      ORDER BY triggered_at DESC LIMIT 10
    `, [userId]);

    const notifications = triggered.map(r => {
      const content = buildNotificationContent(r);
      return {
        title:  content.title,
        desc:   content.desc,
        time:   r.triggered_at
          ? new Date(r.triggered_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
          : '—',
        unread: true,
        icon:   content.icon,
        bg:     content.bg,
        color:  content.color,
      };
    });

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
        id:             a.id,
        sym:            a.symbol,
        typeKey:        TYPE_LABELS[a.type] || a.type,
        cur:            currentPrice
          ? `$${currentPrice.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`
          : '—',
        target:         `${condSymbol} $${target.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`,
        pct,
        color:          COLORS[a.type] || 'var(--cyan)',
        near,
        notifyEmail:    a.notify_email,
        notifyTelegram: a.notify_telegram,
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

// ── GET /api/alerts/history ───────────────────────────────
async function getHistory(req, res) {
  try {
    const userId = req.user.id;
    const limit  = parseInt(req.query.limit, 10) || 50;

    const { rows } = await db.query(`
      SELECT id, symbol, type, condition, target, triggered_at, created_at,
             notify_email, notify_telegram, metadata
      FROM alerts
      WHERE user_id = $1 AND triggered = true
      ORDER BY triggered_at DESC
      LIMIT $2
    `, [userId, limit]);

    const history = rows.map(r => {
      const isAiSignal = r.type === 'ai_signal';
      const meta = r.metadata || {};
      return {
        id:             r.id,
        sym:            r.symbol,
        typeKey:        TYPE_LABELS[r.type] || r.type,
        // ✅ Fix Bug 2: pour un ai_signal, on affiche la direction détectée
        // (BUY/SELL) plutôt que la "condition" générique (toujours 'above').
        condition:      isAiSignal ? (meta.signal || r.condition) : r.condition,
        target:         `$${parseFloat(r.target).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`,
        triggeredAt:    r.triggered_at,
        createdAt:      r.created_at,
        notifyEmail:    r.notify_email,
        notifyTelegram: r.notify_telegram,
        color:          COLORS[r.type] || 'var(--cyan)',
      };
    });

    res.json({ success: true, history });
  } catch (err) {
    logger.error(`[alerts.controller] History Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to fetch history' });
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

    if (rowCount === 0) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true });
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
      WHERE id = $1 AND user_id = $2 RETURNING paused
    `, [alertId, userId]);

    if (rowCount === 0) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true, paused: rows[0].paused });
  } catch (err) {
    logger.error(`[alerts.controller] Pause Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to toggle pause' });
  }
}

// ── PATCH /api/alerts/:id/reset ──────────────────────────
async function resetAlert(req, res) {
  try {
    const userId  = req.user.id;
    const alertId = parseInt(req.params.id, 10);

    const { rowCount } = await db.query(`
      UPDATE alerts
      SET triggered = false, triggered_at = NULL, paused = false
      WHERE id = $1 AND user_id = $2
    `, [alertId, userId]);

    if (rowCount === 0) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`[alerts.controller] Reset Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to reset alert' });
  }
}

module.exports = { getAlerts, getHistory, createAlert, deleteAlert, togglePause, resetAlert };

// ── Refactor note ─────────────────────────────────────────
// YF_MAP + normalizeForexSymbol are now duplicated in both
// watchlist.controller.js and this file. Worth extracting to a
// shared services/symbolMap.service.js next time either one
// needs a new symbol added, so both stay in sync automatically.