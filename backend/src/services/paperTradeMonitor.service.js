/**
 * services/paperTradeMonitor.service.js — AtlasQuant AI
 * Watches open paper trades that have a stop_loss / take_profit set and
 * auto-closes them once price crosses the target. Crypto uses Binance's
 * public ticker (no auth needed); OANDA needs the user's own credentials
 * since pricing is account-scoped there.
 *
 * Wiring: in your existing cron bootstrap file (wherever the screener /
 * checkAlerts crons are started), add:
 *
 *   const paperTradeMonitor = require('./services/paperTradeMonitor.service');
 *   paperTradeMonitor.start(); // checks every 60s by default
 */

const axios         = require('axios');
const logger        = require('../utils/logger');
const exchangesSvc  = require('./exchanges.service');

// Fetches the current price for a trade's symbol on its exchange.
// Returns null (not throws) on failure so one bad symbol doesn't stop
// the rest of the batch from being checked.
async function getCurrentPrice(trade) {
  try {
    if (trade.exchange_id === 'oanda') {
      const creds = await exchangesSvc.getDecryptedCredentials(trade.user_id, 'oanda');
      if (!creds) return null;
      const { mid } = await exchangesSvc.getOandaPrice(
        creds.apiKey, creds.apiSecret, creds.mode, trade.symbol.toUpperCase()
      );
      return mid;
    }

    const sym  = trade.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pair = sym.endsWith('USDT') ? sym : `${sym}USDT`;
    const res  = await axios.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
      { timeout: 5000 }
    );
    return parseFloat(res.data.price);
  } catch (err) {
    logger.error(`[paperTradeMonitor] price fetch failed for ${trade.symbol}@${trade.exchange_id}: ${err.message}`);
    return null;
  }
}

// Returns 'stop_loss' | 'take_profit' | null
function checkTrigger(trade, price) {
  const sl = trade.stop_loss   != null ? parseFloat(trade.stop_loss)   : null;
  const tp = trade.take_profit != null ? parseFloat(trade.take_profit) : null;

  if (trade.side === 'buy') {
    if (sl && price <= sl) return 'stop_loss';
    if (tp && price >= tp) return 'take_profit';
  } else {
    if (sl && price >= sl) return 'stop_loss';
    if (tp && price <= tp) return 'take_profit';
  }
  return null;
}

// Runs one full pass over every open bracketed trade across all users.
// Exported standalone (not just via start()) so it can also be triggered
// manually — e.g. from an admin endpoint or a test script.
async function checkAndCloseTriggeredTrades() {
  const trades = await exchangesSvc.getOpenBracketTrades();
  if (!trades.length) return { checked: 0, closed: 0 };

  // Multiple trades often share the same symbol/exchange — one price
  // fetch per unique pair per run instead of one per trade.
  const priceCache = {};
  let closed = 0;

  for (const trade of trades) {
    try {
      const cacheKey = `${trade.exchange_id}:${trade.symbol}`;
      if (!(cacheKey in priceCache)) {
        priceCache[cacheKey] = await getCurrentPrice(trade);
      }
      const price = priceCache[cacheKey];
      if (!price) continue;

      const reason = checkTrigger(trade, price);
      if (reason) {
        await exchangesSvc.closePaperTrade(trade.user_id, trade.id, price, reason);
        closed++;
        logger.info(`[paperTradeMonitor] closed trade #${trade.id} (${trade.symbol}) via ${reason} @ ${price}`);
      }
    } catch (err) {
      logger.error(`[paperTradeMonitor] trade #${trade.id}: ${err.message}`);
    }
  }

  return { checked: trades.length, closed };
}

let intervalHandle = null;

function start(intervalMs = 60000) {
  if (intervalHandle) return; // already running — avoid double-scheduling on hot reload
  intervalHandle = setInterval(() => {
    checkAndCloseTriggeredTrades().catch(err =>
      logger.error(`[paperTradeMonitor] run error: ${err.message}`)
    );
  }, intervalMs);
  logger.info(`[paperTradeMonitor] started — checking every ${intervalMs / 1000}s`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { checkAndCloseTriggeredTrades, start, stop };