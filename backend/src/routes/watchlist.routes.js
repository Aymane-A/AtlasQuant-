const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { getWatchlist, addSymbol, removeSymbol } = require('../controllers/watchlist.controller');

router.get('/',         protect, getWatchlist);
router.post('/',        protect, addSymbol);        
router.delete('/:sym',  protect, removeSymbol);     

module.exports = router;