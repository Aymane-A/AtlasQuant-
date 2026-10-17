/**
 * src/ws/dashboardSocket.server.js — AtlasQuant AI
 * Per-user WebSocket for a "live" Dashboard, replacing the 60s client-side
 * poll. Unlike marketSocket.server.js (one shared snapshot broadcast to
 * everyone), each connection here is authenticated and only ever receives
 * that one user's own data.
 *
 * Auth: the browser WebSocket API can't send custom headers. The client first
 * calls POST /api/auth/ws-ticket (normal Bearer auth) and connects with the
 * resulting single-use 30 s ticket (?ticket=...). The JWT itself is never put in
 * the URL, so it can't leak through proxy/access logs or browser history
 * (see utils/wsTicket.js).
 *
 * ✅ Fix — `noServer: true`: the HTTP upgrade is routed by
 * ws/upgradeRouter.js. startDashboardSocket() returns the upgrade handler
 * to register for '/ws/dashboard'.
 *
 * Interval is 30s (vs. marketSocket's 10s) because this does a real DB
 * query set per connected user, not one shared in-memory snapshot — a
 * shorter interval scales badly with concurrent users.
 */
const { WebSocketServer } = require('ws');
const { consumeTicket } = require('../utils/wsTicket');
const logger = require('../utils/logger');
const { buildDashboardPayload } = require('../services/dashboardData.service');

const BROADCAST_INTERVAL_MS = 30000;
const VALID_RANGES = new Set(['7', '30', '90', 'all']);

let wss = null;
let broadcastTimer = null;

function startDashboardSocket() {
  wss = new WebSocketServer({ noServer: true });

  wss.on('connection', async (socket, request) => {
    const url   = new URL(request.url, 'http://localhost');
    const ticket = url.searchParams.get('ticket');
    const rangeParam = url.searchParams.get('range');

    if (!ticket) {
      socket.close(4001, 'No ticket provided');
      return;
    }

    const consumed = consumeTicket(ticket);
    if (!consumed) {
      logger.warn('[dashboardSocket] Invalid, expired or already used ticket');
      socket.close(4001, 'Invalid or expired ticket');
      return;
    }
    const decoded = { id: consumed.userId };

    socket.userId = decoded.id;
    socket.range  = VALID_RANGES.has(rangeParam) ? rangeParam : '30';

    logger.info(`[dashboardSocket] User ${socket.userId} connected (range=${socket.range})`);

    // Send an immediate payload so the client doesn't wait for the next
    // broadcast tick to see data.
    try {
      const payload = await buildDashboardPayload(socket.userId, {
        range: socket.range, activityLimit: 5, activityOffset: 0, includeBenchmark: false,
      });
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'dashboard:update', ...payload }));
      }
    } catch (err) {
      logger.error(`[dashboardSocket] Initial payload failed for user ${socket.userId}: ${err.message}`);
    }

    socket.on('close', () => {
      logger.info(`[dashboardSocket] User ${socket.userId} disconnected`);
    });

    socket.on('error', (err) => {
      logger.error(`[dashboardSocket] Socket error (user ${socket.userId}): ${err.message}`);
    });
  });

  broadcastTimer = setInterval(refreshAndBroadcast, BROADCAST_INTERVAL_MS);
  logger.info('[dashboardSocket] ✅ Per-user Dashboard WebSocket active (/ws/dashboard)');

  return (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
}

async function refreshAndBroadcast() {
  if (!wss || wss.clients.size === 0) return;

  // Group connected sockets by (userId, range) so a user with two tabs
  // open at the same range only triggers one DB query set, not one per
  // socket.
  const groups = new Map();
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN || !client.userId) continue;
    const key = `${client.userId}:${client.range}`;
    if (!groups.has(key)) groups.set(key, { userId: client.userId, range: client.range, sockets: [] });
    groups.get(key).sockets.push(client);
  }
  if (groups.size === 0) return;

  await Promise.allSettled(
    [...groups.values()].map(async (g) => {
      try {
        const payload = await buildDashboardPayload(g.userId, {
          range: g.range, activityLimit: 5, activityOffset: 0, includeBenchmark: false,
        });
        const msg = JSON.stringify({ type: 'dashboard:update', ...payload });
        for (const socket of g.sockets) {
          if (socket.readyState === socket.OPEN) socket.send(msg);
        }
      } catch (err) {
        logger.error(`[dashboardSocket] Broadcast failed for user ${g.userId}: ${err.message}`);
      }
    })
  );
}

function stopDashboardSocket() {
  if (broadcastTimer) clearInterval(broadcastTimer);
  if (wss) wss.close();
}

module.exports = { startDashboardSocket, stopDashboardSocket };