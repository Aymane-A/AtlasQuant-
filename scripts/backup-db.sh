#!/usr/bin/env bash
# AtlasQuant — PostgreSQL backup (pg_dump custom format), verified, with retention.
#
#   DATABASE_URL=postgres://user:pass@host:5432/atlasquant  BACKUP_DIR=/var/backups/atlasquant  KEEP=14  scripts/backup-db.sh
#
# - writes <BACKUP_DIR>/atlasquant-<UTC timestamp>.dump (+ .sha256), prints its path on the last line
# - the archive is read back (pg_restore --list) before it is accepted; a failed dump never replaces a good one
# - keeps the newest KEEP dumps (default 14), deletes older ones
# The dump holds password hashes, AES-encrypted exchange keys and personal data: store it off the server,
# encrypted, with the same care as the database. The ENCRYPTION key that protects the exchange keys is NOT in
# the dump: back it up separately, or those keys cannot be decrypted after a restore (see docs/runbook.md).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${KEEP:-14}"

umask 077
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/atlasquant-$stamp.dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

pg_dump --format=custom --no-owner --no-privileges --dbname "$DATABASE_URL" --file "$tmp"
pg_restore --list "$tmp" > /dev/null          # the archive must be readable
[ -s "$tmp" ] || { echo "backup is empty" >&2; exit 1; }

mv "$tmp" "$out"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )

# retention: newest KEEP dumps stay
i=0
for f in $(ls -1t "$BACKUP_DIR"/atlasquant-*.dump); do
  i=$((i + 1))
  if [ "$i" -gt "$KEEP" ]; then rm -f "$f" "$f.sha256"; fi
done

echo "$out"
