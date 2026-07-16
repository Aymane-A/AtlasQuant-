/**
 * config/db.js — AtlasQuant AI · PostgreSQL v2
 */

const { Pool } = require('pg');
const logger   = require('../utils/logger');

function buildPoolConfig() {
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith('postgres')) {
    return {
      connectionString: url,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    };
  }
  const host     = process.env.DB_HOST     || 'localhost';
  const port     = process.env.DB_PORT     || 5432;
  const database = process.env.DB_NAME     || 'atlasquant';
  const user     = process.env.DB_USER     || 'postgres';
  const password = process.env.DB_PASSWORD;
  if (!password) {
    logger.error('[db] ❌ DB_PASSWORD manquant dans .env');
    process.exit(1);
  }
  return { host, port: Number(port), database, user, password: String(password) };
}

// ✅ Fix pool exhaustion: max était à 10, ce qui suffisait à peine en usage normal
// mais se vidait rapidement dès que le cron (scan crypto + forex/commo/indices,
// checkAlerts toutes les minutes) tournait en même temps que le trafic frontend
// (polling analytics/alerts/settings). Résultat : "Connection terminated due to
// connection timeout" dès que les 10 connexions étaient toutes occupées plus de
// 5s. On augmente la taille du pool et on garde un timeout raisonnable.
//
// ⚠️ DB_POOL_MAX est configurable via .env car la limite dépend de l'hébergeur
// PostgreSQL (souvent bien plus basse sur les tiers gratuits : Render ~22,
// Supabase free ~60 partagées, Neon/Railway variable). Si tu déploies avec
// plusieurs instances de l'app, chaque instance a SON PROPRE pool — vérifie
// (instances × DB_POOL_MAX) contre le max_connections réel de ta base avant
// de passer en public/prod, sinon tu retrouveras le même timeout mais côté
// hébergeur cette fois.
const pool = new Pool({
  ...buildPoolConfig(),
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
});

pool.on('error', (err) => logger.error(`[db] Pool error: ${err.message}`));

// ── Monitoring léger : alerte si le pool approche de sa capacité max ──
setInterval(() => {
  const { totalCount, idleCount, waitingCount } = pool;
  if (waitingCount > 0) {
    logger.warn(`[db] Pool sous pression — total:${totalCount} idle:${idleCount} waiting:${waitingCount}`);
  }
}, 15000);

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    logger.error(`[db] Query error: ${err.message}`);
    throw err;
  }
}

async function getClient() { return pool.connect(); }

async function migrate() {
  await pool.query(`
    -- ── Core tables ───────────────────────────────────────────────────────────
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
      condition    TEXT    NOT NULL DEFAULT 'above',
      target       NUMERIC NOT NULL,
      triggered    BOOLEAN DEFAULT FALSE,
      paused       BOOLEAN DEFAULT FALSE,
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

    -- ── Portfolio ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS portfolio (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol        VARCHAR(20)    NOT NULL,
      side          VARCHAR(10)    NOT NULL DEFAULT 'long',
      amount        NUMERIC(20, 8) NOT NULL,
      average_entry NUMERIC(20, 8) NOT NULL,
      current_price NUMERIC(20, 8) NOT NULL DEFAULT 0,
      sector        VARCHAR(50)    DEFAULT 'Other',
      opened_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, symbol, side)
    );
    CREATE INDEX IF NOT EXISTS idx_portfolio_user ON portfolio(user_id);

    CREATE TABLE IF NOT EXISTS accounts (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      cash_balance  NUMERIC(20, 2) NOT NULL DEFAULT 10000,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_date DATE    NOT NULL,
      total_value   NUMERIC(20, 2) NOT NULL,
      UNIQUE(user_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_user_date
      ON portfolio_snapshots(user_id, snapshot_date DESC);

    -- ── Exchange connections ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS user_exchange_connections (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exchange_id    VARCHAR(32)  NOT NULL,
      api_key_enc    TEXT         NOT NULL,
      api_secret_enc TEXT         NOT NULL,
      passphrase_enc TEXT,
      mode           VARCHAR(10)  NOT NULL DEFAULT 'readonly'
                       CHECK (mode IN ('readonly','paper','live')),
      connected_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      last_sync_at   TIMESTAMPTZ,
      CONSTRAINT uq_user_exchange UNIQUE (user_id, exchange_id)
    );
    CREATE INDEX IF NOT EXISTS idx_uec_user_id ON user_exchange_connections(user_id);

    -- ── Paper trades ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS paper_trades (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exchange_id   VARCHAR(32)    NOT NULL,
      symbol        VARCHAR(30)    NOT NULL,
      side          VARCHAR(10)    NOT NULL CHECK (side IN ('buy','sell')),
      order_type    VARCHAR(10)    NOT NULL CHECK (order_type IN ('market','limit')),
      quantity      NUMERIC(20, 8) NOT NULL,
      price         NUMERIC(20, 8) NOT NULL,
      limit_price   NUMERIC(20, 8),
      status        VARCHAR(10)    NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','closed','cancelled')),
      pnl           NUMERIC(20, 8),
      pnl_pct       NUMERIC(10, 4),
      opened_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      closed_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_paper_trades_user   ON paper_trades(user_id);
    CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(user_id, status);

    -- ── Live orders log ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS live_orders (
      id                SERIAL PRIMARY KEY,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exchange_id       VARCHAR(32)    NOT NULL,
      exchange_order_id VARCHAR(100),
      symbol            VARCHAR(30)    NOT NULL,
      side              VARCHAR(10)    NOT NULL,
      order_type        VARCHAR(10)    NOT NULL,
      quantity          NUMERIC(20, 8) NOT NULL,
      price             NUMERIC(20, 8),
      status            VARCHAR(20)    NOT NULL DEFAULT 'pending',
      raw_response      JSONB,
      created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_live_orders_user ON live_orders(user_id);

    -- ── Screener presets ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS screener_presets (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        VARCHAR(100) NOT NULL,
      asset_type  VARCHAR(20)  NOT NULL DEFAULT 'crypto',
      filters     JSONB        NOT NULL,
      created_at  TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_screener_presets_user ON screener_presets(user_id);
  `);

  // ── Triggers ──────────────────────────────────────────────
  await pool.query(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$;
  `);

  for (const [trig, tbl] of [
    ['trg_portfolio_updated_at',   'portfolio'],
    ['trg_accounts_updated_at',    'accounts'],
    ['trg_live_orders_updated_at', 'live_orders'],
  ]) {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${trig}') THEN
          CREATE TRIGGER ${trig}
            BEFORE UPDATE ON ${tbl}
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        END IF;
      END $$;
    `);
  }

  // ── Incremental migrations ────────────────────────────────
  await pool.query(`
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS condition        TEXT    NOT NULL DEFAULT 'above';
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS paused          BOOLEAN DEFAULT FALSE;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notify_email    BOOLEAN DEFAULT TRUE;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notify_telegram BOOLEAN DEFAULT FALSE;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS metadata        JSONB;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT FALSE;

    -- ✅ Fix: TIMESTAMPTZ au lieu de TIMESTAMP — tout le reste du schéma
    -- (triggered_at, created_at, etc.) est en TIMESTAMPTZ. NOW() +
    -- make_interval(...) produit un timestamptz ; comparer paused_until <=
    -- NOW() avec une colonne TIMESTAMP réintroduirait le même type de bug
    -- de timezone déjà rencontré avec node-postgres sur les colonnes DATE.
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;

    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signal_alert_mode    VARCHAR(10) NOT NULL DEFAULT 'all';
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signal_alert_symbols JSONB       NOT NULL DEFAULT '[]'::jsonb;

    -- ✅ Feature: seuil de confiance minimum pour les alertes AI
    -- auto-générées. Séparé du reste des colonnes signal_alert_* pour
    -- rester cohérent avec la validation côté controller (clamp 50-95).
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signal_alert_min_confidence INTEGER NOT NULL DEFAULT 75;

    ALTER TABLE signals ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'Crypto';
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_signals_asset_class ON signals(asset_class);
  `);

  logger.info('[db] ✅ Tables PostgreSQL prêtes');
}

// ── Run migration — non-fatal ─────────────────────────────
migrate().catch((err) => {
  logger.error(`[db] Migration failed: ${err.message}`);
});

module.exports = { query, getClient, pool };