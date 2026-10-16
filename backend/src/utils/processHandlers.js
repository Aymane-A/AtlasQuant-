/**
 * src/utils/processHandlers.js — AtlasQuant AI
 *
 * Sur Node 15+, une promesse rejetée sans .catch() termine le process. Avec
 * beaucoup de crons/timers, un seul oubli de catch suffisait à tuer tout le
 * backend (et à interrompre les trades papier en cours).
 *
 *  - unhandledRejection : on LOGUE (avec la stack) et on continue de tourner.
 *  - uncaughtException  : l'état peut être corrompu → on logue, on laisse
 *    1,5 s au logger pour flusher, puis exit(1) (le restart policy relance).
 */
const logger = require('./logger');

let installed = false;

function describe(reason) {
  if (reason instanceof Error) return reason.stack || reason.message;
  try { return typeof reason === 'string' ? reason : JSON.stringify(reason); }
  catch { return String(reason); }
}

function installProcessHandlers(proc = process, { exit = (c) => proc.exit(c), exitDelayMs = 1500 } = {}) {
  if (installed && proc === process) return;
  if (proc === process) installed = true;

  proc.on('unhandledRejection', (reason) => {
    logger.error(`[process] unhandledRejection: ${describe(reason)}`);
  });

  proc.on('uncaughtException', (err) => {
    logger.error(`[process] uncaughtException: ${describe(err)}`);
    const t = setTimeout(() => exit(1), exitDelayMs);
    if (t.unref) t.unref();
  });
}

module.exports = { installProcessHandlers };
