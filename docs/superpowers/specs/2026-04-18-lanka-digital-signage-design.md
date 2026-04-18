# Lanka — Digital Signage Platform

**Status:** Design approved 2026-04-18
**Owner:** Solo dev
**Target:** Prototype first; production-ready later; cloud-deployable eventually

## Summary

A simplified Yodeck alternative. Looped video/image playlists play on Android TVs, managed from a web dashboard. Everything runs on a Tailscale tailnet — no public exposure, no auth layer, no HTTPS concerns. One Nuxt app serves both the dashboard and the player webpage; a thin Android WebView APK hosts the player fullscreen. Target scale: 50 TVs in year one.

## Goals

- Centrally manage playlists and TV assignments from a web dashboard.
- TVs play looped content reliably, including when the network briefly drops.
- Playlist changes propagate to TVs within seconds.
- Deployment is reproducible locally now and portable to cloud later without rework.
- Solo-dev maintainable — minimal moving parts, boring choices.

## Non-goals (v1)

- Multi-tenant / multi-user / RBAC.
- Time-of-day or day-of-week scheduling.
- Multi-zone layouts (picture-in-picture, split screens).
- Web-URL playlist items (iframes to dashboards, Google Slides, etc.).
- Proof-of-play analytics.
- Emergency broadcast / instant-message overlay.
- OTA APK updates.
- Cloud deployment (design accommodates it; not executed in v1).

## Trust model

- All traffic lives on a Tailscale tailnet owned by one operator.
- No authentication on the API. No CORS. No HTTPS termination.
- Nitro binds to `0.0.0.0` on the tailnet host.
- Device identity is a device-generated identifier (Android ID on real devices, fallback to a stored UUID on emulators or if Android ID is unavailable) claimed by the operator in the dashboard.

## Architecture

One Nuxt 4 app, two surfaces:

```
┌──────────────────────────────────┐          ┌─────────────────────────┐
│  Nuxt app (dashboard + API)      │◄─────────┤  Android WebView APK    │
│  - Pages: /addresses, /groups,   │  HTTP    │  - Thin native shell    │
│    /devices, /playlists, /media  │  on      │  - WebView loads        │
│  - Nitro server routes /api/*    │  tailnet │    /player?deviceId=X   │
│  - SSE streams per device &      │          │  - JS bridge for:       │
│    per dashboard session         │          │    download, exists,    │
│  - SQLite (better-sqlite3)       │          │    evictExcept, fileUrl │
│  - Local filesystem media store  │          │                         │
│  - Pinia store (dashboard)       │          │                         │
└──────────────┬───────────────────┘          └─────────────────────────┘
               │
               ▼
     ./data/media/<sha256>          (no extension; `kind` held in DB)
     ./data/signage.db
```

### Stack

- **Runtime:** Node.js 22 LTS.
- **Framework:** Nuxt 4 (Vue 3, `<script setup>`, TypeScript). Nitro server routes carry the API.
- **UI:** Nuxt UI (Tailwind-based), dark mode default.
- **State:** Pinia in the dashboard.
- **DB:** SQLite via `better-sqlite3` with Drizzle ORM + drizzle-kit migrations.
- **Media storage:** local disk, content-addressed by sha256, behind a `MediaStore` interface so the impl can be swapped for S3-compatible later.
- **Thumbnails:** `sharp` for images, `ffmpeg` for first-frame video thumbs — both at upload time.
- **Transport:** HTTP + SSE (one-way). No WebSocket.
- **Tests:** `vitest` for unit + integration. Nuxt Test Utils for a few critical component flows.

## Domain model

Three-level hierarchy: **Address → Group → Device**. One address usually has one group but may have several. Playlists can be assigned at any level. Resolution is **most-specific-wins**: Device > Group > Address.

### Tables

```
addresses(id, name, created_at, updated_at)

groups(id, address_id → addresses, name, created_at, updated_at)

devices(
  id              TEXT PRIMARY KEY,           -- device-generated: Android ID, or stored UUID fallback
  group_id        INTEGER NULL → groups,      -- null = unclaimed
  name            TEXT NULL,                  -- null until claimed
  last_seen_at    DATETIME,
  player_version  TEXT,
  current_item_id INTEGER NULL → playlist_items ON DELETE SET NULL,
  created_at, updated_at
)

media(
  id          INTEGER PRIMARY KEY,
  sha256      TEXT UNIQUE NOT NULL,
  kind        TEXT CHECK (kind IN ('video','image')),
  filename    TEXT NOT NULL,                 -- original upload name, display only
  bytes       INTEGER NOT NULL,
  duration_ms INTEGER NULL,                  -- videos only
  width       INTEGER NULL,
  height      INTEGER NULL,
  created_at
)

playlists(
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,     -- bumped atomically on any edit
  created_at, updated_at
)

playlist_items(
  id                    INTEGER PRIMARY KEY,
  playlist_id           INTEGER → playlists,
  media_id              INTEGER → media,
  position              INTEGER NOT NULL,
  duration_ms_override  INTEGER NULL,        -- required for images; ignored for videos
  UNIQUE (playlist_id, position)
)

assignments(
  id          INTEGER PRIMARY KEY,
  playlist_id INTEGER → playlists,
  device_id   TEXT    NULL UNIQUE → devices,
  group_id    INTEGER NULL UNIQUE → groups,
  address_id  INTEGER NULL UNIQUE → addresses,
  created_at, updated_at,
  CHECK (
    (device_id  IS NOT NULL) +
    (group_id   IS NOT NULL) +
    (address_id IS NOT NULL) = 1
  )
)
```

The `assignments` table holds exactly one target per row (enforced by `CHECK` and the three `UNIQUE` nullable columns). Resolution for a device executes:

```sql
SELECT playlist_id, 'device' AS level FROM assignments WHERE device_id = :id
UNION ALL
SELECT a.playlist_id, 'group' AS level FROM assignments a
  JOIN devices d ON d.group_id = a.group_id
  WHERE d.id = :id
UNION ALL
SELECT a.playlist_id, 'address' AS level FROM assignments a
  JOIN groups g   ON g.address_id = a.address_id
  JOIN devices d  ON d.group_id   = g.id
  WHERE d.id = :id
LIMIT 1;
```

The `UNION ALL` preserves priority order; first row wins. The `level` column lets the dashboard surface the matched tier ("inherited from group *Lobby*"). The device's manifest response does not include `level`; it's a dashboard-only concern.

### Version bumping

`playlists.version` is incremented atomically in a single transaction on any change that affects what a device would play:

- Playlist rename
- Item added, removed, reordered
- `duration_ms_override` changed
- `media_id` of any item changed (note: re-uploading the same content yields the same `sha256`, so `media_id` usually doesn't change; but swapping to a different video file does)

Assignment changes do **not** bump `playlists.version` — they change which playlist a device resolves to, which the device sees as a `playlistId` change in its next manifest.

## Sync protocol

### Endpoints called by the player

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/devices/register` | Idempotent self-registration. Body: `{ deviceId, playerVersion }`. Creates new `devices` row if unknown, else updates `player_version` + `last_seen_at`. |
| `GET`  | `/api/devices/:id/manifest` | Returns current resolved playlist manifest or `204 No Content`. Updates `last_seen_at` as a side effect. |
| `GET`  | `/api/devices/:id/stream` | SSE connection. Events: `manifest-changed`, `reload`, `ping`. |
| `POST` | `/api/devices/:id/telemetry` | Fire-and-forget: `{ currentItemId, error? }`. Updates `current_item_id`. |
| `GET`  | `/media/:sha256` | Binary file with `Range:` support. `Cache-Control: public, max-age=31536000, immutable`. |

### Manifest shape

```json
{
  "playlistId": 42,
  "playlistName": "Summer Promo",
  "version": 7,
  "items": [
    { "id": 101, "type": "video", "sha256": "abc…", "durationMs": 15000 },
    { "id": 102, "type": "image", "sha256": "def…", "durationMs": 8000 }
  ]
}
```

If no assignment resolves, the endpoint returns `204 No Content`. Player displays a built-in "No content assigned" screen and keeps polling.

### Player reconcile loop

```
boot:
  deviceId = localStorage.get('deviceId') ?? nativeDevice.deviceId()
  await register(deviceId)
  await reconcile()
  openSSE()
  setInterval(reconcile, 30_000)   // fallback

on SSE 'manifest-changed' → reconcile()
on SSE 'reload'           → nativeDevice.reload()

reconcile():
  m = GET /api/devices/:id/manifest
  if m is 204: showNoContent(); last = null; return
  if m.playlistId === last?.playlistId && m.version === last?.version: return
  for item in m.items:
    if !(await nativeFS.exists(item.sha256)):
      await nativeFS.download(`/media/${item.sha256}`, item.sha256)
  await nativeFS.evictExcept(m.items.map(i => i.sha256))
  loadPlaylist(m)
  last = { playlistId: m.playlistId, version: m.version }
```

### Why polling + SSE

SSE delivers changes within seconds. The 30-second poll is insurance: recovers from any disconnect without reconnect bookkeeping, and provides a reliable heartbeat for `last_seen_at`.

### Failure handling

- **Download fails** → item skipped during playback, retried on next reconcile. Telemetry posts `{ sha256, error }`; dashboard surfaces a red dot on the device.
- **Manifest `204`** → "No content" screen; polling continues.
- **SSE drops** → `EventSource` auto-reconnects; poll fills the gap in the meantime.
- **Server unreachable on boot** → APK shows "Connecting…" overlay, retries every 5s.

## Player & APK

### Division of labor

| Layer | Built with | Ships how | Responsibilities |
|---|---|---|---|
| **APK (native shell)** | Kotlin, Android WebView | Sideloaded via `adb` | Fullscreen kiosk, filesystem bridge, auto-start on boot, server-URL config |
| **Player (web)** | Nuxt route `/player` | Deployed with the dashboard | Playlist loop, double-buffered rendering, reconcile logic, SSE client, telemetry |

Player iteration happens in the Nuxt codebase; TVs pick up new player code on next reload without touching the APK.

### Native bridge contract

```ts
interface NativeFS {
  download(url: string, sha256: string): Promise<void>   // atomic write
  exists(sha256: string): Promise<boolean>
  evictExcept(keep: string[]): Promise<void>             // prune orphans
  fileUrl(sha256: string): string                        // for <video>/<img>
  free(): Promise<{ usedBytes: number, freeBytes: number }>
}
interface NativeDevice {
  deviceId(): string                // Android ID — stable per-device, survives reinstall
  reload(): void                    // WebView reload
  version(): { app: string, os: string, model: string }
  serverUrl(): string               // configured at APK build or via setup screen
}
```

The APK uses `WebViewAssetLoader` to expose cached files as `https://appassets.androidplatform.net/media/<sha256>`, avoiding `file://` and CORS issues. `<video>` and `<img>` work with these URLs.

### Player rendering

- **Double-buffered `<video>` elements** — two stacked, z-index swapped on `ended` / `canplay`. Preload item N+1 during item N → no black flash.
- **Images** preloaded into a hidden `<img>` during the prior item, swapped on timer.
- Fullscreen, black background, no UI chrome.
- **On media error** (decode failure, missing file): skip item, POST telemetry, continue loop.

### APK responsibilities

- Launch on boot (`RECEIVE_BOOT_COMPLETED`).
- Fullscreen kiosk: immersive mode, `FLAG_KEEP_SCREEN_ON`, intercept HOME/BACK/RECENTS.
- Watchdog (`JobScheduler`) re-launches the app if the WebView process dies.
- Single-tenant: one `SERVER_URL` per install (baked in at build or overridden via a minimal native setup screen stored in `SharedPreferences`).
- No playback logic, no playlist state, no HTTP / SSE — the JS does all of that.

### Update paths

| What changed | How TVs get it |
|---|---|
| Playlist content | SSE `manifest-changed` → reconcile in seconds |
| Player code (HTML/JS) | SSE `reload` event or next boot pulls fresh Nuxt bundle |
| APK shell | Manual `adb install -r` for v1 |

## Dashboard UX

### Information architecture

```
Overview        — counts, unclaimed tray, red-dot feed
Addresses       — list + detail (groups, assigned playlist)
Groups          — list + detail (devices, assigned playlist)
Devices         — list + detail (status, resolved playlist, actions)
Media           — grid, upload, preview, delete-if-unused
Playlists       — list + editor (drag-reorder, per-image duration)
```

Assignment UI lives **inline on each target's detail page** (one "Assigned playlist" row with a picker). Playlist detail reciprocally shows "assigned at: …" for back-reference.

### Pages that matter

**Overview** — "is anything broken?" in one screen.
- Four stat cards: Total / Online / Offline >5min / Unclaimed
- Expandable unclaimed tray (name field + group picker + "Claim" per row)
- Red-dot feed listing devices with recent playback errors

**Devices list** — single table, filterable by address/group.
- Columns: Name, Address/Group, Status dot, Playing now, Last seen
- Status derives from `last_seen_at`: ≤60s green, ≤5m yellow, >5m red
- Row actions: Reload, Move, Rename, Delete
- Live refresh via `/api/dashboard/stream` SSE (poll fallback)

**Device detail** — everything about one TV.
- Header: name, status, last seen, player version
- "Playing" card: current item thumb + title, playlist name, **resolution source** label
- Actions: Reload • Override with direct assignment • Clear direct assignment • Move • Delete

**Media library** — grid of thumbnails.
- Drag-drop or button upload; server computes sha256 (dedupe), stores file, generates thumbnail on ingest
- Tile: thumbnail, filename, duration/dimensions, "used in N playlists" chip
- Delete disabled if used anywhere; force-delete with confirm

**Playlist editor** — the one page that deserves care.
- Left: searchable media picker
- Right: ordered item list (drag-to-reorder)
- Per item: thumb, title, duration input (enabled for images, read-only for videos)
- "Save" bumps `playlists.version`; change propagates via SSE to all resolving devices

### Conventions

- Optimistic updates on mutations with toast rollback on failure.
- Confirmation dialogs only for destructive actions.
- Filters + selections reflected in the URL query string.
- Dark mode default; desktop-only (no mobile layout in v1).

## Repo layout

```
lanka/
├── app/                          # Nuxt dashboard + player pages
│   ├── pages/
│   │   ├── index.vue                 # Overview
│   │   ├── addresses/[[id]].vue
│   │   ├── groups/[[id]].vue
│   │   ├── devices/[[id]].vue
│   │   ├── media.vue
│   │   ├── playlists/[[id]].vue
│   │   └── player.vue                # served to the APK
│   ├── components/
│   ├── composables/
│   └── app.config.ts
├── server/                       # Nitro server routes + services
│   ├── api/
│   │   ├── devices/
│   │   │   ├── [id]/manifest.get.ts
│   │   │   ├── [id]/stream.get.ts
│   │   │   ├── [id]/telemetry.post.ts
│   │   │   ├── [id].patch.ts
│   │   │   └── register.post.ts
│   │   ├── addresses/…
│   │   ├── groups/…
│   │   ├── playlists/…
│   │   ├── media.post.ts
│   │   └── dashboard/stream.get.ts
│   ├── routes/media/[sha256].get.ts
│   ├── services/
│   │   ├── resolver.ts
│   │   ├── media-store.ts
│   │   ├── events.ts
│   │   └── playlist-version.ts
│   ├── db/
│   │   ├── schema.ts
│   │   ├── client.ts
│   │   └── migrations/
│   └── utils/
├── android/                      # APK source (Kotlin)
│   ├── app/
│   └── gradle/
├── docs/
│   └── superpowers/
│       ├── specs/
│       └── plans/
├── data/                         # bind-mounted at runtime
│   ├── signage.db
│   └── media/
├── Dockerfile
├── docker-compose.yml
├── drizzle.config.ts
├── nuxt.config.ts
├── package.json
└── .env.example
```

## Deployment

### Local target (v1)

Ubuntu host running Tailscale, Docker, and one `docker compose` service. Development is done outside Docker (`pnpm dev`); the compose file below is the production shape.

```yaml
# docker-compose.yml
services:
  lanka:
    build: .
    restart: unless-stopped
    network_mode: host
    environment:
      - NODE_ENV=production
      - DATABASE_URL=file:/app/data/signage.db
      - MEDIA_DIR=/app/data/media
      - PORT=3000
    volumes:
      - ./data:/app/data
```

`network_mode: host` lets the container reach the Tailscale interface without port-mapping. Systemd unit runs `docker compose up` on boot.

### Dockerfile shape

Multi-stage: `node:22-alpine` builder → runtime. Builder compiles `better-sqlite3` native bindings. Runtime ships `.output/`, `node_modules`, and an `ffmpeg` binary.

### Backups

Nightly cron:

```bash
sqlite3 /opt/lanka/data/signage.db \
  ".backup '/opt/lanka/backups/$(date +%F).db'"
rsync -a /opt/lanka/data/media /opt/lanka/backups/media/
```

Seven-day retention.

### Cloud-compat seams (built from day one)

- `MediaStore` interface with `LocalDiskStore` impl. Swap in `S3Store` (R2/MinIO/S3) to migrate media. ~50 lines.
- Drizzle ORM queries kept dialect-agnostic. SQLite → Postgres later is a config change + regenerated migrations, not a rewrite.
- Logs to stdout only (`pino`). Any platform picks them up.
- Config exclusively via env vars (12-factor).
- When cloud-migrating, Tailscale moves from host install to the `tailscale/tailscale` sidecar in Compose.

## Testing

- **Unit (vitest)** — `server/services/` (resolver, version bumper, media-store). These are where silent bugs hurt most.
- **Integration (vitest + in-memory SQLite)** — Nitro route handlers for register, manifest, assignments, media upload.
- **Component (Nuxt Test Utils)** — playlist editor reorder, claim-device flow.
- **Manual E2E** — APK in Android emulator against a dev server. No Playwright in v1.

## Dev workflow

- `pnpm dev` — Nuxt dev server with HMR
- `pnpm db:migrate` / `pnpm db:studio` — drizzle-kit
- `pnpm test` / `pnpm test:watch`
- Android Studio for the APK; emulator points at the dev machine's tailnet IP

## Open questions (deferred)

- Telemetry detail — item-change only for v1; consider per-item start/finish pairs if proof-of-play is ever needed.
- APK OTA updates — revisit past ~10 devices.
- Per-playlist shuffle / gap content / audio mute — add only when a real need appears.
