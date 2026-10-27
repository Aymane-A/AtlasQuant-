/**
 * utils/orderState.js — AtlasQuant AI
 *
 * Live order state machine helpers.
 *
 *   pending ──send──► submitted ─► partially_filled ─► filled
 *      │                  └──────────────────────────► cancelled / rejected
 *      ├─ exchange says "no" (definite) ───────────────► rejected
 *      └─ we cannot tell (timeout, 5xx, lost reply) ──► unknown ──reconciler──► (any state above)
 *
 * "unknown" is the dangerous one: the exchange may have accepted the order while our client never saw
 * the answer. It is NEVER guessed: it stays "unknown" until the exchange is asked for the order by the
 * client id we generated (services/liveOrderReconciler.service.js).
 */
const crypto = require('crypto');
const ccxt   = require('ccxt');

const STATUSES = ['pending', 'submitted', 'partially_filled', 'filled', 'cancelled', 'rejected', 'unknown'];
const OPEN_STATUSES   = ['pending', 'submitted', 'partially_filled', 'unknown'];
const CLOSED_STATUSES = ['filled', 'cancelled', 'rejected'];

/** 'aq' + 28 hex chars = 30 chars: accepted by Binance (<=36, [A-Za-z0-9-_]), OANDA and Alpaca (<=128). */
function newClientOrderId() {
  return 'aq' + crypto.randomBytes(14).toString('hex');
}

// ccxt errors that mean "the exchange looked at the order and refused it" (nothing was placed).
const CCXT_DEFINITE = [
  'InvalidOrder', 'InsufficientFunds', 'AuthenticationError', 'PermissionDenied', 'BadSymbol',
  'BadRequest', 'AccountSuspended', 'OrderNotFillable', 'OrderImmediatelyFillable',
  'NotSupported', 'ArgumentsRequired', 'InvalidNonce',
].map((n) => ccxt[n]).filter((c) => typeof c === 'function');

// HTTP statuses that are a definite refusal. Everything else (408, 429, 5xx, no response) is ambiguous.
// 429 is treated as ambiguous on purpose: the cost of a wrong "unknown" is a delay, the cost of a wrong
// "rejected" is a live order we no longer track.
const HTTP_DEFINITE = new Set([400, 401, 403, 404, 405, 422]);

/**
 * 'rejected' = we are sure nothing was placed. 'unknown' = we cannot tell (default: safe side).
 */
function classifyOrderError(err) {
  if (!err) return 'unknown';
  if (err.orderNotSent === true) return 'rejected';           // thrown before any request left this server
  const http = err.response && err.response.status;
  if (typeof http === 'number') return HTTP_DEFINITE.has(http) ? 'rejected' : 'unknown';
  if (CCXT_DEFINITE.some((C) => err instanceof C)) return 'rejected';
  return 'unknown';                                           // timeouts, resets, DNS, 5xx, ccxt NetworkError/ExchangeError, anything else
}

/** Maps what exchanges say to our own statuses (so the open/closed filters in the API are reliable). */
function normalizeOrderStatus(raw, filled = 0) {
  const s = String(raw || '').toLowerCase();
  if (['filled', 'closed', 'done', 'executed'].includes(s)) return 'filled';
  if (['partially_filled', 'partial'].includes(s)) return 'partially_filled';
  if (['canceled', 'cancelled', 'expired', 'done_for_day'].includes(s)) return 'cancelled';
  if (['rejected', 'failed'].includes(s)) return 'rejected';
  if (['open', 'new', 'accepted', 'pending_new', 'pending', 'triggered', 'submitted', 'accepted_for_bidding', 'held'].includes(s)) {
    return Number(filled) > 0 ? 'partially_filled' : 'submitted';
  }
  return 'submitted';                                         // the exchange knows the order: it is live, not "unknown"
}

module.exports = { STATUSES, OPEN_STATUSES, CLOSED_STATUSES, newClientOrderId, classifyOrderError, normalizeOrderStatus };
