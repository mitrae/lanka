#!/usr/bin/env bash
set -euo pipefail

# Host-side nightly backup. Safe to run while the container is serving
# writes because signage.db is in WAL mode; sqlite3 .backup uses the
# online backup API.
#
# Layout:
#   /opt/lanka/backups/db/signage-YYYY-MM-DD.db
#   /opt/lanka/backups/media/ (rsync mirror of /opt/lanka/data/media)
#
# Media is mirrored (--delete), not snapshotted: content-addressed
# sha256 filenames never mutate, so a mirror is lossless and cheap.

BACKUP_DIR="${LANKA_BACKUP_DIR:-/opt/lanka/backups}"
DATA_DIR="${LANKA_DATA_DIR:-/opt/lanka/data}"
STAMP="$(date +%F)"
RETENTION_DAYS="${LANKA_RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/media"

echo "backup.sh: sqlite .backup -> $BACKUP_DIR/db/signage-$STAMP.db"
sqlite3 "$DATA_DIR/signage.db" ".backup '$BACKUP_DIR/db/signage-$STAMP.db'"

echo "backup.sh: rsync media -> $BACKUP_DIR/media/"
rsync -a --delete "$DATA_DIR/media/" "$BACKUP_DIR/media/"

echo "backup.sh: pruning db snapshots older than $RETENTION_DAYS days"
find "$BACKUP_DIR/db" -name 'signage-*.db' -mtime +"$RETENTION_DAYS" -delete

if [ -x "$BACKUP_DIR/offsite.sh" ]; then
  echo "backup.sh: invoking offsite hook $BACKUP_DIR/offsite.sh"
  "$BACKUP_DIR/offsite.sh" "$BACKUP_DIR"
else
  echo "backup.sh: no offsite hook; skipping"
fi

echo "backup.sh: done"
