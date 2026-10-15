-- AtlasQuant AI — database schema snapshot (PostgreSQL 16)
--
-- GENERATED with: pg_dump --schema-only --no-owner --no-privileges
-- from a database created by the app itself.
--
-- backend/src/config/db.js (migrate()) is the SOURCE OF TRUTH: it runs at every
-- backend start and is idempotent, so you normally never need this file.
-- Use it for reference/review, or to bootstrap a DB by hand:
--     psql -U postgres -d atlasquant -f database/schema.sql
-- Re-generate it after changing migrate().

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$;




--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id integer NOT NULL,
    user_id integer NOT NULL,
    cash_balance numeric(20,2) DEFAULT 10000 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.accounts_id_seq OWNED BY public.accounts.id;


--
-- Name: alert_digest_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_digest_queue (
    id integer NOT NULL,
    user_id integer NOT NULL,
    alert_id integer,
    symbol text NOT NULL,
    type text,
    condition text,
    target numeric,
    current_price numeric,
    triggered_at timestamp with time zone DEFAULT now() NOT NULL,
    sent boolean DEFAULT false NOT NULL
);


--
-- Name: alert_digest_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_digest_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_digest_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_digest_queue_id_seq OWNED BY public.alert_digest_queue.id;


--
-- Name: alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alerts (
    id integer NOT NULL,
    user_id integer,
    symbol text NOT NULL,
    type text NOT NULL,
    condition text DEFAULT 'above'::text NOT NULL,
    target numeric NOT NULL,
    triggered boolean DEFAULT false,
    paused boolean DEFAULT false,
    triggered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    notify_email boolean DEFAULT true,
    notify_telegram boolean DEFAULT false,
    metadata jsonb,
    read boolean DEFAULT false,
    paused_until timestamp with time zone,
    email_frequency character varying(10) DEFAULT 'instant'::character varying NOT NULL,
    CONSTRAINT alerts_email_frequency_check CHECK (((email_frequency)::text = ANY ((ARRAY['instant'::character varying, 'digest'::character varying])::text[])))
);


--
-- Name: alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alerts_id_seq OWNED BY public.alerts.id;


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    scopes jsonb DEFAULT '["read"]'::jsonb NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id integer NOT NULL,
    user_id integer,
    event_type text NOT NULL,
    ip_address text,
    user_agent text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: auto_trade_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auto_trade_configs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    symbol text NOT NULL,
    strategy_id text NOT NULL,
    params_hash text NOT NULL,
    exchange_id character varying(32) NOT NULL,
    backtest_id integer,
    status character varying(20) DEFAULT 'backtest_required'::character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    probation_trades_required integer DEFAULT 5 NOT NULL,
    probation_trades_completed integer DEFAULT 0 NOT NULL,
    probation_wins integer DEFAULT 0 NOT NULL,
    probation_pnl numeric(20,8) DEFAULT 0 NOT NULL,
    max_position_size numeric(20,8),
    max_daily_loss_pct numeric,
    max_open_positions integer DEFAULT 1 NOT NULL,
    last_evaluated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_signal_at timestamp with time zone,
    CONSTRAINT auto_trade_configs_status_check CHECK (((status)::text = ANY ((ARRAY['disabled'::character varying, 'backtest_required'::character varying, 'backtest_expired'::character varying, 'backtest_rejected'::character varying, 'probation'::character varying, 'live'::character varying, 'blocked'::character varying])::text[])))
);


--
-- Name: auto_trade_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auto_trade_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auto_trade_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auto_trade_configs_id_seq OWNED BY public.auto_trade_configs.id;


--
-- Name: backtest_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backtest_configs (
    id integer NOT NULL,
    user_id integer,
    name text NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: backtest_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.backtest_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: backtest_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.backtest_configs_id_seq OWNED BY public.backtest_configs.id;


--
-- Name: backtest_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backtest_history (
    id integer NOT NULL,
    user_id integer,
    symbol text NOT NULL,
    strategy text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    params jsonb,
    params_hash text,
    start_date date,
    end_date date,
    expires_at timestamp with time zone,
    total_trades integer,
    expectancy numeric,
    sharpe numeric,
    gate_eligible boolean DEFAULT false NOT NULL,
    strategy_id text
);


--
-- Name: backtest_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.backtest_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: backtest_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.backtest_history_id_seq OWNED BY public.backtest_history.id;


--
-- Name: live_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.live_orders (
    id integer NOT NULL,
    user_id integer NOT NULL,
    exchange_id character varying(32) NOT NULL,
    exchange_order_id character varying(100),
    symbol character varying(30) NOT NULL,
    side character varying(10) NOT NULL,
    order_type character varying(10) NOT NULL,
    quantity numeric(20,8) NOT NULL,
    price numeric(20,8),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    raw_response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stop_loss numeric(20,8),
    take_profit numeric(20,8),
    signal_id integer,
    filled_qty numeric(28,10),
    avg_price numeric(28,10),
    fee_cost numeric(28,10),
    fee_currency character varying(20),
    exchange_status character varying(30),
    fill_final boolean DEFAULT false NOT NULL,
    reconciled_at timestamp with time zone,
    reconcile_attempts integer DEFAULT 0 NOT NULL
);


--
-- Name: live_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.live_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: live_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.live_orders_id_seq OWNED BY public.live_orders.id;


--
-- Name: paper_trades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.paper_trades (
    id integer NOT NULL,
    user_id integer NOT NULL,
    exchange_id character varying(32) NOT NULL,
    symbol character varying(30) NOT NULL,
    side character varying(10) NOT NULL,
    order_type character varying(10) NOT NULL,
    quantity numeric(20,8) NOT NULL,
    price numeric(20,8) NOT NULL,
    limit_price numeric(20,8),
    status character varying(10) DEFAULT 'open'::character varying NOT NULL,
    pnl numeric(20,8),
    pnl_pct numeric(10,4),
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    auto_trade_config_id integer,
    backtest_id integer,
    stop_loss numeric(20,8),
    take_profit numeric(20,8),
    exit_price numeric(20,8),
    close_reason text,
    signal_id integer,
    CONSTRAINT paper_trades_order_type_check CHECK (((order_type)::text = ANY ((ARRAY['market'::character varying, 'limit'::character varying])::text[]))),
    CONSTRAINT paper_trades_side_check CHECK (((side)::text = ANY ((ARRAY['buy'::character varying, 'sell'::character varying])::text[]))),
    CONSTRAINT paper_trades_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'closed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: paper_trades_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.paper_trades_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: paper_trades_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.paper_trades_id_seq OWNED BY public.paper_trades.id;


--
-- Name: portfolio; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolio (
    id integer NOT NULL,
    user_id integer NOT NULL,
    symbol character varying(20) NOT NULL,
    side character varying(10) DEFAULT 'long'::character varying NOT NULL,
    amount numeric(20,8) NOT NULL,
    average_entry numeric(20,8) NOT NULL,
    current_price numeric(20,8) DEFAULT 0 NOT NULL,
    sector character varying(50) DEFAULT 'Other'::character varying,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: portfolio_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portfolio_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portfolio_id_seq OWNED BY public.portfolio.id;


--
-- Name: portfolio_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolio_snapshots (
    id integer NOT NULL,
    user_id integer NOT NULL,
    snapshot_date date NOT NULL,
    total_value numeric(20,2) NOT NULL
);


--
-- Name: portfolio_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portfolio_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portfolio_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portfolio_snapshots_id_seq OWNED BY public.portfolio_snapshots.id;


--
-- Name: screener_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.screener_presets (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name character varying(100) NOT NULL,
    asset_type character varying(20) DEFAULT 'crypto'::character varying NOT NULL,
    filters jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: screener_presets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.screener_presets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: screener_presets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.screener_presets_id_seq OWNED BY public.screener_presets.id;


--
-- Name: signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signals (
    id integer NOT NULL,
    symbol text NOT NULL,
    "interval" text NOT NULL,
    signal text NOT NULL,
    confidence integer,
    price numeric,
    entry numeric,
    stop_loss numeric,
    take_profit numeric,
    risk_reward text,
    reasoning text,
    indicators jsonb,
    created_at timestamp with time zone DEFAULT now(),
    asset_class text DEFAULT 'Crypto'::text NOT NULL,
    outcome text,
    closed_at timestamp with time zone,
    exit_price numeric,
    pnl_pct numeric
);


--
-- Name: signals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.signals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: signals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.signals_id_seq OWNED BY public.signals.id;


--
-- Name: trades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trades (
    id integer NOT NULL,
    user_id integer,
    symbol text NOT NULL,
    side text NOT NULL,
    entry_price numeric NOT NULL,
    exit_price numeric,
    quantity numeric NOT NULL,
    pnl numeric,
    pnl_pct numeric,
    status text DEFAULT 'open'::text,
    paper boolean DEFAULT true,
    opened_at timestamp with time zone DEFAULT now(),
    closed_at timestamp with time zone
);


--
-- Name: trades_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trades_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trades_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trades_id_seq OWNED BY public.trades.id;


--
-- Name: user_exchange_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_exchange_connections (
    id integer NOT NULL,
    user_id integer NOT NULL,
    exchange_id character varying(32) NOT NULL,
    api_key_enc text NOT NULL,
    api_secret_enc text NOT NULL,
    passphrase_enc text,
    mode character varying(10) DEFAULT 'readonly'::character varying NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_sync_at timestamp with time zone,
    health_status character varying(10) DEFAULT 'unknown'::character varying NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    last_health_check timestamp with time zone,
    CONSTRAINT uec_health_status_check CHECK (((health_status)::text = ANY ((ARRAY['ok'::character varying, 'degraded'::character varying, 'failed'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT user_exchange_connections_mode_check CHECK (((mode)::text = ANY ((ARRAY['readonly'::character varying, 'paper'::character varying, 'live'::character varying])::text[])))
);


--
-- Name: user_exchange_connections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_exchange_connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_exchange_connections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_exchange_connections_id_seq OWNED BY public.user_exchange_connections.id;


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer NOT NULL,
    refresh_hash text NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_settings (
    user_id integer NOT NULL,
    theme text DEFAULT 'dark'::text,
    notifications jsonb DEFAULT '{"push_alerts": true, "email_alerts": true, "price_alerts": true}'::jsonb,
    api_keys_enabled boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now(),
    signal_alert_mode character varying(10) DEFAULT 'all'::character varying NOT NULL,
    signal_alert_symbols jsonb DEFAULT '[]'::jsonb NOT NULL,
    signal_alert_min_confidence integer DEFAULT 75 NOT NULL,
    language text DEFAULT 'en'::text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    currency character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    webhook_url text,
    webhook_enabled boolean DEFAULT false NOT NULL,
    risk_max_daily_loss_pct numeric DEFAULT 5 NOT NULL,
    risk_max_position_pct numeric DEFAULT 20 NOT NULL,
    risk_default_stoploss_pct numeric DEFAULT 2 NOT NULL,
    quiet_hours_enabled boolean DEFAULT false NOT NULL,
    quiet_hours_start character varying(5) DEFAULT '23:00'::character varying NOT NULL,
    quiet_hours_end character varying(5) DEFAULT '07:00'::character varying NOT NULL,
    telegram_chat_id text,
    telegram_enabled boolean DEFAULT false NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email text NOT NULL,
    password text NOT NULL,
    name text,
    plan text DEFAULT 'free'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    twofa_secret text,
    twofa_enabled boolean DEFAULT false NOT NULL,
    twofa_backup_codes jsonb DEFAULT '[]'::jsonb,
    email_verified boolean DEFAULT false NOT NULL,
    email_verification_token text,
    email_verification_sent_at timestamp with time zone
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: watchlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watchlist (
    id integer NOT NULL,
    user_id integer,
    symbol text NOT NULL,
    added_at timestamp with time zone DEFAULT now()
);


--
-- Name: watchlist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.watchlist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: watchlist_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.watchlist_id_seq OWNED BY public.watchlist.id;


--
-- Name: accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);


--
-- Name: alert_digest_queue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_digest_queue ALTER COLUMN id SET DEFAULT nextval('public.alert_digest_queue_id_seq'::regclass);


--
-- Name: alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts ALTER COLUMN id SET DEFAULT nextval('public.alerts_id_seq'::regclass);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: auto_trade_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_trade_configs ALTER COLUMN id SET DEFAULT nextval('public.auto_trade_configs_id_seq'::regclass);


--
-- Name: backtest_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_configs ALTER COLUMN id SET DEFAULT nextval('public.backtest_configs_id_seq'::regclass);


--
-- Name: backtest_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_history ALTER COLUMN id SET DEFAULT nextval('public.backtest_history_id_seq'::regclass);


--
-- Name: live_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_orders ALTER COLUMN id SET DEFAULT nextval('public.live_orders_id_seq'::regclass);


--
-- Name: paper_trades id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_trades ALTER COLUMN id SET DEFAULT nextval('public.paper_trades_id_seq'::regclass);


--
-- Name: portfolio id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio ALTER COLUMN id SET DEFAULT nextval('public.portfolio_id_seq'::regclass);


--
-- Name: portfolio_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_snapshots ALTER COLUMN id SET DEFAULT nextval('public.portfolio_snapshots_id_seq'::regclass);


--
-- Name: screener_presets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screener_presets ALTER COLUMN id SET DEFAULT nextval('public.screener_presets_id_seq'::regclass);


--
-- Name: signals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signals ALTER COLUMN id SET DEFAULT nextval('public.signals_id_seq'::regclass);


--
-- Name: trades id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades ALTER COLUMN id SET DEFAULT nextval('public.trades_id_seq'::regclass);


--
-- Name: user_exchange_connections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_exchange_connections ALTER COLUMN id SET DEFAULT nextval('public.user_exchange_connections_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: watchlist id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchlist ALTER COLUMN id SET DEFAULT nextval('public.watchlist_id_seq'::regclass);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_key UNIQUE (user_id);


--
-- Name: alert_digest_queue alert_digest_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_digest_queue
    ADD CONSTRAINT alert_digest_queue_pkey PRIMARY KEY (id);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: auto_trade_configs auto_trade_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_trade_configs
    ADD CONSTRAINT auto_trade_configs_pkey PRIMARY KEY (id);


--
-- Name: auto_trade_configs auto_trade_configs_user_id_symbol_strategy_id_params_hash_e_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_trade_configs
    ADD CONSTRAINT auto_trade_configs_user_id_symbol_strategy_id_params_hash_e_key UNIQUE (user_id, symbol, strategy_id, params_hash, exchange_id);


--
-- Name: backtest_configs backtest_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_configs
    ADD CONSTRAINT backtest_configs_pkey PRIMARY KEY (id);


--
-- Name: backtest_history backtest_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_history
    ADD CONSTRAINT backtest_history_pkey PRIMARY KEY (id);


--
-- Name: live_orders live_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_orders
    ADD CONSTRAINT live_orders_pkey PRIMARY KEY (id);


--
-- Name: paper_trades paper_trades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_trades
    ADD CONSTRAINT paper_trades_pkey PRIMARY KEY (id);


--
-- Name: portfolio portfolio_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio
    ADD CONSTRAINT portfolio_pkey PRIMARY KEY (id);


--
-- Name: portfolio_snapshots portfolio_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_snapshots
    ADD CONSTRAINT portfolio_snapshots_pkey PRIMARY KEY (id);


--
-- Name: portfolio_snapshots portfolio_snapshots_user_id_snapshot_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_snapshots
    ADD CONSTRAINT portfolio_snapshots_user_id_snapshot_date_key UNIQUE (user_id, snapshot_date);


--
-- Name: portfolio portfolio_user_id_symbol_side_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio
    ADD CONSTRAINT portfolio_user_id_symbol_side_key UNIQUE (user_id, symbol, side);


--
-- Name: screener_presets screener_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screener_presets
    ADD CONSTRAINT screener_presets_pkey PRIMARY KEY (id);


--
-- Name: signals signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signals
    ADD CONSTRAINT signals_pkey PRIMARY KEY (id);


--
-- Name: trades trades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_pkey PRIMARY KEY (id);


--
-- Name: user_exchange_connections uq_user_exchange; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_exchange_connections
    ADD CONSTRAINT uq_user_exchange UNIQUE (user_id, exchange_id);


--
-- Name: user_exchange_connections user_exchange_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_exchange_connections
    ADD CONSTRAINT user_exchange_connections_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: watchlist watchlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchlist
    ADD CONSTRAINT watchlist_pkey PRIMARY KEY (id);


--
-- Name: watchlist watchlist_user_id_symbol_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchlist
    ADD CONSTRAINT watchlist_user_id_symbol_key UNIQUE (user_id, symbol);


--
-- Name: idx_apikeys_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_apikeys_user ON public.api_keys USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_atc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_atc_status ON public.auto_trade_configs USING btree (status) WHERE (enabled = true);


--
-- Name: idx_atc_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_atc_user ON public.auto_trade_configs USING btree (user_id);


--
-- Name: idx_audit_log_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_user ON public.audit_log USING btree (user_id, created_at DESC);


--
-- Name: idx_audit_login_fail; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_login_fail ON public.audit_log USING btree (((metadata ->> 'email'::text)), created_at DESC) WHERE (event_type = ANY (ARRAY['login_failed'::text, 'login_2fa_failed'::text]));


--
-- Name: idx_backtest_configs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_backtest_configs_user ON public.backtest_configs USING btree (user_id);


--
-- Name: idx_backtest_gate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_backtest_gate ON public.backtest_history USING btree (user_id, symbol, strategy_id, params_hash, expires_at DESC) WHERE (gate_eligible = true);


--
-- Name: idx_backtest_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_backtest_user ON public.backtest_history USING btree (user_id);


--
-- Name: idx_digest_queue_unsent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digest_queue_unsent ON public.alert_digest_queue USING btree (user_id) WHERE (sent = false);


--
-- Name: idx_live_orders_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_live_orders_pending ON public.live_orders USING btree (created_at) WHERE ((fill_final = false) AND (exchange_order_id IS NOT NULL));


--
-- Name: idx_live_orders_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_live_orders_user ON public.live_orders USING btree (user_id);


--
-- Name: idx_paper_trades_signal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paper_trades_signal ON public.paper_trades USING btree (signal_id) WHERE (signal_id IS NOT NULL);


--
-- Name: idx_paper_trades_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paper_trades_status ON public.paper_trades USING btree (user_id, status);


--
-- Name: idx_paper_trades_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paper_trades_user ON public.paper_trades USING btree (user_id);


--
-- Name: idx_portfolio_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portfolio_user ON public.portfolio USING btree (user_id);


--
-- Name: idx_screener_presets_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_screener_presets_user ON public.screener_presets USING btree (user_id);


--
-- Name: idx_sessions_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_hash ON public.user_sessions USING btree (refresh_hash);


--
-- Name: idx_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_user ON public.user_sessions USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_signals_asset_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_signals_asset_class ON public.signals USING btree (asset_class);


--
-- Name: idx_signals_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_signals_created ON public.signals USING btree (created_at DESC);


--
-- Name: idx_signals_created_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_signals_created_class ON public.signals USING btree (created_at DESC, asset_class);


--
-- Name: idx_signals_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_signals_open ON public.signals USING btree (created_at) WHERE ((outcome IS NULL) AND (signal = ANY (ARRAY['BUY'::text, 'SELL'::text])));


--
-- Name: idx_signals_symbol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_signals_symbol ON public.signals USING btree (symbol);


--
-- Name: idx_signals_trades; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_signals_trades ON public.signals USING btree (created_at) WHERE (signal = ANY (ARRAY['BUY'::text, 'SELL'::text]));


--
-- Name: idx_snapshots_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_snapshots_user_date ON public.portfolio_snapshots USING btree (user_id, snapshot_date DESC);


--
-- Name: idx_uec_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uec_user_id ON public.user_exchange_connections USING btree (user_id);


--
-- Name: accounts trg_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: auto_trade_configs trg_atc_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_atc_updated_at BEFORE UPDATE ON public.auto_trade_configs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: live_orders trg_live_orders_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_live_orders_updated_at BEFORE UPDATE ON public.live_orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: portfolio trg_portfolio_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_portfolio_updated_at BEFORE UPDATE ON public.portfolio FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: accounts accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: alert_digest_queue alert_digest_queue_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_digest_queue
    ADD CONSTRAINT alert_digest_queue_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES public.alerts(id) ON DELETE SET NULL;


--
-- Name: alert_digest_queue alert_digest_queue_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_digest_queue
    ADD CONSTRAINT alert_digest_queue_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: alerts alerts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: auto_trade_configs auto_trade_configs_backtest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_trade_configs
    ADD CONSTRAINT auto_trade_configs_backtest_id_fkey FOREIGN KEY (backtest_id) REFERENCES public.backtest_history(id) ON DELETE SET NULL;


--
-- Name: auto_trade_configs auto_trade_configs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_trade_configs
    ADD CONSTRAINT auto_trade_configs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: backtest_configs backtest_configs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_configs
    ADD CONSTRAINT backtest_configs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: backtest_history backtest_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_history
    ADD CONSTRAINT backtest_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: live_orders live_orders_signal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_orders
    ADD CONSTRAINT live_orders_signal_id_fkey FOREIGN KEY (signal_id) REFERENCES public.signals(id) ON DELETE SET NULL;


--
-- Name: live_orders live_orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_orders
    ADD CONSTRAINT live_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: paper_trades paper_trades_auto_trade_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_trades
    ADD CONSTRAINT paper_trades_auto_trade_config_id_fkey FOREIGN KEY (auto_trade_config_id) REFERENCES public.auto_trade_configs(id) ON DELETE SET NULL;


--
-- Name: paper_trades paper_trades_backtest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_trades
    ADD CONSTRAINT paper_trades_backtest_id_fkey FOREIGN KEY (backtest_id) REFERENCES public.backtest_history(id) ON DELETE SET NULL;


--
-- Name: paper_trades paper_trades_signal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_trades
    ADD CONSTRAINT paper_trades_signal_id_fkey FOREIGN KEY (signal_id) REFERENCES public.signals(id) ON DELETE SET NULL;


--
-- Name: paper_trades paper_trades_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_trades
    ADD CONSTRAINT paper_trades_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: portfolio_snapshots portfolio_snapshots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_snapshots
    ADD CONSTRAINT portfolio_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: portfolio portfolio_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio
    ADD CONSTRAINT portfolio_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: screener_presets screener_presets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screener_presets
    ADD CONSTRAINT screener_presets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: trades trades_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_exchange_connections user_exchange_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_exchange_connections
    ADD CONSTRAINT user_exchange_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_settings user_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: watchlist watchlist_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchlist
    ADD CONSTRAINT watchlist_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


