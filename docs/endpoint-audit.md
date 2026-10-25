# Endpoint audit — AtlasQuant AI

Generated from `backend/src/routes/*.js` (20 Oct 2026). **Auth** = middleware on the route; **Ownership** = how a resource addressed by id/symbol is bound to the caller; **IDOR test** = covered by `tests/idor-pg.test.js` (real PostgreSQL, two users). "static check" = every SQL statement carries `user_id`, verified by reading the controller, not yet by a runtime test.

Rules that apply to every route: cookie sessions need the CSRF token on POST/PUT/PATCH/DELETE and an allowed Origin; Bearer and `aq_live_` API keys are not ambient. API keys are read-only and refused on account/security/exchange/auth routes. `rateLimiter` is an in-memory counter per instance (use Redis if you run several backends).

| Method | Path | Auth | Ownership / IDOR test | Rate limit | Notes |
|---|---|---|---|---|---|
| GET | /api/admin/kill-switch | ADMIN_KEY (timing-safe) | n/a | 20/min/IP (router.use) | reads the shared state; `persisted:false, stale:true` if the database is unreadable |
| GET | /api/alerts | session / API key | idor-pg (list) | 30/min/IP |  |
| GET | /api/alerts/history | session / API key | idor-pg (list) | 30/min/IP |  |
| POST | /api/alerts | session / API key | own data (req.user.id), no foreign id | 20/min/IP |  |
| DELETE | /api/alerts/triggered/all | session / API key | own data (req.user.id), no foreign id | 10/min/IP |  |
| PATCH | /api/alerts/read-all | session / API key | own data (req.user.id), no foreign id | 10/min/IP |  |
| PATCH | /api/alerts/:id/read | session / API key | idor-pg | 30/min/IP |  |
| PATCH | /api/alerts/:id | session / API key | scoped by user_id in SQL (static check) | 20/min/IP |  |
| DELETE | /api/alerts/:id | session / API key | idor-pg | 30/min/IP |  |
| PATCH | /api/alerts/:id/pause | session / API key | scoped by user_id in SQL (static check) | 30/min/IP |  |
| PATCH | /api/alerts/:id/snooze | session / API key | scoped by user_id in SQL (static check) | 20/min/IP |  |
| PATCH | /api/alerts/:id/reset | session / API key | scoped by user_id in SQL (static check) | 30/min/IP |  |
| PATCH | /api/alerts/:id/email-frequency | session / API key | scoped by user_id in SQL (static check) | 30/min/IP |  |
| POST | /api/auth/register | public | n/a | 5/min/IP | IP limiter (5/min) |
| POST | /api/auth/login | public | n/a | 10/min/IP | per-account lockout (5 fails/15 min, audit_log) + IP limiter; 2FA failures counted |
| POST | /api/auth/refresh | public | n/a | 10/min/IP | IP limiter; legacy Bearer exchanged for cookie session; CSRF needed with cookie |
| GET | /api/auth/me | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/auth/logout | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/auth/ws-ticket | session / API key | own data (req.user.id), no foreign id | 30/min/IP |  |
| POST | /api/auto-trade/configs | session / API key | own data (req.user.id), no foreign id | 20/min/IP |  |
| GET | /api/auto-trade/configs | session / API key | idor-pg (list) | global (500/15 min/IP) |  |
| POST | /api/auto-trade/configs/pause-all | session / API key | own data (req.user.id), no foreign id | 20/min/IP |  |
| POST | /api/auto-trade/configs/resume-all | session / API key | own data (req.user.id), no foreign id | 20/min/IP |  |
| PATCH | /api/auto-trade/configs/:id | session / API key | scoped by user_id in SQL (static check) | 20/min/IP |  |
| DELETE | /api/auto-trade/configs/:id | session / API key | idor-pg | global (500/15 min/IP) |  |
| POST | /api/backtest | session / API key | own data (req.user.id), no foreign id | 20/min/IP + backtest limiter |  |
| POST | /api/backtest/configs | session / API key | own data (req.user.id), no foreign id | backtest limiter |  |
| GET | /api/backtest/configs | session / API key | own data (req.user.id), no foreign id | backtest limiter |  |
| DELETE | /api/backtest/configs/:id | session / API key | idor-pg | backtest limiter |  |
| GET | /api/backtest/:id | session / API key | idor-pg | backtest limiter |  |
| GET | /api/dashboard/summary | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| DELETE | /api/exchanges/:exchangeId | session / API key | idor-pg | global (500/15 min/IP) |  |
| GET | /api/market/forex/prices | public | n/a | 30/min/IP |  |
| GET | /api/market/commodities/prices | public | n/a | 30/min/IP |  |
| GET | /api/market/prices | public | n/a | 30/min/IP |  |
| GET | /api/market/:symbol/stats | public | n/a | 30/min/IP |  |
| GET | /api/market/:symbol/candles | public | n/a | 20/min/IP |  |
| GET | /api/market/economic-calendar | public | n/a | global (500/15 min/IP) |  |
| GET | /api/market/news | public | n/a | global (500/15 min/IP) |  |
| GET | /api/portfolio/data | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/portfolio/position | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/portfolio/position/:symbol/:side/reduce | session / API key | scoped by user_id in SQL (static check) | global (500/15 min/IP) |  |
| DELETE | /api/portfolio/position/:symbol/:side | session / API key | scoped by user_id in SQL (static check) | global (500/15 min/IP) |  |
| GET | /api/portfolio/history | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| PATCH | /api/portfolio/cash | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/portfolio/analyze | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| GET | /api/prices/stocks | public | n/a | 10/min/IP |  |
| DELETE | /api/prices/stocks/cache | public | n/a | global (500/15 min/IP) | dev only: the route is registered only when `NODE_ENV=development` |
| GET | /api/risk/matrix | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/risk/stress-test | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| GET | /api/screener/presets | session / API key | idor-pg (list) | 30/min/IP |  |
| POST | /api/screener/presets | session / API key | own data (req.user.id), no foreign id | 15/min/IP |  |
| DELETE | /api/screener/presets/:id | session / API key | idor-pg | 15/min/IP |  |
| GET | /api/security/2fa/status | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/security/2fa/setup | session / API key | own data (req.user.id), no foreign id | 10/min/IP | FIXED: +IP limiter |
| POST | /api/security/2fa/verify | session / API key | own data (req.user.id), no foreign id | 10/min/IP | FIXED: +IP limiter |
| POST | /api/security/2fa/disable | session / API key | own data (req.user.id), no foreign id | 10/min/IP | FIXED: password AND TOTP/backup code; per-account lockout; +IP limiter |
| GET | /api/security/sessions | session / API key | idor-pg (list) | global (500/15 min/IP) |  |
| DELETE | /api/security/sessions/:id | session / API key | idor-pg | global (500/15 min/IP) |  |
| DELETE | /api/security/sessions | session / API key | idor-pg | global (500/15 min/IP) |  |
| GET | /api/security/api-keys | session / API key | idor-pg (list) | global (500/15 min/IP) |  |
| POST | /api/security/api-keys | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| DELETE | /api/security/api-keys/:id | session / API key | idor-pg | global (500/15 min/IP) |  |
| GET | /api/settings | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/settings/update | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/settings/password | session / API key | own data (req.user.id), no foreign id | 10/min/IP | FIXED: revokes other sessions; per-account lockout (5/15 min); +IP limiter |
| GET | /api/settings/export | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| DELETE | /api/settings/account | session / API key | own data (req.user.id), no foreign id | 5/min/IP | FIXED: per-account lockout (5/15 min); 2FA code required when 2FA is on; +IP limiter |
| POST | /api/settings/webhook/test | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/settings/telegram/test | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/settings/email/resend-verification | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| POST | /api/settings/email/verify | public | n/a | global (500/15 min/IP) | emailed token stored as SHA-256, expires after 24 h, single use |
| GET | /api/settings/audit-log | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| GET | /api/signals | session / API key | own data (req.user.id), no foreign id | 10/min/IP | public GET; ?refresh=true starts a scan => protect inside controller; job bound to owner |
| GET | /api/signals/meta/supported | public | n/a | global (500/15 min/IP) |  |
| GET | /api/signals/alpha/engine-data | public | n/a | 10/min/IP | public by design (aggregate) |
| GET | /api/signals/analytics | public | n/a | 10/min/IP | public by design (aggregate market data) |
| GET | /api/signals/analytics/mine | session / API key | own data (req.user.id), no foreign id | 10/min/IP |  |
| GET | /api/signals/:symbol | public | n/a | 20/min/IP | public by design (market data) |
| GET | /api/signals/scan-status/:jobId | session / API key | scoped by user_id in SQL (static check) | global (500/15 min/IP) | FIXED: job bound to its owner (404 otherwise); unguessable id |
| GET | /api/symbols/resolve | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| DELETE | /api/trading/orders/:orderId | session / API key | idor-pg | global (500/15 min/IP) |  |
| GET | /api/watchlist | session / API key | idor-pg (list) | global (500/15 min/IP) |  |
| POST | /api/watchlist | session / API key | own data (req.user.id), no foreign id | global (500/15 min/IP) |  |
| DELETE | /api/watchlist/:sym | session / API key | idor-pg | global (500/15 min/IP) |  |

## Open items (not fixed by this audit)

1. ~~**Kill switch** lives in process memory~~ **DONE**: the state is in the `system_flags` table (key `kill_switch`): it survives a restart and is shared by every instance. Order paths (`placeOrder`, auto-trader) read it from the database on every order and **fail closed** (database unreadable => orders refused); `/api/health` uses a cache refreshed every 3 s. Engaging always works (even if the write fails); a release that cannot be persisted is refused. Engage/release is written to `audit_log` (`kill_switch_engaged` / `kill_switch_released`, `user_id` NULL). `TRADING_KILL_SWITCH=true` re-engages at every boot. Tests: `kill-switch-persist.test.js`, `kill-switch-pg.test.js`.
2. **In-memory rate limiter / lockouts**: the IP limiter is per instance. Per-account lockouts (login, password change, 2FA disable, account delete) use `audit_log`, so they are already shared across instances.
3. ~~`DELETE /api/settings/account` asks for the password only~~ **DONE**: with 2FA on it also needs a TOTP or backup code (`utils/secondFactor.js`, shared with `disable2FA`); per-account lockout applies to wrong passwords and wrong codes.
4. **Legacy tokens without a `user_sessions` row** cannot be revoked individually by a password change; they die at JWT expiry or on the next refresh (legacy Bearer is exchanged for a cookie session and revoked).
5. **Lockout trade-off**: 5 failures lock the action for 15 minutes for that account, so someone who knows an account and holds a session could lock the owner out of password change / 2FA disable. Acceptable for sensitive actions; consider an unlock by email.
6. **CSP** still allows `unsafe-inline` for scripts and styles (`app.js`). **`TRUST_PROXY`** must be set to match nginx or every user shares one IP bucket.
7. Live orders now have a state machine with an `unknown` state and a reconciler (see `docs/order-state-machine.md`), but it is **not validated on a real exchange** and there is still no balance/position reconciliation or live exposure/P&L tracking. Live trading stays **NO-GO**; keep `PAPER_TRADING=true`.
