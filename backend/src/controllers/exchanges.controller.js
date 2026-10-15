/**
 * controllers/exchanges.controller.js — AtlasQuant AI
 *
 * HTTP layer for /api/exchanges/*. All business logic lives in
 * services/exchanges.service.js — this file only validates input, calls the
 * service and shapes the JSON the frontend (pages/Exchanges.jsx) expects.
 *
 * NOTE: the previous contents of this file were a copy of the service, so
 * routes/exchanges.routes.js referenced handlers that did not exist and the
 * whole server crashed at startup ("Route.get() requires a callback function").
 *
 * Error shape: { success:false, error, message } — `message` is kept because
 * Exchanges.jsx historically reads `.message`.
 */
const svc    = require('../services/exchanges.service');
const db     = require('../config/db');
const logger = require('../utils/logger');
const { logAuditEvent } = require('../utils/auditLog');
const { requireVerifiedEmailForLive } = require('../utils/emailVerified');

const VALID_MODES   = ['readonly', 'paper', 'live'];
const ID_RE         = /^[a-z0-9_]{2,32}$/;
const PAPER_STATUS  = ['open', 'closed', 'cancelled'];

function fail(res, err, fallback = 'Erreur serveur') {
  const status  = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status >= 500 && !err?.status ? fallback : (err?.message || fallback);
  if (status >= 500) logger.error(`[exchanges.controller] ${err?.message}`);
  return res.status(status).json({ success: false, error: message, message });
}

const bad = (res, message) => res.status(400).json({ success: false, error: message, message });

function validId(res, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) { bad(res, 'exchangeId invalide'); return false; }
  return true;
}

// GET /api/exchanges/connections  → { [exchangeId]: { mode, connectedAt, lastSync, healthStatus, consecutiveFailures } }
async function getConnections(req, res) {
  try {
    res.json(await svc.getUserConnections(req.user.id));
  } catch (err) { fail(res, err); }
}

// POST /api/exchanges/connect  { exchange, credentials:{apiKey,apiSecret,passphrase?}, mode }
async function connect(req, res) {
  const { exchange, credentials, mode = 'readonly' } = req.body || {};
  if (!validId(res, exchange)) return;
  if (!VALID_MODES.includes(mode)) return bad(res, 'Mode invalide');
  if (!credentials || typeof credentials !== 'object') return bad(res, 'credentials requis');
  try {
    if (mode === 'live') {
      const v = await requireVerifiedEmailForLive(req.user.id);
      if (!v.ok) return res.status(v.status).json({ success: false, code: v.code, error: v.error, message: v.error });
    }
    await svc.connectExchange(req.user.id, exchange, credentials, mode);
    logAuditEvent(req.user.id, 'api_key_created', req, { exchange, mode }).catch(() => {});
    res.json({ success: true, message: 'Exchange connectée' });
  } catch (err) { fail(res, err); }
}

// PATCH /api/exchanges/:exchangeId/mode  { mode }
async function changeMode(req, res) {
  const { exchangeId } = req.params;
  const { mode } = req.body || {};
  if (!validId(res, exchangeId)) return;
  if (!VALID_MODES.includes(mode)) return bad(res, 'Mode invalide');
  try {
    if (mode === 'live') {
      const v = await requireVerifiedEmailForLive(req.user.id);
      if (!v.ok) return res.status(v.status).json({ success: false, code: v.code, error: v.error, message: v.error });
    }
    await svc.updateMode(req.user.id, exchangeId, mode);
    logger.info(`[exchanges] user ${req.user.id} switched ${exchangeId} to ${mode}`);
    res.json({ success: true, mode });
  } catch (err) { fail(res, err); }
}

// DELETE /api/exchanges/:exchangeId
async function disconnect(req, res) {
  const { exchangeId } = req.params;
  if (!validId(res, exchangeId)) return;
  try {
    await svc.disconnectExchange(req.user.id, exchangeId);
    logAuditEvent(req.user.id, 'api_key_revoked', req, { exchange: exchangeId }).catch(() => {});
    res.json({ success: true });
  } catch (err) { fail(res, err); }
}

// POST /api/exchanges/:exchangeId/test  → { success, message }
async function testConnection(req, res) {
  const { exchangeId } = req.params;
  if (!validId(res, exchangeId)) return;
  try {
    res.json(await svc.testConnection(req.user.id, exchangeId));
  } catch (err) { fail(res, err, 'Vérification impossible'); }
}

// POST /api/exchanges/:exchangeId/health-check
async function healthCheckOne(req, res) {
  const { exchangeId } = req.params;
  if (!validId(res, exchangeId)) return;
  try {
    const result = await svc.healthCheckConnection(req.user.id, exchangeId);
    if (!result) return res.status(404).json({ success: false, error: 'Exchange non connectée', message: 'Exchange non connectée' });
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
}

// GET /api/exchanges/portfolio/all  → { exchanges, totalsBySymbol, skipped }
async function getAggregatedPortfolio(req, res) {
  try {
    res.json({ success: true, ...(await svc.getAggregatedPortfolio(req.user.id)) });
  } catch (err) { fail(res, err); }
}

// GET /api/exchanges/:exchangeId/portfolio  → { mode, positions }
//   live/readonly → positions = [{symbol, free, locked, total}]
//   paper         → positions = open paper_trades rows
async function getPortfolio(req, res) {
  const { exchangeId } = req.params;
  if (!validId(res, exchangeId)) return;
  try {
    const creds = await svc.getDecryptedCredentials(req.user.id, exchangeId);
    if (!creds) return res.status(404).json({ success: false, error: 'Exchange non connectée', message: 'Exchange non connectée' });

    if (creds.mode === 'paper') {
      const positions = await svc.getPaperTrades(req.user.id, exchangeId, 'open');
      return res.json({ success: true, mode: 'paper', positions });
    }

    const positions = await svc.fetchPortfolio(exchangeId, creds);
    db.query(
      `UPDATE user_exchange_connections SET last_sync_at = NOW() WHERE user_id = $1 AND exchange_id = $2`,
      [req.user.id, exchangeId]
    ).catch(() => {});
    res.json({ success: true, mode: creds.mode, positions });
  } catch (err) { fail(res, err, 'Impossible de récupérer le portfolio'); }
}

// POST /api/exchanges/:exchangeId/order — same behaviour (and same validation)
// as POST /api/trading/order; kept for backward compatibility.
async function placeOrder(req, res) {
  const { exchangeId } = req.params;
  if (!validId(res, exchangeId)) return;
  req.body = { ...(req.body || {}), exchangeId };
  return require('./trading.controller').placeOrder(req, res);
}

// GET /api/exchanges/:exchangeId/paper-trades?status=open|closed|cancelled
async function getPaperTrades(req, res) {
  const { exchangeId } = req.params;
  const status = req.query.status || 'open';
  if (!validId(res, exchangeId)) return;
  if (!PAPER_STATUS.includes(status)) return bad(res, 'status invalide');
  try {
    const trades = await svc.getPaperTrades(req.user.id, exchangeId, status);
    res.json({ success: true, trades });
  } catch (err) { fail(res, err); }
}

// POST /api/exchanges/:exchangeId/paper-trades/:tradeId/close  { closePrice }
async function closePaperTrade(req, res) {
  const tradeId    = Number.parseInt(req.params.tradeId, 10);
  const closePrice = Number(req.body?.closePrice);
  if (!validId(res, req.params.exchangeId)) return;
  if (!Number.isInteger(tradeId) || tradeId <= 0) return bad(res, 'tradeId invalide');
  if (!Number.isFinite(closePrice) || closePrice <= 0) return bad(res, 'closePrice doit être un nombre positif');
  try {
    const trade = await svc.closePaperTrade(req.user.id, tradeId, closePrice, 'manual');
    res.json({ success: true, trade });
  } catch (err) { fail(res, err); }
}

module.exports = {
  getConnections, connect, changeMode, disconnect, testConnection, healthCheckOne,
  getAggregatedPortfolio, getPortfolio, placeOrder, getPaperTrades, closePaperTrade,
};
