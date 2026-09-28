/**
 * src/ws/upgradeRouter.js — AtlasQuant AI
 *
 * ✅ Fix — two `new WebSocketServer({ server, path })` on the same HTTP
 * server do NOT coexist: each one registers its own 'upgrade' listener,
 * every listener fires for every upgrade request, and the one whose
 * `path` doesn't match aborts the handshake with a 400 on the shared
 * socket. The `ws` docs' recommended pattern for multiple servers on one
 * HTTP server is `noServer: true` + a single 'upgrade' handler that
 * routes by pathname — which is exactly what this does.
 */
const logger = require('../utils/logger');

function attachUpgradeRouter(httpServer, routes) {
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    const handler = routes[pathname];
    if (!handler) {
      logger.warn(`[ws] Upgrade refused — no WebSocket route for ${pathname}`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    handler(req, socket, head);
  });
}

module.exports = { attachUpgradeRouter };