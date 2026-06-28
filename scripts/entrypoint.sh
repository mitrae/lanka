#!/usr/bin/env bash
set -euo pipefail

# --- privilege drop -------------------------------------------------------
# The container starts as root ONLY so we can fix ownership of the host-owned,
# bind-mounted /app/data (the SQLite DB + WAL live there). A naive non-root
# `USER` would leave the unprivileged user unable to write that mount, so
# `drizzle-kit migrate` would fail → crash loop. Here, while still root, we
# chown the data dir to the runtime user, then re-exec this same script under
# that user via gosu. Everything below then runs unprivileged. `gosu` (unlike
# `su`) execs without an intermediate shell, so tini stays PID 1 and signals
# propagate cleanly.
RUN_AS=lanka
if [ "$(id -u)" = "0" ]; then
  # MEDIA_DIR may live under /app/data too; chown the whole tree so a fresh
  # host-owned ./data and its media/ subdir become writable.
  chown -R "$RUN_AS:$RUN_AS" /app/data 2>/dev/null || true
  exec gosu "$RUN_AS" "$0" "$@"
fi

# Run migrations against the bind-mounted DB, then start Nitro.
# drizzle-kit reads DATABASE_URL from env; compose sets it to
# file:/app/data/signage.db.
pnpm exec drizzle-kit migrate

# Bridge plain env names → the NUXT_-prefixed names Nitro reads at runtime.
#
# Why this is needed: nuxt.config captures `process.env.*` into runtimeConfig at
# BUILD time, and the image build excludes `.env` (.dockerignore). So values set
# only at runtime (via compose `env_file: .env`) never reach `useRuntimeConfig()`
# unless they use the NUXT_ override prefix. Without this, RESEND_API_KEY /
# APP_BASE_URL would be empty in the running server (no reset emails, broken
# links) and R2_* would silently fall back to local-disk storage. We keep the
# plain names in `.env` and map them here. Only maps when the plain var is set
# and the NUXT_ one isn't already provided (so explicit NUXT_* still wins).
map_runtime_env() {
  local plain="$1" nuxt="$2"
  if [ -n "${!plain:-}" ] && [ -z "${!nuxt:-}" ]; then
    export "$nuxt"="${!plain}"
  fi
}

map_runtime_env DATABASE_URL          NUXT_DATABASE_URL
map_runtime_env MEDIA_DIR             NUXT_MEDIA_DIR
map_runtime_env RESEND_API_KEY        NUXT_RESEND_API_KEY
map_runtime_env MAIL_FROM             NUXT_MAIL_FROM
# APP_BASE_URL maps to NUXT_MAIL_BASE_URL (runtimeConfig.mailBaseUrl) — NOT
# NUXT_APP_BASE_URL, which Nuxt reserves for app.baseURL (the router base) and
# would re-base every route, 404-ing the whole API.
map_runtime_env APP_BASE_URL          NUXT_MAIL_BASE_URL
map_runtime_env R2_ENDPOINT           NUXT_R2_ENDPOINT
map_runtime_env R2_BUCKET             NUXT_R2_BUCKET
map_runtime_env R2_ACCESS_KEY_ID      NUXT_R2_ACCESS_KEY_ID
map_runtime_env R2_SECRET_ACCESS_KEY  NUXT_R2_SECRET_ACCESS_KEY

exec node .output/server/index.mjs
