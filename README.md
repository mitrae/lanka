# Lanka

Self-hosted digital signage for Android TVs on a Tailscale tailnet.

**Status:** Plan 1 + Plan 2a + Plan 2b complete — foundation, device sync, admin CRUD API, and dashboard UI.

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

### Device API (called by the player APK)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/devices/register` | Device self-registration (idempotent) |
| GET  | `/api/devices/:id/manifest` | Device fetches resolved playlist manifest |
| GET  | `/api/devices/:id/stream` | SSE — push events to the device |
| POST | `/api/devices/:id/telemetry` | Device reports current item / errors |

### Media

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/media` | Upload a media file (multipart: `file`, `kind=video\|image`) |
| GET  | `/api/media` | List media with usage counts |
| GET  | `/api/media/:id` | Get a single media row |
| DELETE | `/api/media/:id` | Delete media (409 if in use; `?force=true` to cascade) |
| GET  | `/media/:sha256` | Serve a media file (supports Range) |
| GET  | `/media/:sha256/thumb` | Serve JPEG thumbnail |

### Admin CRUD

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/addresses` | List / create |
| GET/PATCH/DELETE | `/api/addresses/:id` | Read / rename / delete (cascades) |
| GET/POST | `/api/groups` (+`?addressId=N`) | List / create |
| GET/PATCH/DELETE | `/api/groups/:id` | Read / rename or move / delete |
| GET | `/api/devices` (+`?groupId=…&addressId=…&unclaimed=true`) | List with live status |
| GET/PATCH/DELETE | `/api/devices/:id` | Read / claim-or-rename / delete |
| POST | `/api/devices/:id/reload` | Kick the WebView to reload via SSE |
| GET/POST | `/api/playlists` | List (summary) / create |
| GET/PATCH/DELETE | `/api/playlists/:id` | Read (with items) / rename / delete |
| PUT | `/api/playlists/:id/items` | Bulk replace items |

### Assignments (target-addressed)

| Method | Path | Purpose |
|---|---|---|
| PUT/DELETE | `/api/assignments/devices/:id` | Set or clear device-level assignment |
| PUT/DELETE | `/api/assignments/groups/:id` | Set or clear group-level assignment |
| PUT/DELETE | `/api/assignments/addresses/:id` | Set or clear address-level assignment |

### Dashboard SSE

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dashboard/stream` | SSE — receives mirrored device events + dashboard-only events |

## Project structure

```
server/        Nitro routes, services, DB client & schema
tests/         vitest tests (services, api, integration, helpers)
data/          runtime data (DB + media files) — gitignored
docs/          superpowers specs and plans
```

## Design spec

`docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`

## Dashboard

Visit `http://localhost:3000` during dev. Routes:

- `/` — Overview (stat cards, unclaimed-device claim tray)
- `/addresses` — Addresses list + detail
- `/groups` — Groups list + detail (filterable by address)
- `/devices` — Devices list with live SSE status + detail with reload / assignment override
- `/media` — Media library with drag-drop upload
- `/playlists` — Playlists list + editor (reorder + inline image-duration)

Dark mode default; toggle in the header. Desktop-only (minimum 1280px wide). Runs as a Nuxt SPA (`ssr: false`).

## Next plans

1. **Player web page** (Plan 3) — `/player` Nuxt route with double-buffered playback + SSE client for TVs.
2. **Deployment** (Plan 4) — Dockerfile, Compose, systemd, backups.
3. **Android APK** (Plan 5) — native kiosk shell with FS bridge.
