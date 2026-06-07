# Lanka — Claude guide

Self-hosted digital signage: Nuxt 4 monolith (dashboard + Nitro API + `/player` route) driving Android TVs over a Tailscale tailnet. Solo-dev prototype aimed at ~50 TVs. Deployed as one Docker Compose service on Ubuntu, wrapped by systemd. Design spec: `docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`.

## Commands

```bash
pnpm dev          # Nuxt dev (port 3000 by default — see "ports" below)
pnpm build        # production build → .output/
pnpm test         # full vitest suite
pnpm test:watch   # vitest watch
pnpm db:migrate   # apply migrations to data/signage.db
pnpm db:generate  # new migration from schema changes
pnpm db:studio    # Drizzle Studio
```

Run the built app with `node .output/server/index.mjs`.

## Architecture gotchas (non-obvious)

- **SPA mode** (`ssr: false` in nuxt.config). Pinia stores hold `_api: useApiClient()` — an object of functions — which Vue SSR's devalue serializer can't flatten. Dashboard lives behind Tailscale, never needed SSR. If re-enabling SSR, first move `_api` out of Pinia state.
- **Nuxt directory layout**: `srcDir: '.'` + `dir.pages: 'app/pages'` + `dir.layouts: 'app/layouts'` + `dir.middleware: 'app/middleware'`. Do not change these. Auto-imports are explicitly wired via `imports.dirs: ['app/composables', 'app/stores']` and `components: [{ path: '~/app/components' }]`. Anything under those paths is auto-imported — no explicit import needed in SFCs. **Gotcha:** because `srcDir` is `.`, every Nuxt-scanned dir defaults to repo root (`./pages`, `./middleware`, `./plugins`, …). Anything you put under `app/` must get an explicit `dir.*` (or `imports.dirs`/`components`) entry, or **Nuxt silently never scans it** — no error, the files just don't load. This already bit `app/middleware/auth.global.ts` once: without `dir.middleware` the client auth guard never ran, so unauthenticated users were not redirected to `/login` and every dashboard write 401'd. If you add `app/plugins/`, wire `dir.plugins` too.
- **`useApiClient` in Pinia state**: every store keeps `_api: useApiClient()` in state so tests can `$patch({ _api: mock })`. `tests/helpers/nuxt-stubs.ts` stubs `$fetch` so module load doesn't crash under Node.
- **Auth, sessions & seeding**: a single global Nitro middleware (`server/middleware/auth.ts`) authenticates *every* request via the `lanka_session` cookie and sets `event.context.user`; `server/services/auth-guard.ts#decideAccess` is the policy. Public (no session) routes: `/api/healthz`, `/api/devices/register`, `/api/auth/*`, and the device `manifest|stream|telemetry` endpoints; non-`/api/` paths pass through (SPA assets, guarded client-side). **401 = no/expired session, 403 = wrong role.** Roles: `super`/`admin` → full dashboard; `client` → `/portal/*` only. Sessions (`server/services/sessions.ts`): the cookie holds a random token, the DB stores only its sha256 (table `sessions`), 30-day TTL; cookie is `httpOnly`+`sameSite=lax` with **no `secure` flag** (so it works over plain-http localhost dev). Client-side guard is `app/middleware/auth.global.ts` (redirects unauth→`/login`, `client`→`/portal`). **Seeding:** `server/plugins/seed.ts` runs on startup and, *only when the `users` table is empty*, creates `super`/`admin`/`client`. Passwords come from `SEED_SUPER_PASSWORD`/`SEED_ADMIN_PASSWORD`/`SEED_CLIENT_PASSWORD`; if unset, a random one is generated and **printed to the server log once** (`[seed] created <role> … generated password: …`). So a fresh dev DB with no `SEED_*` env means you must grab the password from the startup log (or set the env and delete `data/signage.db` to reseed).
- **No `<template #header>` on pages**: earlier iterations wrapped page content with `<template #header>...</template>` intending to fill a layout slot. That syntax only works on direct children of `<NuxtLayout>`; inside `<div>` it breaks Vue's prod-build compiler with `Cannot read properties of undefined (reading 'type')`. Don't add it back — the layout's header slot is currently unused.
- **Three-level hierarchy**: Address → Group → Device. Playlist assignments work at any level; most-specific wins (Device > Group > Address).
- **Content-addressed media** by sha256. `playlists.version` bumps on any content-affecting edit. Devices sync = poll every 30s + SSE kick.
- **Pluggable media store** behind the `MediaStore` interface (`server/services/media-store.ts`). `useMediaStore()` picks `R2Store` when all four `R2_*` runtime-config values are set, else `LocalDiskStore(mediaDir)`. R2 is proxied through the server (players always fetch `/media/:sha` over the tailnet; never the public bucket). `R2Store` lazy-loads `@aws-sdk/client-s3`/`lib-storage` via dynamic import, so local-disk dev/test never loads the SDK. **`MediaStore.open()`/`openThumbnail()` return `Promise<Readable>`** (async, for the R2 fetch) — `await` them at call sites.
- **`handleDeleteMedia force=true` is atomic** via a sync `db.transaction((tx) => {...})`. The callback is synchronous (better-sqlite3 driver), so every op inside uses `.run()` / `.all()` — no `await`, no `bumpPlaylistVersion()` call. The version bump is inlined there; `bumpPlaylistVersion` in `server/services/playlist-version.ts` stays for other callers. Reads and file unlinks stay outside the transaction (unlinks are idempotent via ENOENT swallowing).
- **App version in production comes from `runtimeConfig.appVersion`, not `process.env.npm_package_version`.** The container launches via bare `node .output/server/index.mjs` (`scripts/entrypoint.sh`), which doesn't set `npm_*` env vars. `nuxt.config.ts` captures `npm_package_version` at build time (pnpm *is* running during `pnpm build`) into `runtimeConfig.appVersion`. `/api/healthz` reads it from there. Same pattern for any future "what version is running" surface.

## Ports (dev machine)

`localhost:3000-3999` is occupied by other services on this machine. Use `PORT=5100 pnpm dev` (or any 5xxx) to start Nuxt. (`.env` pins `PORT=5100`, so plain `pnpm dev` works.)

## Dev login (seed accounts)

Seeded on first run of an empty DB by `server/plugins/seed.ts`. Local dev sets known passwords via `SEED_*_PASSWORD` in `.env` (gitignored); the current dev value is **`lanka-dev`** for all three:

| username | password    | role     | access            |
|----------|-------------|----------|-------------------|
| `super`  | `lanka-dev` | `super`  | full dashboard    |
| `admin`  | `lanka-dev` | `admin`  | full dashboard    |
| `client` | `lanka-dev` | `client` | `/portal/*` only  |

**Dev-only** — production leaves `SEED_*` unset, so a random password is generated and printed to the server log once (never commit real ones). To rotate dev creds: change `SEED_*` in `.env`, delete `data/signage.db`, restart (reseeds). To set them on an existing DB without wiping it, overwrite `users.password_hash` with a `scrypt$16384$8$1$<salt_b64>$<derived_b64>` value (format per `server/services/password.ts`).

## Testing

- Vitest, `pool: 'forks'` (better-sqlite3 native module needs per-worker isolation).
- `tests/helpers/nuxt-stubs.ts` stubs Nitro auto-imports (`defineEventHandler`, `readBody`, `$fetch`, etc.) — call `handleXxx` functions directly, not the default export.
- Keep the stub file updated when a new Nitro auto-import appears in a server file imported by tests.
- `~` alias resolves to project root in both vitest and Nuxt.

## Stack

Nuxt 4 · Nuxt UI v3 (indigo on slate, light default — `app/app.config.ts` + `colorMode.preference: 'light'`) · Pinia · VueUse (via Nuxt UI) · Nitro · SQLite (better-sqlite3) · Drizzle ORM · Vitest · Docker + systemd (production). Package manager: pnpm.

## Production deployment (summary — full details in README)

- `Dockerfile` multi-stage bookworm-slim, `tini` PID 1. Runtime launches via `scripts/entrypoint.sh` (runs `drizzle-kit migrate`, then `exec node .output/server/index.mjs`).
- `docker-compose.yml` uses `network_mode: host` so Nitro can bind to the tailnet interface only (see `HOST` env var).
- `ops/lanka.service` wraps `docker compose up`; `ExecStartPre=scripts/render-env.sh` resolves the tailnet IP on every start. `Requires=tailscaled.service` → service refuses to start without a tailnet IP (defense-in-depth against accidental public bind).
- `ops/lanka-backup.{service,timer}` fires `scripts/backup.sh` nightly at 03:00: `sqlite3 .backup` (WAL-safe online backup) + `rsync --delete` media mirror, 7-day DB retention, optional `offsite.sh` drop-in hook.
- `scripts/deploy.sh` is the manual upgrade: pre-backup → `git pull --ff-only` → rebuild → 30×2s healthz poll → auto-rollback on failure via `git reset --hard $PRE_HEAD`.

## Docs

- Plans: `docs/superpowers/plans/` (Plan 1 = foundation; Plan 2a = API; Plan 2b = dashboard UI; Plan 3 = `/player`; Plan 4 = deployment — all merged).
- Design specs: `docs/superpowers/specs/` (main spec, player spec, deployment spec).
- Endpoints + Deployment + Operations summaries in `README.md`.
