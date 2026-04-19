#!/usr/bin/env bash
set -euo pipefail

# Manual upgrade flow, run on the host after `ssh lanka-host`.
# 1. Snapshot current DB + media (reuses backup.sh).
# 2. Fast-forward pull from main.
# 3. Rebuild the compose image and restart the service.
# 4. Poll /api/healthz for up to 60s.
# 5. On failure: git reset --hard to the pre-pull HEAD and rebuild.

cd /opt/lanka

echo "==> Pre-upgrade backup"
./scripts/backup.sh

echo "==> Fetching origin"
git fetch --prune
git checkout main

PRE_HEAD="$(git rev-parse HEAD)"
echo "==> Current HEAD before pull: $PRE_HEAD"

echo "==> Pulling (fast-forward only)"
if ! git pull --ff-only; then
  echo "!! git pull --ff-only failed: local main has diverged from origin/main." >&2
  echo "!! Either reset local commits with 'git reset --hard origin/main' (losing them)" >&2
  echo "!! or investigate unpushed work on the host before retrying deploy.sh." >&2
  exit 1
fi

NEW_HEAD="$(git rev-parse HEAD)"
if [ "$PRE_HEAD" = "$NEW_HEAD" ]; then
  echo "==> No new commits; nothing to deploy."
  exit 0
fi

echo "==> Building and restarting"
docker compose up -d --build

echo "==> Loading HOST/PORT from .env for healthz poll"
# docker-compose already treats .env as shell-sourceable via env_file.
# Source it the same way here so future format changes (comments,
# quoted values) don't silently break the poll URL.
set -a
# shellcheck disable=SC1091
. ./.env
set +a
HOST_IP="$HOST"
PORT_VAL="$PORT"

echo "==> Waiting for http://${HOST_IP}:${PORT_VAL}/api/healthz"
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://${HOST_IP}:${PORT_VAL}/api/healthz" >/dev/null; then
    echo "==> Healthy after ${i} attempt(s)"
    docker image prune -f >/dev/null || true
    exit 0
  fi
  sleep 2
done

echo "!! Healthz never came up — rolling back to $PRE_HEAD"
git reset --hard "$PRE_HEAD"
docker compose up -d --build

echo "!! Rollback complete. Investigate the failed deploy in docker logs lanka."
echo "!! If the failed deploy advanced the DB schema (drizzle migrations are"
echo "!! forward-only), the rolled-back code may be incompatible with the"
echo "!! current DB. Restore from backups/db/signage-\$(date +%F).db per"
echo "!! the README 'Restore from backup' procedure before the service recovers."
exit 1
