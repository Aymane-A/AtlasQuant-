const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const ctrl    = require('../controllers/trading.controller');

router.use(protect);

// Orders
router.post  ('/order',          ctrl.placeOrder);       // POST /api/trading/order
router.get   ('/orders',         ctrl.getOrders);        // GET  /api/trading/orders?exchangeId=&status=
router.delete('/orders/:orderId',ctrl.cancelOrder);      // DELETE /api/trading/orders/:orderId

// Market data for trading page
router.get   ('/ticker/:symbol', ctrl.getTicker);        // GET /api/trading/ticker/:symbol?exchange=
router.get   ('/balance',        ctrl.getBalance);       // GET /api/trading/balance?exchangeId=

module.exports = router;