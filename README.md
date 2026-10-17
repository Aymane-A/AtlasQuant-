# AtlasQuant

Trading / portfolio platform: React (Vite) frontend, Node/Express + PostgreSQL backend, and a separate
Python (FastAPI) volatility-model service. **Paper trading is the default; real orders are off until you opt in.**

```
frontend/    React + Vite SPA
backend/     Express API + WebSockets (auth, 2FA, exchanges, paper/live trading, risk limits)
ai-service/  FastAPI volatility model (/predict) + research protocol (PROTOCOL.md)
ai-engine/   LLM helpers used by the backend
database/    schema.sql (also created/migrated automatically at backend start)
docker/      Dockerfiles + nginx configs      docker-compose.yml: db + backend + ai-service + frontend (+ optional TLS edge)
```

## Prerequisites
Node 22+, PostgreSQL 16, Python 3.13 (AI service only), Docker (optional).

## Run locally
```bash
# 1. backend
cd backend && cp .env.example .env      # fill JWT_SECRET, DB_PASSWORD, EXCHANGE_ENCRYPTION_KEY (see comments inside)
npm ci && npm run dev                   # http://localhost:5000

# 2. frontend (dev falls back to http://localhost:5000, production builds do not)
cd frontend && npm ci && npm run dev    # http://localhost:3000

# 3. AI service (optional, standalone — the backend does not call it yet)
cd ai-service && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt         # Windows-only pywinpty/colorama can be skipped on Linux/macOS
AI_SERVICE_KEY=<strong-key> uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## Docker
```bash
cp backend/.env.example backend/.env
DB_PASSWORD=<password> AI_SERVICE_KEY=<strong-key> docker compose up --build   # frontend :3000, backend :5000
```
`ai-service` is only reachable inside the compose network (`http://ai-service:8000`, key in `X-API-Key`); its port is not published.
The backend does not call it yet. Each container has a healthcheck (`docker compose ps`).

**TLS / single public origin (optional):** put `fullchain.pem` + `privkey.pem` in `docker/certs/` and run
`docker compose --profile edge up --build`. `docker/nginx.edge.conf` serves the SPA, proxies `/api` and `/ws` (WebSocket upgrade
headers, size/timeout limits). Build the SPA with `VITE_API_URL=https://YOUR_DOMAIN/api VITE_WS_URL=wss://YOUR_DOMAIN`
and set `TRUST_PROXY=1`, `FRONTEND_URL=https://YOUR_DOMAIN` for the backend. Check the config before deploying:
`docker run --rm -v "$PWD/docker/nginx.edge.conf:/etc/nginx/conf.d/default.conf:ro" -v "$PWD/docker/certs:/etc/nginx/certs:ro" nginx:1.27-alpine nginx -t`
(needs the `backend` and `frontend` hosts to resolve, so run it inside the compose network, or just `docker compose --profile edge up`).
For a real deployment pass the **public** URLs at build time (Vite inlines them; the build fails without them):
`docker build -f docker/frontend.Dockerfile --build-arg VITE_API_URL=https://api.example.com/api --build-arg VITE_WS_URL=wss://api.example.com .`

## Safety defaults
| Setting | Default | Effect |
|---|---|---|
| `PAPER_TRADING` | `true` | Every live order is refused inside `placeLiveOrder()` (403 `PAPER_TRADING_ENABLED`). Set `false` to trade live. |
| `REQUIRE_VERIFIED_EMAIL_FOR_LIVE` | `true` | Live mode / live orders need a verified email. |
| `RISK_STRICT_LIVE` | `true` | Live buys are refused when equity can't be verified. |
| Settings → Risk | per user | Max position %, max daily loss %, default stop-loss. |
| `TRADING_KILL_SWITCH` | `false` | `true` = every NEW order (manual and auto-trader) is refused with 503 `TRADING_DISABLED`. Cancels still work. Toggle at runtime with `POST /api/admin/kill-switch` (`X-Admin-Key: $ADMIN_KEY`, 24+ chars; endpoint is off when `ADMIN_KEY` is empty). The runtime toggle is in-memory: a restart goes back to the env value. |
| `AI_SERVICE_KEY` | required | The AI service won't start without it (`AI_ALLOW_INSECURE=1` = local dev only). |
| `PRICES_DEMO_MODE` | `false` | Hardcoded demo prices are never served as real quotes. |

## Tests
```bash
cd backend && npm test                  # auth, 2FA, risk limits, live gates, PAPER_TRADING guard
cd ai-service && python -m pytest -q tests
cd frontend && VITE_API_URL=http://localhost:5000/api VITE_WS_URL=ws://localhost:5000 npm run build
```
CI (`.github/workflows/ci.yml`) runs all three plus `npm audit` on every push/PR.
`paper-log.yml` is a separate hourly job that appends to `ai-service/data/live/*.csv`.

## Operations
`GET /api/health` (public, used by Docker probes): `{status: ok|degraded|down, db, cron, killSwitch, paperTrading}`.
HTTP 503 only when the database is unreachable; a stopped cron or an engaged kill-switch is `degraded` (still 200).

## Security notes
Never commit `.env`. Rotate any key that was ever pasted in a chat or committed. Deleting a file does not remove it from Git history.
