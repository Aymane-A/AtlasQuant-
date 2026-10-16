/**
 * services/riskGuard.service.js — AtlasQuant AI
 *
 * Enforces the per-user limits saved in Settings → Risk
 * (user_settings.risk_max_position_pct / risk_max_daily_loss_pct / risk_default_stoploss_pct).
 * Before this module those values were stored but never applied anywhere.
 *
 *  1. Max position size  — order notional must be <= X% of account equity.
 *  1b. Max total exposure — SUM of all open paper positions + this order <= X% of equity
 *                          (cumulative: 10 orders of 18% no longer slip through a 20% per-order cap).
 *  2. Max daily loss     — once today's realised paper loss reaches X% of equity,
 *                          NEW positions are refused until tomorrow (paper only:
 *                          live P&L is not tracked in this codebase).
 *  3. Default stop-loss  — if the order has no stop-loss, one is attached at X% from
 *                          entry (paper, OANDA, Alpaca). CEX spot orders can't carry
 *                          a bracket, so a warning is returned instead.
 *
 * Equity:  paper → PAPER_START_CAPITAL + realised paper P&L on that exchange.
 *          live  → sum of USD-pegged stablecoin balances (CEX only). OANDA/Alpaca
 *                  expose positions not equity here, so equity is "unknown" and,
 *                  with RISK_STRICT_LIVE=true (default), live orders are refused
 *                  rather than silently skipping the check.
 *
 * Reduce-only exception: a SELL on a CEX *spot* account only reduces exposure, so it
 * is never blocked by these limits (the user must always be able to exit).
 */
const db           = require('../config/db');
const env          = require('../config/env');
const logger       = require('../utils/logger');
const exchangesSvc = require('./exchanges.service');

const DEFAULTS = { maxPositionPct: 20, maxDailyLossPct: 5, defaultStopLossPct: 2, maxTotalExposurePct: 100 };
const STABLES  = new Set(['USDT', 'USDC', 'USD', 'BUSD', 'FDUSD', 'TUSD', 'DAI']);

const isCex = (exchangeId) => exchangeId !== 'oanda' && exchangeId !== 'alpaca';

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

async function getRiskSettings(userId) {
  const { rows } = await db.query(
    `SELECT risk_max_position_pct, risk_max_daily_loss_pct, risk_default_stoploss_pct, risk_max_total_exposure_pct
     FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  const r = rows[0] || {};
  // A value <= 0 means "limit disabled" by the user.
  return {
    maxPositionPct:     num(r.risk_max_position_pct,     DEFAULTS.maxPositionPct),
    maxDailyLossPct:    num(r.risk_max_daily_loss_pct,   DEFAULTS.maxDailyLossPct),
    defaultStopLossPct: num(r.risk_default_stoploss_pct, DEFAULTS.defaultStopLossPct),
    maxTotalExposurePct: num(r.risk_max_total_exposure_pct, DEFAULTS.maxTotalExposurePct),
  };
}

/** Account equity in quote currency, or null if it cannot be determined. */
async function getEquity({ userId, exchangeId, mode, creds }) {
  if (mode === 'paper') {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(pnl), 0) AS realised
       FROM paper_trades WHERE user_id = $1 AND exchange_id = $2 AND status = 'closed'`,
      [userId, exchangeId]
    );
    return Math.max(exchangesSvc.PAPER_START_CAPITAL + num(rows[0]?.realised, 0), 0);
  }
  if (!isCex(exchangeId) || !creds) return null;
  const positions = await exchangesSvc.fetchPortfolio(exchangeId, creds);
  const total = positions.filter(p => STABLES.has(String(p.symbol).toUpperCase()))
                         .reduce((a, p) => a + num(p.total, 0), 0);
  return total > 0 ? total : null;
}

/** Gross notional of the user's currently open paper positions on this exchange. */
async function openPaperNotional(userId, exchangeId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(quantity * price), 0) AS notional
       FROM paper_trades WHERE user_id = $1 AND exchange_id = $2 AND status = 'open'`,
    [userId, exchangeId]
  );
  return num(rows[0]?.notional, 0);
}

async function todayRealisedPaperPnl(userId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(pnl), 0) AS pnl FROM paper_trades
     WHERE user_id = $1 AND status = 'closed' AND closed_at >= date_trunc('day', NOW())`,
    [userId]
  );
  return num(rows[0]?.pnl, 0);
}

function roundPrice(exchangeId, price) {
  const dp = exchangeId === 'alpaca' ? 2 : exchangeId === 'oanda' ? 5 : 8;
  return Number(price.toFixed(dp));
}

const fail = (status, code, error, details) => ({ ok: false, status, code, error, details });

/**
 * @param {object} o
 * @param {number} o.userId
 * @param {string} o.exchangeId
 * @param {'paper'|'live'} o.mode
 * @param {object} [o.creds]        decrypted credentials (live only)
 * @param {'buy'|'sell'} o.side
 * @param {number} o.quantity
 * @param {number} o.refPrice       limit price, or current market price
 * @param {number|null} [o.stopLoss]
 * @param {boolean} [o.noStopLoss]  caller explicitly opts out of the default stop-loss
 * @returns {Promise<{ok:true, stopLoss:number|null, warnings:string[], details:object}
 *                  |{ok:false, status:number, code:string, error:string}>}
 */
async function checkOrder(o) {
  const { userId, exchangeId, mode, creds, side, quantity, refPrice } = o;
  const warnings = [];
  let stopLoss = o.stopLoss ?? null;

  // Exits on CEX spot must never be blocked.
  if (mode === 'live' && isCex(exchangeId) && side === 'sell') {
    return { ok: true, stopLoss, warnings, details: { reduceOnly: true } };
  }

  const s = await getRiskSettings(userId);

  let equity = null;
  try {
    equity = await getEquity({ userId, exchangeId, mode, creds });
  } catch (err) {
    logger.warn(`[riskGuard] equity lookup failed (${exchangeId}): ${err.message}`);
  }

  if (equity == null) {
    if (mode === 'live' && env.RISK_STRICT_LIVE) {
      return fail(403, 'RISK_UNVERIFIABLE',
        'Cannot verify your risk limits for this account (equity unknown), so the live order was not sent. ' +
        'Hold a USDT/USD balance on a supported exchange, or set RISK_STRICT_LIVE=false on the server to override.');
    }
    warnings.push('Risk limits could not be verified for this account.');
  }

  const notional = quantity * refPrice;

  // 1) Max position size
  if (equity != null && s.maxPositionPct > 0) {
    const pct = (notional / equity) * 100;
    if (pct > s.maxPositionPct) {
      const maxQty = Math.floor(((equity * s.maxPositionPct) / 100 / refPrice) * 1e8) / 1e8;
      return fail(403, 'RISK_MAX_POSITION',
        `Order size is ${pct.toFixed(1)}% of your equity (${equity.toFixed(2)}); your limit is ${s.maxPositionPct}%. ` +
        `Max quantity at this price ≈ ${maxQty}.`,
        { equity, notional, positionPct: pct, limitPct: s.maxPositionPct, maxQuantity: maxQty });
    }
  }

  // 1b) Max TOTAL exposure (paper: open positions are tracked; live exposure isn't)
  if (mode === 'paper' && equity != null && equity > 0 && s.maxTotalExposurePct > 0) {
    const openNotional = await openPaperNotional(userId, exchangeId);
    const totalPct = ((openNotional + notional) / equity) * 100;
    if (totalPct > s.maxTotalExposurePct) {
      const room = Math.max(0, (equity * s.maxTotalExposurePct) / 100 - openNotional);
      const maxQty = Math.floor((room / refPrice) * 1e8) / 1e8;
      return fail(403, 'RISK_MAX_EXPOSURE',
        `Total open exposure would be ${totalPct.toFixed(1)}% of your equity (${equity.toFixed(2)}); your limit is ${s.maxTotalExposurePct}%. ` +
        `Max quantity at this price ≈ ${maxQty}.`,
        { equity, openNotional, notional, totalPct, limitPct: s.maxTotalExposurePct, maxQuantity: maxQty });
    }
  }

  // 2) Max daily loss (paper only — live P&L isn't tracked)
  if (mode === 'paper' && s.maxDailyLossPct > 0) {
    const todayPnl = await todayRealisedPaperPnl(userId);
    if (todayPnl < 0) {
      const base = equity ?? exchangesSvc.PAPER_START_CAPITAL;
      const lossPct = (Math.abs(todayPnl) / base) * 100;
      if (lossPct >= s.maxDailyLossPct) {
        return fail(403, 'RISK_DAILY_LOSS',
          `Daily loss limit reached (${lossPct.toFixed(1)}% ≥ ${s.maxDailyLossPct}%). New positions are blocked until tomorrow.`,
          { todayPnl, lossPct, limitPct: s.maxDailyLossPct });
      }
    }
  } else if (mode === 'live') {
    warnings.push('Daily-loss limit is not enforced for live orders (live P&L is not tracked).');
  }

  // 3) Default stop-loss
  if (stopLoss == null && !o.noStopLoss && s.defaultStopLossPct > 0) {
    if (mode === 'paper' || !isCex(exchangeId)) {
      const k = s.defaultStopLossPct / 100;
      stopLoss = roundPrice(exchangeId, side === 'buy' ? refPrice * (1 - k) : refPrice * (1 + k));
    } else {
      warnings.push('No stop-loss attached: this exchange cannot attach a stop-loss to a spot order. Set one manually.');
    }
  }

  return { ok: true, stopLoss, warnings, details: { equity, notional } };
}

module.exports = { checkOrder, getRiskSettings, getEquity, DEFAULTS };
