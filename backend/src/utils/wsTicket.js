/**
 * utils/wsTicket.js — AtlasQuant AI
 *
 * Single-use, short-lived WebSocket tickets. The browser WebSocket API can't send an
 * Authorization header, so the JWT used to travel in the URL (?token=...), where it ends up
 * in proxy/access logs and browser history. Instead the client calls POST /api/auth/ws-ticket
 * (normal Bearer auth), gets an opaque random ticket, and connects with ?ticket=...
 *
 *  - random 256-bit value, never derived from the JWT
 *  - valid for TTL_MS (30 s) and consumed on first use (replay => rejected)
 *  - in-memory: fine for a single backend process. With several instances behind a load
 *    balancer, move this Map to Redis/Postgres (same issue/consume interface).
 */
const crypto = require('crypto');

const TTL_MS = 30_000;
const MAX_PENDING = 5000;            // hard cap so the Map cannot grow without bound
const tickets = new Map();           // ticket -> { userId, exp }

function prune(now = Date.now()) {
  for (const [t, v] of tickets) if (v.exp <= now) tickets.delete(t);
}

function issueTicket(userId, now = Date.now()) {
  if (tickets.size >= MAX_PENDING) prune(now);
  if (tickets.size >= MAX_PENDING) {
    const err = new Error('Too many pending WebSocket tickets');
    err.status = 503;
    throw err;
  }
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, { userId, exp: now + TTL_MS });
  return { ticket, expiresInMs: TTL_MS };
}

/** Returns { userId } and deletes the ticket, or null if unknown / expired / already used. */
function consumeTicket(ticket, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 128) return null;
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);            // single use, even if expired
  return entry.exp > now ? { userId: entry.userId } : null;
}

function _size() { return tickets.size; }

module.exports = { issueTicket, consumeTicket, TTL_MS, _size };
