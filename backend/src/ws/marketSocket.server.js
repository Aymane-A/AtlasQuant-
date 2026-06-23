/**
 * src/ws/marketSocket.server.js
 *
 * RÔLE DE CE FICHIER :
 * Serveur WebSocket attaché au même serveur HTTP qu'Express (pas de
 * port séparé — important pour le déploiement où un seul port est
 * généralement exposé). Diffuse un snapshot du marché à tous les
 * clients connectés toutes les BROADCAST_INTERVAL_MS millisecondes.
 *
 * Le frontend (useMarketData.js) attend des messages JSON de la forme :
 *   { ticks, indices, sectors, comms, forex, cryptos, sp500Intraday }
 * — exactement ce que buildMarketSnapshot() renvoie.
 */

const { WebSocketServer } = require('ws');
const logger = require('../utils/logger');
const { buildMarketSnapshot } = require('../services/marketStream.service');

const BROADCAST_INTERVAL_MS = 10000; // 10s — évite de saturer Yahoo/Binance avec des requêtes trop fréquentes

let wss = null;
let broadcastTimer = null;
let lastSnapshot = null;

/**
 * Démarre le serveur WebSocket sur le serveur HTTP fourni (celui créé
 * par app.listen() dans app.js — on ne crée pas de nouveau port).
 */
function startMarketSocket(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket) => {
    logger.info(`[marketSocket] Client connecté (${wss.clients.size} actifs)`);

    // Envoie immédiatement le dernier snapshot connu, pour que le
    // client n'attende pas le prochain cycle de broadcast pour voir des données.
    if (lastSnapshot) {
      socket.send(JSON.stringify(lastSnapshot));
    }

    socket.on('close', () => {
      logger.info(`[marketSocket] Client déconnecté (${wss.clients.size} actifs)`);
    });

    socket.on('error', (err) => {
      logger.error(`[marketSocket] Erreur socket client: ${err.message}`);
    });
  });

  // Premier snapshot immédiat, puis cycle régulier
  refreshAndBroadcast();
  broadcastTimer = setInterval(refreshAndBroadcast, BROADCAST_INTERVAL_MS);

  logger.info('[marketSocket] ✅ WebSocket de marché actif (attaché au serveur HTTP)');
}

/**
 * Reconstruit le snapshot et l'envoie à tous les clients connectés.
 * Si la construction échoue entièrement, on garde le dernier snapshot
 * valide plutôt que de couper le flux vers les clients.
 */
async function refreshAndBroadcast() {
  try {
    const snapshot = await buildMarketSnapshot();
    lastSnapshot = snapshot;

    if (!wss || wss.clients.size === 0) return;

    const payload = JSON.stringify(snapshot);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  } catch (err) {
    logger.error(`[marketSocket] Échec de construction du snapshot: ${err.message}`);
  }
}

function stopMarketSocket() {
  if (broadcastTimer) clearInterval(broadcastTimer);
  if (wss) wss.close();
}

module.exports = { startMarketSocket, stopMarketSocket };