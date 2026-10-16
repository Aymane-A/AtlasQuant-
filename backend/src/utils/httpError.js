/**
 * utils/httpError.js — never leak internal error details to API clients.
 *
 * - Full error (with stack) goes to the server log, tagged with a short requestId.
 * - In production the client only gets a generic message + that requestId, so a user
 *   can quote it to support. In development/test the real message is returned.
 * - Errors that are deliberately client-safe pass through: status < 500, or err.expose === true.
 */
const crypto = require('crypto');
const logger = require('./logger');

const GENERIC = 'Internal server error';

function isProd() {
  return process.env.NODE_ENV === 'production';
}

function newRequestId() {
  return crypto.randomBytes(4).toString('hex');
}

function isClientSafe(err) {
  const s = Number(err && err.status);
  return (err && err.expose === true) || (Number.isInteger(s) && s >= 400 && s < 500);
}

/** Message that is safe to put in a response (or a stored job result). */
function publicMessage(err) {
  if (!isProd() || isClientSafe(err)) return (err && err.message) || GENERIC;
  return GENERIC;
}

/**
 * Log the error and answer the request. Drop-in for
 *   res.status(500).json({ success:false, error: err.message })
 */
function sendServerError(res, err, scope = '') {
  const requestId = newRequestId();
  const clientSafe = isClientSafe(err);
  const status = clientSafe && Number.isInteger(Number(err.status)) ? Number(err.status) : 500;
  logger.error(`[${requestId}]${scope ? ` ${scope}` : ''} ${(err && err.stack) || err}`);
  const body = {
    success: false,
    error: !isProd() || clientSafe ? ((err && err.message) || GENERIC) : GENERIC,
    requestId,
  };
  if (err && err.code && clientSafe && typeof err.code === 'string') body.code = err.code;
  if (res.headersSent) return res;
  return res.status(status).json(body);
}

module.exports = { sendServerError, publicMessage, newRequestId };
