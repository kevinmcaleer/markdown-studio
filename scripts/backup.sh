#!/bin/sh
# Consistent online backup of the Markdown Studio SQLite database.
#
# Uses SQLite's online backup API (sqlite3 ".backup"), which is safe while the
# app is running and writing. A plain `cp` of a WAL-mode database is not.
#
# Usage:
#   scripts/backup.sh [DB_PATH] [BACKUP_DIR]
#
# Defaults:   DB_PATH    = $DATABASE_PATH or ./data/studio.db
#             BACKUP_DIR = $BACKUP_DIR or ./backups
#             KEEP       = 14   (number of backups to keep; 0 keeps all)
#
# From the host while the container runs:
#   docker compose exec -u app markdown-studio scripts/backup.sh /data/studio.db /backups
# or, if sqlite3 is installed on the host:
#   scripts/backup.sh data/studio.db backups
set -eu

DB="${1:-${DATABASE_PATH:-./data/studio.db}}"
DEST_DIR="${2:-${BACKUP_DIR:-./backups}}"
KEEP="${KEEP:-14}"

if [ ! -f "$DB" ]; then
    echo "backup: database not found: $DB" >&2
    exit 1
fi
mkdir -p "$DEST_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST_DIR/studio-$STAMP.db"
TMP="$OUT.partial"

if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" ".timeout 15000" ".backup '$TMP'"
    CHECK="$(sqlite3 "$TMP" 'PRAGMA integrity_check;')"
else
    # No sqlite3 CLI: Python's sqlite3 module has the same online backup API.
    python3 - "$DB" "$TMP" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1], timeout=15)
dst = sqlite3.connect(sys.argv[2])
with dst:
    src.backup(dst)
dst.close(); src.close()
PY
    CHECK="$(python3 -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('PRAGMA integrity_check').fetchone()[0])" "$TMP")"
fi

if [ "$CHECK" != "ok" ]; then
    echo "backup: integrity check failed on $TMP: $CHECK" >&2
    rm -f "$TMP"
    exit 1
fi
mv "$TMP" "$OUT"
# If run as root (e.g. a plain `docker compose exec`), give the file to the
# database's owner so host-side tools can read and rotate it.
if [ "$(id -u)" = "0" ]; then
    chown "$(stat -c '%u:%g' "$DB" 2>/dev/null || echo 0:0)" "$OUT" 2>/dev/null || true
fi
echo "backup: wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, integrity ok)"

# Retention: keep the newest $KEEP backups.
if [ "$KEEP" -gt 0 ] 2>/dev/null; then
    # shellcheck disable=SC2012  # file names are ours and contain no spaces
    ls -1t "$DEST_DIR"/studio-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
        rm -f "$old"
        echo "backup: removed old backup $old"
    done
fi
