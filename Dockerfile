# ---- builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# @ffprobe-installer ships the binary non-executable and relies on a postinstall
# chmod that pnpm's build-script gating may skip; guarantee it here.
RUN node -e "require('fs').chmodSync(require('@ffprobe-installer/ffprobe').path, 0o755)"
COPY . .
ARG MEDIA_PUBLIC_BASE=""
ENV MEDIA_PUBLIC_BASE=$MEDIA_PUBLIC_BASE
ARG GOOGLE_CLIENT_ID=""
ENV GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
RUN pnpm build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 ca-certificates tini gosu \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm
# Unprivileged runtime user. Fixed uid/gid 10001 so the operator can predict the
# owner of files written into the bind-mounted ./data (SQLite DB + WAL).
RUN groupadd -r -g 10001 lanka \
 && useradd -r -u 10001 -g lanka -m -d /home/lanka lanka
COPY --from=builder /app/.output       ./.output
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/server/db     ./server/db
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/package.json  ./
# Maintenance scripts (`docker compose exec lanka pnpm tsx scripts/<name>.ts`),
# e.g. transcode-existing.ts backfilling media that predates a kiosk-safety
# rule. They are NOT part of .output — Nitro only bundles the request path — so
# without these the scripts are simply absent from the image and every
# documented "container exec" invocation dies with ERR_MODULE_NOT_FOUND. They
# import server/services/* by relative path (no `~` alias, so no tsconfig
# needed) and never touch Nitro auto-imports; `tsx` and the ffmpeg/ffprobe
# binaries already ship in node_modules, which is a full install from the
# builder. Together ~200 KB of TS.
COPY --from=builder /app/server/services ./server/services
COPY --from=builder /app/scripts         ./scripts
# Copied last and chmod'ed explicitly: this one must be executable regardless of
# the mode the builder stage preserved.
COPY scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod +x ./scripts/entrypoint.sh
# Own the whole app tree as the runtime user. The bind-mounted /app/data is
# re-chowned at runtime by the entrypoint (it starts as root, fixes ownership of
# the host-owned mount, then drops to `lanka` via gosu).
RUN chown -R lanka:lanka /app
# Probe loopback (always reachable in-container whether the app binds 127.0.0.1
# or 0.0.0.0) and default the port, so a missing/!=3000 HOST/PORT in the
# environment can't make this resolve to http://undefined:.../ and flap unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# NOTE: no `USER lanka` here on purpose. The container must start as root so the
# entrypoint can chown the host-owned bind-mounted /app/data (the SQLite DB + WAL
# live there); it then drops to the unprivileged `lanka` user via `gosu` before
# exec'ing node. A static `USER lanka` would make `drizzle-kit migrate` fail to
# write the DB on a fresh host-owned ./data → crash loop. tini stays PID 1.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/entrypoint.sh"]
