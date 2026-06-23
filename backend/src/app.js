/**
 * src/app.js — AtlasQuant AI
 * Final Version: Full Stack Backend Engine
 */

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

require('dotenv').config();
const env    = require('./config/env');
const logger = require('./utils/logger');
const db     = require('./config/db');
const { initCronJobs }      = require('./services/cron.service');
const { startMarketSocket } = require('./ws/marketSocket.server');

const app = express();

// ── 1. Security & Middlewares ─────────────────────────────
app.use(helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc:    ["'self'", "https://fonts.gstatic.com"],
            imgSrc:     ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "http://localhost:5000", "http://localhost:3000", "ws://localhost:5000"],
        }
    }
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(cors({
    origin: (origin, cb) => {
        const allowed = [
            'http://localhost:3000',
            'http://localhost:4173',
            ...(process.env.ALLOWED_ORIGINS?.split(',') || []),
        ];
        if (!origin || allowed.includes(origin)) return cb(null, true);
        cb(new Error('CORS blocked'));
    },
    credentials: true,
}));

app.use(morgan('[:method] :url :status :response-time ms'));

// ── 2. Rate Limiters ──────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max:      100,
    message:  { success: false, error: 'Too many requests, slow down!' },
});

const backtestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max:      20,
    message:  { success: false, error: 'Too many backtest requests' },
});

// Backtest has its own limiter
app.use('/api/backtest', backtestLimiter);
// Global limiter for everything else
app.use('/api/', (req, res, next) => {
    if (req.path.startsWith('/backtest')) return next();
    apiLimiter(req, res, next);
});

// ── 3. API Routes ─────────────────────────────────────────
app.use('/api/signals',   require('./routes/signals.routes'));
app.use('/api/market',    require('./routes/market.routes'));
app.use('/api/alerts',    require('./routes/alerts.routes'));
app.use('/api/auth',      require('./routes/auth.routes'));
app.use('/api/prices',    require('./routes/prices.routes'));
app.use('/api/apikeys',   require('./routes/apiKeys.routes'));
app.use('/api/backtest',  require('./routes/backtest.routes'));
app.use('/api/portfolio', require('./routes/portfolio.routes'));
app.use('/api/risk',      require('./routes/risk.routes'));
app.use('/api/settings',  require('./routes/settings.routes'));
app.use('/api/watchlist', require('./routes/watchlist.routes'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));

// ── 4. Health Check ───────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status:       'ok',
        timestamp:    new Date().toISOString(),
        groq:         !!env.GROQ_API_KEY,
        paperTrading: env.PAPER_TRADING,
    });
});

// ── 5. Catch-all ──────────────────────────────────────────
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` });
    }
    res.status(404).json({ success: false, error: 'Use React frontend on port 3000' });
});

// ── 6. Global Error Handler ───────────────────────────────
app.use((err, req, res, next) => {
    logger.error(`[app] Error: ${err.message}`);
    res.status(err.status || 500).json({ success: false, error: err.message });
});

// ── 7. Server Start ───────────────────────────────────────
const server = app.listen(env.PORT, async () => {
    logger.info('═'.repeat(55));
    logger.info(' AtlasQuant AI — Backend API Online');
    logger.info(` Port: ${env.PORT} | Environment: ${env.NODE_ENV}`);

    try {
        await db.query('SELECT NOW()');
        logger.info(' Database: ✅ Connected (PostgreSQL)');

        initCronJobs();
        logger.info(' Cron Engine: ✅ Initialized & Active');

        startMarketSocket(server);

    } catch (err) {
        logger.error(' Initialization Failed:', err.message);
    }

    logger.info('═'.repeat(55));
});

server.timeout = 120000;

module.exports = app;