/**
 * trading.controller.js — AtlasQuant AI
 * Handles live + paper order execution, order history, balance, ticker
 */
const crypto       = require('crypto');
const axios        = require('axios');
const db           = require('../config/db');
const logger       = require('../utils/logger');
const exchangesSvc = require('../services/exchanges.service');

// ── POST /api/trading/order ───────────────────────────────────────────────────
// body: { exchangeId, symbol, side, orderType, quantity, price?, stopPrice? }
async function placeOrder(req, res) {
  const userId = req.user.id;
  const { exchangeId, symbol, side, orderType = 'market', quantity, price, stopPrice } = req.body;

  if (!exchangeId || !symbol || !side || !quantity)
    return res.status(400).json({ success:false, error:'exchangeId, symbol, side, quantity required' });

  try {
    const creds = await exchangesSvc.getDecryptedCredentials(userId, exchangeId);
    if (!creds) return res.status(404).json({ success:false, error:'Exchange not connected' });

    // ── Paper mode ──
    if (creds.mode === 'paper') {
      // Fetch current price for paper fill
      let fillPrice = price;
      if (!fillPrice || orderType === 'market') {
        try {
          const r = await axios.get(
            `https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}USDT`,
            { timeout: 5000 }
          );
          fillPrice = parseFloat(r.data.price);
        } catch { fillPrice = price || 0; }
      }

      const trade = await exchangesSvc.openPaperTrade(userId, exchangeId, {
        symbol:    symbol.toUpperCase(),
        side,
        orderType,
        quantity:  parseFloat(quantity),
        price:     fillPrice,
        limitPrice: orderType === 'limit' ? parseFloat(price) : null,
      });

      return res.json({ success:true, mode:'paper', order: trade });
    }

    // ── Readonly mode ──
    if (creds.mode === 'readonly')
      return res.status(403).json({ success:false, error:'Exchange is in read-only mode. Switch to Paper or Live to trade.' });

    // ── Live mode ──
    const result = await exchangesSvc.placeLiveOrder(exchangeId, creds, {
      symbol: symbol.toUpperCase(),
      side, type: orderType, quantity: parseFloat(quantity), price,
    });

    // Audit log
    await db.query(
      `INSERT INTO live_orders
         (user_id, exchange_id, exchange_order_id, symbol, side, order_type, quantity, price, status, raw_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [userId, exchangeId, result.exchangeOrderId, symbol.toUpperCase(),
       side, orderType, quantity, price || null, result.status || 'submitted',
       JSON.stringify(result.raw)]
    );

    res.json({ success:true, mode:'live', order: result });

  } catch (err) {
    logger.error(`[trading.placeOrder] ${err.message}`);
    res.status(err.status || 500).json({ success:false, error: err.message });
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
    res.status(500).json({ success:false, error: err.message });
  }
}

// ── DELETE /api/trading/orders/:orderId ──────────────────────────────────────
async function cancelOrder(req, res) {
  const userId  = req.user.id;
  const { orderId } = req.params;
  const { exchangeId, mode = 'paper' } = req.query;

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

    // Live cancel — call exchange
    const creds = await exchangesSvc.getDecryptedCredentials(userId, exchangeId);
    if (!creds) return res.status(404).json({ success:false, error:'Exchange not connected' });

    await cancelLiveOrder(exchangeId, creds, orderId);

    await db.query(
      `UPDATE live_orders SET status='cancelled', updated_at=NOW() WHERE exchange_order_id=$1 AND user_id=$2`,
      [orderId, userId]
    );

    res.json({ success:true, message:'Order cancelled' });
  } catch (err) {
    logger.error(`[trading.cancelOrder] ${err.message}`);
    res.status(500).json({ success:false, error: err.message });
  }
}

// ── GET /api/trading/ticker/:symbol ──────────────────────────────────────────
async function getTicker(req, res) {
  const { symbol } = req.params;
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');

  try {
    // Try Binance first (fastest, no auth needed)
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
    res.status(500).json({ success:false, error: err.message });
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
      // Return simulated $10,000 paper balance
      return res.json({
        success: true, mode:'paper',
        balances: [
          { symbol:'USDT', free:10000, locked:0, total:10000 },
          { symbol:'BTC',  free:0.1,   locked:0, total:0.1   },
          { symbol:'ETH',  free:1.0,   locked:0, total:1.0   },
        ]
      });
    }

    const balances = await exchangesSvc.fetchPortfolio(exchangeId, creds);
    res.json({ success:true, mode: creds.mode, balances });

  } catch (err) {
    logger.error(`[trading.getBalance] ${err.message}`);
    res.status(500).json({ success:false, error: err.message });
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

async function cancelLiveOrder(exchange, credentials, orderId) {
  switch (exchange) {
    case 'binance': {
      // Need symbol — get from audit log or pass as param
      // Simplified: just attempt cancel
      const ts  = Date.now();
      const qs  = `orderId=${orderId}&timestamp=${ts}`;
      const sig = crypto.createHmac('sha256', credentials.apiSecret).update(qs).digest('hex');
      await axios.delete(
        `https://api.binance.com/api/v3/order?${qs}&signature=${sig}`,
        { headers:{ 'X-MBX-APIKEY': credentials.apiKey }, timeout:8000 }
      );
      break;
    }
    case 'bybit': {
      const ts  = Date.now().toString();
      const rw  = '5000';
      const body = { category:'spot', orderId };
      const sig  = crypto.createHmac('sha256', credentials.apiSecret)
        .update(ts + credentials.apiKey + rw + JSON.stringify(body)).digest('hex');
      await axios.post('https://api.bybit.com/v5/order/cancel', body, {
        headers:{ 'X-BAPI-API-KEY':credentials.apiKey, 'X-BAPI-SIGN':sig,
                  'X-BAPI-TIMESTAMP':ts, 'X-BAPI-RECV-WINDOW':rw }, timeout:8000
      });
      break;
    }
    default: throw new Error(`Cancel not implemented for ${exchange}`);
  }
}

module.exports = { placeOrder, getOrders, cancelOrder, getTicker, getBalance };