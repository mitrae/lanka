# Lanka

Self-hosted digital signage for Android TVs on a Tailscale tailnet.

**Status:** Plan 1 + Plan 2a + Plan 2b + Plan 3 complete — foundation, device sync, admin CRUD API, dashboard UI, and the `/player` route.

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

## Player (`/player`)

The fullscreen player route, served by the same Nuxt app. Loaded by the
Android WebView kiosk (Plan 5) or a desktop browser for QA.

- **URL:** `http://<host>:<port>/player?deviceId=<device-id>`
  - `deviceId` query overrides the persisted id for ad-hoc testing.
  - Omit the query to use (or generate) the browser's persisted id.
- **Design:** `docs/superpowers/specs/2026-04-18-lanka-player-design.md`.
- **Behavior:** registers → fetches manifest → plays items in a loop
  (video `ended` + image timer), double-buffered. Syncs via
  `/api/devices/:id/stream` SSE + 30-second safety poll. Posts
  telemetry on each item start and on errors. Falls back to
  `NoContentScreen` on 204 and `StandbyScreen` on first-boot failures.

### Manual QA checklist

- [ ] Unclaimed → NoContentScreen, device appears in dashboard unclaimed tray
- [ ] After assignment → PlayerStage, no black flash on video→image and image→video transitions
- [ ] Playlist-version bump → seamless rebuild within ~5s
- [ ] `POST /api/devices/:id/reload` → `window.location.reload()`
- [ ] Corrupt media file → item skipped, red dot on dashboard
- [ ] Server restart mid-playback → player keeps last playlist, recovers on reconnect
- [ ] Single video playlist → native `<video loop>`, zero-gap loop
- [ ] Single image playlist → timer re-fires, telemetry re-posts every cycle

## Next plans

1. **Deployment** (Plan 4) — Dockerfile, Compose, systemd, backups.
2. **Android APK** (Plan 5) — native kiosk shell with FS bridge.
