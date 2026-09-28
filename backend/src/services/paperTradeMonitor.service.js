/**
 * services/paperTradeMonitor.service.js — AtlasQuant AI
 * Watches open paper trades that have a stop_loss / take_profit set and
 * auto-closes them once price crosses the target. Crypto uses Binance's
 * public ticker (no auth needed); equities/indices/forex/commodities use
 * Yahoo Finance; OANDA needs the user's own credentials since pricing is
 * account-scoped there.
 *
 * ✅ Fix: garde anti-chevauchement (isRunning) — sans ça, si un cycle
 * traîne plus longtemps que l'intervalle, le setInterval relance un
 * nouveau cycle par-dessus l'ancien = pool pg épuisé.
 *
 * ✅ Fix (2026-09-27): getCurrentPrice() envoyait TOUT symbole non-OANDA
 * vers Binance (ex: "^GSPC" → "GSPCUSDT" → 400). On route maintenant sur
 * la NATURE du symbole (crypto vs reste), pas sur exchange_id : un config
 * auto-trade sur une action peut très bien avoir exchange_id='binance'.
 *
 * ✅ Feature (2026-09-27): notifyTradeClosed() — email/Telegram quand un
 * trade ouvert par l'auto-trader est clôturé par SL/TP. Limité aux trades
 * qui ont un auto_trade_config_id (les trades manuels ne déclenchent pas
 * de notification "Auto-trade closed").
 */

const axios          = require('axios');
const logger         = require('../utils/logger');
const db             = require('../config/db');
const exchangesSvc   = require('./exchanges.service');
const autoTrader     = require('./autoTrader.service');
const { CRYPTO_SYMBOLS }     = require('./signalGenerator.service');
const { notifyTradeClosed }  = require('./tradeNotify.service');

const PRICE_FETCH_TIMEOUT_MS = 6000;

const CRYPTO_SYMBOLS_SET = new Set(CRYPTO_SYMBOLS);
function isCryptoSymbol(symbol) {
  const noSlash = symbol.toUpperCase().replace('/', '');
  return CRYPTO_SYMBOLS_SET.has(noSlash) || CRYPTO_SYMBOLS_SET.has(`${noSlash}USDT`);
}

// Returns null (not throws) on failure so one bad symbol doesn't stop
// the rest of the batch from being checked.
async function getCurrentPrice(trade) {
  try {
    if (trade.exchange_id === 'oanda') {
      const creds = await exchangesSvc.getDecryptedCredentials(trade.user_id, 'oanda');
      if (!creds) return null;

      const { mid } = await Promise.race([
        exchangesSvc.getOandaPrice(creds.apiKey, creds.apiSecret, creds.mode, trade.symbol.toUpperCase()),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('OANDA price fetch timeout')), PRICE_FETCH_TIMEOUT_MS)
        ),
      ]);
      return mid;
    }

    if (!isCryptoSymbol(trade.symbol)) {
      const YahooFinance = require('yahoo-finance2').default;
      const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
      const quote = await Promise.race([
        yf.quote(trade.symbol),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Yahoo price fetch timeout')), PRICE_FETCH_TIMEOUT_MS)
        ),
      ]);
      return quote?.regularMarketPrice ?? null;
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

async function checkAndCloseTriggeredTrades() {
  const trades = await exchangesSvc.getOpenBracketTrades();
  if (!trades.length) return { checked: 0, closed: 0 };

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

        // ✅ Fix + Feature: seulement pour les trades de l'auto-trader.
        if (trade.auto_trade_config_id) {
          // pnl réel écrit par closePaperTrade ; fallback sur un calcul local.
          let pnl = null, pnlPct = null;
          try {
            const { rows } = await db.query('SELECT pnl, pnl_pct FROM paper_trades WHERE id = $1', [trade.id]);
            if (rows[0] && rows[0].pnl != null) {
              pnl    = parseFloat(rows[0].pnl);
              pnlPct = rows[0].pnl_pct != null ? parseFloat(rows[0].pnl_pct) : null;
            }
          } catch (e) {
            logger.error(`[paperTradeMonitor] pnl read failed for trade #${trade.id}: ${e.message}`);
          }
          const entry = parseFloat(trade.price);
          const qty   = parseFloat(trade.quantity);
          if (!Number.isFinite(pnl)) {
            pnl    = trade.side === 'buy' ? (price - entry) * qty : (entry - price) * qty;
            pnlPct = entry && qty ? (pnl / (entry * qty)) * 100 : null;
          }

          // Ferme la boucle de probation : sans cet appel, probation_trades_completed
          // restait à 0 et aucun config ne pouvait passer 'live'.
          if (Number.isFinite(pnl)) {
            try {
              await autoTrader.recordProbationResult(trade.auto_trade_config_id, pnl);
            } catch (e) {
              logger.error(`[paperTradeMonitor] recordProbationResult failed (config #${trade.auto_trade_config_id}): ${e.message}`);
            }
          }

          notifyTradeClosed(trade.user_id, {
            symbol: trade.symbol, side: trade.side, price: entry, reason, pnl, pnlPct,
          }).catch(e => logger.error(`[paperTradeMonitor] notify failed: ${e.message}`));
        }
      }
    } catch (err) {
      logger.error(`[paperTradeMonitor] trade #${trade.id}: ${err.message}`);
    }
  }

  return { checked: trades.length, closed };
}

let intervalHandle = null;
let isRunning       = false;

function start(intervalMs = 60000) {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    if (isRunning) {
      logger.warn('[paperTradeMonitor] previous run still in progress — skipping this tick');
      return;
    }
    isRunning = true;
    checkAndCloseTriggeredTrades()
      .catch(err => logger.error(`[paperTradeMonitor] run error: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, intervalMs);
  logger.info(`[paperTradeMonitor] started — checking every ${intervalMs / 1000}s`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  isRunning = false;
}

module.exports = { checkAndCloseTriggeredTrades, start, stop };