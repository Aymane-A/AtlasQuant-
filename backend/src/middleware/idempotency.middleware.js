/**
 * src/middleware/idempotency.middleware.js — AtlasQuant AI
 * `idempotent(scope)` : à placer APRÈS protect sur les routes qui envoient des ordres.
 * Le header `Idempotency-Key` est optionnel ici (compat) ; le contrôleur l'exige
 * pour les ordres LIVE (req.idempotency absent => 400).
 */
const svc    = require('../services/idempotency.service');
const logger = require('../utils/logger');

function idempotent(scope) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.get('Idempotency-Key');
    if (key === undefined || key === '') return next();

    if (!svc.validKey(key)) {
      return res.status(400).json({ success: false, code: 'IDEMPOTENCY_KEY_INVALID',
        error: 'Idempotency-Key must be 8-128 characters: letters, digits, _ - : .' });
    }

    const userId = req.user.id;
    const requestHash = svc.hashRequest(scope, { params: req.params, body: req.body });

    let claimed;
    try {
      claimed = await svc.claim(userId, scope, key, requestHash);
    } catch (err) {
      logger.error(`[idempotency] claim failed: ${err.message}`);
      // Fail closed : sans store d'idempotence on ne sait pas si l'ordre est un doublon.
      return res.status(503).json({ success: false, code: 'IDEMPOTENCY_UNAVAILABLE', error: 'Order service temporarily unavailable. Retry shortly.' });
    }

    if (claimed.state === 'replay') {
      res.set('Idempotent-Replayed', 'true');
      return res.status(claimed.status).json(claimed.body);
    }
    if (claimed.state === 'in_progress') {
      res.set('Retry-After', '2');
      return res.status(409).json({ success: false, code: 'IDEMPOTENCY_IN_PROGRESS',
        error: 'A request with this Idempotency-Key is still being processed (or ended without a recorded result). Check your orders before retrying with a new key.' });
    }
    if (claimed.state === 'conflict') {
      return res.status(422).json({ success: false, code: 'IDEMPOTENCY_KEY_REUSED',
        error: 'This Idempotency-Key was already used with a different request. Use a new key for a new order.' });
    }

    // state === 'new' : on mémorise la réponse AVANT de l'envoyer (un retry juste après la voit).
    req.idempotency = { key, scope };
    const origJson = res.json.bind(res);
    let recorded = false;
    res.json = (body) => {
      if (recorded) return origJson(body);
      recorded = true;
      svc.complete(userId, scope, key, res.statusCode || 200, body)
        .catch((err) => logger.error(`[idempotency] complete failed: ${err.message}`))
        .finally(() => origJson(body));
      return res;
    };
    next();
  };
}

module.exports = { idempotent };
