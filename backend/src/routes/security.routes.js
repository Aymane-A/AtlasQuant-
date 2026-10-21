const router = require('express').Router();
const { protect } = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimit.middleware');
const sec = require('../controllers/security.controller');

router.get('/2fa/status',            protect, sec.get2FAStatus);
router.post('/2fa/setup',            protect, rateLimiter(10), sec.setup2FA);
router.post('/2fa/verify',           protect, rateLimiter(10), sec.verify2FA);
router.post('/2fa/disable',          protect, rateLimiter(10), sec.disable2FA);

router.get('/sessions',              protect, sec.listSessions);
router.delete('/sessions/:id',       protect, sec.revokeSession);
router.delete('/sessions',           protect, sec.revokeAllOtherSessions);

router.get('/api-keys',              protect, sec.listApiKeys);
router.post('/api-keys',             protect, sec.createApiKey);
router.delete('/api-keys/:id',       protect, sec.revokeApiKey);

module.exports = router;