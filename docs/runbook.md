# AtlasQuant — operations runbook

Short, practical procedures. Everything marked **(tested)** was run against a real PostgreSQL 16; everything marked
**(not tested)** was written from the documentation and has to be tried once on your own setup before you rely on it.

## 1. Backups

`scripts/backup-db.sh` **(tested)** — `pg_dump` custom format, read back before it is accepted, SHA-256 file, keeps the newest `KEEP` dumps:

```bash
DATABASE_URL=postgres://user:pass@host:5432/atlasquant BACKUP_DIR=/var/backups/atlasquant KEEP=14 scripts/backup-db.sh
```

Schedule it (Linux `crontab -e`): `0 3 * * * cd /opt/atlasquant && DATABASE_URL=... BACKUP_DIR=/var/backups/atlasquant scripts/backup-db.sh >> /var/log/aq-backup.log 2>&1`

- **Docker Compose** **(not tested)**: `docker compose exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > atlasquant-$(date -u +%Y%m%dT%H%M%SZ).dump`
- **Windows** **(not tested)**: Task Scheduler running `"C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -Fc -U postgres -d atlasquant -f D:\backups\atlasquant-%DATE%.dump` (set `PGPASSWORD` in the task, not in the command line).

What the dump contains: password hashes, **AES-encrypted** exchange keys, 2FA secrets, personal data, audit log. Treat it like the database:
copy it **off the server**, encrypt it (e.g. `gpg --symmetric`), restrict access.

**The `EXCHANGE_ENCRYPTION_KEY` is not in the dump.** Without it the stored exchange keys and 2FA secrets cannot be decrypted after a restore.
Keep a copy of that key (and `JWT_SECRET`, `ADMIN_KEY`) in a password manager or secrets vault, separate from the backups.

## 2. Restore drill — do it monthly, and after changing the schema

`scripts/restore-test.sh` **(tested)** restores a dump into a throw-away database, checks it and drops it:

```bash
ADMIN_URL=postgres://user:pass@host:5432/postgres SOURCE_URL=postgres://user:pass@host:5432/atlasquant BACKUP_DIR=/var/backups/atlasquant scripts/restore-test.sh
```

It fails (exit 1) on a corrupted dump (checksum), on a dump that does not restore, and on a missing table. Differences in row counts against the
live source are only a warning (the database keeps changing after the dump); `STRICT=1` makes them a failure (use right after a backup on a quiet database).
A backup that was never restored is not a backup: put the drill in the calendar.

### Real restore (disaster)
1. Stop the backend (`docker compose stop backend` / stop the service) so nothing writes.
2. `createdb atlasquant_new` then `pg_restore --no-owner --no-privileges --exit-on-error --dbname postgres://.../atlasquant_new atlasquant-<stamp>.dump`
3. Check: `SELECT count(*) FROM users;` and the latest rows of `audit_log`.
4. Point `DB_NAME` / `DATABASE_URL` at the restored database (or rename databases), start the backend, check `GET /api/health` (`db: up`).
5. The backend re-applies its idempotent migration at boot, so a dump from an older version is upgraded automatically.
6. Everything written between the last backup and the incident is lost: reconcile live orders with the exchange by hand (section 4).

## 3. Kill switch drill (stops NEW orders everywhere, persistent and shared) **(tested)**
Needs `ADMIN_KEY` (24+ characters) in `backend/.env` (restart after changing it; nodemon does not watch `.env`).

```powershell
$k = "<ADMIN_KEY>"
# engage
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/admin/kill-switch -Headers @{ "x-admin-key" = $k } -ContentType "application/json" -Body (@{ enabled = $true; reason = "why" } | ConvertTo-Json)
# state (shared, read from the database)
Invoke-RestMethod -Uri http://localhost:5000/api/admin/kill-switch -Headers @{ "x-admin-key" = $k }
# release (answers 503 and stays engaged if the release cannot be saved)
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/admin/kill-switch -Headers @{ "x-admin-key" = $k } -ContentType "application/json" -Body (@{ enabled = $false } | ConvertTo-Json)
```
It survives restarts. `TRADING_KILL_SWITCH=true` in the environment re-engages it at every boot: remove the variable to release for good.
`/api/health` shows `degraded` while it is engaged. Cancelling existing orders stays possible.

## 4. An order is "unknown" (the exchange did not confirm) — see `docs/order-state-machine.md`
1. **Do not send it again.** The API answered 502 `ORDER_STATE_UNKNOWN`; the order may exist.
2. Wait one or two minutes: the reconciler asks the exchange by client id and moves it to `submitted` / `filled` / `cancelled` / `rejected`.
3. Still `unknown` after an hour: the backend logs an ERROR every minute. Look at the order list on the exchange itself, then set the row by hand
   (`UPDATE live_orders SET status = '...', status_note = 'manual: ...' WHERE id = ...`).
4. Many unknown orders at once usually means the exchange or the network is down: engage the kill switch (section 3) until it is stable.

## 5. Secret rotation
- **Telegram bot token** (if it ever leaked): Telegram → @BotFather → `/revoke` → pick the bot → new token in `backend/.env` (`TELEGRAM_BOT_TOKEN`) → restart.
  The old token stops working immediately.
- **`ADMIN_KEY`**: generate a new one (40 random characters), update `.env`, restart.
- **`JWT_SECRET`**: new value + restart. **Every session is cut** (everyone logs in again).
- **Exchange API keys**: revoke them on the exchange first, then disconnect/reconnect them in Settings.
- **`EXCHANGE_ENCRYPTION_KEY`**: do **not** change it casually: stored exchange keys and 2FA secrets become unreadable. There is no re-encryption tool yet.
- After any suspected compromise: change the password, check Settings → Security → sessions/API keys, revoke what you do not know, read the audit log.

## 6. Docker Compose notes (read from the files; **not tested**, Docker was not available to the person who wrote this)
- First run on your machine: `docker compose config` (validates and shows the final values), then `docker compose up --build`, then `docker compose ps` (all `healthy`) and `GET /api/health`.
- Required variables fail fast with a message: `DB_PASSWORD`, `AI_SERVICE_KEY` (see `.env.example` at the repository root). `backend/.env` holds the rest.
- The database port is not published and `ai-service` is internal only (good). The backend (`5000`) and frontend (`3000`) ports **are** published: with the `edge`
  nginx doing TLS, publish only `edge` (80/443) in production (e.g. `127.0.0.1:5000:5000` for the backend) so nobody bypasses TLS and the edge rate limits.
- `pgdata` is the only copy of the data: nothing in compose backs it up. Use section 1.
- Set `TRUST_PROXY` to match the proxy in front of the backend, otherwise every client appears with the proxy's IP and the rate limits/lockouts act on everyone at once.
