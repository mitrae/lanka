# Lanka

Self-hosted digital signage for Android TVs on a Tailscale tailnet.

**Status:** Foundation & sync backbone only (Plan 1 of 5). No dashboard UI, no player page, no Docker yet — those come in later plans.

## Requirements

- Node.js 20+ (LTS)
- pnpm (via corepack: `corepack enable pnpm`)
- SQLite 3 CLI (optional, for poking at the DB)

## Setup

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
```

## Dev

```bash
pnpm dev          # Nuxt dev server on http://localhost:3000
pnpm test         # run full vitest suite
pnpm test:watch   # vitest watch mode
pnpm typecheck    # nuxt typecheck
pnpm db:studio    # Drizzle Studio (DB explorer)
pnpm db:generate  # generate a new migration from schema changes
pnpm db:migrate   # apply migrations to data/signage.db
```

## Current endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/devices/register` | Device self-registration (idempotent) |
| GET  | `/api/devices/:id/manifest` | Device fetches its resolved playlist manifest |
| GET  | `/api/devices/:id/stream` | SSE stream for push events |
| POST | `/api/devices/:id/telemetry` | Device reports current item / errors |
| POST | `/api/media` | Upload a media file (multipart, field name `file`, `kind=video\|image`) |
| GET  | `/media/:sha256` | Serve a media file (supports Range) |

## Project structure

```
server/        Nitro routes, services, DB client & schema
tests/         vitest tests (services, api, integration, helpers)
data/          runtime data (DB + media files) — gitignored
docs/          superpowers specs and plans
```

## Design spec

`docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`

## Next plans

1. **Dashboard API & UI** — CRUD for all entities + Nuxt UI admin.
2. **Player web page** — `/player` route with double-buffered playback.
3. **Deployment** — Dockerfile, Compose, systemd, backups.
4. **Android APK** — native kiosk shell.
