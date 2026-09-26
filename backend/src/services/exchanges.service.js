/**
 * services/exchanges.service.js — AtlasQuant AI
 *
 * Couche unique d'accès aux exchanges connectées par l'utilisateur.
 * Trois familles gérées différemment :
 *   - CEX crypto (binance, bybit, okx, kucoin, kraken, coinbase, bitget,
 *     mexc, gate, htx, phemex) : via ccxt, generique. bitmex n'est PAS
 *     supporté par la version actuelle de ccxt (4.5.x) — connect() rejette
 *     explicitement plutôt que de planter sur "ccxt.bitmex is not a
 *     constructor".
 *   - oanda (Forex/CFD) : API REST custom. Convention de champs (vue dans
 *     Exchanges.jsx) : credentials.apiKey = Account ID, credentials.apiSecret
 *     = Personal Access Token (PAS l'inverse du nommage habituel API
 *     key/secret — respecté partout ci-dessous pour matcher trading.controller.js
 *     et paperTradeMonitor.service.js qui appellent déjà getOandaPrice avec
 *     cet ordre).
 *   - alpaca (Stocks/ETF US) : API REST custom, header APCA-API-KEY-ID /
 *     APCA-API-SECRET-KEY.
 *
 * ⚠️ Nécessite EXCHANGE_ENCRYPTION_KEY dans .env (64 caractères hex = 32
 * bytes) — générer avec :
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * Ce schéma d'encryption est NOUVEAU (le fichier original a été perdu) —
 * toute connexion existante en DB doit être reconnectée après déploiement.
 */

const crypto = require('crypto');
const axios  = require('axios');
const ccxt   = require('ccxt');
const db     = require('../config/db');
const logger = require('../utils/logger');

const ALGO = 'aes-256-gcm';
const VALID_MODES = ['readonly', 'paper', 'live'];

// Exchanges gérées génériquement via ccxt — tout exchange_id hors de cette
// liste (et hors 'oanda'/'alpaca') est rejeté explicitement à connectExchange().
const CCXT_EXCHANGES = new Set([
  'binance', 'bybit', 'okx', 'kucoin', 'kraken', 'coinbase',
  'bitget', 'mexc', 'gate', 'htx', 'phemex',
]);

// ── Encryption helpers ──────────────────────────────────────────
// Format stocké : iv(hex):authTag(hex):ciphertext(hex)
function getEncryptionKey() {
  const hex = process.env.EXCHANGE_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('EXCHANGE_ENCRYPTION_KEY manquante/invalide dans .env (64 caractères hex attendus)');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plainText) {
  if (plainText == null) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(payload) {
  if (!payload) return null;
  const key = getEncryptionKey();
  const [ivHex, authTagHex, dataHex] = payload.split(':');
  if (!ivHex || !authTagHex || !dataHex) throw new Error('Format de payload chiffré invalide');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

// ── ccxt helpers ──────────────────────────────────────────────
function getCcxtInstance(exchangeId, creds) {
  const ExchangeClass = ccxt[exchangeId];
  if (typeof ExchangeClass !== 'function') {
    const err = new Error(`Exchange "${exchangeId}" non supportée par ccxt (version installée)`);
    err.status = 400;
    throw err;
  }
  return new ExchangeClass({
    apiKey: creds.apiKey,
    secret: creds.apiSecret,
    password: creds.passphrase || undefined, // okx/kucoin/coinbase/bitget
    enableRateLimit: true,
  });
}

function normalizeCcxtBalance(balance) {
  const totals = balance.total || {};
  const free = balance.free || {};
  const used = balance.used || {};
  return Object.keys(totals)
    .filter(sym => parseFloat(totals[sym]) > 0.000001)
    .map(sym => ({
      symbol: sym,
      free: parseFloat(free[sym] || 0),
      locked: parseFloat(used[sym] || 0),
      total: parseFloat(totals[sym] || 0),
    }));
}

// ── OANDA helpers ────────────────────────────────────────────
// mode 'live' → api-fxtrade, sinon (readonly/paper) → api-fxpractice.
function getOandaBaseUrl(mode) {
  return mode === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
}

function toOandaInstrument(symbol) {
  const clean = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  return clean.length === 6 ? `${clean.slice(0, 3)}_${clean.slice(3)}` : symbol.toUpperCase();
}

// accountId = credentials.apiKey, apiToken = credentials.apiSecret — voir
// commentaire en tête de fichier. Ordre des paramètres positionnel pour
// matcher les appels existants (paperTradeMonitor.service.js, trading.controller.js).
async function getOandaPrice(accountId, apiToken, mode, symbol) {
  const base = getOandaBaseUrl(mode);
  const instrument = toOandaInstrument(symbol);
  const { data } = await axios.get(
    `${base}/v3/accounts/${accountId}/pricing?instruments=${instrument}`,
    { headers: { Authorization: `Bearer ${apiToken}` }, timeout: 6000 }
  );
  const p = data.prices?.[0];
  if (!p) throw new Error(`Pas de prix OANDA pour ${instrument}`);
  const bid = parseFloat(p.bids[0].price);
  const ask = parseFloat(p.asks[0].price);
  return { mid: (bid + ask) / 2, bid, ask };
}

// ── Alpaca helpers ───────────────────────────────────────────
function getAlpacaBaseUrl(mode) {
  return mode === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
}

function alpacaHeaders(creds) {
  return { 'APCA-API-KEY-ID': creds.apiKey, 'APCA-API-SECRET-KEY': creds.apiSecret };
}

async function getAlpacaQuote(creds, symbol) {
  const { data } = await axios.get(
    `https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`,
    { headers: alpacaHeaders(creds), timeout: 6000 }
  );
  const q = data?.quote;
  if (!q || !q.bp || !q.ap) throw new Error(`Pas de quote Alpaca pour ${symbol}`);
  return { mid: (q.bp + q.ap) / 2, bid: q.bp, ask: q.ap };
}

// ── GET /api/exchanges/connections ────────────────────────────
// ── GET /api/exchanges/connections ────────────────────────────
// Objet keyed par exchange_id — Exchanges.jsx lit connections[exchangeId]
// directement (pas un tableau), et connections initial state = {} côté
// frontend. Champs en camelCase pour matcher exactement ce que
// handleConnected() pose optimistiquement après un connect.
async function getUserConnections(userId) {
  const { rows } = await db.query(
    `SELECT exchange_id, mode, health_status, consecutive_failures,
            connected_at, last_sync_at
     FROM user_exchange_connections
     WHERE user_id = $1
     ORDER BY connected_at DESC`,
    [userId]
  );

  const result = {};
  for (const row of rows) {
    result[row.exchange_id] = {
      mode: row.mode,
      connectedAt: row.connected_at ? new Date(row.connected_at).toLocaleDateString() : '—',
      lastSync: row.last_sync_at ? new Date(row.last_sync_at).toLocaleString() : '—',
      healthStatus: row.health_status,
      consecutiveFailures: row.consecutive_failures,
    };
  }
  return result;
}

// ── Vérifie que des identifiants fonctionnent réellement ───────
async function verifyCredentials(exchangeId, creds) {
  try {
    if (exchangeId === 'oanda') {
      await axios.get(
        `${getOandaBaseUrl(creds.mode)}/v3/accounts/${creds.apiKey}/summary`,
        { headers: { Authorization: `Bearer ${creds.apiSecret}` }, timeout: 6000 }
      );
      return;
    }
    if (exchangeId === 'alpaca') {
      await axios.get(`${getAlpacaBaseUrl(creds.mode)}/v2/account`, {
        headers: alpacaHeaders(creds), timeout: 6000,
      });
      return;
    }
    if (CCXT_EXCHANGES.has(exchangeId)) {
      const ex = getCcxtInstance(exchangeId, creds);
      await ex.fetchBalance();
      return;
    }
    const err = new Error(`Exchange "${exchangeId}" non supportée`);
    err.status = 400;
    throw err;
  } catch (err) {
    if (err.status) throw err;
    const e = new Error(`Connexion à ${exchangeId} refusée — vérifie tes identifiants`);
    e.status = 400;
    throw e;
  }
}

// ── POST /api/exchanges/connect ───────────────────────────────
async function connectExchange(userId, exchange, credentials, mode = 'readonly') {
  if (!VALID_MODES.includes(mode)) {
    const err = new Error(`Mode invalide: ${mode}`);
    err.status = 400;
    throw err;
  }
  if (!credentials?.apiKey || !credentials?.apiSecret) {
    const err = new Error('apiKey et apiSecret requis');
    err.status = 400;
    throw err;
  }
  if (!CCXT_EXCHANGES.has(exchange) && exchange !== 'oanda' && exchange !== 'alpaca') {
    const err = new Error(`Exchange "${exchange}" non supportée`);
    err.status = 400;
    throw err;
  }

  // Paper mode : les credentials ne sont PAS vérifiés contre l'exchange —
  // OANDA/Alpaca practice acceptent des clés démo distinctes de leurs clés
  // live, et un paper trade CEX ne touche jamais l'exchange réel. Vérifier
  // ici bloquerait des connexions paper légitimes avec des clés démo.
  if (mode !== 'paper') {
    await verifyCredentials(exchange, { ...credentials, mode });
  }

  const apiKeyEnc = encrypt(credentials.apiKey);
  const apiSecretEnc = encrypt(credentials.apiSecret);
  const passphraseEnc = credentials.passphrase ? encrypt(credentials.passphrase) : null;

  await db.query(
    `INSERT INTO user_exchange_connections
       (user_id, exchange_id, api_key_enc, api_secret_enc, passphrase_enc, mode, connected_at, health_status)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),'ok')
     ON CONFLICT ON CONSTRAINT uq_user_exchange DO UPDATE SET
       api_key_enc = EXCLUDED.api_key_enc,
       api_secret_enc = EXCLUDED.api_secret_enc,
       passphrase_enc = EXCLUDED.passphrase_enc,
       mode = EXCLUDED.mode,
       connected_at = NOW(),
       health_status = 'ok',
       consecutive_failures = 0`,
    [userId, exchange, apiKeyEnc, apiSecretEnc, passphraseEnc, mode]
  );
}

// ── Décrypte les creds — utilisé partout (controller, trading, autoTrader,
// paperTradeMonitor, portfolioController).
async function getDecryptedCredentials(userId, exchangeId) {
  const { rows } = await db.query(
    `SELECT api_key_enc, api_secret_enc, passphrase_enc, mode
     FROM user_exchange_connections WHERE user_id = $1 AND exchange_id = $2`,
    [userId, exchangeId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    apiKey: decrypt(row.api_key_enc),
    apiSecret: decrypt(row.api_secret_enc),
    passphrase: row.passphrase_enc ? decrypt(row.passphrase_enc) : null,
    mode: row.mode,
  };
}

// ── PATCH /api/exchanges/:exchangeId/mode ─────────────────────
async function updateMode(userId, exchangeId, mode) {
  if (!VALID_MODES.includes(mode)) {
    const err = new Error(`Mode invalide: ${mode}`);
    err.status = 400;
    throw err;
  }
  const { rowCount } = await db.query(
    `UPDATE user_exchange_connections SET mode = $1 WHERE user_id = $2 AND exchange_id = $3`,
    [mode, userId, exchangeId]
  );
  if (!rowCount) {
    const err = new Error('Exchange non connectée');
    err.status = 404;
    throw err;
  }
}

// ── DELETE /api/exchanges/:exchangeId ─────────────────────────
async function disconnectExchange(userId, exchangeId) {
  const { rowCount } = await db.query(
    `DELETE FROM user_exchange_connections WHERE user_id = $1 AND exchange_id = $2`,
    [userId, exchangeId]
  );
  if (!rowCount) {
    const err = new Error('Exchange non connectée');
    err.status = 404;
    throw err;
  }
}

// ── POST /api/exchanges/:exchangeId/test ──────────────────────
async function testConnection(userId, exchangeId) {
  const creds = await getDecryptedCredentials(userId, exchangeId);
  if (!creds) {
    const err = new Error('Exchange non connectée');
    err.status = 404;
    throw err;
  }
  await verifyCredentials(exchangeId, creds);
  return { success: true, message: 'Connexion valide' };
}

// ── POST /api/exchanges/:exchangeId/health-check ──────────────
async function healthCheckConnection(userId, exchangeId) {
  const creds = await getDecryptedCredentials(userId, exchangeId);
  if (!creds) return null;

  let status = 'ok';
  let failures = 0;
  try {
    await verifyCredentials(exchangeId, creds);
  } catch {
    const { rows } = await db.query(
      `SELECT consecutive_failures FROM user_exchange_connections WHERE user_id=$1 AND exchange_id=$2`,
      [userId, exchangeId]
    );
    failures = (rows[0]?.consecutive_failures || 0) + 1;
    status = failures >= 3 ? 'failed' : 'degraded';
  }

  await db.query(
    `UPDATE user_exchange_connections
     SET health_status = $1, consecutive_failures = $2, last_health_check = NOW()
     WHERE user_id = $3 AND exchange_id = $4`,
    [status, failures, userId, exchangeId]
  );
  return { health_status: status, consecutive_failures: failures };
}

// ── GET /api/exchanges/:exchangeId/portfolio (live/readonly) ──
// Retourne toujours [{symbol, free, locked, total}, ...] quelle que soit
// l'exchange — c'est ce format que BalanceModal/AllPortfolioModal (frontend)
// et getAggregatedPortfolio() attendent.
async function fetchPortfolio(exchangeId, creds) {
  if (exchangeId === 'oanda') {
    const { data } = await axios.get(
      `${getOandaBaseUrl(creds.mode)}/v3/accounts/${creds.apiKey}/openPositions`,
      { headers: { Authorization: `Bearer ${creds.apiSecret}` }, timeout: 6000 }
    );
    return (data.positions || []).map(p => ({
      symbol: p.instrument,
      free: parseFloat(p.long?.units || 0) + parseFloat(p.short?.units || 0),
      locked: 0,
      total: parseFloat(p.long?.units || 0) + parseFloat(p.short?.units || 0),
    }));
  }

  if (exchangeId === 'alpaca') {
    const { data } = await axios.get(`${getAlpacaBaseUrl(creds.mode)}/v2/positions`, {
      headers: alpacaHeaders(creds), timeout: 6000,
    });
    return (data || []).map(p => ({
      symbol: p.symbol,
      free: parseFloat(p.qty_available ?? p.qty),
      locked: parseFloat(p.qty) - parseFloat(p.qty_available ?? p.qty),
      total: parseFloat(p.qty),
    }));
  }

  const ex = getCcxtInstance(exchangeId, creds);
  const balance = await ex.fetchBalance();
  return normalizeCcxtBalance(balance);
}

// ── GET /api/exchanges/portfolio/all ───────────────────────────
// Ignore les connexions en mode 'paper' — cette vue agrège les positions
// RÉELLES live/readonly uniquement.
async function getAggregatedPortfolio(userId) {
  const connectionsObj = await getUserConnections(userId);
  const connections = Object.entries(connectionsObj)
    .filter(([, c]) => c.mode !== 'paper')
    .map(([exchangeId, c]) => ({ exchange_id: exchangeId, mode: c.mode }));

  const totalsBySymbol = {};
  const exchangesOut = [];
  const skipped = [];

  await Promise.all(connections.map(async c => {
    try {
      const creds = await getDecryptedCredentials(userId, c.exchange_id);
      const positions = await fetchPortfolio(c.exchange_id, creds);
      exchangesOut.push({ exchangeId: c.exchange_id, mode: c.mode, positions });
      for (const p of positions) {
        totalsBySymbol[p.symbol] = (totalsBySymbol[p.symbol] || 0) + p.total;
      }
    } catch (err) {
      logger.error(`[exchanges] getAggregatedPortfolio(${c.exchange_id}): ${err.message}`);
      skipped.push({ exchangeId: c.exchange_id, reason: err.message });
    }
  }));

  return { exchanges: exchangesOut, totalsBySymbol, skipped };
}

// ── Utilisé par autoTrader.service.js pour le position sizing ──
// (creds.mode === 'paper' → solde simulé, sinon → fetchPortfolio réel)
async function getBalance(userId, exchangeId) {
  const creds = await getDecryptedCredentials(userId, exchangeId);
  if (!creds) return null;
  if (creds.mode === 'paper') {
    return [
      { symbol: 'USDT', free: 10000, locked: 0, total: 10000 },
      { symbol: 'USD', free: 10000, locked: 0, total: 10000 },
    ];
  }
  return fetchPortfolio(exchangeId, creds);
}

// ── POST /api/exchanges/:exchangeId/order (mode 'live') ───────
// Retourne { exchangeOrderId, status, raw, bracketUnsupported? }.
// OANDA et Alpaca supportent nativement un SL/TP attaché à l'ordre ; les
// CEX génériques via ccxt non (implémentation OCO/bracket variant trop
// par exchange pour un chemin générique fiable) — bracketUnsupported=true
// signale ce cas à trading.controller.js, qui avertit l'utilisateur.
async function placeLiveOrder(exchangeId, creds, { symbol, side, type, quantity, price, stopLoss, takeProfit }) {
  if (exchangeId === 'oanda') {
    const base = getOandaBaseUrl(creds.mode);
    const units = side === 'buy' ? String(quantity) : String(-quantity);
    const order = {
      type: type === 'limit' ? 'LIMIT' : 'MARKET',
      instrument: toOandaInstrument(symbol),
      units,
      ...(type === 'limit' ? { price: String(price) } : {}),
      ...(stopLoss ? { stopLossOnFill: { price: String(stopLoss) } } : {}),
      ...(takeProfit ? { takeProfitOnFill: { price: String(takeProfit) } } : {}),
    };
    const { data } = await axios.post(
      `${base}/v3/accounts/${creds.apiKey}/orders`,
      { order },
      { headers: { Authorization: `Bearer ${creds.apiSecret}`, 'Content-Type': 'application/json' }, timeout: 8000 }
    );
    return {
      exchangeOrderId: data.orderFillTransaction?.id || data.orderCreateTransaction?.id,
      status: data.orderFillTransaction ? 'filled' : 'pending',
      raw: data,
    };
  }

  if (exchangeId === 'alpaca') {
    const body = {
      symbol, side, type, qty: quantity,
      time_in_force: 'gtc',
      ...(type === 'limit' ? { limit_price: price } : {}),
    };
    if (stopLoss && takeProfit) {
      body.order_class = 'bracket';
      body.take_profit = { limit_price: takeProfit };
      body.stop_loss = { stop_price: stopLoss };
    } else if (stopLoss || takeProfit) {
      body.order_class = 'oto';
      if (takeProfit) body.take_profit = { limit_price: takeProfit };
      if (stopLoss) body.stop_loss = { stop_price: stopLoss };
    }
    const { data } = await axios.post(`${getAlpacaBaseUrl(creds.mode)}/v2/orders`, body, {
      headers: { ...alpacaHeaders(creds), 'Content-Type': 'application/json' }, timeout: 8000,
    });
    return { exchangeOrderId: data.id, status: data.status, raw: data };
  }

  const ex = getCcxtInstance(exchangeId, creds);
  await ex.loadMarkets();
  const pair = `${symbol.toUpperCase()}/USDT`;
  const order = await ex.createOrder(pair, type, side, quantity, type === 'limit' ? price : undefined);
  return {
    exchangeOrderId: String(order.id),
    status: order.status || 'open',
    raw: order,
    bracketUnsupported: !!(stopLoss || takeProfit),
  };
}

// ── DELETE /api/trading/orders/:orderId (mode live) ────────────
async function cancelLiveOrder(exchangeId, creds, orderId, symbol) {
  if (exchangeId === 'oanda') {
    await axios.put(
      `${getOandaBaseUrl(creds.mode)}/v3/accounts/${creds.apiKey}/orders/${orderId}/cancel`,
      {}, { headers: { Authorization: `Bearer ${creds.apiSecret}` }, timeout: 6000 }
    );
    return;
  }
  if (exchangeId === 'alpaca') {
    await axios.delete(`${getAlpacaBaseUrl(creds.mode)}/v2/orders/${orderId}`, {
      headers: alpacaHeaders(creds), timeout: 6000,
    });
    return;
  }
  const ex = getCcxtInstance(exchangeId, creds);
  await ex.loadMarkets();
  const pair = symbol ? `${symbol.toUpperCase()}/USDT` : undefined;
  await ex.cancelOrder(orderId, pair);
}

// ── POST /api/exchanges/:exchangeId/order (mode 'paper') ──────
async function openPaperTrade(userId, exchangeId, { symbol, side, orderType, quantity, price, limitPrice, stopLoss, takeProfit }) {
  const { rows } = await db.query(
    `INSERT INTO paper_trades
       (user_id, exchange_id, symbol, side, order_type, quantity, price, limit_price, stop_loss, take_profit, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')
     RETURNING *`,
    [userId, exchangeId, symbol.toUpperCase(), side, orderType, quantity, price,
     limitPrice || null, stopLoss || null, takeProfit || null]
  );
  return rows[0];
}

// ── POST /api/exchanges/:exchangeId/paper-trades/:tradeId/close ─
async function closePaperTrade(userId, tradeId, closePrice, reason = null) {
  const { rows: existing } = await db.query(
    `SELECT * FROM paper_trades WHERE id = $1 AND user_id = $2 AND status = 'open'`,
    [tradeId, userId]
  );
  if (!existing.length) {
    const err = new Error('Paper trade introuvable ou déjà fermé');
    err.status = 404;
    throw err;
  }
  const trade = existing[0];
  const entry = parseFloat(trade.price);
  const qty = parseFloat(trade.quantity);
  const pnl = trade.side === 'buy' ? (closePrice - entry) * qty : (entry - closePrice) * qty;
  const pnlPct = entry !== 0 ? (pnl / (entry * qty)) * 100 : 0;

  const { rows } = await db.query(
    `UPDATE paper_trades
     SET exit_price = $1, pnl = $2, pnl_pct = $3, status = 'closed', closed_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [closePrice, pnl.toFixed(8), pnlPct.toFixed(4), tradeId]
  );
  logger.info(`[exchanges] paper trade #${tradeId} fermé${reason ? ` (${reason})` : ''} — pnl ${pnl.toFixed(2)}`);
  return rows[0];
}

// ── GET /api/exchanges/:exchangeId/paper-trades ────────────────
async function getPaperTrades(userId, exchangeId, status = 'open') {
  const { rows } = await db.query(
    `SELECT * FROM paper_trades WHERE user_id = $1 AND exchange_id = $2 AND status = $3 ORDER BY opened_at DESC`,
    [userId, exchangeId, status]
  );
  return rows;
}

// ── Utilisé par paperTradeMonitor.service.js — tous users confondus ────
async function getOpenBracketTrades() {
  const { rows } = await db.query(
    `SELECT * FROM paper_trades
     WHERE status = 'open' AND (stop_loss IS NOT NULL OR take_profit IS NOT NULL)`
  );
  return rows;
}

// ── Cron toutes les 15min — vérifie TOUTES les connexions de TOUS les
// users (pas scoped à un seul userId comme healthCheckConnection).
// Retourne healthStatus en camelCase — c'est ce que cron.service.js lit
// (`r.healthStatus === 'failed'`), pas health_status (snake_case DB).
async function healthCheckAllConnections() {
  const { rows: connections } = await db.query(
    `SELECT user_id, exchange_id FROM user_exchange_connections`
  );

  const results = [];
  for (const conn of connections) {
    try {
      const result = await healthCheckConnection(conn.user_id, conn.exchange_id);
      results.push({
        userId: conn.user_id,
        exchangeId: conn.exchange_id,
        healthStatus: result?.health_status || 'unknown',
      });
    } catch (err) {
      logger.error(`[exchanges] healthCheckAllConnections(${conn.exchange_id}, user ${conn.user_id}): ${err.message}`);
      results.push({ userId: conn.user_id, exchangeId: conn.exchange_id, healthStatus: 'failed' });
    }
  }
  return results;
}

module.exports = {
  getUserConnections, connectExchange, getDecryptedCredentials,
  updateMode, disconnectExchange, testConnection, healthCheckConnection, healthCheckAllConnections,
  getOandaBaseUrl, getOandaPrice, alpacaHeaders, getAlpacaQuote,
  placeLiveOrder, cancelLiveOrder, fetchPortfolio, getAggregatedPortfolio, getBalance,
  openPaperTrade, closePaperTrade, getPaperTrades, getOpenBracketTrades,
};