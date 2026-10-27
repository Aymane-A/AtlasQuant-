#!/usr/bin/env bash
# AtlasQuant — restore drill: restores a backup into a THROWAWAY database and checks it.
#
#   ADMIN_URL=postgres://user:pass@host:5432/postgres  [SOURCE_URL=postgres://.../atlasquant]  [STRICT=1]  scripts/restore-test.sh [backup.dump]
#
# - backup.dump defaults to the newest in BACKUP_DIR (default ./backups); its .sha256 is checked if present
# - restores into aq_restore_test_<pid>, which is always dropped at the end
# - checks every table of the source (SOURCE_URL) or the core tables exist, and prints the row counts
# - with SOURCE_URL, differing counts are reported (the live database keeps changing after the dump, so this is
#   a WARNING; STRICT=1 turns it into a failure, useful right after a backup on a quiet database)
# Exit code 0 = the backup restores and the schema is complete.
set -euo pipefail

: "${ADMIN_URL:?ADMIN_URL (a connection to the 'postgres' database of the target server) is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
file="${1:-$(ls -1t "$BACKUP_DIR"/atlasquant-*.dump 2>/dev/null | head -1 || true)}"
[ -n "$file" ] && [ -f "$file" ] || { echo "no backup file found" >&2; exit 1; }

if [ -f "$file.sha256" ]; then
  ( cd "$(dirname "$file")" && sha256sum --check --status "$(basename "$file").sha256" ) || { echo "CHECKSUM MISMATCH: $file is corrupted" >&2; exit 1; }
  echo "checksum ok"
fi

scratch="aq_restore_test_$$"
scratch_url="${ADMIN_URL%/*}/$scratch"
cleanup() { psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql "$ADMIN_URL" -q -c "CREATE DATABASE $scratch"
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$scratch_url" "$file"
echo "restored $file into $scratch"

tables_of() { psql "$1" -At -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1"; }
count_of()  { psql "$1" -At -c "SELECT count(*) FROM \"$2\""; }

if [ -n "${SOURCE_URL:-}" ]; then required="$(tables_of "$SOURCE_URL")"
else required="users user_sessions audit_log live_orders paper_trades alerts system_flags idempotency_keys"; fi

missing=0; drift=0
echo "table                           restored"
for t in $required; do
  if ! psql "$scratch_url" -At -c "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='$t'" | grep -q 1; then
    echo "MISSING TABLE: $t" >&2; missing=$((missing + 1)); continue
  fi
  n="$(count_of "$scratch_url" "$t")"
  line="$(printf '%-30s %8s' "$t" "$n")"
  if [ -n "${SOURCE_URL:-}" ]; then
    s="$(count_of "$SOURCE_URL" "$t")"
    if [ "$s" != "$n" ]; then line="$line   (source now: $s)"; drift=$((drift + 1)); fi
  fi
  echo "$line"
done

[ "$missing" -eq 0 ] || { echo "RESTORE CHECK FAILED: $missing table(s) missing" >&2; exit 1; }
if [ "$drift" -gt 0 ]; then
  echo "WARNING: $drift table(s) differ from the live source (normal if it changed since the dump)" >&2
  [ "${STRICT:-0}" = "1" ] && { echo "STRICT=1: failing" >&2; exit 2; }
fi
echo "RESTORE OK"
