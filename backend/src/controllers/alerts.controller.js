/**
 * src/controllers/alerts.controller.js — AtlasQuant AI
 * Full version: live prices, delete, pause, snooze, reset, edit,
 * pagination, read tracking, history, email digest mode
 */

const db     = require('../config/db');
const logger = require('../utils/logger');

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance  = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const TYPE_MAP = {
  typePrice:  'price',
  typeRsi:    'rsi',
  typeMacd:   'macd',
  typeVolume: 'volume',
  typePct:    'percent',
};

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

const YF_MAP = {
  'XAU/USD': 'GC=F',     'XAG/USD': 'SI=F',
  'OIL/USD': 'CL=F',     'EUR/USD':  'EURUSD=X',
  'GBP/USD': 'GBPUSD=X', 'USD/JPY':  'JPY=X',
  'USD/CHF': 'CHF=X',    'AUD/USD':  'AUDUSD=X',
  'SPY':     'SPY',       'QQQ':      'QQQ',
  'NGAS':    'NG=F',
};

// ✅ Feature: durées de snooze acceptées côté serveur — whitelist stricte pour
// éviter qu'un body malformé/malveillant ne pousse un paused_until absurde
// (ex. hours=99999 ou négatif).
const SNOOZE_ALLOWED_HOURS = [1, 4, 24];

// ✅ Feature: modes d'envoi email acceptés — cohérent avec le CHECK constraint
// alerts_email_frequency_check ajouté en migration.
const EMAIL_FREQUENCY_ALLOWED = ['instant', 'digest'];

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
  try {
    const normalized = normalizeForexSymbol(symbol);
    const yfSym       = YF_MAP[normalized] || YF_MAP[symbol] || normalized;
    const quote       = await yahooFinance.quote(yfSym);
    if (quote?.regularMarketPrice) return quote.regularMarketPrice;
  } catch (err) {
    logger.error(`[alerts] fetchPrice yahoo(${symbol}): ${err.message}`);
  }

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

// ✅ Feature: lève automatiquement les snoozes expirés avant toute lecture —
// évite d'avoir besoin d'un cron dédié: dès que l'utilisateur recharge la
// page (polling 30s côté front), les alertes dont paused_until est passé
// redeviennent actives.
async function releaseExpiredSnoozes(userId) {
  try {
    await db.query(`
      UPDATE alerts SET paused = false, paused_until = NULL
      WHERE user_id = $1 AND paused_until IS NOT NULL AND paused_until <= NOW()
    `, [userId]);
  } catch (err) {
    logger.error(`[alerts] releaseExpiredSnoozes: ${err.message}`);
  }
}

// ── GET /api/alerts?feedLimit=10 ──────────────────────────
async function getAlerts(req, res) {
  try {
    const userId    = req.user.id;
    // ✅ Feature: pagination du feed — 10 par défaut, "Load more" renvoie
    // juste une LIMIT plus grande (pas d'offset, pas de doublons de page).
    const feedLimit = Math.min(parseInt(req.query.feedLimit, 10) || 10, 200);

    await releaseExpiredSnoozes(userId);

    const { rows: alerts } = await db.query(`
      SELECT id, symbol, type, condition, target, triggered, paused, paused_until,
             notify_email, notify_telegram, email_frequency, triggered_at, created_at
      FROM alerts WHERE user_id = $1 ORDER BY created_at DESC
    `, [userId]);

    const { rows: [s] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE triggered = false AND paused = false) AS active,
        COUNT(*) FILTER (WHERE triggered = true)                     AS triggered,
        COUNT(*) FILTER (WHERE paused    = true)                     AS paused
      FROM alerts WHERE user_id = $1
    `, [userId]);

    // ✅ Fix "unread": on récupère id + read pour construire un badge réel
    // et permettre de marquer une alerte précise comme lue (PATCH /:id/read).
    const { rows: triggered } = await db.query(`
      SELECT id, symbol, type, condition, target, triggered_at, metadata, read
      FROM alerts WHERE user_id = $1 AND triggered = true
      ORDER BY triggered_at DESC LIMIT $2
    `, [userId, feedLimit]);

    const notifications = triggered.map(r => {
      const content = buildNotificationContent(r);
      return {
        id:     r.id,
        title:  content.title,
        desc:   content.desc,
        time:   r.triggered_at
          ? new Date(r.triggered_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
          : '—',
        unread: !r.read,
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
        // ✅ Feature (Edit/Duplicate): valeurs brutes pour pré-remplir le
        // formulaire — `cur`/`target` ci-dessous sont déjà formatés pour
        // l'affichage et inutilisables tels quels dans un <input>.
        condition:      a.condition,
        targetValue:    target,
        cur:            currentPrice
          ? `$${currentPrice.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`
          : '—',
        target:         `${condSymbol} $${target.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`,
        pct,
        color:          COLORS[a.type] || 'var(--cyan)',
        near,
        notifyEmail:    a.notify_email,
        notifyTelegram: a.notify_telegram,
        emailFrequency: a.email_frequency || 'instant',
      };
    });

    // ✅ Feature: cards pausées/snoozées séparées, avec pausedUntil pour
    // affichage countdown côté frontend ("Resumes in 3h20").
    const pausedCards = alerts
      .filter(a => a.paused)
      .map(a => ({
        id:          a.id,
        sym:         a.symbol,
        typeKey:     TYPE_LABELS[a.type] || a.type,
        condition:   a.condition,
        targetValue: parseFloat(a.target) || 0,
        snoozed:     !!a.paused_until,
        pausedUntil: a.paused_until,
      }));

    res.json({
      success: true,
      stats: {
        active:    parseInt(s.active,    10) || 0,
        triggered: parseInt(s.triggered, 10) || 0,
        near:      nearCount,
        paused:    parseInt(s.paused,    10) || 0,
      },
      notifications,
      hasMoreNotifications: feedLimit < (parseInt(s.triggered, 10) || 0),
      alerts: alertCards,
      pausedAlerts: pausedCards,
    });
  } catch (err) {
    logger.error(`[alerts.controller] Get Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to fetch alerts' });
  }
}

// ── GET /api/alerts/history?limit=50 ──────────────────────
async function getHistory(req, res) {
  try {
    const userId = req.user.id;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 500);

    const { rows } = await db.query(`
      SELECT id, symbol, type, condition, target, triggered_at, created_at,
             notify_email, notify_telegram, metadata
      FROM alerts
      WHERE user_id = $1 AND triggered = true
      ORDER BY triggered_at DESC
      LIMIT $2
    `, [userId, limit]);

    // ✅ Feature: total count pour savoir s'il faut afficher "Load more"
    const { rows: [c] } = await db.query(`
      SELECT COUNT(*)::int AS total FROM alerts WHERE user_id = $1 AND triggered = true
    `, [userId]);

    const history = rows.map(r => {
      const isAiSignal = r.type === 'ai_signal';
      const meta = r.metadata || {};
      return {
        id:             r.id,
        sym:            r.symbol,
        typeKey:        TYPE_LABELS[r.type] || r.type,
        condition:      isAiSignal ? (meta.signal || r.condition) : r.condition,
        target:         `$${parseFloat(r.target).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`,
        triggeredAt:    r.triggered_at,
        createdAt:      r.created_at,
        notifyEmail:    r.notify_email,
        notifyTelegram: r.notify_telegram,
        color:          COLORS[r.type] || 'var(--cyan)',
      };
    });

    res.json({ success: true, history, total: c.total, hasMore: limit < c.total });
  } catch (err) {
    logger.error(`[alerts.controller] History Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
}

// ── POST /api/alerts ──────────────────────────────────────
async function createAlert(req, res) {
  try {
    const userId = req.user.id;
    const { symbol, type, condition, value, channels = [], emailFrequency } = req.body;
    const dbType = TYPE_MAP[type] || type;

    if (!symbol || !dbType || !value) {
      return res.status(400).json({ success: false, error: 'symbol, type, and value are required' });
    }

    const notifyEmail    = channels.includes('email');
    const notifyTelegram = channels.includes('telegram');
    // ✅ Feature: whitelist stricte, même pattern que SNOOZE_ALLOWED_HOURS —
    // évite qu'une valeur non gérée par alertChecker.service.js se glisse en base.
    const freq = EMAIL_FREQUENCY_ALLOWED.includes(emailFrequency) ? emailFrequency : 'instant';

    const { rows } = await db.query(`
      INSERT INTO alerts (user_id, symbol, type, condition, target, notify_email, notify_telegram, email_frequency)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, symbol, type, condition, target, notify_email, notify_telegram, email_frequency, triggered, created_at
    `, [userId, symbol.toUpperCase(), dbType, condition || 'above', value, notifyEmail, notifyTelegram, freq]);

    res.status(201).json({ success: true, alert: rows[0] });
  } catch (err) {
    logger.error(`[alerts.controller] Create Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to create alert' });
  }
}

// ── PATCH /api/alerts/:id ─────────────────────────────────
// ✅ Feature: Edit alert — modifie symbol/type/condition/target d'une alerte
// existante sans devoir la supprimer et en recréer une. Les canaux de notif
// (email/telegram) ne sont volontairement pas touchés ici — ils restent ceux
// définis à la création (édition limitée aux specs de déclenchement).
async function updateAlert(req, res) {
  try {
    const userId  = req.user.id;
    const alertId = parseInt(req.params.id, 10);
    const { symbol, type, condition, value } = req.body;
    const dbType = TYPE_MAP[type] || type;

    if (!symbol || !dbType || !value) {
      return res.status(400).json({ success: false, error: 'symbol, type, and value are required' });
    }

    const { rows, rowCount } = await db.query(`
      UPDATE alerts
      SET symbol = $1, type = $2, condition = $3, target = $4
      WHERE id = $5 AND user_id = $6
      RETURNING id, symbol, type, condition, target, notify_email, notify_telegram, email_frequency, triggered, created_at
    `, [symbol.toUpperCase(), dbType, condition || 'above', value, alertId, userId]);

    if (rowCount === 0) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true, alert: rows[0] });
  } catch (err) {
    logger.error(`[alerts.controller] Update Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to update alert' });
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

    // ✅ Fix: un pause manuel doit aussi effacer un éventuel paused_until
    // hérité d'un ancien snooze, sinon releaseExpiredSnoozes le dé-pause
    // tout seul plus tard sans que l'utilisateur l'ait demandé.
    const { rows, rowCount } = await db.query(`
      UPDATE alerts SET paused = NOT paused, paused_until = NULL
      WHERE id = $1 AND user_id = $2 RETURNING paused
    `, [alertId, userId]);

    if (rowCount === 0) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true, paused: rows[0].paused });
  } catch (err) {
    logger.error(`[alerts.controller] Pause Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to toggle pause' });
  }
}

// ── PATCH /api/alerts/:id/snooze ──────────────────────────
// ✅ Feature: Snooze — met l'alerte en pause pour une durée précise (1h/4h/24h)
// au lieu d'une pause indéfinie. Réutilise la colonne "paused" existante pour
// que les stats/filtres déjà en place la traitent naturellement comme
// "Paused", + paused_until pour savoir quand la relever automatiquement
// (voir releaseExpiredSnoozes, appelé à chaque GET /api/alerts).
//
// ✅ Fix vs version précédente: `NOW() + ($1 || ' hours')::interval` plantait
// avec "operator does not exist: integer || text" — $1 arrive en integer côté
// pg, pas en text, donc || (concat text) ne matchait aucun opérateur. Remplacé
// par make_interval(hours => $1), qui prend directement un integer.
async function snoozeAlert(req, res) {
  try {
    const userId  = req.user.id;
    const alertId = parseInt(req.params.id, 10);
    const hours   = parseInt(req.body.hours, 10);

    if (!SNOOZE_ALLOWED_HOURS.includes(hours)) {
      return res.status(400).json({ success: false, error: `hours must be one of: ${SNOOZE_ALLOWED_HOURS.join(', ')}` });
    }

    const { rows, rowCount } = await db.query(`
      UPDATE alerts
      SET paused = true, paused_until = NOW() + make_interval(hours => $1)
      WHERE id = $2 AND user_id = $3
      RETURNING paused, paused_until
    `, [hours, alertId, userId]);

    if (rowCount === 0) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true, paused: rows[0].paused, pausedUntil: rows[0].paused_until });
  } catch (err) {
    logger.error(`[alerts.controller] Snooze Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to snooze alert' });
  }
}

// ── PATCH /api/alerts/:id/reset ──────────────────────────
async function resetAlert(req, res) {
  try {
    const userId  = req.user.id;
    const alertId = parseInt(req.params.id, 10);

    // ✅ read reset à false aussi: si l'alerte se redéclenche plus tard,
    // elle doit réapparaître comme "unread", pas rester marquée lue pour
    // toujours à cause d'un ancien déclenchement déjà vu.
    // ✅ paused_until aussi nettoyé, au cas où un reset arrive sur une
    // alerte encore snoozée.
    const { rowCount } = await db.query(`
      UPDATE alerts
      SET triggered = false, triggered_at = NULL, paused = false, paused_until = NULL, read = false
      WHERE id = $1 AND user_id = $2
    `, [alertId, userId]);

    if (rowCount === 0) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`[alerts.controller] Reset Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to reset alert' });
  }
}

// ── PATCH /api/alerts/:id/read ────────────────────────────
// ✅ Fix "unread" mzawer: marque une notification précise comme lue.
async function markAsRead(req, res) {
  try {
    const userId  = req.user.id;
    const alertId = parseInt(req.params.id, 10);

    const { rowCount } = await db.query(
      `UPDATE alerts SET read = true WHERE id = $1 AND user_id = $2`,
      [alertId, userId]
    );

    if (rowCount === 0) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`[alerts.controller] MarkRead Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to mark alert as read' });
  }
}

// ── PATCH /api/alerts/read-all ────────────────────────────
async function markAllRead(req, res) {
  try {
    const userId = req.user.id;
    const { rowCount } = await db.query(
      `UPDATE alerts SET read = true WHERE user_id = $1 AND triggered = true AND read = false`,
      [userId]
    );
    res.json({ success: true, updated: rowCount });
  } catch (err) {
    logger.error(`[alerts.controller] MarkAllRead Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to mark alerts as read' });
  }
}

// ── DELETE /api/alerts/triggered/all ──────────────────────
async function clearAllTriggered(req, res) {
  try {
    const userId = req.user.id;
    const { rowCount } = await db.query(
      `DELETE FROM alerts WHERE user_id = $1 AND triggered = true`,
      [userId]
    );
    res.json({ success: true, deleted: rowCount });
  } catch (err) {
    logger.error(`[alerts.controller] ClearAll Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to clear alerts' });
  }
}

// ── PATCH /api/alerts/:id/email-frequency ─────────────────
// ✅ Feature: toggle rapide Instant/Digest depuis une card active, sans passer
// par l'édition complète (qui exige symbol/type/condition/value tous présents).
// Les alertes déjà en queue (alert_digest_queue, sent=false) au moment du
// switch instant→digest ou digest→instant ne sont pas rétroactivement
// affectées — seuls les futurs déclenchements suivent le nouveau mode.
async function setEmailFrequency(req, res) {
  try {
    const userId  = req.user.id;
    const alertId = parseInt(req.params.id, 10);
    const { emailFrequency } = req.body;

    if (!EMAIL_FREQUENCY_ALLOWED.includes(emailFrequency)) {
      return res.status(400).json({ success: false, error: `emailFrequency must be one of: ${EMAIL_FREQUENCY_ALLOWED.join(', ')}` });
    }

    const { rows, rowCount } = await db.query(`
      UPDATE alerts SET email_frequency = $1
      WHERE id = $2 AND user_id = $3
      RETURNING email_frequency
    `, [emailFrequency, alertId, userId]);

    if (rowCount === 0) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true, emailFrequency: rows[0].email_frequency });
  } catch (err) {
    logger.error(`[alerts.controller] SetEmailFrequency Error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to update email frequency' });
  }
}

module.exports = {
  getAlerts, getHistory, createAlert, updateAlert, deleteAlert,
  togglePause, snoozeAlert, resetAlert, clearAllTriggered,
  markAsRead, markAllRead, setEmailFrequency,
};

// ── Refactor note ─────────────────────────────────────────
// YF_MAP + normalizeForexSymbol are now duplicated in both
// watchlist.controller.js and this file. Worth extracting to a
// shared services/symbolMap.service.js next time either one
// needs a new symbol added, so both stay in sync automatically.