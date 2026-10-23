#!/bin/sh
# Runs as root just long enough to make /data writable by the app user,
# then drops privileges. PUID/PGID default to 1000 (the first user on most
# Linux hosts, including Raspberry Pi OS) so backups taken from the host
# don't hit permission errors.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="$(dirname "${DATABASE_PATH:-/data/studio.db}")"

if [ "$(id -u)" = "0" ]; then
    if [ "$(id -g app)" != "$PGID" ]; then groupmod -o -g "$PGID" app; fi
    if [ "$(id -u app)" != "$PUID" ]; then usermod -o -u "$PUID" app; fi
    mkdir -p "$DATA_DIR"
    chown "$PUID:$PGID" "$DATA_DIR"
    # Existing database files from an older run or a restore.
    find "$DATA_DIR" -maxdepth 1 -name '*.db*' -exec chown "$PUID:$PGID" {} +
    if [ -d /backups ]; then chown "$PUID:$PGID" /backups; fi
    exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups "$@"
fi

exec "$@"
