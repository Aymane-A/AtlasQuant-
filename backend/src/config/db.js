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

const pool = new Pool({
  ...buildPoolConfig(),
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
});

pool.on('error', (err) => logger.error(`[db] Pool error: ${err.message}`));

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
  // ✅ Fix: requis par gen_random_uuid() (user_sessions, api_keys) sur
  // PostgreSQL < 13 où gen_random_uuid() n'est pas native. Sans risque sur
  // les versions plus récentes — CREATE EXTENSION IF NOT EXISTS est idempotent.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

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

    -- Presets de configuration de backtest sauvegardés par l'utilisateur
    -- (universe, dates, stratégie, sizing...) — distinct de
    -- backtest_history qui stocke les RÉSULTATS d'un run déjà exécuté.
    -- Ici on stocke uniquement les paramètres d'entrée, pour pouvoir les
    -- recharger dans le formulaire sans ré-exécuter quoi que ce soit.
    CREATE TABLE IF NOT EXISTS backtest_configs (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      config      JSONB   NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_backtest_configs_user ON backtest_configs(user_id);
    
    -- ✅ Fix: 'notifications' créée directement en JSONB (au lieu de BOOLEAN).
    -- settings.controller.js y stocke un objet {email_alerts, push_alerts,
    -- price_alerts} depuis le début — BOOLEAN cassait toute écriture/lecture
    -- pour les installs neuves. Les installs existantes sont corrigées plus
    -- bas par la migration incrémentale ALTER COLUMN ... TYPE JSONB USING.
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme             TEXT    DEFAULT 'dark',
      notifications     JSONB   DEFAULT '{"email_alerts":true,"push_alerts":true,"price_alerts":true}'::jsonb,
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

    -- ✅ Feature: email digest queue — les alertes en mode 'digest' (email_frequency
    -- sur la table alerts) atterrissent ici au lieu de partir en email instant.
    -- Flushée 1x/jour par runDailyDigest() dans alertChecker.service.js.
    CREATE TABLE IF NOT EXISTS alert_digest_queue (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      alert_id      INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
      symbol        TEXT    NOT NULL,
      type          TEXT,
      condition     TEXT,
      target        NUMERIC,
      current_price NUMERIC,
      triggered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent          BOOLEAN     NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_digest_queue_unsent ON alert_digest_queue(user_id) WHERE sent = false;

    -- ── Sécurité: sessions & API keys ────────────────────────────────────────
    -- ✅ Fix: les CREATE INDEX qui filtrent sur revoked_at (WHERE revoked_at
    -- IS NULL) ont été retirés d'ici et déplacés tout en bas de migrate(),
    -- APRÈS les ALTER TABLE ADD COLUMN IF NOT EXISTS. Raison: si ces tables
    -- existaient déjà en base (run précédent avorté avant la fin du script),
    -- CREATE TABLE IF NOT EXISTS est un no-op et ne recrée pas revoked_at —
    -- créer l'index dans la même requête plantait alors avec "column
    -- revoked_at does not exist". Les colonnes sont maintenant garanties
    -- présentes par ALTER TABLE avant que l'index ne soit créé.
    CREATE TABLE IF NOT EXISTS user_sessions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refresh_hash  TEXT NOT NULL,           -- hash du refresh token, jamais le token en clair
      ip_address    TEXT,
      user_agent    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at    TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      key_prefix    TEXT NOT NULL,           -- ex: 'aq_live_8f2c' — affiché à l'user
      key_hash      TEXT NOT NULL,           -- sha256 de la clé complète, jamais stockée en clair
      scopes        JSONB NOT NULL DEFAULT '["read"]',  -- ['read','trade']
      last_used_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at    TIMESTAMPTZ
    );
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
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;

    -- ✅ Feature: mode d'envoi email par alerte — 'instant' (défaut, comportement
    -- actuel) ou 'digest' (accumulée dans alert_digest_queue, envoyée 1x/jour).
    -- CHECK plutôt que TEXT libre: évite qu'une valeur non gérée par
    -- alertChecker.service.js se glisse silencieusement dans la colonne.
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS email_frequency VARCHAR(10) NOT NULL DEFAULT 'instant';
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'alerts_email_frequency_check'
      ) THEN
        ALTER TABLE alerts ADD CONSTRAINT alerts_email_frequency_check
          CHECK (email_frequency IN ('instant','digest'));
      END IF;
    END $$;

    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signal_alert_mode    VARCHAR(10) NOT NULL DEFAULT 'all';
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signal_alert_symbols JSONB       NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS signal_alert_min_confidence INTEGER NOT NULL DEFAULT 75;

    ALTER TABLE signals ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'Crypto';
    -- ✅ Feature: health monitoring des connexions exchange — permet de
    -- détecter une clé API cassée/expirée AVANT qu'un ordre réel échoue,
    -- au lieu de le découvrir seulement au moment critique.
    ALTER TABLE user_exchange_connections ADD COLUMN IF NOT EXISTS health_status VARCHAR(10) NOT NULL DEFAULT 'unknown';
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uec_health_status_check'
      ) THEN
        ALTER TABLE user_exchange_connections ADD CONSTRAINT uec_health_status_check
          CHECK (health_status IN ('ok','degraded','failed','unknown'));
      END IF;
    END $$;
    ALTER TABLE user_exchange_connections ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE user_exchange_connections ADD COLUMN IF NOT EXISTS last_health_check TIMESTAMPTZ;

    -- migration: 2fa, sessions, api_keys
    ALTER TABLE users ADD COLUMN IF NOT EXISTS twofa_secret TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS twofa_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS twofa_backup_codes JSONB DEFAULT '[]';

    -- ✅ Fix: user_sessions/api_keys existaient déjà en base (créées par un
    -- run précédent qui avait crashé avant la fin du script), donc
    -- CREATE TABLE IF NOT EXISTS ne les complétait pas. On force chaque
    -- colonne attendue avec ADD COLUMN IF NOT EXISTS pour rendre la
    -- migration réellement idempotente peu importe l'état de départ.
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS refresh_hash TEXT;
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS ip_address   TEXT;
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS user_agent   TEXT;
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS last_active  TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS revoked_at   TIMESTAMPTZ;

    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name         TEXT;
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix   TEXT;
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash     TEXT;
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes       JSONB NOT NULL DEFAULT '["read"]';
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at   TIMESTAMPTZ;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

    -- ✅ Feature: devise d'affichage, webhook custom (Discord/Slack/générique),
    -- et paramètres de gestion du risque avancés (max daily loss, max
    -- position size, stop-loss par défaut). Voir settings.controller.js
    -- (sections 'locale', 'webhook', 'trading') pour la validation associée.
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS webhook_url TEXT;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS webhook_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS risk_max_daily_loss_pct NUMERIC NOT NULL DEFAULT 5;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS risk_max_position_pct NUMERIC NOT NULL DEFAULT 20;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS risk_default_stoploss_pct NUMERIC NOT NULL DEFAULT 2;

    -- Email verification
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_sent_at TIMESTAMPTZ;

    -- Quiet hours
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS quiet_hours_start VARCHAR(5) NOT NULL DEFAULT '23:00';
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS quiet_hours_end VARCHAR(5) NOT NULL DEFAULT '07:00';

    -- Telegram
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS telegram_enabled BOOLEAN NOT NULL DEFAULT false;

    -- Audit log
    CREATE TABLE IF NOT EXISTS audit_log (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      event_type  TEXT NOT NULL,
      ip_address  TEXT,
      user_agent  TEXT,
      metadata    JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at DESC);
  `);

  // ✅ Fix critique: 'notifications' était créée en BOOLEAN dans les
  // installations existantes, alors que settings.controller.js y écrit/lit
  // un objet JSON ({email_alerts, push_alerts, price_alerts}). Toute
  // installation antérieure à ce fix plante sur POST /settings/update
  // (section 'notifications') avec "invalid input syntax for type boolean".
  // On convertit la colonne en JSONB en préservant le sens de l'ancienne
  // valeur boolean, sans y toucher si la table est déjà à jour (idempotent).
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_settings' AND column_name = 'notifications' AND data_type = 'boolean'
      ) THEN
        ALTER TABLE user_settings ALTER COLUMN notifications DROP DEFAULT;
        ALTER TABLE user_settings ALTER COLUMN notifications TYPE JSONB USING
          CASE
            WHEN notifications IS TRUE  THEN '{"email_alerts":true,"push_alerts":true,"price_alerts":true}'::jsonb
            WHEN notifications IS FALSE THEN '{"email_alerts":false,"push_alerts":false,"price_alerts":false}'::jsonb
            ELSE '{"email_alerts":true,"push_alerts":true,"price_alerts":true}'::jsonb
          END;
        ALTER TABLE user_settings ALTER COLUMN notifications
          SET DEFAULT '{"email_alerts":true,"push_alerts":true,"price_alerts":true}'::jsonb;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_signals_asset_class ON signals(asset_class);
  `);

  // ✅ Fix: ces deux index doivent être créés APRÈS les ALTER TABLE ADD
  // COLUMN ci-dessus (voir commentaire sur user_sessions/api_keys plus
  // haut) — sinon "column revoked_at does not exist" sur une base où ces
  // tables existaient déjà sans cette colonne.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_apikeys_user   ON api_keys(user_id)     WHERE revoked_at IS NULL;
  `);

  logger.info('[db] ✅ Tables PostgreSQL prêtes');
}

migrate().catch((err) => {
  logger.error(`[db] Migration failed: ${err.message}`);
});

module.exports = { query, getClient, pool };