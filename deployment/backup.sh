#!/usr/bin/env bash
#
# Nightly logical backup.
#
# Keeps 30 days locally. Copy the output off this machine — a backup that only
# exists on the host it protects is not a backup.
#
# Cron:
#   15 2 * * * /srv/event-hub/deployment/backup.sh >> /var/log/event-hub-backup.log 2>&1

set -euo pipefail

cd "$(dirname "$0")/.."

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR=${BACKUP_DIR:-/srv/backups/event-hub}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-30}

DB_SERVICE=${DB_SERVICE:-db}
DB_USER=${POSTGRES_OWNER_USER:-event_owner}
DB_NAME=${POSTGRES_DB:-event_platform}

mkdir -p "$DIR"

# Fail loudly rather than writing an empty archive.
if ! docker compose ps --status running --services | grep -qx "$DB_SERVICE"; then
  echo "error: the $DB_SERVICE service is not running" >&2
  exit 1
fi

TARGET="$DIR/event-platform-$STAMP.dump"

docker compose exec -T "$DB_SERVICE" pg_dump \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --format=custom \
  --no-owner \
  > "$TARGET"

gzip -f "$TARGET"

if [ ! -s "$TARGET.gz" ]; then
  echo "error: backup is empty" >&2
  exit 1
fi

find "$DIR" -name 'event-platform-*.dump.gz' -mtime "+$KEEP_DAYS" -delete

echo "backup written: $TARGET.gz ($(du -h "$TARGET.gz" | cut -f1))"
