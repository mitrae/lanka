# ---- builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG MEDIA_PUBLIC_BASE=""
ENV MEDIA_PUBLIC_BASE=$MEDIA_PUBLIC_BASE
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://'+process.env.HOST+':'+process.env.PORT+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/entrypoint.sh"]
