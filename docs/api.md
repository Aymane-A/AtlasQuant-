# AtlasQuant AI — API reference

Base URL: `/api` (backend, default port 5000). All responses are JSON with `success: true|false`.
In production, 5xx errors return `{ success:false, error:"Internal server error", requestId }`;
the details stay in the server logs.

## Authentication

Protected routes (`🔒`) accept the session in two ways:

- **HttpOnly cookie `aq_session`** (what the web app uses). `POST /auth/login`, `/auth/register` and `/auth/refresh` set it and
  return `{ csrfToken }` — the JWT itself is **not** in the JSON body. Because browsers send cookies automatically, every
  non-`GET`/`HEAD`/`OPTIONS` request authenticated by the cookie must carry `X-CSRF-Token: <csrfToken>` (HMAC bound to that session;
  `GET /auth/me` returns a fresh one after a page reload) → otherwise `403 CSRF_INVALID`; a foreign `Origin` → `403 CSRF_ORIGIN`.
  `POST /auth/logout` revokes the session and clears the cookie. Cookie settings: `COOKIE_SAMESITE`, `COOKIE_SECURE`, `COOKIE_DOMAIN`.
- **`Authorization: Bearer <token>`** (no CSRF needed — not ambient). Used by API keys and by legacy JWTs issued before the cookie
  migration: sending one to `POST /auth/refresh` exchanges it for a cookie session and revokes the old token.

Two kinds of token are accepted:

| Token | How to get it | What it can do |
|---|---|---|
| **JWT** | `POST /auth/login` | Everything the user can do. Rejected if its session was revoked. |
| **API key** (`aq_live_…`) | Settings → API Keys (`POST /security/api-keys`) | **Read-only**: `GET`/`HEAD` only. Never `/security`, `/settings`, `/exchanges`, `/auth`. |

API-key errors: `403 API_KEY_READ_ONLY` (non-GET), `403 API_KEY_FORBIDDEN` (blocked path),
`400 API_KEY_SCOPE_UNSUPPORTED` (creating a `trade` key — not supported yet).
The raw key is shown once at creation; only its SHA-256 is stored.

### Login with 2FA

`POST /auth/login { email, password }` → if the account has 2FA enabled and no code was sent:

```json
{ "success": true, "requires2FA": true, "message": "Code 2FA requis" }
```

No token is issued yet. Call login again with the same credentials plus `totp` (6 digits)
**or** `backupCode` (one-time). Repeated failures (password or code) lock the email for 15 minutes (`429`).
TOTP secrets are encrypted at rest (AES-256-GCM, `EXCHANGE_ENCRYPTION_KEY`).

## Endpoints

### Auth — `/auth`
`POST /register` · `POST /login` · `POST /refresh` · 🔒 `GET /me` · 🔒 `POST /logout`

`POST /auth/ws-ticket` (🔒, JWT only) → `{ticket, expiresInMs: 30000}`. Single-use opaque ticket for `/ws/dashboard?ticket=…&range=30`;
the JWT is never accepted in the WebSocket URL. In-memory (single backend instance).

### Health & operations
`GET /health` → `{status: ok|degraded|down, timestamp, db, cron, killSwitch, paperTrading}` (503 only if the DB is down).
`GET|POST /admin/kill-switch` (header `X-Admin-Key`; 404 if `ADMIN_KEY` unset) → `{engaged, reason, since}`;
POST body `{enabled: boolean, reason?: string}`. While engaged, `POST /trading/order` and the auto-trader refuse with 503 `TRADING_DISABLED`.

### Security — `/security` (🔒, JWT only)
`GET /2fa/status` · `POST /2fa/setup` · `POST /2fa/verify` · `POST /2fa/disable` ·
`GET /sessions` · `DELETE /sessions/:id` · `DELETE /sessions` ·
`GET /api-keys` · `POST /api-keys` · `DELETE /api-keys/:id`

### Settings — `/settings` (🔒, JWT only)
`GET /` · `POST /update` (`section`: profile, notifications, trading, appearance, signalAlerts, locale, webhook, telegram, quietHours) · `POST /password` ·
`GET /export` · `DELETE /account` · `POST /webhook/test` · `POST /telegram/test` ·
`POST /email/resend-verification` · `POST /email/verify` (public) · `GET /audit-log`

Risk settings (section `trading`): `max_daily_loss_pct`, `max_position_pct`, `default_stoploss_pct`,
`max_total_exposure_pct` (0 = off, default 100).

### Prices & market
- `GET /prices/stocks?symbols=AAPL,MSFT` — public, rate-limited, restricted to `PRICES_ALLOWED_SYMBOLS`
  (default: 9 large caps). Quotes may carry `isStale` / `isDemo` (demo only when `PRICES_DEMO_MODE=true`).
- `GET /market/prices`, `/market/forex/prices`, `/market/commodities/prices`, `/market/:symbol/stats`,
  `/market/:symbol/candles`, `/market/economic-calendar`, `/market/news`

### Signals — `/signals`
`GET /` (`?refresh=true` needs 🔒) · `GET /meta/supported` · `GET /alpha/engine-data` · `GET /analytics` ·
🔒 `GET /analytics/mine` · `GET /:symbol` · 🔒 `GET /scan-status/:jobId`

### Alerts — `/alerts` (🔒)
`GET /` · `GET /history` · `POST /` · `PATCH /:id` · `DELETE /:id` · `PATCH /:id/pause|snooze|reset|read|email-frequency` ·
`PATCH /read-all` · `DELETE /triggered/all`

Telegram alerts go to **the chat the user linked in Settings** (`telegram_chat_id`, with Telegram enabled),
never to a server-wide chat.

### Portfolio — `/portfolio` (🔒)
`GET /data` · `POST /position` · `POST /position/:symbol/:side/reduce` · `DELETE /position/:symbol/:side` ·
`GET /history` · `PATCH /cash` · `POST /analyze`.
`GET /data` → `_meta.stale` lists symbols priced from stale cache (24h change = 0), `_meta.demo` those priced by demo data.

### Trading — `/trading` (🔒)
`POST /order` · `GET /orders` · `DELETE /orders/:orderId` · `GET /ticker/:symbol` · `GET /balance`

**Idempotency.** `POST /trading/order` and `POST /exchanges/:exchangeId/order` accept an `Idempotency-Key` header
(8–128 chars: letters, digits, `_ - : .`), one key per order *intent* (a click), not per network attempt.
- **LIVE orders require it** (`400 IDEMPOTENCY_KEY_REQUIRED`); for paper it is optional (the web app always sends one).
- Same key + same request → the original response is **replayed** (header `Idempotent-Replayed: true`); no second order.
- Same key + a different request → `422 IDEMPOTENCY_KEY_REUSED`.
- Same key while the first request is still running (or died mid-order) → `409 IDEMPOTENCY_IN_PROGRESS`: check
  `GET /orders` before retrying with a **new** key. A live order is never re-sent automatically.
- Keys are per user, kept 24 h. If the idempotency store is unavailable the order is refused (`503 IDEMPOTENCY_UNAVAILABLE`).

`GET /balance` never invents a number. If the exchange is unreachable: `502 { balanceUnavailable:true, balances:[] }`.
Responses include `source` (exchange | simulated) and `simulated` (true for paper wallets).

### Exchanges — `/exchanges` (🔒, JWT only)
`GET /connections` · `POST /connect` · `PATCH /:exchangeId/mode` · `DELETE /:exchangeId` ·
`POST /:exchangeId/test` · `POST /:exchangeId/health-check` · `GET /portfolio/all` · `GET /:exchangeId/portfolio` ·
`POST /:exchangeId/order` · `GET /:exchangeId/paper-trades` · `POST /:exchangeId/paper-trades/:tradeId/close`

### Auto-Trade — `/auto-trade` (🔒)
`POST /configs` · `GET /configs` · `PATCH /configs/:id` · `DELETE /configs/:id` · `POST /configs/pause-all|resume-all`.
Invalid values return `400` with the list of errors (finite numbers, bounds, integer `id`, boolean `enabled`).

### Backtest — `/backtest` (🔒)
`POST /` · `GET /:id` · `POST|GET /configs` · `DELETE /configs/:id`.
Invalid params → `400` (no silent fallback). Every result carries `effectiveParams` (and `defaultsApplied`).

### Other (🔒)
`GET /dashboard/summary` · `GET /risk/matrix` · `POST /risk/stress-test` · `GET|POST|DELETE /screener/presets` ·
`GET|POST|DELETE /watchlist` · `GET /symbols/resolve`

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `EMAIL_NOT_VERIFIED` | 403 | LIVE trading needs a verified email (`REQUIRE_VERIFIED_EMAIL_FOR_LIVE`, default on). |
| `TRADING_DISABLED` | 503 | Operator kill-switch is engaged: new orders are refused (cancels still work). |
| `PAPER_TRADING_ENABLED` | 403 | Server runs with `PAPER_TRADING=true` (default): no real order is ever sent. |
| `RISK_MAX_POSITION` | 403 | Order notional > `max_position_pct` of equity. `details.maxQuantity` suggests a size. |
| `RISK_MAX_EXPOSURE` | 403 | Open paper positions + this order > `max_total_exposure_pct` of equity (cumulative cap). |
| `RISK_DAILY_LOSS` | 403 | Today's realised paper loss reached `max_daily_loss_pct`; new positions blocked until tomorrow. |
| `RISK_UNVERIFIABLE` | 403 | Live equity unknown and `RISK_STRICT_LIVE=true` (default): live order refused. |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Live order sent without an `Idempotency-Key`. |
| `IDEMPOTENCY_KEY_INVALID` | 400 | Key is not 8–128 chars of `[A-Za-z0-9_\-:.]`. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Key already used with a different request. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | Same key still being processed (or ended without a recorded result). |
| `IDEMPOTENCY_UNAVAILABLE` | 503 | Idempotency store unreachable: order refused (fail closed). |
| `ORDER_BUSY` | 503 | Another paper order of the same account held the order lock for > `ORDER_LOCK_TIMEOUT_MS`. Retry. |
| `API_KEY_READ_ONLY` / `API_KEY_FORBIDDEN` | 403 | See Authentication. |
| `requires2FA` (field, not a code) | 200 | Login needs a TOTP/backup code. |

Notes: daily-loss is enforced for **paper** only (live P&L isn't tracked); the cumulative-exposure cap is
also paper-only (open live exposure isn't tracked). For paper orders (manual and auto-trade) the risk check and the
position insert run **atomically under a per-user lock**, so concurrent orders cannot overshoot the limits.
Live orders are not covered by that reservation (their exposure isn't tracked): per-order limits only.
