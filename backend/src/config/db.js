/**
 * config/db.js — AtlasQuant AI · PostgreSQL
 * Supporte deux formats de connexion :
 *   - DATABASE_URL complet  (Supabase, Railway, Render)
 *   - Variables séparées    (local dev)
 */

const { Pool } = require('pg');
const logger   = require('../utils/logger');

// ── Validation avant connexion ────────────────────────────
function buildPoolConfig() {
  const url = process.env.DATABASE_URL;

  // Format 1 : DATABASE_URL complet
  if (url && url.startsWith('postgres')) {
    return {
      connectionString: url,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
    };
  }

  // Format 2 : variables séparées
  const host     = process.env.DB_HOST     || 'localhost';
  const port     = process.env.DB_PORT     || 5432;
  const database = process.env.DB_NAME     || 'atlasquant';
  const user     = process.env.DB_USER     || 'postgres';
  const password = process.env.DB_PASSWORD;

  if (!password) {
    logger.error('[db] ❌ DB_PASSWORD manquant dans .env');
    logger.error('[db] Ajoute dans ton .env :');
    logger.error('[db]   DATABASE_URL=postgresql://postgres:TON_MOT_DE_PASSE@localhost:5432/atlasquant');
    logger.error('[db]   OU');
    logger.error('[db]   DB_HOST=localhost');
    logger.error('[db]   DB_PORT=5432');
    logger.error('[db]   DB_NAME=atlasquant');
    logger.error('[db]   DB_USER=postgres');
    logger.error('[db]   DB_PASSWORD=TON_MOT_DE_PASSE');
    process.exit(1);
  }

  return { host, port: Number(port), database, user, password: String(password) };
}

// ── Créer le pool ─────────────────────────────────────────
const pool = new Pool({
  ...buildPoolConfig(),
  max:                     10,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => logger.error(`[db] Pool error: ${err.message}`));

// ── Helpers ───────────────────────────────────────────────
async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    logger.error(`[db] Query error: ${err.message}`);
    throw err;
  }
}

async function getClient() {
  return pool.connect();
}

// ── Migration auto ────────────────────────────────────────
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      email       TEXT   UNIQUE NOT NULL,
      password    TEXT   NOT NULL,
      name        TEXT,
      plan        TEXT   DEFAULT 'free',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS signals (
      id           SERIAL PRIMARY KEY,
      symbol       TEXT    NOT NULL,
      interval     TEXT    NOT NULL,
      signal       TEXT    NOT NULL,
      confidence   INTEGER,
      price        NUMERIC,
      entry        NUMERIC,
      stop_loss    NUMERIC,
      take_profit  NUMERIC,
      risk_reward  TEXT,
      reasoning    TEXT,
      indicators   JSONB,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_signals_symbol  ON signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);

    CREATE TABLE IF NOT EXISTS watchlist (
      id        SERIAL PRIMARY KEY,
      user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
      symbol    TEXT NOT NULL,
      added_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, symbol)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      symbol       TEXT    NOT NULL,
      type         TEXT    NOT NULL,
      target       NUMERIC NOT NULL,
      triggered    BOOLEAN DEFAULT FALSE,
      triggered_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS trades (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      symbol      TEXT    NOT NULL,
      side        TEXT    NOT NULL,
      entry_price NUMERIC NOT NULL,
      exit_price  NUMERIC,
      quantity    NUMERIC NOT NULL,
      pnl         NUMERIC,
      pnl_pct     NUMERIC,
      status      TEXT    DEFAULT 'open',
      paper       BOOLEAN DEFAULT TRUE,
      opened_at   TIMESTAMPTZ DEFAULT NOW(),
      closed_at   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS backtest_history (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      symbol      TEXT    NOT NULL,
      strategy    TEXT    NOT NULL,
      result      JSONB   NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_backtest_user ON backtest_history(user_id);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme             TEXT    DEFAULT 'dark',
      notifications     BOOLEAN DEFAULT TRUE,
      api_keys_enabled  BOOLEAN DEFAULT FALSE,
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  logger.info('[db] ✅ Tables PostgreSQL prêtes');
}

migrate().catch((err) => {
  logger.error(`[db] Migration failed: ${err.message}`);
  process.exit(1);
});

module.exports = { query, getClient, pool };