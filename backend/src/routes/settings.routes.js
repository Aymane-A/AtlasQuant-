const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimit.middleware');
const {
  getSettings,
  updateSettings,
  changePassword,
  exportUserData,
  deleteAccount,
  testWebhook,
  testTelegram,
  sendVerificationEmail,
  verifyEmail,
  getAuditLog,
} = require('../controllers/settings.controller');

router.get('/', protect, getSettings);
router.post('/update', protect, updateSettings);
router.post('/password', protect, rateLimiter(10), changePassword);
router.get('/export', protect, exportUserData);
router.delete('/account', protect, rateLimiter(5), deleteAccount);
router.post('/webhook/test', protect, testWebhook);
router.post('/telegram/test', protect, testTelegram);
router.post('/email/resend-verification', protect, sendVerificationEmail);
router.post('/email/verify', verifyEmail); // ⚠️ public — cliqué depuis l'email, pas de session requise
router.get('/audit-log', protect, getAuditLog);

module.exports = router;