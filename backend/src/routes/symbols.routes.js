const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { resolve } = require('../controllers/symbols.controller');

router.get('/resolve', protect, resolve);

module.exports = router;