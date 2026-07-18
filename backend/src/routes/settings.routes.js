const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { getSettings, updateSettings, changePassword, exportUserData, deleteAccount, } = require('../controllers/settings.controller');

router.get('/', protect, getSettings);
router.post('/update', protect, updateSettings);
router.post('/password', protect, changePassword);
router.get('/export', protect, exportUserData);
router.delete('/account', protect, deleteAccount);
module.exports = router;