/**
 * trading.controller.js — AtlasQuant AI
 * Handles live + paper order execution, order history, balance, ticker
 */
const axios         = require('axios');
const db            = require('../config/db');
const logger        = require('../utils/logger');
const exchangesSvc  = require('../services/exchanges.service');
const riskGuard     = require('../services/riskGuard.service');
const { requireVerifiedEmailForLive } = require('../utils/emailVerified');
const { sendServerError } = require('../utils/httpError');
const killSwitch    = require('../utils/killSwitch');
const { withUserOrderLock } = require('../utils/orderLock');

// Reference price used for risk checks and paper fills: the limit price for limit
// orders, otherwise the current market price. Returns null if it can't be fetched.
async function getReferencePrice(exchangeId, creds, symbol, orderType, price) {
  if (orderType === 'limit') return Number(price);
  try {
    const sym = symbol.toUpperCase();
    if (exchangeId === 'oanda')  return (await exchangesSvc.getOandaPrice(creds.apiKey, creds.apiSecret, creds.mode, sym)).mid;
    if (exchangeId === 'alpaca') return (await exchangesSvc.getAlpacaQuote(creds, sym)).mid;
    const r = await axios.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}USDT`,
      { timeout: 5000 }
    );
    return parseFloat(r.data.price);
  } catch {
    return null;
  }
}

// ── POST /api/trading/order ───────────────────────────────────────────────────
// body: { exchangeId, symbol, side, orderType, quantity, price?, stopPrice?,
//         stopLoss?, takeProfit? }
// stopLoss / takeProfit are optional trigger prices for a bracket order.
// For crypto exchanges, `symbol` is the base asset (e.g. "BTC") and gets
// "USDT" appended. For OANDA, `symbol` is already the full instrument
// (e.g. "EUR_USD") and is used as-is. For Alpaca, `symbol` is the stock
// ticker (e.g. "AAPL") and is used as-is.
async function placeOrder(req, res) {
  if (killSwitch.isEngaged()) {
    const b = killSwitch.blockedResponse();
    return res.status(b.status).json(b.body);
  }
  const userId = req.user.id;
  const {
    exchangeId, symbol, side, orderType = 'market', quantity, price, stopPrice, noStopLoss,
    stopLoss, takeProfit, signalId, 
  } = req.body;

  if (!exchangeId || !symbol || !side || !quantity)
    return res.status(400).json({ success:false, error:'exchangeId, symbol, side, quantity required' });

  // ── Input validation (this endpoint can send REAL orders in live mode) ──
  const sideNorm = String(side).toLowerCase();
  if (!['buy', 'sell'].includes(sideNorm))
    return res.status(400).json({ success:false, error:"side must be 'buy' or 'sell'" });
  if (!['market', 'limit'].includes(orderType))
    return res.status(400).json({ success:false, error:"orderType must be 'market' or 'limit'" });

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0)
    return res.status(400).json({ success:false, error:'quantity must be a positive number' });

  if (typeof symbol !== 'string' || !/^[A-Za-z0-9._\-\/]{1,30}$/.test(symbol))
    return res.status(400).json({ success:false, error:'invalid symbol' });

  if (orderType === 'limit') {
    const lp = Number(price);
    if (!Number.isFinite(lp) || lp <= 0)
      return res.status(400).json({ success:false, error:'limit orders require a positive price' });
  }
  for (const [name, v] of [['stopLoss', stopLoss], ['takeProfit', takeProfit]]) {
    if (v !== undefined && v !== null && v !== '' && (!Number.isFinite(Number(v)) || Number(v) <= 0))
      return res.status(400).json({ success:false, error:`${name} must be a positive number` });
  }

  // Sanity-check the bracket against the intended direction so a bad UI
  // value can't accidentally submit a nonsensical SL/TP to the exchange.
  if (stopLoss || takeProfit) {
    const refPrice = orderType === 'market' ? null : parseFloat(price);
    if (refPrice) {
      if (sideNorm === 'buy'  && stopLoss   && parseFloat(stopLoss)   >= refPrice)
        return res.status(400).json({ success:false, error:'Stop-loss must be below entry price for a buy order' });
      if (sideNorm === 'buy'  && takeProfit && parseFloat(takeProfit) <= refPrice)
        return res.status(400).json({ success:false, error:'Take-profit must be above entry price for a buy order' });
      if (sideNorm === 'sell' && stopLoss   && parseFloat(stopLoss)   <= refPrice)
        return res.status(400).json({ success:false, error:'Stop-loss must be above entry price for a sell order' });
      if (sideNorm === 'sell' && takeProfit && parseFloat(takeProfit) >= refPrice)
        return res.status(400).json({ success:false, error:'Take-profit must be below entry price for a sell order' });
    }
  }

  const isOanda  = exchangeId === 'oanda';
  const isAlpaca = exchangeId === 'alpaca';

  try {
    const creds = await exchangesSvc.getDecryptedCredentials(userId, exchangeId);
    if (!creds) return res.status(404).json({ success:false, error:'Exchange not connected' });

    if (creds.mode === 'readonly')
      return res.status(403).json({ success:false, error:'Exchange is in read-only mode. Switch to Paper or Live to trade.' });

    const isLive = creds.mode === 'live';

    if (isLive) {
      const v = await requireVerifiedEmailForLive(userId);
      if (!v.ok) return res.status(v.status).json({ success:false, code:v.code, error:v.error });
    }

    // ✅ Audit 4: un ordre LIVE exige une Idempotency-Key (un retry réseau ne doit jamais créer un 2e ordre réel).
    if (isLive && !req.idempotency) {
      return res.status(400).json({ success:false, code:'IDEMPOTENCY_KEY_REQUIRED',
        error:'Live orders require an Idempotency-Key header (unique per order intent, 8-128 chars).' });
    }

    // Price used for risk checks (and as the paper fill). Without it we can't
    // enforce the user's limits, and we never guess a price.
    const refPrice = await getReferencePrice(exchangeId, creds, symbol, orderType, price);
    if (!Number.isFinite(refPrice) || refPrice <= 0) {
      return res.status(502).json({ success:false, error:'Could not fetch a market price for this symbol. Try again shortly.' });
    }

    // ── Paper mode : limites de risque + écriture de la position sous un lock par utilisateur ──
    // Sans lock, N ordres simultanés lisent tous la même exposition ouverte et passent tous le plafond.
    if (!isLive) {
      const out = await withUserOrderLock(userId, async (q) => {
        const risk = await riskGuard.checkOrder({
          userId, exchangeId, mode: 'paper', creds,
          side: sideNorm, quantity: qty, refPrice,
          stopLoss: stopLoss ? Number(stopLoss) : null,
          noStopLoss: noStopLoss === true,
          q,
        });
        if (!risk.ok) return { risk };
        const trade = await exchangesSvc.openPaperTrade(userId, exchangeId, {
          symbol:      symbol.toUpperCase(),
          side:        sideNorm,
          orderType,
          quantity:    qty,
          price:       refPrice,
          limitPrice:  orderType === 'limit' ? parseFloat(price) : null,
          stopLoss:    risk.stopLoss,
          takeProfit:  takeProfit ? parseFloat(takeProfit) : null,
          signalId:    signalId ? parseInt(signalId, 10) : null,
        }, q);
        return { risk, trade };
      });

      if (!out.risk.ok) {
        return res.status(out.risk.status).json({ success:false, code:out.risk.code, error:out.risk.error, details:out.risk.details });
      }
      const paperRiskInfo = { appliedStopLoss: stopLoss ? null : out.risk.stopLoss, warnings: out.risk.warnings };
      return res.json({ success:true, mode:'paper', order: out.trade, risk: paperRiskInfo });
    }

    // ── Live : limites par ordre (l'exposition live n'est pas suivie, donc pas de réservation atomique) ──
    const risk = await riskGuard.checkOrder({
      userId, exchangeId, mode: 'live', creds,
      side: sideNorm, quantity: qty, refPrice,
      stopLoss: stopLoss ? Number(stopLoss) : null,
      noStopLoss: noStopLoss === true,
    });
    if (!risk.ok) {
      return res.status(risk.status).json({ success:false, code:risk.code, error:risk.error, details:risk.details });
    }
    const effStopLoss = risk.stopLoss;
    const riskInfo = { appliedStopLoss: stopLoss ? null : risk.stopLoss, warnings: risk.warnings };

    // ── Live mode ──
    const result = await exchangesSvc.placeLiveOrder(exchangeId, creds, {
      symbol: symbol.toUpperCase(),
      side: sideNorm, type: orderType, quantity: qty, price,
      stopLoss:   effStopLoss ?? undefined,
      takeProfit: takeProfit ? parseFloat(takeProfit) : undefined,
    });

    // Audit log
    await db.query(
      `INSERT INTO live_orders
         (user_id, exchange_id, exchange_order_id, symbol, side, order_type, quantity, price, stop_loss, take_profit, status, raw_response, signal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [userId, exchangeId, result.exchangeOrderId, symbol.toUpperCase(),
       sideNorm, orderType, qty, price || null,
       effStopLoss || null, takeProfit || null,
       result.status || 'submitted', JSON.stringify(result.raw),
       signalId ? parseInt(signalId, 10) : null]
    );

    res.json({
      success: true, mode:'live', order: result, risk: riskInfo,
      warning: result.bracketUnsupported
        ? 'Order placed, but this exchange does not support attached stop-loss/take-profit — set them manually.'
        : undefined,
    });

  } catch (err) {
    logger.error(`[trading.placeOrder] ${err.message}`);
    sendServerError(res, err, '[trading.placeOrder]');
  }
}

// ── GET /api/trading/orders ───────────────────────────────────────────────────
// ?exchangeId=binance&status=open&mode=paper|live
async function getOrders(req, res) {
  const userId = req.user.id;
  const { exchangeId, status = 'open', mode } = req.query;

  try {
    const results = [];

    // Paper trades
    if (!mode || mode === 'paper') {
      const exchanges = exchangeId ? [exchangeId] : await getUserExchangeIds(userId);
      for (const exId of exchanges) {
        const creds = await exchangesSvc.getDecryptedCredentials(userId, exId);
        if (!creds || creds.mode !== 'paper') continue;
        const trades = await exchangesSvc.getPaperTrades(userId, exId, status);
        trades.forEach(t => results.push({ ...t, mode:'paper', exchangeId:exId }));
      }
    }

    // Live orders from audit log
    if (!mode || mode === 'live') {
      const statusFilter = status === 'open' ? ['submitted','pending','partially_filled'] : ['filled','cancelled','rejected'];
      const whereEx = exchangeId ? 'AND exchange_id=$3' : '';
      const params  = exchangeId ? [userId, statusFilter, exchangeId] : [userId, statusFilter];
      const { rows } = await db.query(
        `SELECT * FROM live_orders
         WHERE user_id=$1 AND status = ANY($2) ${whereEx}
         ORDER BY created_at DESC LIMIT 50`,
        params
      );
      rows.forEach(r => results.push({ ...r, mode:'live' }));
    }

    // Sort by date desc
    results.sort((a, b) => new Date(b.created_at || b.opened_at) - new Date(a.created_at || a.opened_at));

    res.json({ success:true, orders: results });
  } catch (err) {
    logger.error(`[trading.getOrders] ${err.message}`);
    sendServerError(res, err);
  }
}

// ── DELETE /api/trading/orders/:orderId ──────────────────────────────────────
async function cancelOrder(req, res) {
  const userId  = req.user.id;
  const { orderId } = req.params;
  const { exchangeId, mode = 'paper', symbol } = req.query;

  try {
    if (mode === 'paper') {
      // Cancel paper trade = close at current price
      await db.query(
        `UPDATE paper_trades SET status='cancelled', closed_at=NOW()
         WHERE id=$1 AND user_id=$2`,
        [orderId, userId]
      );
      return res.json({ success:true, message:'Paper order cancelled' });
    }

    // Live cancel — call exchange (generic ccxt path + OANDA/Alpaca custom,
    // all live in exchangesSvc.cancelLiveOrder now)
    const creds = await exchangesSvc.getDecryptedCredentials(userId, exchangeId);
    if (!creds) return res.status(404).json({ success:false, error:'Exchange not connected' });

    await exchangesSvc.cancelLiveOrder(exchangeId, creds, orderId, symbol);

    await db.query(
      `UPDATE live_orders SET status='cancelled', updated_at=NOW() WHERE exchange_order_id=$1 AND user_id=$2`,
      [orderId, userId]
    );

    res.json({ success:true, message:'Order cancelled' });
  } catch (err) {
    logger.error(`[trading.cancelOrder] ${err.message}`);
    sendServerError(res, err);
  }
}

// ── GET /api/trading/ticker/:symbol ──────────────────────────────────────────
// ?exchangeId=oanda|alpaca — routes forex/commodity instruments to OANDA's
// pricing + candles endpoints, and stock/ETF instruments to Alpaca's
// market-data endpoints, instead of Binance. Both require authenticated
// credentials (unlike Binance's public ticker), so these paths need the
// connected credentials.
async function getTicker(req, res) {
  const { symbol }     = req.params;
  const { exchangeId } = req.query;
  const userId          = req.user.id;

  if (exchangeId === 'oanda') {
    try {
      const creds = await exchangesSvc.getDecryptedCredentials(userId, 'oanda');
      if (!creds) return res.status(404).json({ success:false, error:'OANDA not connected' });

      const instrument = symbol.toUpperCase();
      const base        = exchangesSvc.getOandaBaseUrl(creds.mode);
      const authHeaders = { Authorization: `Bearer ${creds.apiSecret}` };

      const [priceRes, candlesRes] = await Promise.allSettled([
        axios.get(`${base}/v3/accounts/${creds.apiKey}/pricing`, {
          headers: authHeaders, params: { instruments: instrument }, timeout: 8000,
        }),
        axios.get(`${base}/v3/instruments/${instrument}/candles`, {
          headers: authHeaders, params: { granularity: 'H1', count: 24 }, timeout: 8000,
        }),
      ]);

      let ticker = null;
      if (priceRes.status === 'fulfilled') {
        const p = priceRes.value.data?.prices?.[0];
        if (p) {
          const bid = parseFloat(p.bids?.[0]?.price);
          const ask = parseFloat(p.asks?.[0]?.price);
          ticker = {
            symbol: instrument, price: (bid + ask) / 2, change24h: 0,
            high24h: null, low24h: null, volume24h: null, quoteVol: null, bid, ask,
          };
        }
      }

      let candles = [];
      if (candlesRes.status === 'fulfilled') {
        const raw = candlesRes.value.data?.candles || [];
        candles = raw.filter(c => c.complete).map(c => ({
          t:     new Date(c.time).getTime(),
          open:  parseFloat(c.mid.o), high: parseFloat(c.mid.h),
          low:   parseFloat(c.mid.l), close: parseFloat(c.mid.c),
          vol:   c.volume,
        }));
        if (ticker && candles.length >= 2) {
          const first = candles[0].close, last = candles[candles.length - 1].close;
          ticker.change24h = ((last - first) / first) * 100;
          ticker.high24h   = Math.max(...candles.map(c => c.high));
          ticker.low24h    = Math.min(...candles.map(c => c.low));
        }
      }

      if (!ticker) return res.status(404).json({ success:false, error:'Instrument not found on OANDA' });
      return res.json({ success:true, ticker, candles });

    } catch (err) {
      logger.error(`[trading.getTicker] oanda(${symbol}): ${err.message}`);
      return sendServerError(res, err);
    }
  }

  if (exchangeId === 'alpaca') {
    try {
      const creds = await exchangesSvc.getDecryptedCredentials(userId, 'alpaca');
      if (!creds) return res.status(404).json({ success:false, error:'Alpaca not connected' });

      const sym     = symbol.toUpperCase();
      const headers = exchangesSvc.alpacaHeaders(creds);

      const [quoteRes, barsRes] = await Promise.allSettled([
        axios.get(`https://data.alpaca.markets/v2/stocks/${sym}/quotes/latest`, {
          headers, timeout: 8000,
        }),
        axios.get(`https://data.alpaca.markets/v2/stocks/${sym}/bars`, {
          headers, timeout: 8000, params: { timeframe: '1Hour', limit: 24 },
        }),
      ]);

      let ticker = null;
      if (quoteRes.status === 'fulfilled') {
        const q = quoteRes.value.data?.quote;
        if (q && q.bp && q.ap) {
          ticker = {
            symbol: sym, price: (q.bp + q.ap) / 2, change24h: 0,
            high24h: null, low24h: null, volume24h: null, quoteVol: null,
            bid: q.bp, ask: q.ap,
          };
        }
      }

      let candles = [];
      if (barsRes.status === 'fulfilled') {
        const raw = barsRes.value.data?.bars || [];
        candles = raw.map(b => ({
          t:    new Date(b.t).getTime(),
          open: b.o, high: b.h, low: b.l, close: b.c, vol: b.v,
        }));
        if (ticker && candles.length >= 2) {
          const first = candles[0].close, last = candles[candles.length - 1].close;
          ticker.change24h = ((last - first) / first) * 100;
          ticker.high24h   = Math.max(...candles.map(c => c.high));
          ticker.low24h    = Math.min(...candles.map(c => c.low));
        } else if (!ticker && candles.length) {
          // Market-closed fallback — quotes/latest can be empty outside
          // trading hours while bars still return the last session's data.
          const last = candles[candles.length - 1];
          ticker = {
            symbol: sym, price: last.close, change24h: 0,
            high24h: Math.max(...candles.map(c => c.high)),
            low24h:  Math.min(...candles.map(c => c.low)),
            volume24h: null, quoteVol: null, bid: null, ask: null,
          };
        }
      }

      if (!ticker) return res.status(404).json({ success:false, error:'Symbol not found on Alpaca' });
      return res.json({ success:true, ticker, candles });

    } catch (err) {
      logger.error(`[trading.getTicker] alpaca(${symbol}): ${err.message}`);
      return sendServerError(res, err);
    }
  }

  // ── Crypto (Binance) — default path ──
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');

  try {
    const [tickerRes, klinesRes] = await Promise.allSettled([
      axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}USDT`, { timeout: 5000 }),
      axios.get(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1h&limit=24`, { timeout: 5000 }),
    ]);

    let ticker = null;
    if (tickerRes.status === 'fulfilled') {
      const d = tickerRes.value.data;
      ticker = {
        symbol:    sym,
        price:     parseFloat(d.lastPrice),
        change24h: parseFloat(d.priceChangePercent),
        high24h:   parseFloat(d.highPrice),
        low24h:    parseFloat(d.lowPrice),
        volume24h: parseFloat(d.volume),
        quoteVol:  parseFloat(d.quoteVolume),
        bid:       parseFloat(d.bidPrice),
        ask:       parseFloat(d.askPrice),
      };
    }

    let candles = [];
    if (klinesRes.status === 'fulfilled') {
      candles = klinesRes.value.data.map(k => ({
        t:    k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low:  parseFloat(k[3]),
        close:parseFloat(k[4]),
        vol:  parseFloat(k[5]),
      }));
    }

    if (!ticker) return res.status(404).json({ success:false, error:'Symbol not found on Binance' });

    res.json({ success:true, ticker, candles });
  } catch (err) {
    logger.error(`[trading.getTicker] ${err.message}`);
    sendServerError(res, err);
  }
}

// ── GET /api/trading/balance ──────────────────────────────────────────────────
// ?exchangeId=binance
async function getBalance(req, res) {
  const userId = req.user.id;
  const { exchangeId } = req.query;

  if (!exchangeId) return res.status(400).json({ success:false, error:'exchangeId required' });

  try {
    const creds = await exchangesSvc.getDecryptedCredentials(userId, exchangeId);
    if (!creds) return res.status(404).json({ success:false, error:'Exchange not connected' });

    if (creds.mode === 'paper') {
      // OANDA/Alpaca paper: balance comes from the broker's free practice API ("source: 'exchange'").
      // If that sync fails we say so explicitly (balanceUnavailable) — we NEVER invent a balance
      // and present it as the connected account's.
      if (exchangeId === 'oanda' || exchangeId === 'alpaca') {
        try {
          const balances = await exchangesSvc.fetchPortfolio(exchangeId, creds);
          return res.json({ success:true, mode:'paper', source:'exchange', simulated:false, balances });
        } catch (err) {
          logger.error(`[trading.getBalance] ${exchangeId} paper: ${err.message}`);
          return res.status(502).json({
            success: false, mode: 'paper', source: 'unavailable', balanceUnavailable: true, balances: [],
            error: 'Could not sync the practice-account balance from the broker. Try again shortly.',
          });
        }
      }
      // Other exchanges in paper mode have no remote account: this is a SIMULATED wallet, flagged as such.
      const start = exchangesSvc.PAPER_START_CAPITAL;
      return res.json({
        success: true, mode:'paper', source:'simulated', simulated:true,
        balances: [
          { symbol:'USDT', free:start, locked:0, total:start },
          { symbol:'BTC',  free:0.1,   locked:0, total:0.1   },
          { symbol:'ETH',  free:1.0,   locked:0, total:1.0   },
        ]
      });
    }

    const balances = await exchangesSvc.fetchPortfolio(exchangeId, creds);
    res.json({ success:true, mode: creds.mode, source:'exchange', simulated:false, balances });

  } catch (err) {
    logger.error(`[trading.getBalance] ${err.message}`);
    sendServerError(res, err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getUserExchangeIds(userId) {
  const { rows } = await db.query(
    `SELECT exchange_id FROM user_exchange_connections WHERE user_id=$1`,
    [userId]
  );
  return rows.map(r => r.exchange_id);
}

module.exports = { placeOrder, getOrders, cancelOrder, getTicker, getBalance };