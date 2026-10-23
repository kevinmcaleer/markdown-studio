#!/bin/sh
# Restore a backup made by scripts/backup.sh into the Docker deployment.
#
# Usage (from the project directory on the host):
#   scripts/restore.sh backups/studio-20260101T020000Z.db
#
# Steps: verify the backup, stop the app, keep a copy of the current
# database, swap the backup in, start the app, and wait for /health.
set -eu

BACKUP="${1:-}"
DATA_DIR="${DATA_DIR:-./data}"
DB="$DATA_DIR/studio.db"
SERVICE="${SERVICE:-markdown-studio}"

if [ -z "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
    echo "usage: $0 path/to/backup.db" >&2
    exit 1
fi

integrity() {
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$1" 'PRAGMA integrity_check;'
    else
        python3 -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('PRAGMA integrity_check').fetchone()[0])" "$1"
    fi
}

echo "restore: checking $BACKUP"
if [ "$(integrity "$BACKUP")" != "ok" ]; then
    echo "restore: $BACKUP failed PRAGMA integrity_check; not restoring" >&2
    exit 1
fi

echo "restore: stopping $SERVICE"
docker compose stop "$SERVICE"

mkdir -p "$DATA_DIR"
if [ -f "$DB" ]; then
    SAFETY="$DB.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$DB" "$SAFETY"
    echo "restore: previous database kept at $SAFETY"
fi
# Stale WAL/SHM files belong to the old database and must not be replayed.
rm -f "$DB-wal" "$DB-shm"
cp "$BACKUP" "$DB"

echo "restore: starting $SERVICE"
docker compose start "$SERVICE"

PORT="${PORT:-8000}"
i=0
while [ $i -lt 30 ]; do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
        echo "restore: done, app is healthy"
        exit 0
    fi
    i=$((i + 1))
    sleep 1
done
echo "restore: app did not report healthy within 30s; check 'docker compose logs'" >&2
exit 1
