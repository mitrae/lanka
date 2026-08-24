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
- **Auth, sessions & seeding**: a single global Nitro middleware (`server/middleware/auth.ts`) authenticates *every* request via the `lanka_session` cookie and sets `event.context.user`; `server/services/auth-guard.ts#decideAccess` is the policy. Public (no session) routes: `/api/healthz`, `/api/devices/register`, `/api/auth/*`, and the device `manifest|stream|telemetry` endpoints; non-`/api/` paths pass through (SPA assets, guarded client-side). **401 = no/expired session, 403 = wrong role.** Roles: `super`/`admin` → full dashboard; `client` → `/portal/*` only. Sessions (`server/services/sessions.ts`): the cookie holds a random token, the DB stores only its sha256 (table `sessions`), 30-day TTL; cookie is `httpOnly`+`sameSite=lax` with **no `secure` flag** (so it works over plain-http localhost dev). Client-side guard is `app/middleware/auth.global.ts` (redirects unauth→`/login`, `client`→`/portal`); **`/player` is exempt entirely** (the kiosk WebView has no session — never gate it, or every TV goes blank). **Seeding:** `server/plugins/seed.ts` runs on startup and, *only when the `users` table is empty*, creates three accounts with emails `super@lanka.live`/`admin@lanka.live`/`client@lanka.live` (overridable via `SEED_SUPER_EMAIL`/`SEED_ADMIN_EMAIL`/`SEED_CLIENT_EMAIL`). Passwords come from `SEED_SUPER_PASSWORD`/`SEED_ADMIN_PASSWORD`/`SEED_CLIENT_PASSWORD`; if unset, a random one is generated and **printed to the server log once** (`[seed] created <role> … generated password: …`). Login is by email. So a fresh dev DB with no `SEED_*` env means you must grab the password from the startup log (or set the env and delete `data/signage.db` to reseed).
- **No `<template #header>` on pages**: earlier iterations wrapped page content with `<template #header>...</template>` intending to fill a layout slot. That syntax only works on direct children of `<NuxtLayout>`; inside `<div>` it breaks Vue's prod-build compiler with `Cannot read properties of undefined (reading 'type')`. Don't add it back — the layout's header slot is currently unused.
- **Three-level hierarchy**: Address → Group → Device. Playlist assignments work at any level; most-specific wins (Device > Group > Address).
- **Content-addressed media** by sha256. `playlists.version` bumps on any content-affecting edit. Devices sync = poll every 30s + SSE kick.
- **Pluggable media store** behind the `MediaStore` interface (`server/services/media-store.ts`). `useMediaStore()` picks `R2Store` when all four `R2_*` runtime-config values are set, else `LocalDiskStore(mediaDir)`. R2 is proxied through the server for thumbnails (`/media/:sha/thumb`) and for local-disk dev. In the Hetzner+Cloudflare deployment, players fetch full media bytes directly from the public R2 CDN (`media.lanka.live`) — `usePlayerEnv.fileUrl` emits `${mediaPublicBase}/<sha>` when `MEDIA_PUBLIC_BASE` is set, falling back to the `/media/:sha` proxy route when empty (dev/local disk). **On the APK, `fileUrl` always returns the `/media/:sha` (or CDN) http(s) URL — never `file://`.** An http-origin player page is forbidden from loading `file://` resources (WebView rejects it: *"Not allowed to load local resource"*), so the pre-downloaded bytes are served locally instead by the APK's `shouldInterceptRequest` interceptor (`LankaWebViewClient` → `MediaCache.intercept`), which matches `/media/:sha`, streams the cached file from disk with the correct Content-Type + Range, and only hits the network on a cache miss. (A `file://` fast-path here silently never played — fixed 2026-06.) `R2Store` lazy-loads `@aws-sdk/client-s3`/`lib-storage` via dynamic import, so local-disk dev/test never loads the SDK. **`MediaStore.open()`/`openThumbnail()` return `Promise<Readable>`** (async, for the R2 fetch) — `await` them at call sites.
- **`handleDeleteMedia force=true` is atomic** via a sync `db.transaction((tx) => {...})`. The callback is synchronous (better-sqlite3 driver), so every op inside uses `.run()` / `.all()` — no `await`, no `bumpPlaylistVersion()` call. The version bump is inlined there; `bumpPlaylistVersion` in `server/services/playlist-version.ts` stays for other callers. Reads and file unlinks stay outside the transaction (unlinks are idempotent via ENOENT swallowing).
- **App version in production comes from `runtimeConfig.appVersion`, not `process.env.npm_package_version`.** The container launches via bare `node .output/server/index.mjs` (`scripts/entrypoint.sh`), which doesn't set `npm_*` env vars. `nuxt.config.ts` captures `npm_package_version` at build time (pnpm *is* running during `pnpm build`) into `runtimeConfig.appVersion`. `/api/healthz` reads it from there. Same pattern for any future "what version is running" surface.
- **Media uploads are async and direct-to-store.** The dashboard never POSTs file bytes to the app: `POST /api/media/uploads` creates a `media_uploads` job and returns a ticket — a **presigned PUT to the R2 S3 endpoint** (`uploads/<uuid>`, 1 h, `ContentType` signed) or, on `LocalDiskStore`, `PUT /api/media/uploads/:id/file`. `…/complete` verifies the staged size and enqueues; `server/services/media-ingest-queue.ts` (single in-process worker, started by `server/plugins/ingest-worker.ts`) runs the same `ingestMedia()` and deletes the staged object. Why: Cloudflare's proxy caps bodies at 100 MB and times out at 100 s — the presigned PUT must go to `<account>.r2.cloudflarestorage.com`, **never** through `app.lanka.live` or `media.lanka.live`. Prod needs the bucket CORS + lifecycle rules (`scripts/r2-bucket-setup.mjs`). Worker rules: atomic `queued→processing` claim; h3 4xx from `ingestMedia` = permanent failure, anything else is retried (3 attempts, staged object kept); `recover()` (resets `processing`) runs at **boot only** — periodic maintenance only `reconcile()`s `queued` rows, or a live 30-min transcode would be re-queued. One Nitro instance is assumed. The sync `POST /api/media` still exists for curl/scripts only.

## Android kiosk player (APK)

The TVs run a thin Android WebView kiosk (`android/`, package `ai.lanka.kiosk`) that loads `/player?deviceId=…` fullscreen. The Nuxt app *is* the player; the APK just wraps it with kiosk flags, self-heal (reload-on-main-frame-error backoff + renderer-gone `recreate()`), and a persisted random `deviceId` (SharedPreferences).

- **Server URL is compile-time**, not a runtime setting: `BuildConfig.LANKA_SERVER_URL` (default `http://lanka-server:3000`, a tailnet hostname). No in-app picker — rebuild to retarget (a LAN IP for local box testing; `http://lanka-server:3000` for the tailnet). One APK, one package — `./gradlew :app:assembleDebug -PLANKA_SERVER_URL=… [-PKIOSK_PIN=…]`; APK at `app/build/outputs/apk/debug/app-debug.apk`. Both player surfaces ship in it (see "Runtime player surface" below).
- **`KioskFlags` runs in `MainActivity.onCreate` after `setContentView`** and reaches the inset controller via `window.decorView.windowInsetsController` — calling `window.insetsController` before the decor view exists NPEs and crashes the APK on launch on some Amlogic ROMs.
- **Deploy over ADB *wireless debugging*, not USB.** These TV boxes' USB-A ports are host-only, so ADB-over-USB never enumerates. On the box: Developer options → Wireless debugging; `adb` discovers it via mDNS (no `:5555` toggle on this firmware). Then `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`; launch with `adb shell am start -n ai.lanka.kiosk/.MainActivity`.
- **Amlogic-box WebView video — the #1 cause of the play-button placeholder is H.264 *profile*, not size.** The kiosk WebView's HTML5 `<video>` **cannot decode H.264 High profile** (shows the placeholder; `video.error.code = 4`). It plays **Main / (Constrained) Baseline** only. The Amlogic *hardware* decodes High fine in native apps — the limit is the WebView path. So **all media must be H.264 Main/Baseline, `yuv420p`, ≤720p, `+faststart`** — and most phone/Telegram clips are *High*, so they fail until transcoded. (The earlier "~15MB clip OOMs the renderer" note was a misdiagnosis — it was High profile; size is rarely the issue.) A real fleet needs **server-side upload transcoding** to that profile — spec/plan: `docs/superpowers/{specs,plans}/2026-06-28-server-side-upload-transcoding*`. Secondary playback gotcha: media served with an **empty `Content-Type`** also makes `<video>` reject the source (`MEDIA_ERR_SRC_NOT_SUPPORTED`) — `R2Store.put(sha, stream, contentType)` now sets it, and the APK interceptor sniffs it. **Verify box playback against a production build** (`pnpm build` + `node .output/server/index.mjs`), NOT `pnpm dev` (the unbundled dev module graph is too heavy for the box).
- **Tailscale on the boxes:** the **Tanix X4 can't run stock Tailscale** (broken Android keystore — use a subnet router / Linux player). A **Google-TV box (Xiaomi TV Box S 3rd Gen) can** run the official Tailscale app — but enable **Always-on VPN** (Settings → Network → VPN → Tailscale), or a reboot/power-cut drops it off the tailnet permanently. Prod boxes join the **`ua.lanka.live@`** tailnet; reach prod nginx at `http://<tailnet-ip>:80`.
- **Device command channel (Plan 7: OTA / reboot / screenshot / logs / kiosk-lock)** runs over a WebSocket at `/api/devices/:id/ws`. It needs **`nitro.experimental.websocket: true`** in `nuxt.config.ts` (else the node server answers WS upgrades with HTTP 426) **and**, in prod, **nginx WS upgrade headers** on the tailnet block. On a **certified box** (Google TV), silent OTA + real reboot + lock-task kiosk require **device-owner** provisioning (`dpm set-device-owner`, see `android/README.md`); without it the same APK degrades to a **snap-back kiosk** (re-foreground on HOME/leave via `SYSTEM_ALERT_WINDOW`) and the Android-12 self-update path. `KioskLock` (in-memory, defaults locked) gates the snap-back; toggle remotely via the `kiosk-lock`/`kiosk-unlock` dashboard command.
- **Play counts** (`media.play_count`): incremented in `server/api/devices/[id]/telemetry.post.ts` on each real item start (`currentItemId` set, no `error`). A single looping video uses native `<video loop>` so it counts once per session; images and multi-item playlists count per slide/cycle. Surfaced via `GET /api/devices/:id/status`, media detail (`GET /api/media/:id`), and portal reach stats.
- **Offline media cache (Plan 6)** — `NativeFSBridge` (`android/app/…/NativeFSBridge.kt`) injects `window.NativeFS` into the WebView, exposing `exists(sha)`, `download(sha, url)`, `fileUrl(sha)`, `evictExcept(jsonArray)`, and `free()`. `createReconciler` (`useReconciler.ts`) accepts optional `nativeFS`+`cdnUrl` deps: when present, it calls `NativeFS.download()` for every uncached item in the incoming manifest (blocking the JS thread), then `NativeFS.evictExcept()` for stale items, before emitting the manifest. `usePlayerBoot` reads `globalThis.NativeFS` and wires it in; `usePlayerEnv.fileUrl` always returns the http(s) `/media/:sha` URL (never `file://` — see the media-store note above). `MediaCache.downloadSync()` has a storage guard: if `StatFs.availableBytes > 0` and `< Content-Length`, the download is skipped (falls back to streaming). The transparent `shouldInterceptRequest` cache-aside interceptor (`MediaCache.intercept`) is the **primary** local-serving path, not just a safety net — it serves cached media with a Content-Type from `mimeFor`, which re-sniffs magic bytes when the stored `.type` is missing/`application/octet-stream` so `<video>` always gets a playable type. **Test with `./gradlew test`** in `android/`; `MediaCache.forTesting(dir: File)` enables JVM unit tests without Android context.
- **Player visibility telemetry.** The APK reports whether it is actually on
  screen — `foreground` / `obscured` (a dialog is on top: focus lost with no
  `onStop`, the one kiosk failure snap-back can never fix) / `background` —
  plus `snapBacks`/`focusLosses`/`hiddenMs`. The player samples every 2 s and
  posts on a state change, with a 30 s heartbeat as the floor; a beat alone
  would miss an occlusion that starts and ends between two beats. State lives in
  `KioskVisibility` (`src/main`), fed by `KioskActivity`'s
  `onStart`/`onResume`/`onPause`/`onStop`/`onWindowFocusChanged` — `onPause`
  matters, because a translucent overlay never calls `onStop`. One
  `KioskVisibility.shared` serves both player surfaces and survives the
  `recreate()` of a `set-surface` switch, so the counters are process totals;
  `NativeSurface` owns its sampling scheduler and shuts it down in `stop()` per
  the `PlayerSurface` contract. The intruder package comes from
  `ForegroundAppProbe`, whose lookback window is derived from the episode length
  (a fixed short window misses the covering app), and is `null` unless the box
  got `appops set ai.lanka.kiosk GET_USAGE_STATS allow`. **`telemetry.currentItemId`
  is now OPTIONAL** — absent means "heartbeat: don't touch the current item,
  don't count a play"; `null` still clears. Sending the current item on every
  heartbeat would inflate `media.play_count` by ~120x/hour. Note the two signals
  that still lie about occlusion: the screenshot command draws the WebView's own
  view tree (`webView.draw`), not the display, and `lastSeenAt` keeps refreshing
  while hidden because the WebView is never `onPause()`d.
- **On-device PIN escape hatch:** long-press BACK, or five BACK taps in 2 s,
  opens a native `PinPadView` over the player; a correct PIN (sha256-baked via
  `-PKIOSK_PIN`, empty default = disabled) clears `KioskLock`, releases lock
  task, **verifies** it is released, and opens Settings. All of it lives in
  `KioskActivity`, shared by both player surfaces. The pad is a **native
  view, not HTML** (must work when the WebView renderer is dead) and it **never
  takes focus** — `KioskActivity.dispatchKeyEvent` routes every key to
  `PinPadView.handleKey()` while it is showing and calls nothing else. Every
  pad action requires `repeatCount == 0` (the opening long-press is still held
  when the pad appears). One `KioskPin` per process, so the lockout survives
  closing the pad. `KioskLock.locked` is now **listener-driven**: assigning it
  mirrors into real lock-task state via `KioskActivity`, which is what makes the
  dashboard's `kiosk-unlock` command actually work on a pinned box (it previously
  flipped the flag but never called `stopLockTask()`). `onResume` reconciles
  unconditionally, posted listener work re-reads the flag under an identity
  guard, and the dashboard sets the flag off-thread — `start/stopLockTask` are
  main-thread-only. **Never set `android:enableOnBackInvokedCallback="true"`**
  in either manifest — it reroutes BACK through `OnBackInvokedDispatcher` and
  silently kills the BACK swallow *and* both PIN triggers with no compile
  error.

## Runtime player surface (WebView ⇄ native ExoPlayer)

The APK carries **two player surfaces** and picks one at runtime (merged 2026-08-23; spec/plan: `docs/superpowers/{specs,plans}/2026-08-23-single-apk-runtime-surface*`). There is **one launcher component, `ai.lanka.kiosk/.MainActivity`** — it hosts a `PlayerSurface`: `WebViewSurface` (the WebView kiosk loading `/player`, with `NativeFSBridge`) or `NativeSurface` (ExoPlayer/Media3; Kotlin owns manifest/SSE/telemetry/command-WS in `player/*.kt`, a 1:1 port of the web composables). Boot, the device-owner HOME pin, lock task, snap-back and the PIN pad live in `KioskActivity`/`DevicePolicy` and never see the difference.

- **Switching** = dashboard device page → "Switch to Native/WebView" → `set-surface {surface}` command. The box commits the choice (`SharedPreferences lanka_kiosk`, key `surface`; absent → `webview`) via `SurfaceSwitcher`, **acks, then `recreate()`s 500 ms later** (one debounced restart per toggle burst). Rollback = switch back; no OTA. Refused with `ota in progress` while `OtaInstaller.busy` (download → install → OS result, age-capped at 15 min so a wedged OTA can never block the rollback path).
- **Crash-loop guard** (`SurfacePolicy`, pure, JVM-tested; `SurfaceStore` = prefs adapter): a switch is *pending* until the surface confirms health (WebView: a **clean** main-frame load — `LankaWebViewClient.onPageOk` no longer fires after a main-frame network/HTTP≥400 error; native: first manifest (confirmed after the mount)). 3 **cold** process starts within 10 min of a pending switch, a synchronous start failure, or a WebView renderer death before the first clean load, revert to `lastGood`. Cold start = a **new OS process**, detected by `ProcessToken` vs the stored `surface.process` key — a `recreate()` (switch, renderer recovery, native `reload`) is not one. Window expiry stops guarding (no revert — a server outage must not flip a healthy box). `MainActivity.onCreate` is the only caller; `SurfaceStore` serializes on one process-wide lock.
- **Ownership rule:** everything a surface's `start()` creates, its idempotent `stop()` releases (views, WebView/ExoPlayer, sockets, SSE, executors, Handler posts, `OtaResultBus` listener). Each surface owns its own `Handler`; `KioskActivity.onDestroy` clears only its own.
- **Reported vs requested:** `devices.surface` is what the box last reported (the web player now sends `surface: 'webview'` on register + telemetry; native sends `native`). The server stores no desired state — the newest `set-surface` command row is the request; `app/utils/surfaceSwitch.ts` derives the control's queued/sent/applying/failed state.
- **OTA guard:** `OtaInstaller.installSilently` refuses an archive whose package name ≠ `ai.lanka.kiosk` **or is unreadable** (fail closed; a stale `-vs` release from the flavor era would otherwise install a second kiosk). `apk_releases.flavor` was dropped.
- Native plays cached files directly via `Uri.fromFile(MediaCache.file(sha))`; the WebView path uses the `shouldInterceptRequest` cache. **Images must be pre-cached** for native (no network fallback in the ImageView path).
- Unit tests: `./gradlew test` (single variant; the former `src/testNative` suites now live in `src/test/kotlin/ai/lanka/kiosk/player/`). `media3`/`okhttp`/`kotlinx-serialization` are plain `implementation` deps (~6 MB APK).

## Ports (dev machine)

`localhost:3000-3999` is occupied by other services on this machine. Use `PORT=5100 pnpm dev` (or any 5xxx) to start Nuxt. (`.env` pins `PORT=5100`, so plain `pnpm dev` works.)

## Dev login (seed accounts)

Seeded on first run of an empty DB by `server/plugins/seed.ts`. Local dev sets known passwords via `SEED_*_PASSWORD` in `.env` (gitignored); the current dev value is **`lanka-dev`** for all three:

| email                 | password    | role     | access            |
|-----------------------|-------------|----------|-------------------|
| `super@lanka.live`    | `lanka-dev` | `super`  | full dashboard    |
| `admin@lanka.live`    | `lanka-dev` | `admin`  | full dashboard    |
| `client@lanka.live`   | `lanka-dev` | `client` | `/portal/*` only  |

Login is by email address. The default seed emails above can be overridden via `SEED_SUPER_EMAIL`/`SEED_ADMIN_EMAIL`/`SEED_CLIENT_EMAIL` in `.env`.

**Dev-only** — production leaves `SEED_*` unset, so a random password is generated and printed to the server log once (never commit real ones). To rotate dev creds: change `SEED_*` in `.env`, delete `data/signage.db`, restart (reseeds). To set them on an existing DB without wiping it, overwrite `users.password_hash` with a `scrypt$16384$8$1$<salt_b64>$<derived_b64>` value (format per `server/services/password.ts`).

## Testing

- Vitest, `pool: 'forks'` (better-sqlite3 native module needs per-worker isolation).
- `tests/helpers/nuxt-stubs.ts` stubs Nitro auto-imports (`defineEventHandler`, `readBody`, `$fetch`, etc.) — call `handleXxx` functions directly, not the default export.
- Keep the stub file updated when a new Nitro auto-import appears in a server file imported by tests.
- `~` alias resolves to project root in both vitest and Nuxt.
- **Android:** `./gradlew test` (in `android/`) runs the JVM unit tests (one variant). Pure cores (`SurfacePolicy`, `KioskPin`, `TapChord`, `player/*`) are tested; Activity/surface/bridge code is build-verified.

## Stack

Nuxt 4 · Nuxt UI v3 (indigo on slate, light default — `app/app.config.ts` + `colorMode.preference: 'light'`) · Pinia · VueUse (via Nuxt UI) · Nitro · SQLite (better-sqlite3) · Drizzle ORM · Vitest · Docker + systemd (production). Package manager: pnpm.

## Production deployment (summary — full details in README)

- `Dockerfile` multi-stage bookworm-slim, `tini` PID 1. Accepts a `MEDIA_PUBLIC_BASE` build ARG baked into the SPA bundle at `pnpm build` time. Runtime launches via `scripts/entrypoint.sh` (runs `drizzle-kit migrate`, then `exec node .output/server/index.mjs`).
- **The app binds `127.0.0.1:3000` only** (`HOST=127.0.0.1` in `.env`). `docker-compose.yml` uses `network_mode: host`; nginx is the sole front door.
- **nginx (host package; config in `ops/nginx/`, `lanka.conf` uses a `listen TAILSCALE_IP:80` placeholder)** — two server blocks: (1) *public block* on `127.0.0.1:8080` — what `cloudflared` dials; 403s the device control plane (`/api/devices/register`, `/api/devices/:id/{manifest,stream,telemetry,ws}`, `/api/apk/:id/download`), rate-limits `/api/auth/login` + `/api/auth/forgot-password`, proxies the rest; (2) *tailnet block* on the box's tailnet IP `:80` — what the TVs hit; full proxy incl. the `/ws` command channel (needs WS upgrade headers + the `nitro.experimental.websocket` flag). **nginx config is deployed MANUALLY** — scp `ops/nginx/*` to `/etc/nginx/…`, substitute `TAILSCALE_IP` → the box's tailnet IP, `nginx -t && systemctl reload nginx`. `deploy.sh` only rebuilds the Docker app, **not** host nginx; if the box's tailnet IP changes (e.g. moving tailnet accounts), nginx's `listen` IP must be updated by hand.
- **`app.lanka.live` via Cloudflare Tunnel** (`cloudflared` outbound service, `ops/cloudflared/config.yml`). No inbound public ports on the box — the dashboard is unreachable if the tunnel is down, but the fleet keeps playing.
- **Device control plane is tailnet-only.** The nginx public block 403s device endpoints; TVs reach the app at `http://100.x/` over WireGuard.
- **Media served from R2 public CDN** (`media.lanka.live`). TVs fetch bytes straight from Cloudflare — the box is never in the media path. Uploads still flow through the app into `R2Store`. `SESSION_COOKIE_SECURE=true` in prod (dashboard is HTTPS at the Cloudflare edge).
- `ops/lanka.service` wraps `docker compose up`. `scripts/render-env.sh` **has been removed** — `HOST` is the static `127.0.0.1` from `.env`. `Requires=tailscaled.service` still prevents the service from starting without the tailnet (device plane depends on it).
- `ops/lanka-backup.{service,timer}` fires `scripts/backup.sh` nightly at 03:00: `sqlite3 .backup` (WAL-safe online backup) + `rsync --delete` media mirror (near-empty local dir — R2 is the media source of truth), 7-day DB retention, optional `offsite.sh` drop-in hook.
- `scripts/deploy.sh` is the manual upgrade: pre-backup → `git pull --ff-only` → rebuild → 30×2s healthz poll (`http://127.0.0.1:3000/api/healthz`) → auto-rollback on failure via `git reset --hard $PRE_HEAD`.

## Docs

- Plans: `docs/superpowers/plans/` (Plan 1 = foundation; Plan 2a = API; Plan 2b = dashboard UI; Plan 3 = `/player`; Plan 4 = deployment — all merged).
- Design specs: `docs/superpowers/specs/` (main spec, player spec, deployment spec; Plan 6 offline cache spec = `tech-spec-apk-offline-media-cache-2026-06-16.md`).
- Endpoints + Deployment + Operations summaries in `README.md`.
