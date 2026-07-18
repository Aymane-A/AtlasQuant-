const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const {
  getSettings,
  updateSettings,
  changePassword,
  exportUserData,
  deleteAccount,
  testWebhook,
  testTelegram,
  resendVerification,
  verifyEmail,
  getAuditLog,
} = require('../controllers/settings.controller');

router.get('/', protect, getSettings);
router.post('/update', protect, updateSettings);
router.post('/password', protect, changePassword);
router.get('/export', protect, exportUserData);
router.delete('/account', protect, deleteAccount);
router.post('/webhook/test', protect, testWebhook);
router.post('/telegram/test', protect, testTelegram);
router.post('/email/resend-verification', protect, resendVerification);
router.post('/email/verify', verifyEmail); // ⚠️ public — cliqué depuis l'email, pas de session requise
router.get('/audit-log', protect, getAuditLog);

module.exports = router;