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
- **Nuxt directory layout**: `srcDir: '.'` + `dir.pages: 'app/pages'` + `dir.layouts: 'app/layouts'`. Do not change these. Auto-imports are explicitly wired via `imports.dirs: ['app/composables', 'app/stores']` and `components: [{ path: '~/app/components' }]`. Anything under those paths is auto-imported — no explicit import needed in SFCs.
- **`useApiClient` in Pinia state**: every store keeps `_api: useApiClient()` in state so tests can `$patch({ _api: mock })`. `tests/helpers/nuxt-stubs.ts` stubs `$fetch` so module load doesn't crash under Node.
- **No `<template #header>` on pages**: earlier iterations wrapped page content with `<template #header>...</template>` intending to fill a layout slot. That syntax only works on direct children of `<NuxtLayout>`; inside `<div>` it breaks Vue's prod-build compiler with `Cannot read properties of undefined (reading 'type')`. Don't add it back — the layout's header slot is currently unused.
- **Three-level hierarchy**: Address → Group → Device. Playlist assignments work at any level; most-specific wins (Device > Group > Address).
- **Content-addressed media** by sha256. `playlists.version` bumps on any content-affecting edit. Devices sync = poll every 30s + SSE kick.
- **`handleDeleteMedia force=true` is atomic** via a sync `db.transaction((tx) => {...})`. The callback is synchronous (better-sqlite3 driver), so every op inside uses `.run()` / `.all()` — no `await`, no `bumpPlaylistVersion()` call. The version bump is inlined there; `bumpPlaylistVersion` in `server/services/playlist-version.ts` stays for other callers. Reads and file unlinks stay outside the transaction (unlinks are idempotent via ENOENT swallowing).
- **App version in production comes from `runtimeConfig.appVersion`, not `process.env.npm_package_version`.** The container launches via bare `node .output/server/index.mjs` (`scripts/entrypoint.sh`), which doesn't set `npm_*` env vars. `nuxt.config.ts` captures `npm_package_version` at build time (pnpm *is* running during `pnpm build`) into `runtimeConfig.appVersion`. `/api/healthz` reads it from there. Same pattern for any future "what version is running" surface.

## Ports (dev machine)

`localhost:3000-3999` is occupied by other services on this machine. Use `PORT=5100 pnpm dev` (or any 5xxx) to start Nuxt.

## Testing

- Vitest, `pool: 'forks'` (better-sqlite3 native module needs per-worker isolation).
- `tests/helpers/nuxt-stubs.ts` stubs Nitro auto-imports (`defineEventHandler`, `readBody`, `$fetch`, etc.) — call `handleXxx` functions directly, not the default export.
- Keep the stub file updated when a new Nitro auto-import appears in a server file imported by tests.
- `~` alias resolves to project root in both vitest and Nuxt.

## Stack

Nuxt 4 · Nuxt UI v3 (emerald on zinc, dark default) · Pinia · VueUse (via Nuxt UI) · Nitro · SQLite (better-sqlite3) · Drizzle ORM · Vitest · Docker + systemd (production). Package manager: pnpm.

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
