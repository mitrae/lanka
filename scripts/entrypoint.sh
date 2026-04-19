#!/usr/bin/env bash
set -euo pipefail

# Run migrations against the bind-mounted DB, then start Nitro.
# drizzle-kit reads DATABASE_URL from env; compose sets it to
# file:/app/data/signage.db.
pnpm exec drizzle-kit migrate

exec node .output/server/index.mjs
