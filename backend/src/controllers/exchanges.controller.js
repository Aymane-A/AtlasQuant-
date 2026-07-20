const svc = require('../services/exchanges.service');

// GET /api/exchanges/connections
async function getConnections(req, res) {
  try {
    res.json(await svc.getUserConnections(req.user.id));
  } catch (err) {
    console.error('[exchanges.controller] getConnections error:', err);
    res.status(500).json({ message: 'Failed to fetch connections' });
  }
}

// POST /api/exchanges/connect
async function connect(req, res) {
  const { exchange, credentials, mode = 'readonly' } = req.body;
  if (!exchange || !credentials)
    return res.status(400).json({ message: 'exchange and credentials required' });
  try {
    await svc.connectExchange(req.user.id, exchange, credentials, mode);
    res.json({ message: `${exchange} connected in ${mode} mode` });
  } catch (err) {
    console.error(`[exchanges.controller] connect(${exchange}) error:`, err);
    res.status(err.status || 500).json({ message: err.message });
  }
}

// PATCH /api/exchanges/:exchangeId/mode
async function changeMode(req, res) {
  const { mode } = req.body;
  if (!mode) return res.status(400).json({ message: 'mode required' });
  try {
    await svc.updateMode(req.user.id, req.params.exchangeId, mode);
    res.json({ message: `Mode updated to ${mode}` });
  } catch (err) {
    console.error(`[exchanges.controller] changeMode(${req.params.exchangeId}) error:`, err);
    res.status(err.status || 500).json({ message: err.message });
  }
}

// DELETE /api/exchanges/:exchangeId
async function disconnect(req, res) {
  try {
    await svc.disconnectExchange(req.user.id, req.params.exchangeId);
    res.json({ message: 'Disconnected' });
  } catch (err) {
    console.error(`[exchanges.controller] disconnect(${req.params.exchangeId}) error:`, err);
    res.status(err.status || 500).json({ message: err.message });
  }
}

// POST /api/exchanges/:exchangeId/test
async function testConnection(req, res) {
  try {
    res.json(await svc.testConnection(req.user.id, req.params.exchangeId));
  } catch (err) {
    console.error(`[exchanges.controller] testConnection(${req.params.exchangeId}) error:`, err);
    res.status(err.status || 500).json({ message: err.message });
  }
}

// POST /api/exchanges/:exchangeId/health-check
// Vérification manuelle à la demande (met à jour health_status/consecutive_failures
// exactement comme le ferait le cron, mais déclenchée immédiatement par l'utilisateur).
async function healthCheckOne(req, res) {
  try {
    const result = await svc.healthCheckConnection(req.user.id, req.params.exchangeId);
    if (!result) return res.status(404).json({ message: 'Exchange not connected' });
    res.json(result);
  } catch (err) {
    console.error(`[exchanges.controller] healthCheckOne(${req.params.exchangeId}) error:`, err);
    res.status(err.status || 500).json({ message: err.message });
  }
}

// GET /api/exchanges/portfolio/all
// Portfolio agrégé de toutes les exchanges connectées de l'utilisateur.
async function getAggregatedPortfolio(req, res) {
  try {
    const result = await svc.getAggregatedPortfolio(req.user.id);
    res.json(result);
  } catch (err) {
    console.error('[exchanges.controller] getAggregatedPortfolio error:', err);
    res.status(500).json({ message: err.message });
  }
}

// GET /api/exchanges/:exchangeId/portfolio
async function getPortfolio(req, res) {
  try {
    const creds = await svc.getDecryptedCredentials(req.user.id, req.params.exchangeId);
    if (!creds) return res.status(404).json({ message: 'Exchange not connected' });
    if (creds.mode === 'paper') {
      const trades = await svc.getPaperTrades(req.user.id, req.params.exchangeId, 'open');
      return res.json({ mode: 'paper', positions: trades });
    }
    const positions = await svc.fetchPortfolio(req.params.exchangeId, creds);
    res.json({ mode: creds.mode, positions });
  } catch (err) {
    console.error(`[exchanges.controller] getPortfolio(${req.params.exchangeId}) error:`, err);
    res.status(err.status || 500).json({ message: err.message });
  }
}

// POST /api/exchanges/:exchangeId/order
async function placeOrder(req, res) {
  const { exchangeId } = req.params;
  const { symbol, side, type = 'market', quantity, price } = req.body;

  if (!symbol || !side || !quantity)
    return res.status(400).json({ message: 'symbol, side, quantity required' });

  try {
    const creds = await svc.getDecryptedCredentials(req.user.id, exchangeId);
    if (!creds) return res.status(404).json({ message: 'Exchange not connected' });

    if (creds.mode === 'readonly')
      return res.status(403).json({ message: 'Exchange is in read-only mode' });

    if (creds.mode === 'paper') {
      const numericPrice = parseFloat(price);
      if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
        return res.status(400).json({
          message: 'Un prix de marché valide (price > 0) est requis pour ouvrir un paper trade — le prix courant doit être transmis par le client.',
        });
      }

      const trade = await svc.openPaperTrade(req.user.id, exchangeId, {
        symbol, side, orderType: type, quantity,
        price: numericPrice,
        limitPrice: type === 'limit' ? price : null,
      });
      return res.json({ mode: 'paper', trade });
    }

    const result = await svc.placeLiveOrder(exchangeId, creds, { symbol, side, type, quantity, price });

    const { pool } = require('../config/db');
    await pool.query(
      `INSERT INTO live_orders
         (user_id, exchange_id, exchange_order_id, symbol, side, order_type, quantity, price, status, raw_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.user.id, exchangeId, result.exchangeOrderId, symbol, side, type,
       quantity, price || null, result.status, JSON.stringify(result.raw)]
    );

    res.json({ mode: 'live', ...result });
  } catch (err) {
    console.error(`[exchanges.controller] placeOrder(${exchangeId}) error:`, err);
    res.status(err.status || 500).json({ message: err.message });
  }
}

// POST /api/exchanges/:exchangeId/paper-trades/:tradeId/close
async function closePaperTrade(req, res) {
  const { tradeId } = req.params;
  const { closePrice } = req.body;
  if (!closePrice) return res.status(400).json({ message: 'closePrice required' });
  try {
    const trade = await svc.closePaperTrade(req.user.id, parseInt(tradeId), parseFloat(closePrice));
    res.json(trade);
  } catch (err) {
    console.error(`[exchanges.controller] closePaperTrade(${tradeId}) error:`, err);
    res.status(err.status || 500).json({ message: err.message });
  }
}

// GET /api/exchanges/:exchangeId/paper-trades?status=open|closed
async function getPaperTrades(req, res) {
  const status = req.query.status || 'open';
  try {
    const trades = await svc.getPaperTrades(req.user.id, req.params.exchangeId, status);
    res.json(trades);
  } catch (err) {
    console.error(`[exchanges.controller] getPaperTrades(${req.params.exchangeId}) error:`, err);
    res.status(500).json({ message: err.message });
  }
}

module.exports = {
  getConnections, connect, changeMode, disconnect,
  testConnection, healthCheckOne, getAggregatedPortfolio,
  getPortfolio, placeOrder,
  closePaperTrade, getPaperTrades,
};