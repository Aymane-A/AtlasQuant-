/**
 * src/routes/dashboard.routes.js
 * Protected route for User Dashboard Overview
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const dashboardController = require('../controllers/dashboard.controller');


router.get('/summary', protect, dashboardController.getDashboardData);

module.exports = router;