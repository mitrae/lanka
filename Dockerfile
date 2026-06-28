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
    sqlite3 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm
COPY --from=builder /app/.output       ./.output
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/server/db     ./server/db
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/package.json  ./
COPY scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod +x ./scripts/entrypoint.sh
# Probe loopback (always reachable in-container whether the app binds 127.0.0.1
# or 0.0.0.0) and default the port, so a missing/!=3000 HOST/PORT in the
# environment can't make this resolve to http://undefined:.../ and flap unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/entrypoint.sh"]
