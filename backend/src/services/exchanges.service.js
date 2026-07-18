const crypto  = require('crypto');
const axios   = require('axios');
const ccxt    = require('ccxt');
const pool    = require('../config/db').pool;

// ── Encryption ────────────────────────────────────────────
// ✅ Fix sécurité critique : l'ancien fallback `'0'.repeat(64)` faisait
// tourner AES-256-GCM avec une clé connue de tout le monde si
// EXCHANGE_ENCRYPTION_KEY était absente du .env (dev oublié, déploiement
// mal configuré...). Tous les API keys/secrets d'exchanges déjà chiffrés
// avec cette clé par défaut deviennent déchiffrables trivialement.
// On refuse maintenant de démarrer plutôt que de chiffrer silencieusement
// avec une clé publique — fail-fast vaut mieux qu'une fuite silencieuse.
const ALGO = 'aes-256-gcm';

if (!process.env.EXCHANGE_ENCRYPTION_KEY) {
  throw new Error(
    'FATAL: EXCHANGE_ENCRYPTION_KEY manquante dans .env — refus de démarrer avec une clé de chiffrement par défaut (non sécurisé). ' +
    'Générez-en une avec: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

const KEY = Buffer.from(process.env.EXCHANGE_ENCRYPTION_KEY, 'hex');

if (KEY.length !== 32) {
  throw new Error(
    `FATAL: EXCHANGE_ENCRYPTION_KEY invalide — attendu 32 bytes (64 caractères hex), reçu ${KEY.length} bytes.`
  );
}

function encrypt(plaintext) {
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored) {
  const [ivHex, tagHex, dataHex] = stored.split(':');
  try {
    const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (err) {
    // Message explicite : la cause la plus fréquente d'un échec de
    // déchiffrement ici est une rotation de EXCHANGE_ENCRYPTION_KEY après
    // que des credentials aient déjà été chiffrés avec l'ancienne clé.
    const e = new Error(
      'Échec du déchiffrement des credentials — probablement causé par un changement de EXCHANGE_ENCRYPTION_KEY depuis que cette connexion a été enregistrée. ' +
      'Solution : déconnectez puis reconnectez cet exchange depuis la page Exchanges.'
    );
    e.status = 401;
    throw e;
  }
}

// ── Supported exchanges ───────────────────────────────────
const PASSPHRASE_EXCHANGES = new Set(['okx', 'kucoin', 'bitget', 'coinbase']);

const CCXT_IDS = [
  'binance', 'binanceus', 'bybit', 'okx', 'kucoin', 'kraken', 'coinbase',
  'mexc', 'gate', 'htx', 'bitget', 'phemex', 'bitmex', 'bitfinex',
  'bitstamp', 'bingx', 'coinex', 'cryptocom', 'deribit', 'poloniex',
  'upbit', 'whitebit', 'woo', 'ascendex', 'bitrue', 'probit', 'hitbtc',
  'latoken', 'digifinex', 'p2b', 'bitopro', 'exmo', 'luno', 'coincheck',
];

const SUPPORTED = CCXT_IDS.reduce((acc, id) => {
  acc[id] = { requiredFields: PASSPHRASE_EXCHANGES.has(id)
    ? ['apiKey', 'apiSecret', 'passphrase']
    : ['apiKey', 'apiSecret'] };
  return acc;
}, {
  oanda: { requiredFields: ['apiKey', 'apiSecret'] },
});

const VALID_MODES = ['readonly', 'paper', 'live'];

function validateCredentials(exchange, credentials) {
  const cfg = SUPPORTED[exchange];
  if (!cfg) { const e = new Error(`Unsupported exchange: ${exchange}`); e.status = 400; throw e; }
  for (const f of cfg.requiredFields) {
    if (!credentials[f]?.trim()) { const e = new Error(`Missing field: ${f}`); e.status = 400; throw e; }
  }
}

// ── ccxt instance factory ─────────────────────────────────
function getCcxtInstance(exchangeId, credentials) {
  const ExchangeClass = ccxt[exchangeId];
  if (!ExchangeClass) { const e = new Error(`ccxt does not support: ${exchangeId}`); e.status = 400; throw e; }
  const config = {
    apiKey:         credentials.apiKey,
    secret:         credentials.apiSecret,
    enableRateLimit: true,
    timeout:        10000,
  };
  if (credentials.passphrase) config.password = credentials.passphrase;
  return new ExchangeClass(config);
}

function toCcxtSymbol(sym) {
  if (sym.includes('/')) return sym.toUpperCase();
  const s = sym.toUpperCase();
  if (s.endsWith('USDT')) return `${s.slice(0, -4)}/USDT`;
  if (s.endsWith('USDC')) return `${s.slice(0, -4)}/USDC`;
  if (s.endsWith('USD'))  return `${s.slice(0, -3)}/USD`;
  if (s.endsWith('BTC'))  return `${s.slice(0, -3)}/BTC`;
  return s;
}

// ── OANDA helpers ──────────────────────────────────────────
function getOandaBaseUrl(mode) {
  return mode === 'live'
    ? 'https://api-fxtrade.oanda.com'
    : 'https://api-fxpractice.oanda.com';
}

async function getOandaPrice(accountId, token, mode, instrument) {
  const base = getOandaBaseUrl(mode);
  const res  = await axios.get(`${base}/v3/accounts/${accountId}/pricing`, {
    headers: { Authorization: `Bearer ${token}` },
    params:  { instruments: instrument },
    timeout: 8000,
  });
  const p = res.data?.prices?.[0];
  if (!p) throw new Error(`No OANDA price for ${instrument}`);
  const bid = parseFloat(p.bids?.[0]?.price);
  const ask = parseFloat(p.asks?.[0]?.price);
  return { bid, ask, mid: (bid + ask) / 2 };
}

// ── Live key verification ─────────────────────────────────
// ✅ Fix : liste blanche d'erreurs "non fatales" (réseau/indispo) au lieu
// d'une liste noire d'erreurs "fatales". Avant, seules AuthenticationError
// et PermissionDenied étaient rejetées — toute autre erreur ccxt
// (InvalidNonce, BadRequest, ExchangeError générique...) tombait dans le
// warn silencieux et la connexion était acceptée comme "vérifiée" alors
// que les credentials étaient potentiellement invalides.
const NON_FATAL_CCXT_ERRORS = err =>
  err instanceof ccxt.NetworkError ||
  err instanceof ccxt.ExchangeNotAvailable ||
  err instanceof ccxt.RequestTimeout ||
  err instanceof ccxt.DDoSProtection;

async function verifyWithExchange(exchange, credentials, mode) {
  const effMode = credentials.mode || mode || 'live';

  if (exchange === 'oanda') {
    try {
      const base = getOandaBaseUrl(effMode);
      const res  = await axios.get(`${base}/v3/accounts/${credentials.apiKey}`, {
        headers: { Authorization: `Bearer ${credentials.apiSecret}` }, timeout: 8000,
      });
      console.log('[oanda] verify ok — account:', res.data?.account?.alias || credentials.apiKey);
    } catch (err) {
      if (err.response) {
        const e = new Error('Invalid API credentials — exchange rejected the key');
        e.status = 401; throw e;
      }
      console.warn('[exchanges] Could not reach oanda for verification:', err.message);
    }
    return;
  }

  // ccxt path — fetchBalance vérifie la clé pour tous les exchanges.
  try {
    const ex = getCcxtInstance(exchange, credentials);
    await ex.fetchBalance();
    console.log(`[${exchange}] verify ok`);
  } catch (err) {
    if (NON_FATAL_CCXT_ERRORS(err)) {
      console.warn(`[exchanges] ${exchange} unreachable during verification (retry later):`, err.message);
      return;
    }
    // Toute autre erreur (auth, permission, requête malformée, etc.) est
    // traitée comme un rejet — mieux vaut un faux refus occasionnel
    // qu'accepter des credentials potentiellement invalides.
    const e = new Error('Invalid API credentials — exchange rejected the key');
    e.status = 401; throw e;
  }
}

// ── Fetch live portfolio from exchange ────────────────────
async function fetchPortfolio(exchange, credentials) {
  console.log(`[fetchPortfolio] fetching ${exchange}...`);

  if (exchange === 'oanda') {
    const effMode = credentials.mode || 'practice';
    const base    = getOandaBaseUrl(effMode);
    const res     = await axios.get(`${base}/v3/accounts/${credentials.apiKey}/summary`, {
      headers: { Authorization: `Bearer ${credentials.apiSecret}` }, timeout: 10000,
    });
    const acc = res.data?.account;
    if (!acc) return [];
    const currency   = acc.currency || 'USD';
    const balance    = parseFloat(acc.balance);
    const marginUsed = parseFloat(acc.marginUsed || 0);
    console.log(`[oanda] balance=${balance} ${currency}, marginUsed=${marginUsed}`);
    return [{
      symbol: currency,
      free:   Math.max(balance - marginUsed, 0),
      locked: marginUsed,
      total:  balance,
    }];
  }

  const ex      = getCcxtInstance(exchange, credentials);
  const balance = await ex.fetchBalance();
  const totals  = balance.total || {};
  const free    = balance.free  || {};
  const used    = balance.used  || {};

  const nonZero = Object.keys(totals).filter(sym => parseFloat(totals[sym]) > 0);
  console.log(`[${exchange}] non-zero:`, nonZero.map(s => `${s}=${totals[s]}`));

  return nonZero.map(sym => ({
    symbol: sym,
    free:   parseFloat(free[sym]  || 0),
    locked: parseFloat(used[sym]  || 0),
    total:  parseFloat(totals[sym]),
  }));
}

// ── Place live order ──────────────────────────────────────
async function placeLiveOrder(exchange, credentials, { symbol, side, type, quantity, price, stopLoss, takeProfit }) {
  if (exchange === 'oanda') {
    const effMode = credentials.mode || 'practice';
    const base    = getOandaBaseUrl(effMode);
    const units   = side === 'buy' ? Math.abs(Math.round(quantity)) : -Math.abs(Math.round(quantity));

    const body = {
      order: {
        type:         type === 'limit' ? 'LIMIT' : 'MARKET',
        instrument:   symbol,
        units:        String(units),
        timeInForce:  type === 'limit' ? 'GTC' : 'FOK',
        positionFill: 'DEFAULT',
        ...(type === 'limit' && { price: String(price) }),
        ...(stopLoss   && { stopLossOnFill:   { price: String(stopLoss) } }),
        ...(takeProfit && { takeProfitOnFill: { price: String(takeProfit) } }),
      },
    };

    const res = await axios.post(`${base}/v3/accounts/${credentials.apiKey}/orders`, body, {
      headers: { Authorization: `Bearer ${credentials.apiSecret}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });

    const fillTxn   = res.data?.orderFillTransaction;
    const createTxn = res.data?.orderCreateTransaction;
    const cancelTxn = res.data?.orderCancelTransaction;

    if (cancelTxn) {
      const e = new Error(`OANDA rejected order: ${cancelTxn.reason || 'unknown reason'}`);
      e.status = 400; throw e;
    }

    return {
      exchangeOrderId: fillTxn?.id || createTxn?.id,
      status:          fillTxn ? 'FILLED' : 'PENDING',
      raw:             res.data,
    };
  }

  const ex           = getCcxtInstance(exchange, credentials);
  const marketSymbol = toCcxtSymbol(symbol);
  const ccxtParams   = {};
  if (stopLoss)   ccxtParams.stopLoss   = { triggerPrice: stopLoss };
  if (takeProfit) ccxtParams.takeProfit = { triggerPrice: takeProfit };

  let order;
  try {
    order = await ex.createOrder(
      marketSymbol, type, side, quantity,
      type === 'market' ? undefined : price,
      ccxtParams
    );
  } catch (err) {
    if ((stopLoss || takeProfit) && err instanceof ccxt.NotSupported) {
      order = await ex.createOrder(marketSymbol, type, side, quantity, type === 'market' ? undefined : price);
      order._bracketUnsupported = true;
    } else {
      throw err;
    }
  }

  return {
    exchangeOrderId:    order.id,
    status:             order.status,
    bracketUnsupported: !!order._bracketUnsupported,
    raw:                order,
  };
}

async function cancelLiveOrder(exchange, credentials, orderId, symbol) {
  if (exchange === 'oanda') {
    const base = getOandaBaseUrl(credentials.mode || 'practice');
    await axios.put(
      `${base}/v3/accounts/${credentials.apiKey}/orders/${orderId}/cancel`,
      {},
      { headers: { Authorization: `Bearer ${credentials.apiSecret}` }, timeout: 8000 }
    );
    return;
  }
  const ex = getCcxtInstance(exchange, credentials);
  await ex.cancelOrder(orderId, symbol ? toCcxtSymbol(symbol) : undefined);
}

// ── DB operations ─────────────────────────────────────────
async function getUserConnections(userId) {
  const { rows } = await pool.query(
    `SELECT exchange_id, mode, connected_at, last_sync_at
     FROM user_exchange_connections WHERE user_id = $1`,
    [userId]
  );
  return rows.reduce((acc, row) => {
    acc[row.exchange_id] = {
      mode: row.mode,
      connectedAt: row.connected_at
        ? new Date(row.connected_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
        : null,
      lastSync: row.last_sync_at
        ? new Date(row.last_sync_at).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
        : '—',
    };
    return acc;
  }, {});
}

async function connectExchange(userId, exchange, credentials, mode = 'readonly') {
  if (!VALID_MODES.includes(mode)) {
    const e = new Error(`Invalid mode: ${mode}`); e.status = 400; throw e;
  }
  validateCredentials(exchange, credentials);

  // ✅ Fix : pour les exchanges crypto (ccxt), le mode 'paper' est une
  // simulation 100% locale (aucun appel réseau réel) — sauter la
  // vérification a du sens. Mais OANDA "paper" = compte demo RÉEL sur
  // les serveurs OANDA (api-fxpractice.oanda.com), utilisé ensuite pour
  // de vrais appels prix/portfolio. Avant ce fix, des credentials OANDA
  // invalides en mode paper étaient acceptés silencieusement à la
  // connexion, et échouaient seulement plus tard au premier appel prix —
  // mauvaise UX (connexion "réussie" puis tout casse après coup).
  const skipVerification = mode === 'paper' && exchange !== 'oanda';
  if (!skipVerification) await verifyWithExchange(exchange, credentials, mode);

  const encKey    = encrypt(credentials.apiKey.trim());
  const encSecret = encrypt(credentials.apiSecret.trim());
  const encPass   = credentials.passphrase ? encrypt(credentials.passphrase.trim()) : null;
  await pool.query(
    `INSERT INTO user_exchange_connections
       (user_id, exchange_id, api_key_enc, api_secret_enc, passphrase_enc, mode, connected_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (user_id, exchange_id) DO UPDATE SET
       api_key_enc    = EXCLUDED.api_key_enc,
       api_secret_enc = EXCLUDED.api_secret_enc,
       passphrase_enc = EXCLUDED.passphrase_enc,
       mode           = EXCLUDED.mode,
       connected_at   = NOW()`,
    [userId, exchange, encKey, encSecret, encPass, mode]
  );
}

async function updateMode(userId, exchangeId, mode) {
  if (!VALID_MODES.includes(mode)) {
    const e = new Error(`Invalid mode: ${mode}`); e.status = 400; throw e;
  }
  await pool.query(
    `UPDATE user_exchange_connections SET mode=$3 WHERE user_id=$1 AND exchange_id=$2`,
    [userId, exchangeId, mode]
  );
}

async function disconnectExchange(userId, exchangeId) {
  const { rowCount } = await pool.query(
    `DELETE FROM user_exchange_connections WHERE user_id=$1 AND exchange_id=$2`,
    [userId, exchangeId]
  );
  if (!rowCount) { const e = new Error('Not found'); e.status = 404; throw e; }
}

async function testConnection(userId, exchangeId) {
  const creds = await getDecryptedCredentials(userId, exchangeId);
  if (!creds) { const e = new Error('Exchange not connected'); e.status = 404; throw e; }
  await verifyWithExchange(exchangeId, creds);
  await pool.query(
    `UPDATE user_exchange_connections SET last_sync_at=NOW() WHERE user_id=$1 AND exchange_id=$2`,
    [userId, exchangeId]
  );
  return { ok: true, message: 'Connection verified' };
}

async function getDecryptedCredentials(userId, exchangeId) {
  const { rows } = await pool.query(
    `SELECT api_key_enc, api_secret_enc, passphrase_enc, mode
     FROM user_exchange_connections WHERE user_id=$1 AND exchange_id=$2`,
    [userId, exchangeId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    apiKey:     decrypt(r.api_key_enc),
    apiSecret:  decrypt(r.api_secret_enc),
    passphrase: r.passphrase_enc ? decrypt(r.passphrase_enc) : null,
    mode:       r.mode,
  };
}

// ── Paper trade helpers ───────────────────────────────────
async function openPaperTrade(userId, exchangeId, { symbol, side, orderType, quantity, price, limitPrice, stopLoss, takeProfit }) {
  // ✅ Fix : garde-fou au niveau service (en plus de la validation dans le
  // controller) — un prix à 0/null créerait un trade non liquidable
  // proprement (division par zéro dans closePaperTrade → pnl_pct = NaN/Infinity
  // stocké en DB, cassant tout affichage Portfolio/Trade History en aval).
  const numericPrice = parseFloat(price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    const e = new Error(`Prix invalide pour ouvrir un paper trade sur ${symbol}: ${price}`);
    e.status = 400; throw e;
  }

  const { rows } = await pool.query(
    `INSERT INTO paper_trades
       (user_id, exchange_id, symbol, side, order_type, quantity, price, limit_price, stop_loss, take_profit, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')
     RETURNING *`,
    [userId, exchangeId, symbol, side, orderType, quantity, numericPrice, limitPrice || null, stopLoss || null, takeProfit || null]
  );
  return rows[0];
}

async function closePaperTrade(userId, tradeId, closePrice, reason = 'manual') {
  const { rows } = await pool.query(
    `SELECT * FROM paper_trades WHERE id=$1 AND user_id=$2 AND status='open'`,
    [tradeId, userId]
  );
  if (!rows.length) { const e = new Error('Trade not found'); e.status = 404; throw e; }
  const trade = rows[0];

  const entryPrice = parseFloat(trade.price);
  // Défense en profondeur : si un vieux trade avec price=0 traîne encore en
  // DB (créé avant ce fix), on refuse la clôture plutôt que de produire un
  // pnl_pct=Infinity/NaN silencieux.
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    const e = new Error(`Trade #${tradeId} a un prix d'entrée invalide (${trade.price}) — clôture impossible, correction manuelle requise.`);
    e.status = 422; throw e;
  }

  const pnl    = trade.side === 'buy'
    ? (closePrice - entryPrice) * parseFloat(trade.quantity)
    : (entryPrice - closePrice) * parseFloat(trade.quantity);
  const pnlPct = (pnl / (entryPrice * parseFloat(trade.quantity))) * 100;

  const { rows: updated } = await pool.query(
    `UPDATE paper_trades SET status='closed', pnl=$3, pnl_pct=$4, closed_at=NOW(), close_reason=$5
     WHERE id=$1 AND user_id=$2 RETURNING *`,
    [tradeId, userId, pnl.toFixed(8), pnlPct.toFixed(4), reason]
  );
  return updated[0];
}

async function getPaperTrades(userId, exchangeId, status = 'open') {
  const { rows } = await pool.query(
    `SELECT * FROM paper_trades
     WHERE user_id=$1 AND exchange_id=$2 AND status=$3
     ORDER BY opened_at DESC`,
    [userId, exchangeId, status]
  );
  return rows;
}

async function getOpenBracketTrades() {
  const { rows } = await pool.query(
    `SELECT * FROM paper_trades
     WHERE status='open' AND (stop_loss IS NOT NULL OR take_profit IS NOT NULL)`
  );
  return rows;
}

module.exports = {
  getUserConnections,
  connectExchange,
  updateMode,
  disconnectExchange,
  testConnection,
  getDecryptedCredentials,
  fetchPortfolio,
  placeLiveOrder,
  cancelLiveOrder,
  openPaperTrade,
  closePaperTrade,
  getPaperTrades,
  getOpenBracketTrades,
  getOandaBaseUrl,
  getOandaPrice,
  SUPPORTED,
};