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
// ✅ Audit 3: une promesse rejetée sans catch ne doit plus tuer tout le backend
require('./utils/processHandlers').installProcessHandlers();
const db     = require('./config/db');
const { initCronJobs }      = require('./services/cron.service');
const { startMarketSocket } = require('./ws/marketSocket.server');
// ✅ Feature: per-user live Dashboard WebSocket (see ws/dashboardSocket.server.js)
const { startDashboardSocket } = require('./ws/dashboardSocket.server');
const { attachUpgradeRouter } = require('./ws/upgradeRouter');
const app = express();

// Behind a reverse proxy (nginx, Render, Heroku...) req.ip is the proxy's IP
// unless trust proxy is set — which makes every user share one rate-limit bucket.
if (env.TRUST_PROXY) {
    app.set('trust proxy', env.TRUST_PROXY === 'true' ? true : (Number.isNaN(Number(env.TRUST_PROXY)) ? env.TRUST_PROXY : Number(env.TRUST_PROXY)));
}

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
            connectSrc: [
                "'self'",
                env.FRONTEND_URL,
                ...env.ALLOWED_ORIGINS,
                ...(env.IS_PRODUCTION ? [] : ["http://localhost:5000", "ws://localhost:5000"]),
            ],
        }
    }
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(cors({
    origin: (origin, cb) => {
        const allowed = [
            env.FRONTEND_URL,
            ...(env.IS_PRODUCTION ? [] : ['http://localhost:3000', 'http://localhost:4173']),
            ...env.ALLOWED_ORIGINS,
        ];
        if (!origin || allowed.includes(origin)) return cb(null, true);
        cb(new Error('CORS blocked'));
    },
    credentials: true,
    // Idempotency-Key (request) is allowed by reflection; expose the replay marker to the browser.
    exposedHeaders: ['Idempotent-Replayed', 'Retry-After'],
}));

app.use(morgan('[:method] :url :status :response-time ms'));

// ── 2. Rate Limiters ──────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max:      env.API_RATE_LIMIT_MAX,
    message:  { success: false, error: 'Too many requests, slow down!' },
});

const backtestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max:      env.BACKTEST_RATE_LIMIT_MAX,
    message:  { success: false, error: 'Too many backtest requests' },
});

// Backtest has its own limiter
app.use('/api/backtest', backtestLimiter);
// Global limiter for everything else
app.use('/api/', (req, res, next) => {
    if (req.path.startsWith('/backtest')) return next();
    apiLimiter(req, res, next);
});

// ── 2.5. Disable API cache ────────────────────────────────
app.use('/api/', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── 3. API Routes ─────────────────────────────────────────
app.use('/api/signals',   require('./routes/signals.routes'));
app.use('/api/market',    require('./routes/market.routes'));
app.use('/api/alerts',    require('./routes/alerts.routes'));
app.use('/api/auth',      require('./routes/auth.routes'));
app.use('/api/prices',    require('./routes/prices.routes'));
app.use('/api/exchanges',   require('./routes/exchanges.routes'));
app.use('/api/backtest',  require('./routes/backtest.routes'));
app.use('/api/auto-trade', require('./routes/auto_trade.routes'));
app.use('/api/portfolio', require('./routes/portfolio.routes'));
app.use('/api/risk',      require('./routes/risk.routes'));
app.use('/api/settings',  require('./routes/settings.routes'));
app.use('/api/watchlist', require('./routes/watchlist.routes'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/trading',   require('./routes/trading.routes'));
app.use('/api/screener',  require('./routes/screener.routes'));
app.use('/api/security', require('./routes/security.routes'));
app.use('/api/symbols', require('./routes/symbols.routes'));
app.use('/api/admin',   require('./routes/admin.routes'));

// ── 4. Health Check ───────────────────────────────────────
app.get('/api/health', require('./utils/health').healthHandler);

// ── 5. Catch-all ──────────────────────────────────────────
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` });
    }
    res.status(404).json({ success: false, error: 'Use React frontend on port 3000' });
});

// ── 6. Global Error Handler ───────────────────────────────
app.use((err, req, res, next) => {
    const status = err.status || 500;
    logger.error(`[app] Error: ${err.message}`);
    // Don't leak internals (SQL errors, stack hints...) on 5xx in production.
    const message = status >= 500 && env.IS_PRODUCTION ? 'Internal server error' : err.message;
    res.status(status).json({ success: false, error: message });
});

// ── 7. Server Start ───────────────────────────────────────
const server = app.listen(env.PORT, async () => {
    logger.info('═'.repeat(55));
    logger.info(' AtlasQuant AI — Backend API Online');
    logger.info(` Port: ${env.PORT} | Environment: ${env.NODE_ENV}`);

    try {
        await db.query('SELECT NOW()');
        logger.info(' Database: ✅ Connected (PostgreSQL)');

        // Cron jobs/queries must not start before the schema is ready.
        await db.ready;

        // Kill switch: load the persistent shared state BEFORE any job or socket can place an order.
        const killSwitch = require('./utils/killSwitch');
        await killSwitch.init();
        killSwitch.startSync();

        initCronJobs();
        logger.info(' Cron Engine: ✅ Initialized & Active');

        // ✅ Fix — one shared 'upgrade' router instead of two competing
        // `new WebSocketServer({ server, path })` (see ws/upgradeRouter.js).
        const marketUpgrade    = startMarketSocket();
        const dashboardUpgrade = startDashboardSocket();
        attachUpgradeRouter(server, {
          '/ws/market':    marketUpgrade,
          '/ws/dashboard': dashboardUpgrade,
        });

    } catch (err) {
        logger.error(' Initialization Failed:', err.message);
    }

    logger.info('═'.repeat(55));
});

server.timeout = 120000;

module.exports = app;