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
git pull --ff-only

NEW_HEAD="$(git rev-parse HEAD)"
if [ "$PRE_HEAD" = "$NEW_HEAD" ]; then
  echo "==> No new commits; nothing to deploy."
  exit 0
fi

echo "==> Building and restarting"
docker compose up -d --build

echo "==> Resolving HOST/PORT from .env for healthz poll"
HOST_IP="$(grep ^HOST= .env | cut -d= -f2)"
PORT_VAL="$(grep ^PORT= .env | cut -d= -f2)"

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
exit 1
