# Lanka — Claude guide

Self-hosted digital signage: Nuxt 4 monolith (dashboard + Nitro API + future `/player` route) driving Android TVs over a Tailscale tailnet. Solo-dev prototype aimed at ~50 TVs. Design spec: `docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`.

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

## Ports (dev machine)

`localhost:3000-3999` is occupied by other services on this machine. Use `PORT=5100 pnpm dev` (or any 5xxx) to start Nuxt.

## Testing

- Vitest, `pool: 'forks'` (better-sqlite3 native module needs per-worker isolation).
- `tests/helpers/nuxt-stubs.ts` stubs Nitro auto-imports (`defineEventHandler`, `readBody`, `$fetch`, etc.) — call `handleXxx` functions directly, not the default export.
- Keep the stub file updated when a new Nitro auto-import appears in a server file imported by tests.
- `~` alias resolves to project root in both vitest and Nuxt.

## Stack

Nuxt 4 · Nuxt UI v3 (emerald on zinc, dark default) · Pinia · VueUse (via Nuxt UI) · Nitro · SQLite (better-sqlite3) · Drizzle ORM · Vitest. Package manager: pnpm.

## Docs

- Plans: `docs/superpowers/plans/` (Plan 1 = foundation; Plan 2a = API; Plan 2b = dashboard UI — all merged).
- Spec: `docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`.
- Endpoints summarised in `README.md`.
