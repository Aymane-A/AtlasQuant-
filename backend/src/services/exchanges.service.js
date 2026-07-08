const crypto  = require('crypto');
const axios   = require('axios');
const pool    = require('../config/db').pool;

// ── Encryption ────────────────────────────────────────────
const ALGO = 'aes-256-gcm';
const KEY  = Buffer.from(process.env.EXCHANGE_ENCRYPTION_KEY || '0'.repeat(64), 'hex');

function encrypt(plaintext) {
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored) {
  const [ivHex, tagHex, dataHex] = stored.split(':');
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

// ── Supported exchanges ───────────────────────────────────
// 'oanda' reuses the generic apiKey/apiSecret credential slots:
//   apiKey    → OANDA Account ID   (e.g. "101-004-12345678-001")
//   apiSecret → OANDA Personal Access Token
// This avoids any schema/encryption changes — OANDA is a forex/CFD
// broker (majors + metals/commodities via CFD), free REST v20 API,
// works with both practice (demo/paper) and live accounts.
const SUPPORTED = {
  binance:  { requiredFields: ['apiKey','apiSecret'] },
  bybit:    { requiredFields: ['apiKey','apiSecret'] },
  kraken:   { requiredFields: ['apiKey','apiSecret'] },
  coinbase: { requiredFields: ['apiKey','apiSecret','passphrase'] },
  okx:      { requiredFields: ['apiKey','apiSecret','passphrase'] },
  kucoin:   { requiredFields: ['apiKey','apiSecret','passphrase'] },
  bitget:   { requiredFields: ['apiKey','apiSecret','passphrase'] },
  mexc:     { requiredFields: ['apiKey','apiSecret'] },
  gate:     { requiredFields: ['apiKey','apiSecret'] },
  htx:      { requiredFields: ['apiKey','apiSecret'] },
  phemex:   { requiredFields: ['apiKey','apiSecret'] },
  bitmex:   { requiredFields: ['apiKey','apiSecret'] },
  oanda:    { requiredFields: ['apiKey','apiSecret'] },
};

const VALID_MODES = ['readonly', 'paper', 'live'];

function validateCredentials(exchange, credentials) {
  const cfg = SUPPORTED[exchange];
  if (!cfg) { const e = new Error(`Unsupported exchange: ${exchange}`); e.status = 400; throw e; }
  for (const f of cfg.requiredFields) {
    if (!credentials[f]?.trim()) { const e = new Error(`Missing field: ${f}`); e.status = 400; throw e; }
  }
}

// ── OANDA helpers ──────────────────────────────────────────
// mode 'paper' → OANDA practice (demo) environment — free, virtual funds.
// mode 'live'  → OANDA live environment — requires a funded account.
// mode 'readonly' also uses the live pricing/account-info endpoints
// (read-only doesn't place orders either way).
function getOandaBaseUrl(mode) {
  return mode === 'live'
    ? 'https://api-fxtrade.oanda.com'
    : 'https://api-fxpractice.oanda.com';
}

// Fetches bid/ask/mid for a single OANDA instrument (e.g. "EUR_USD").
// Exported so trading.controller.js can reuse it for paper-fill pricing.
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

// ── Binance timestamp sync ────────────────────────────────
// Fetches Binance server time and computes offset once, reuses it
let binanceTimeOffset = 0;
let binanceTimeSynced = false;

async function getBinanceTimestamp() {
  if (!binanceTimeSynced) {
    try {
      const res = await axios.get('https://api.binance.com/api/v3/time', { timeout: 5000 });
      binanceTimeOffset = res.data.serverTime - Date.now();
      binanceTimeSynced = true;
      console.log(`[binance] time offset: ${binanceTimeOffset}ms`);
    } catch (e) {
      console.warn('[binance] could not sync time, using local:', e.message);
    }
  }
  return Date.now() + binanceTimeOffset;
}

// ── Live key verification ─────────────────────────────────
// `mode` param: explicit mode passed at connect-time (connectExchange
// doesn't yet have it persisted). When called via testConnection,
// credentials.mode is already populated from the DB and takes priority.
async function verifyWithExchange(exchange, credentials, mode) {
  const effMode = credentials.mode || mode || 'live';
  try {
    switch (exchange) {

      case 'binance': {
        const ts  = await getBinanceTimestamp();
        const rw  = 10000;
        const qs  = `recvWindow=${rw}&timestamp=${ts}`;
        const sig = crypto.createHmac('sha256', credentials.apiSecret).update(qs).digest('hex');
        const res = await axios.get(`https://api.binance.com/api/v3/account?${qs}&signature=${sig}`, {
          headers: { 'X-MBX-APIKEY': credentials.apiKey }, timeout: 8000,
        });
        console.log('[binance] verify ok — canTrade:', res.data.canTrade);
        break;
      }

      case 'bybit': {
        const ts  = Date.now().toString();
        const rw  = '5000';
        const sig = crypto.createHmac('sha256', credentials.apiSecret)
          .update(ts + credentials.apiKey + rw).digest('hex');
        await axios.get('https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED', {
          headers: { 'X-BAPI-API-KEY': credentials.apiKey, 'X-BAPI-SIGN': sig,
                     'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw }, timeout: 8000,
        });
        break;
      }

      case 'okx': {
        const ts  = new Date().toISOString();
        const sig = crypto.createHmac('sha256', credentials.apiSecret)
          .update(`${ts}GET/api/v5/account/balance`).digest('base64');
        await axios.get('https://www.okx.com/api/v5/account/balance', {
          headers: { 'OK-ACCESS-KEY': credentials.apiKey, 'OK-ACCESS-SIGN': sig,
                     'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': credentials.passphrase }, timeout: 8000,
        });
        break;
      }

      case 'kucoin': {
        const ts      = Date.now().toString();
        const sig     = crypto.createHmac('sha256', credentials.apiSecret)
          .update(`${ts}GET/api/v1/accounts`).digest('base64');
        const passSig = crypto.createHmac('sha256', credentials.apiSecret)
          .update(credentials.passphrase).digest('base64');
        await axios.get('https://api.kucoin.com/api/v1/accounts', {
          headers: { 'KC-API-KEY': credentials.apiKey, 'KC-API-SIGN': sig,
                     'KC-API-TIMESTAMP': ts, 'KC-API-PASSPHRASE': passSig,
                     'KC-API-KEY-VERSION': '2' }, timeout: 8000,
        });
        break;
      }

      case 'oanda': {
        const base = getOandaBaseUrl(effMode);
        const res  = await axios.get(`${base}/v3/accounts/${credentials.apiKey}`, {
          headers: { Authorization: `Bearer ${credentials.apiSecret}` }, timeout: 8000,
        });
        console.log('[oanda] verify ok — account:', res.data?.account?.alias || credentials.apiKey);
        break;
      }

      default: break;
    }
  } catch (err) {
    if (err.response) {
      console.error(`[exchanges] verify failed for ${exchange}:`, err.response.status, JSON.stringify(err.response.data));
      const e = new Error('Invalid API credentials — exchange rejected the key');
      e.status = 401; throw e;
    }
    console.warn(`[exchanges] Could not reach ${exchange} for verification:`, err.message);
  }
}

// ── Fetch live portfolio from exchange ────────────────────
async function fetchPortfolio(exchange, credentials) {
  console.log(`[fetchPortfolio] fetching ${exchange}...`);

  switch (exchange) {

    case 'binance': {
      const ts  = await getBinanceTimestamp();
      const rw  = 10000;
      const qs  = `recvWindow=${rw}&timestamp=${ts}`;
      const sig = crypto.createHmac('sha256', credentials.apiSecret).update(qs).digest('hex');

      console.log(`[binance] ts=${ts}, offset=${binanceTimeOffset}ms`);

      try {
        const res = await axios.get(`https://api.binance.com/api/v3/account?${qs}&signature=${sig}`, {
          headers: { 'X-MBX-APIKEY': credentials.apiKey }, timeout: 10000,
        });

        const allBalances = res.data.balances || [];
        const nonZero     = allBalances.filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0);

        console.log(`[binance] total: ${allBalances.length}, non-zero: ${nonZero.length}`);
        console.log(`[binance] assets:`, nonZero.map(b => `${b.asset}=${parseFloat(b.free)+parseFloat(b.locked)}`));

        return nonZero.map(b => ({
          symbol: b.asset,
          free:   parseFloat(b.free),
          locked: parseFloat(b.locked),
          total:  parseFloat(b.free) + parseFloat(b.locked),
        }));

      } catch (err) {
        // Reset time sync on error so next call re-syncs
        binanceTimeSynced = false;
        console.error('[binance] fetchPortfolio error:', err.response?.status, JSON.stringify(err.response?.data));
        throw err;
      }
    }

    case 'bybit': {
      const ts  = Date.now().toString();
      const rw  = '5000';
      const sig = crypto.createHmac('sha256', credentials.apiSecret)
        .update(ts + credentials.apiKey + rw).digest('hex');
      const res = await axios.get('https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED', {
        headers: { 'X-BAPI-API-KEY': credentials.apiKey, 'X-BAPI-SIGN': sig,
                   'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw }, timeout: 10000,
      });
      const coins = res.data?.result?.list?.[0]?.coin || [];
      const nonZero = coins.filter(c => parseFloat(c.walletBalance) > 0);
      console.log(`[bybit] non-zero:`, nonZero.map(c => `${c.coin}=${c.walletBalance}`));
      return nonZero.map(c => ({
        symbol: c.coin,
        free:   parseFloat(c.availableToWithdraw),
        locked: parseFloat(c.walletBalance) - parseFloat(c.availableToWithdraw),
        total:  parseFloat(c.walletBalance),
      }));
    }

    case 'okx': {
      const ts  = new Date().toISOString();
      const sig = crypto.createHmac('sha256', credentials.apiSecret)
        .update(`${ts}GET/api/v5/account/balance`).digest('base64');
      const res = await axios.get('https://www.okx.com/api/v5/account/balance', {
        headers: { 'OK-ACCESS-KEY': credentials.apiKey, 'OK-ACCESS-SIGN': sig,
                   'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': credentials.passphrase },
        timeout: 10000,
      });
      const details = res.data?.data?.[0]?.details || [];
      const nonZero = details.filter(d => parseFloat(d.cashBal) > 0);
      console.log(`[okx] non-zero:`, nonZero.map(d => `${d.ccy}=${d.cashBal}`));
      return nonZero.map(d => ({
        symbol: d.ccy,
        free:   parseFloat(d.availBal),
        locked: parseFloat(d.frozenBal),
        total:  parseFloat(d.cashBal),
      }));
    }

    case 'kucoin': {
      const ts      = Date.now().toString();
      const sig     = crypto.createHmac('sha256', credentials.apiSecret)
        .update(`${ts}GET/api/v1/accounts`).digest('base64');
      const passSig = crypto.createHmac('sha256', credentials.apiSecret)
        .update(credentials.passphrase).digest('base64');
      const res = await axios.get('https://api.kucoin.com/api/v1/accounts', {
        headers: { 'KC-API-KEY': credentials.apiKey, 'KC-API-SIGN': sig,
                   'KC-API-TIMESTAMP': ts, 'KC-API-PASSPHRASE': passSig,
                   'KC-API-KEY-VERSION': '2' }, timeout: 10000,
      });
      const accounts = (res.data?.data || []).filter(a => parseFloat(a.balance) > 0 && a.type === 'trade');
      console.log(`[kucoin] trade accounts:`, accounts.map(a => `${a.currency}=${a.balance}`));
      return accounts.map(a => ({
        symbol: a.currency,
        free:   parseFloat(a.available),
        locked: parseFloat(a.holds),
        total:  parseFloat(a.balance),
      }));
    }

    case 'kraken': {
      const nonce    = Date.now().toString();
      const postData = `nonce=${nonce}`;
      const secret   = Buffer.from(credentials.apiSecret, 'base64');
      const hash     = crypto.createHash('sha256').update(nonce + postData).digest('binary');
      const sig      = crypto.createHmac('sha512', secret)
        .update('/0/private/Balance' + hash, 'binary').digest('base64');
      const res = await axios.post('https://api.kraken.com/0/private/Balance', postData, {
        headers: { 'API-Key': credentials.apiKey, 'API-Sign': sig,
                   'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000,
      });
      const result    = res.data?.result || {};
      const krakenMap = { XXBT:'BTC', XETH:'ETH', ZUSD:'USD', ZEUR:'EUR', XLTC:'LTC', XXRP:'XRP' };
      console.log(`[kraken] balances:`, result);
      return Object.entries(result)
        .filter(([, v]) => parseFloat(v) > 0)
        .map(([asset, balance]) => ({
          symbol: krakenMap[asset] || asset.replace(/^[XZ]/, ''),
          free:   parseFloat(balance),
          locked: 0,
          total:  parseFloat(balance),
        }));
    }

    case 'mexc': {
      const ts  = Date.now();
      const qs  = `timestamp=${ts}`;
      const sig = crypto.createHmac('sha256', credentials.apiSecret).update(qs).digest('hex');
      const res = await axios.get(`https://api.mexc.com/api/v3/account?${qs}&signature=${sig}`, {
        headers: { 'X-MEXC-APIKEY': credentials.apiKey }, timeout: 10000,
      });
      const nonZero = (res.data.balances || []).filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0);
      console.log(`[mexc] non-zero:`, nonZero.map(b => `${b.asset}=${parseFloat(b.free)+parseFloat(b.locked)}`));
      return nonZero.map(b => ({
        symbol: b.asset,
        free:   parseFloat(b.free),
        locked: parseFloat(b.locked),
        total:  parseFloat(b.free) + parseFloat(b.locked),
      }));
    }

    case 'gate': {
      const ts       = Math.floor(Date.now() / 1000).toString();
      const url      = '/api/v4/spot/accounts';
      const bodyHash = crypto.createHash('sha512').update('').digest('hex');
      const signStr  = `GET\n${url}\n\n${bodyHash}\n${ts}`;
      const sig      = crypto.createHmac('sha512', credentials.apiSecret).update(signStr).digest('hex');
      const res = await axios.get(`https://api.gateio.ws${url}`, {
        headers: { 'KEY': credentials.apiKey, 'SIGN': sig, 'Timestamp': ts }, timeout: 10000,
      });
      const nonZero = (res.data || []).filter(a => parseFloat(a.available) + parseFloat(a.locked) > 0);
      console.log(`[gate] non-zero:`, nonZero.map(a => `${a.currency}=${parseFloat(a.available)+parseFloat(a.locked)}`));
      return nonZero.map(a => ({
        symbol: a.currency,
        free:   parseFloat(a.available),
        locked: parseFloat(a.locked),
        total:  parseFloat(a.available) + parseFloat(a.locked),
      }));
    }

    case 'htx': {
      const ts      = new Date().toISOString().replace(/\.\d+Z/, '');
      const host    = 'api.huobi.pro';
      const path    = '/v1/account/accounts';
      const params  = `AccessKeyId=${credentials.apiKey}&SignatureMethod=HmacSHA256&SignatureVersion=2&Timestamp=${encodeURIComponent(ts)}`;
      const toSign  = `GET\n${host}\n${path}\n${params}`;
      const sig     = crypto.createHmac('sha256', credentials.apiSecret).update(toSign).digest('base64');
      const res     = await axios.get(`https://${host}${path}?${params}&Signature=${encodeURIComponent(sig)}`, { timeout: 10000 });
      const spot    = (res.data?.data || []).find(a => a.type === 'spot');
      if (!spot) return [];
      const balRes  = await axios.get(`https://${host}/v1/account/accounts/${spot.id}/balance?${params}&Signature=${encodeURIComponent(sig)}`, { timeout: 10000 });
      const nonZero = (balRes.data?.data?.list || []).filter(b => b.type === 'trade' && parseFloat(b.balance) > 0);
      console.log(`[htx] non-zero:`, nonZero.map(b => `${b.currency}=${b.balance}`));
      return nonZero.map(b => ({
        symbol: b.currency.toUpperCase(),
        free:   parseFloat(b.balance),
        locked: 0,
        total:  parseFloat(b.balance),
      }));
    }

    case 'bitget': {
      const ts      = Date.now().toString();
      const path    = '/api/v2/spot/account/assets';
      const prehash = ts + 'GET' + path;
      const sig     = crypto.createHmac('sha256', credentials.apiSecret).update(prehash).digest('base64');
      const res = await axios.get(`https://api.bitget.com${path}`, {
        headers: { 'ACCESS-KEY': credentials.apiKey, 'ACCESS-SIGN': sig,
                   'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': credentials.passphrase,
                   'locale': 'en-US' }, timeout: 10000,
      });
      const nonZero = (res.data?.data || []).filter(a => parseFloat(a.available) + parseFloat(a.frozen) > 0);
      console.log(`[bitget] non-zero:`, nonZero.map(a => `${a.coin}=${parseFloat(a.available)+parseFloat(a.frozen)}`));
      return nonZero.map(a => ({
        symbol: a.coin,
        free:   parseFloat(a.available),
        locked: parseFloat(a.frozen),
        total:  parseFloat(a.available) + parseFloat(a.frozen),
      }));
    }

    case 'phemex': {
      const expiry = Date.now() + 60000;
      const path   = '/accounts/accountPositions';
      const sig    = crypto.createHmac('sha256', credentials.apiSecret)
        .update(path + `expiry=${expiry}` + expiry).digest('hex');
      const res = await axios.get(`https://api.phemex.com${path}?currency=USD`, {
        headers: { 'x-phemex-access-token': credentials.apiKey,
                   'x-phemex-request-expiry': expiry,
                   'x-phemex-request-signature': sig }, timeout: 10000,
      });
      const spots = res.data?.data?.spotAccount || [];
      console.log(`[phemex] spots:`, spots);
      return spots.filter(a => parseFloat(a.balanceEv || a.balance || 0) > 0)
        .map(a => ({ symbol: a.currency, free: parseFloat(a.balanceEv || a.balance || 0), locked: 0, total: parseFloat(a.balanceEv || a.balance || 0) }));
    }

    case 'bitmex': {
      const expires = Math.floor(Date.now() / 1000) + 60;
      const path    = '/api/v1/user/wallet';
      const sig     = crypto.createHmac('sha256', credentials.apiSecret)
        .update('GET' + path + expires).digest('hex');
      const res = await axios.get(`https://www.bitmex.com${path}`, {
        headers: { 'api-key': credentials.apiKey, 'api-expires': expires, 'api-signature': sig }, timeout: 10000,
      });
      const amount = (res.data?.amount || 0) / 1e8;
      console.log(`[bitmex] BTC wallet:`, amount);
      return amount > 0 ? [{ symbol:'BTC', free:amount, locked:0, total:amount }] : [];
    }

    case 'oanda': {
      // OANDA is margin/CFD-based — there's no per-instrument "spot balance"
      // like crypto exchanges. We surface the account's home currency
      // balance instead, split into free (available) vs locked (margin used).
      const effMode = credentials.mode || 'practice';
      const base    = getOandaBaseUrl(effMode);
      const res     = await axios.get(`${base}/v3/accounts/${credentials.apiKey}/summary`, {
        headers: { Authorization: `Bearer ${credentials.apiSecret}` }, timeout: 10000,
      });
      const acc = res.data?.account;
      if (!acc) return [];
      const currency    = acc.currency || 'USD';
      const balance     = parseFloat(acc.balance);
      const marginUsed  = parseFloat(acc.marginUsed || 0);
      console.log(`[oanda] balance=${balance} ${currency}, marginUsed=${marginUsed}`);
      return [{
        symbol: currency,
        free:   Math.max(balance - marginUsed, 0),
        locked: marginUsed,
        total:  balance,
      }];
    }

    default:
      console.warn(`[fetchPortfolio] ${exchange} not implemented`);
      return [];
  }
}

// ── Place live order ──────────────────────────────────────
async function placeLiveOrder(exchange, credentials, { symbol, side, type, quantity, price }) {
  switch (exchange) {

    case 'binance': {
      const ts     = await getBinanceTimestamp();
      const rw     = 10000;
      const params = `symbol=${symbol}&side=${side.toUpperCase()}&type=${type.toUpperCase()}&quantity=${quantity}&recvWindow=${rw}&timestamp=${ts}`;
      const full   = type === 'limit' ? `${params}&price=${price}&timeInForce=GTC` : params;
      const sig    = crypto.createHmac('sha256', credentials.apiSecret).update(full).digest('hex');
      const res    = await axios.post(
        `https://api.binance.com/api/v3/order?${full}&signature=${sig}`,
        null,
        { headers: { 'X-MBX-APIKEY': credentials.apiKey }, timeout: 10000 }
      );
      return { exchangeOrderId: res.data.orderId, status: res.data.status, raw: res.data };
    }

    case 'bybit': {
      const ts      = Date.now().toString();
      const body    = { category:'spot', symbol, side:side==='buy'?'Buy':'Sell',
                        orderType:type==='market'?'Market':'Limit', qty:String(quantity),
                        ...(type==='limit' && { price:String(price) }) };
      const bodyStr = JSON.stringify(body);
      const rw      = '5000';
      const sig     = crypto.createHmac('sha256', credentials.apiSecret)
        .update(ts + credentials.apiKey + rw + bodyStr).digest('hex');
      const res = await axios.post('https://api.bybit.com/v5/order/create', body, {
        headers: { 'X-BAPI-API-KEY':credentials.apiKey, 'X-BAPI-SIGN':sig,
                   'X-BAPI-TIMESTAMP':ts, 'X-BAPI-RECV-WINDOW':rw,
                   'Content-Type':'application/json' }, timeout: 10000,
      });
      return { exchangeOrderId: res.data?.result?.orderId, status: res.data?.result?.orderStatus, raw: res.data };
    }

    case 'okx': {
      const ts      = new Date().toISOString();
      const body    = { instId:symbol, tdMode:'cash', side, ordType:type==='market'?'market':'limit',
                        sz:String(quantity), ...(type==='limit' && { px:String(price) }) };
      const bodyStr = JSON.stringify(body);
      const sig     = crypto.createHmac('sha256', credentials.apiSecret)
        .update(`${ts}POST/api/v5/trade/order${bodyStr}`).digest('base64');
      const res = await axios.post('https://www.okx.com/api/v5/trade/order', body, {
        headers: { 'OK-ACCESS-KEY':credentials.apiKey, 'OK-ACCESS-SIGN':sig,
                   'OK-ACCESS-TIMESTAMP':ts, 'OK-ACCESS-PASSPHRASE':credentials.passphrase,
                   'Content-Type':'application/json' }, timeout: 10000,
      });
      return { exchangeOrderId: res.data?.data?.[0]?.ordId, status: res.data?.data?.[0]?.sCode, raw: res.data };
    }

    case 'oanda': {
      // `symbol` here is the OANDA instrument, e.g. "EUR_USD" or "XAU_USD".
      // `quantity` is treated as whole units (OANDA doesn't fraction units);
      // negative units = sell, positive = buy.
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

    default: {
      const e = new Error(`Live orders not yet implemented for ${exchange}`);
      e.status = 501; throw e;
    }
  }
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
  if (mode !== 'paper') await verifyWithExchange(exchange, credentials, mode);
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
async function openPaperTrade(userId, exchangeId, { symbol, side, orderType, quantity, price, limitPrice }) {
  const { rows } = await pool.query(
    `INSERT INTO paper_trades
       (user_id, exchange_id, symbol, side, order_type, quantity, price, limit_price, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')
     RETURNING *`,
    [userId, exchangeId, symbol, side, orderType, quantity, price, limitPrice || null]
  );
  return rows[0];
}

async function closePaperTrade(userId, tradeId, closePrice) {
  const { rows } = await pool.query(
    `SELECT * FROM paper_trades WHERE id=$1 AND user_id=$2 AND status='open'`,
    [tradeId, userId]
  );
  if (!rows.length) { const e = new Error('Trade not found'); e.status = 404; throw e; }
  const trade  = rows[0];
  const pnl    = trade.side === 'buy'
    ? (closePrice - parseFloat(trade.price)) * parseFloat(trade.quantity)
    : (parseFloat(trade.price) - closePrice) * parseFloat(trade.quantity);
  const pnlPct = (pnl / (parseFloat(trade.price) * parseFloat(trade.quantity))) * 100;
  const { rows: updated } = await pool.query(
    `UPDATE paper_trades SET status='closed', pnl=$3, pnl_pct=$4, closed_at=NOW()
     WHERE id=$1 AND user_id=$2 RETURNING *`,
    [tradeId, userId, pnl.toFixed(8), pnlPct.toFixed(4)]
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

module.exports = {
  getUserConnections,
  connectExchange,
  updateMode,
  disconnectExchange,
  testConnection,
  getDecryptedCredentials,
  fetchPortfolio,
  placeLiveOrder,
  openPaperTrade,
  closePaperTrade,
  getPaperTrades,
  getOandaBaseUrl,
  getOandaPrice,
};