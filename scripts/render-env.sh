#!/usr/bin/env bash
set -euo pipefail

# Called by systemd ExecStartPre. Reads the current tailnet IP
# and writes /opt/lanka/.env. This runs on every service start
# so a tailnet re-auth or interface change is picked up automatically.

TS_IP="$(tailscale ip -4 | head -n1 || true)"
if [ -z "$TS_IP" ]; then
  echo "render-env.sh: tailscale ip -4 returned empty; refusing to start" >&2
  exit 1
fi

umask 077
cat > /opt/lanka/.env <<EOF
HOST=${TS_IP}
PORT=${LANKA_PORT:-3000}
TZ=${LANKA_TZ:-UTC}
EOF

echo "render-env.sh: wrote /opt/lanka/.env with HOST=${TS_IP}"
