# AtlasQuant AI — Architecture

```
frontend (React/Vite)  ──HTTP /api──►  backend (Express, Node 22)  ──►  PostgreSQL
        │                                   │  ├─ cron.service (alerts, signals, paper monitor, digest)
        └──WS /ws/market, /ws/dashboard─────┤  ├─ stockQuotes.service (yahoo-finance2, 5 min cache)
                                            │  └─ exchanges.service (ccxt, OANDA, Alpaca, paper wallet)
                                            └──► ai-service (FastAPI, volatility model) — optional
```

- `backend/src/app.js` — middlewares, rate limits, routes, global error handler, process handlers.
- `routes/` thin routers → `controllers/` (HTTP) → `services/` (logic) → `config/db.js` (pg).
- `ai-service/` Python service (HAR-LAD volatility). `ai-engine/` prompt helpers. `shared/` small JS utils.

## Safety model

1. **Paper by default.** `PAPER_TRADING=true`: `placeLiveOrder` refuses (`PAPER_TRADING_ENABLED`) whatever the caller.
   Only one code path sends real orders (`placeLiveOrder`), with that guard first.
2. **Live gates:** verified email (`EMAIL_NOT_VERIFIED`), risk limits (`RISK_*`, strict when equity is unknown).
3. **Risk guard** (`riskGuard.service.js`), applied to manual and auto-trade orders:
   per-order max position, **cumulative max exposure**, max daily loss (paper), default stop-loss.
4. **No invented data:** balances are never fabricated (`balanceUnavailable`), demo prices only with
   `PRICES_DEMO_MODE=true` and always flagged, backtests reject invalid params and report `effectiveParams`.

## Operations
- `/api/health` reports db / cron / kill-switch state (Docker healthchecks use it). Kill-switch: `utils/killSwitch.js`,
  checked in `trading.controller.placeOrder` and the auto-trader entry; `TRADING_KILL_SWITCH` env + `/api/admin/kill-switch`.
- Compose: db, backend, ai-service (internal only), frontend; optional `edge` profile = nginx TLS proxy for SPA + `/api` + `/ws`.
- Frontend pages are code-split (`React.lazy`), main chunk ~0.5 MB instead of 1.6 MB.

## Authentication & secrets
- WebSocket auth: single-use 30 s ticket from `POST /api/auth/ws-ticket` (`utils/wsTicket.js`), not the JWT in the URL.

- JWT + server-side session rows (revocable). 2FA (TOTP + backup codes) at login: `requires2FA` challenge.
- API keys: read-only bearer tokens (`aq_live_…`), SHA-256 stored, blocked from account/security/exchange routes.
- At rest: exchange credentials **and TOTP secrets** are AES-256-GCM encrypted (`utils/secretBox.js`,
  `EXCHANGE_ENCRYPTION_KEY`). Legacy plaintext TOTP secrets still work and are re-encrypted at next login, or in
  bulk with `node backend/scripts/encrypt-2fa-secrets.js`.

## Notifications

Email (per-user preferences), webhook, and **Telegram per user**: `telegram.service` sends only to the chat the user
linked (`user_settings.telegram_chat_id` + `telegram_enabled`). `TELEGRAM_BOT_TOKEN` is the only server-level Telegram var.

## Reliability

- `utils/processHandlers.js`: `unhandledRejection` is logged (process keeps running); `uncaughtException` logs then exits(1)
  so the restart policy brings a clean process back.
- Paper close is atomic (`UPDATE … WHERE status='open' AND user_id`): a manual close and the SL/TP monitor can't both book P&L.
- Cron jobs have overlap guards. Production 5xx never leak internals (`utils/httpError.js`, `requestId`).

## Known limits

No SQL transaction/idempotency key around order placement; risk checks are not atomic across concurrent orders;
live P&L isn't tracked; JWT lives in `localStorage` and the WebSocket token goes in the query string.
