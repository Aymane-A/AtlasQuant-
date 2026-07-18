const router = require('express').Router();
const { protect } = require('../middleware/auth.middleware');
const sec = require('../controllers/security.controller');

router.get('/2fa/status',            protect, sec.get2FAStatus);
router.post('/2fa/setup',            protect, sec.setup2FA);
router.post('/2fa/verify',           protect, sec.verify2FA);
router.post('/2fa/disable',          protect, sec.disable2FA);

router.get('/sessions',              protect, sec.listSessions);
router.delete('/sessions/:id',       protect, sec.revokeSession);
router.delete('/sessions',           protect, sec.revokeAllOtherSessions);

router.get('/api-keys',              protect, sec.listApiKeys);
router.post('/api-keys',             protect, sec.createApiKey);
router.delete('/api-keys/:id',       protect, sec.revokeApiKey);

module.exports = router;