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
| POST | `/api/media` | Upload a media file (multipart: `file`, `kind=video\|image`) — legacy/sync, superseded by the async upload flow below |
| GET  | `/api/media` | List media with usage counts |
| GET  | `/api/media/:id` | Get a single media row |
| DELETE | `/api/media/:id` | Delete media (409 if in use; `?force=true` to cascade) |
| GET  | `/media/:sha256` | Serve a media file (supports Range) |
| GET  | `/media/:sha256/thumb` | Serve JPEG thumbnail |
| POST | `/api/media/uploads` | Create an upload job; returns a presigned PUT ticket (R2) or a local-disk upload URL. `mimeType` must be `video/*`/`image/*` matching `kind`, or `application/octet-stream` (browsers report an empty type for extensions like `.mkv`/`.ts`) |
| PUT | `/api/media/uploads/:id/file` | Upload the file bytes (local-disk `MediaStore` only) |
| POST | `/api/media/uploads/:id/complete` | Verify the staged object and enqueue background ingest |
| GET | `/api/media/uploads/:id` | Poll upload job status |
| GET | `/api/media/uploads?active=1` | List in-flight (non-terminal) upload jobs |
| DELETE | `/api/media/uploads/:id` | Cancel an upload job |

> **Media storage backend.** By default media lives on local disk (`MEDIA_DIR`).
> Set all four `R2_*` env vars (see `.env.example`) to store it in Cloudflare R2
> instead. Either way the API is identical: the server serves `/media/:sha256`,
> and with R2 it proxies the bytes (Range included). In the Hetzner+Cloudflare
> production deployment, players fetch full media bytes directly from the
> `media.lanka.live` CDN (set via `MEDIA_PUBLIC_BASE`) — the `/media/:sha` proxy
> route is then used only for thumbnails and local-disk dev. Switching backends
> does not migrate existing objects; re-upload or copy them across.

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

### Users

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/users` | List users (super sees all; admin sees clients only) |
| POST | `/api/users` | Create a user (super/admin; admin limited to `client` role) |
| DELETE | `/api/users/:id` | Delete a user (super/admin; admin limited to client accounts) |

### Auth

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Email + password login |
| POST | `/api/auth/logout` | Destroy session |
| POST | `/api/auth/forgot-password` | Request a password-reset email (public) |
| POST | `/api/auth/reset-password` | Consume reset token and set new password (public) |

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

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `file:./data/signage.db` | SQLite path |
| `MEDIA_DIR` | `./data/media` | Local media storage root |
| `HOST` | unset (0.0.0.0) | Bind address — set to `127.0.0.1` in production |
| `PORT` | 3000 | HTTP listen port |
| `SESSION_COOKIE_SECURE` | unset | Set to `true` in production (HTTPS only) |
| `MEDIA_PUBLIC_BASE` | unset | Public CDN base URL for media (e.g. `https://media.lanka.live`). Baked into SPA at build time. |
| `MAX_UPLOAD_BYTES` | `2147483648` (2 GiB) | Cap for dashboard uploads |
| `GOOGLE_CLIENT_ID` | unset | Public Google OAuth Client ID for "Sign in with Google". Baked into the SPA at build time (like `MEDIA_PUBLIC_BASE`). Empty → Google button hidden. No client secret is used. |
| `R2_ENDPOINT` | unset | R2-compatible endpoint URL |
| `R2_BUCKET` | unset | R2 bucket name |
| `R2_ACCESS_KEY_ID` | unset | R2 access key |
| `R2_SECRET_ACCESS_KEY` | unset | R2 secret key |
| `RESEND_API_KEY` | unset | Resend API key — if set, password-reset emails are sent via Resend; if unset, `LogMailer` prints the reset link to the server log |
| `MAIL_FROM` | `Lanka <no-reply@lanka.live>` | Sender address for password-reset emails |
| `APP_BASE_URL` | unset | Absolute base URL of the app (e.g. `https://app.lanka.live`) — required so emailed reset links are absolute |
| `SEED_SUPER_EMAIL` | `super@lanka.live` | Email address for the seeded super account |
| `SEED_ADMIN_EMAIL` | `admin@lanka.live` | Email address for the seeded admin account |
| `SEED_CLIENT_EMAIL` | `client@lanka.live` | Email address for the seeded client account |
| `SEED_SUPER_PASSWORD` | (random, logged) | Password for the seeded super account |
| `SEED_ADMIN_PASSWORD` | (random, logged) | Password for the seeded admin account |
| `SEED_CLIENT_PASSWORD` | (random, logged) | Password for the seeded client account |

## Deployment

Production runs on a Hetzner Cloud box (Ubuntu 24.04) using a hybrid model: the Nitro app binds `127.0.0.1:3000` and is never exposed directly. nginx is the single front door with two server blocks — a **public block** on `127.0.0.1:8080` that `cloudflared` dials (returns 403 for the device control plane, rate-limits `/api/auth/login`, proxies everything else) and a **tailnet block** on `tailscale0:80` that the TVs hit. The admin dashboard is reachable at `https://app.lanka.live` via a **Cloudflare Tunnel** (outbound-only — no inbound ports open on the box). Media (videos, images) is served from a public **R2 CDN** at `https://media.lanka.live` straight to the TVs; the Hetzner box is never in the media-serving path. Uploads still flow through the app into R2.

```
Admin browser ─HTTPS─► Cloudflare edge ─tunnel─► cloudflared ─► nginx :8080 ─► app 127.0.0.1:3000
TV (control)  ─tailscale0─► nginx 100.x:80 ─────────────────────────────────► app 127.0.0.1:3000
TV (media)    ─HTTPS─► Cloudflare CDN (media.lanka.live, backed by R2)
```

### Host prerequisites

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin sqlite3 rsync curl git nginx
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# cloudflared: install via the Cloudflare apt repo (see operator runbook)
```

Also configure the host firewall (Hetzner Cloud Firewall + ufw): allow inbound SSH only; deny inbound 80/443 — the Cloudflare Tunnel is outbound so no public HTTP(S) port is needed.

### First install — overview

For the exact step-by-step commands and expected output, follow the **operator runbook** in `docs/superpowers/plans/2026-06-08-lanka-hetzner-cloudflare-deployment.md` (Phase 3, Tasks 13–17). The high-level order is:

1. **Provision + packages + Tailscale + firewall** — install nginx, Docker, cloudflared; join tailnet; lock firewall to SSH-only inbound.
2. **Cloudflare zone** — move `lanka.live` DNS from GoDaddy to Cloudflare (change nameservers); activate the zone.
3. **Tunnel + R2** — create a named Cloudflare Tunnel (`lanka`) and add the `app.lanka.live` DNS route; create the R2 bucket `lanka-media`, attach the `media.lanka.live` custom domain, and generate an R2 API token.
4. **Write `/opt/lanka/.env`** — set `HOST=127.0.0.1`, `SESSION_COOKIE_SECURE=true`, `MEDIA_PUBLIC_BASE=https://media.lanka.live`, `GOOGLE_CLIENT_ID` (consumed at `docker compose up --build` time, like `MEDIA_PUBLIC_BASE`), the four `R2_*` vars, `SEED_*` passwords, `RESEND_API_KEY`, `MAIL_FROM`, `APP_BASE_URL`, etc.
5. **Install configs + systemd units** — copy the nginx config (substitute the tailnet IP for the `TAILSCALE_IP` token), link `ops/nginx/lanka-proxy.conf` as a snippet, reload nginx; install `ops/cloudflared/config.yml` (substitute the tunnel UUID) and run `cloudflared service install`; copy `ops/lanka.service`, `ops/lanka-backup.{service,timer}` and `systemctl daemon-reload`.
6. **Build + start** — `docker compose up -d --build` (bakes `MEDIA_PUBLIC_BASE` into the SPA bundle); start nginx and cloudflared. Grab seeded passwords from `docker logs lanka` if `SEED_*` were left blank.

### Upgrading

```bash
ssh <lanka-host>
cd /opt/lanka
sudo ./scripts/deploy.sh
```

The script snapshots the DB before the pull, builds and restarts, then polls `http://127.0.0.1:3000/api/healthz` for up to ~90s (30 attempts × 2s sleep, 3s curl timeout). On failure it rolls the working tree back to the pre-pull HEAD and rebuilds the previous version. (`HOST=127.0.0.1` in `.env`, so the healthz URL resolves correctly.)

### Restore from backup

```bash
sudo systemctl stop lanka
sudo rm -f /opt/lanka/data/signage.db /opt/lanka/data/signage.db-wal /opt/lanka/data/signage.db-shm
sudo cp /opt/lanka/backups/db/signage-YYYY-MM-DD.db /opt/lanka/data/signage.db
sudo systemctl start lanka
```

DB snapshots retain 7 days. Media lives in **R2** — R2 is the media source of truth. The nightly `rsync --delete` mirrors only the near-empty local `MEDIA_DIR`; to recover media, the R2 bucket itself is the authoritative copy (enable R2 object versioning or an offsite R2 sync for point-in-time recovery if needed).

### Offsite backups (optional, future)

Drop an executable at `/opt/lanka/backups/offsite.sh`. `backup.sh` invokes it at the end of each nightly run with the backup root as `$1`. No code change needed.

### Known limitations

- **Dashboard uploads bypass Cloudflare.** `app.lanka.live` sits behind Cloudflare's
  proxy, which rejects request bodies over 100 MB (Free/Pro plan). Uploads therefore
  go `POST /api/media/uploads` → presigned **PUT straight to the R2 S3 endpoint**
  (up to 5 GiB per object; app cap `MAX_UPLOAD_BYTES`, default 2 GiB) → `…/complete`,
  and the transcode runs in a background worker (no request is held open). This
  needs a **one-time bucket setup** — run `scripts/r2-bucket-setup.mjs` (see
  "Common tasks"; it installs the CORS rule below *and* a lifecycle rule that
  expires `uploads/*` after 1 day as a backstop) or paste the CORS rule in the
  Cloudflare dashboard (R2 → bucket → Settings → CORS policy):
  ```json
  [{ "AllowedOrigins": ["https://app.lanka.live"], "AllowedMethods": ["PUT"],
     "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
  ```
  Without it the browser's PUT fails with a CORS error and the job stays `pending`
  (expired automatically after 24 h). Staged objects live under `uploads/<uuid>` and
  are deleted once ingested. Uploaded source material is treated as **non-confidential**
  (signage content is public by nature): a staged object is anonymously readable by
  anyone who obtains its unguessable URL until it is deleted. Transient ingest failures
  (R2/disk/DB) are retried up to 3 times with backoff; ffmpeg rejecting the file fails
  the job immediately.
- **The dashboard depends on the tunnel.** If `cloudflared` is down, the dashboard is
  unreachable — but the fleet keeps playing (control is tailnet, media is CDN).

## Operations

### Logs

- App logs: `docker logs -f lanka` (last 30MB, 3 files × 10MB — configured in `docker-compose.yml`).
- Service lifecycle: `journalctl -u lanka -f`.
- Backup runs: `journalctl -u lanka-backup`.

### Health

- `GET /api/healthz` returns 200 when SQLite responds to `SELECT 1` and `MEDIA_DIR` is writable. The Docker `HEALTHCHECK` polls it every 30s; `docker ps` shows the container as healthy/unhealthy. `restart: unless-stopped` recovers from crashes.

### Email (password reset)

Password-reset emails are sent via the [Resend](https://resend.com) HTTP API when `RESEND_API_KEY` is set. When `RESEND_API_KEY` is absent or empty, the app falls back to `LogMailer`, which prints the reset link to the server log — useful for local dev and for inspecting the link without configuring a mailer.

Required env vars for production email:
- `RESEND_API_KEY` — API key from the Resend dashboard.
- `MAIL_FROM` — sender address, e.g. `Lanka <no-reply@lanka.live>`. The domain (`lanka.live`) must be verified in Resend (add Resend SPF/DKIM DNS records on the domain).
- `APP_BASE_URL` — absolute base URL of the app, e.g. `https://app.lanka.live`. This is required so that emailed reset links are absolute URLs that open the correct host.

Set these (plus the `R2_*` vars) as plain names in `/opt/lanka/.env`. The container build bakes `runtimeConfig` defaults at build time and excludes `.env`, so the entrypoint (`scripts/entrypoint.sh`) bridges these plain names to the `NUXT_*` runtime overrides Nitro actually reads (e.g. `APP_BASE_URL` → `NUXT_MAIL_BASE_URL`). Without that bridge they would never reach the running server. If you bypass the entrypoint, set the `NUXT_*` names directly.

The nginx public block should rate-limit `POST /api/auth/forgot-password` the same way it rate-limits `POST /api/auth/login`, to prevent abuse.

### Backups

- Schedule: nightly at 03:00 local (`lanka-backup.timer`).
- DB snapshot: `/opt/lanka/backups/db/signage-YYYY-MM-DD.db`, 7-day retention.
- Media mirror: `/opt/lanka/backups/media/` (current state, `rsync --delete`).
- Manual run: `sudo systemctl start lanka-backup.service`.
- Next scheduled run: `systemctl list-timers lanka-backup.timer`.

### Common tasks

- Shell into the container: `docker exec -it lanka bash`
- Inspect the DB from the host: `sqlite3 /opt/lanka/data/signage.db`
- Rotate to a new tailnet IP: re-render the nginx tailnet block and reload nginx — `sudo sed "s/TAILSCALE_IP/$(tailscale ip -4 | head -n1)/" /opt/lanka/ops/nginx/lanka.conf | sudo tee /etc/nginx/sites-available/lanka.conf` then `sudo systemctl reload nginx`.
- Install/refresh the R2 bucket rules (CORS + 1-day lifecycle on uploads/): `docker cp scripts/r2-bucket-setup.mjs lanka:/app/r2-bucket-setup.mjs && docker exec lanka node /app/r2-bucket-setup.mjs --origin https://app.lanka.live` (must land under `/app` — ESM bare-specifier resolution for `@aws-sdk/client-s3` walks up from the script's own directory, and `/tmp` has no `node_modules`)

## Next plans

1. **Deployment** (Plan 4) — Dockerfile, Compose, systemd, backups.
2. **Android APK** (Plan 5) — native kiosk shell with FS bridge.
