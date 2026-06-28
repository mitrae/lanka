# Lanka audit (2026-06-28) — remaining follow-ups

Tracking file for the audit items **not yet fixed**. The 2026-06-28 audit ran 5
parallel reviewers (server security, server correctness, Android APK, ops/deploy,
frontend/player/tests). Each item: **[severity]** location — problem — fix.

**Already fixed** (see git log on `main` + branch `fix/app-rate-limiting`): OTA
integrity, healthcheck/port pin, `current_item_id` cleanup, `items.put`
atomicity, nuxt advisory bump, WS command-ack scoping + reconnect race, NativeFS
origin gating, app-level rate limiting, APK-upload streaming, non-root container,
nginx deny-list hardening, dashboard-SSE role gating + auth-guard-on-error.
**In progress:** per-device-secret (device auth).

---

## Server — correctness

- **[Medium] `play_count` over-counts** — `server/api/devices/[id]/telemetry.post.ts:33-51`. Increments on every telemetry POST with a non-null `currentItemId` and no error; no comparison to the device's *prior* `currentItemId`, so retries/duplicate posts inflate the client-facing metric. **Fix:** only increment on a genuine transition (`body.currentItemId !== device.currentItemId`).
- **[Medium] Telemetry 400s on an unknown `currentItemId` → wedges the device** — same file, `:33-43`. A device reporting a since-deleted item gets the whole POST rejected, so `lastSeenAt` isn't updated (marked offline) and the error/telemetry is lost. **Fix:** treat unknown item as soft — still update `lastSeenAt`, skip play-count, optionally null the column; don't 400.
- **[High] `ingestMedia` dedup TOCTOU** — `server/api/media.post.ts:59-122`. The `contentExisting` check and the final INSERT straddle a full transcode; two concurrent identical uploads both pass the check and the second 500s on the unique sha index. **Fix:** `onConflictDoNothing`/catch the unique violation and re-select the existing row.
- **[Medium] Assignment-swap PUTs aren't transactional** — `server/api/assignments/{devices,groups,addresses}/[id].put.ts`. Delete-then-insert as two statements; a failed insert leaves the target unassigned (device falls back / blanks). **Fix:** wrap delete+insert in one transaction.
- **[Medium] Reach stats are O(devices) N+1** — `server/services/reach.ts:44-68`. Per-device `resolvePlaylistForDevice` (3-way UNION) on every portal-stats load. Fine at ~50 devices; batch-resolve or memoize per request.
- **[Low] Stale commands replay on reconnect with no age cap** — `server/services/command-hub.ts:104-118`. `onDisconnect` reverts `sent`→`pending` forever; a weeks-old `screenshot` can fire when a device reconnects. **Fix:** add an age/attempt cap → `expired`.
- **[Low] Resolver relies on undocumented `UNION ALL` ordering** — `server/services/resolver.ts:15-31`. Most-specific-wins depends on SQLite positional order, no explicit `ORDER BY`. **Fix:** add a `prio` column (0/1/2) + `ORDER BY prio LIMIT 1`.
- **[Low] Three different online/offline thresholds** — `status.get.ts:9` (90s), `devices/index.get.ts:12-18` (60s/5min), `reach.ts:6` (5min). Surfaces can disagree about the same device. **Fix:** derive from one base constant.
- **[Low] `transcode.probeVideo` 0-duration videos emit `durationMs:0` in the manifest** — `server/services/transcode.ts:50-52`, `manifest.get.ts:70-71`. Latent scheduler gotcha. **Fix:** reject zero-duration at ingest or carry null through.
- **[Low] `commands.post` enqueues an unvalidated `cmd`** — `server/api/devices/[id]/commands.post.ts:63`. No zod enum; the column has no CHECK (migration `0006`), so an arbitrary string is persisted/pushed. Admin-gated. **Fix:** `z.enum([...])`.

## Server — security / authz

- **[Low] Org create/list allowed for `admin`, not `super`-only** — `server/api/organizations/index.{post,get}.ts`. Product call: narrow to `super` if intended.
- **[Low] Mass-assignment spread on parsed body** — `devices/[id].patch.ts:25`, `groups/[id].patch.ts:25`. Safe today (zod whitelists), latent if a non-writable field is added. **Fix:** enumerate `.set({...})` fields.
- **[Low] Inconsistent id validation** — `apk/[id]/download.get.ts`, `media/[id]/organization.put.ts`, `devices/index.get.ts`. Non-integer ids reach queries (404/empty, no injection). **Fix:** standardize on `Number.isInteger`.
- **[Note] Device control plane forge-able telemetry/manifest** — once per-device-secret lands on WS, consider extending it to telemetry (stops forged play-count/`deviceErrors` rows) and bounding `deviceErrors` per device.

## Android APK

- **[Medium] WebView self-heal recreate loop doesn't converge** — `MainActivity.kt:64-87`. `recoverFromRenderGone()`→`recreate()` resets `reloadAttempt=0` each life → tight recreate/CPU churn when the server is down. **Fix:** persist a consecutive-recreate counter + global min delay before `recreate()`.
- **[Medium] Native `backoff()` integer-shift overflow** — `src/native/.../player/Backoff.kt:6`. Uncapped `attempt`; `1L shl attempt` eventually goes negative → `schedule(negativeDelay)` fires immediately → busy reconnect loop after a long outage. **Fix:** `attempt.coerceIn(0,5)` (web `MainActivity` already caps its shift).
- **[Medium] Downloads have no max-size guard; chunked bypass; bitmap OOM** — `OtaInstaller.downloadApk`, `MediaCache.downloadSync/download`, `PlaybackView.loadImage`. Storage pre-check skipped when `Content-Length<=0` (chunked); full-res `BitmapFactory.decodeFile` can OOM 2GB boxes. **Fix:** per-file byte cap during copy; decode with `inSampleSize`.
- **[Medium] Native ExoPlayer images have no network fallback** — `PlaybackView.kt:227-247`. An uncached image errors and rides the slow 15s recovery loop. **Fix:** fall back to a network decode (download→cache→decode) for http(s) image URIs.
- **[Medium] `getLogs()` `Runtime.exec` not fully drained** — `NativeFSBridge.kt`, `PlayerActivity.kt`. stderr ignored, process not `waitFor`/destroyed (minor leak). Now origin-gated. **Fix:** read with explicit process cleanup or use a log buffer.
- **[High-ish, accepted] Cleartext everywhere** — `usesCleartextTraffic="true"` + `http://` server URL. Mitigated by tailnet/WireGuard + OTA sha/signer verification. **Fix (later):** `networkSecurityConfig` allowlisting the tailnet host; move control plane to HTTPS where feasible.
- **[Low] `device_admin.xml` declares unused `wipe-data`** — drop until needed.
- **[Low] `OtaInstallReceiver` MUTABLE PendingIntent** — `OtaInstaller.kt:97-100`. Explicit component target mitigates; note only.
- **[Low] `evaluateJavascript` string-interpolates status** — `MainActivity.kt:31`, `OtaInstaller.kt:54`. App-controlled values today; pass JSON-encoded args.
- **[Low] NativeFS residual** — same-origin XSS / off-origin iframe inside the trusted page can still reach the bridge (gate uses top-level `webView.url`); `evictExcept` is an ungated cache-wipe DoS (bounded). **Complete fix:** androidx.webkit `WebMessageListener` + `allowedOriginRules` (needs async player↔bridge protocol) + server CSP `frame-ancestors`/`frame-src`.

## Ops / deploy / data

- **[High] Migrations run on every container start with no auto pre-migrate backup** — `scripts/entrypoint.sh:7` runs `drizzle-kit migrate` first thing; only `deploy.sh` backs up. Any other start path (manual `compose up`, crash-restart onto a new image) is unrecoverable if a migration goes wrong. **Fix:** `sqlite3 "$DB" ".backup pre-migrate-<ts>.db"` at the top of entrypoint (with retention prune); ideally run migrations as a separate pre-serve deploy step.
- **[High] Migration crash-loop with no backoff/signal** — `entrypoint.sh` `set -euo pipefail` exits on migrate failure → `restart: unless-stopped` spins; capped json logs may rotate the root cause away. **Fix:** clear fatal log line + short sleep, or a hold state.
- **[High] `rsync --delete` media mirror, no source-exists guard** — `scripts/backup.sh:26`. A transient empty/unmounted `$DATA_DIR/media` wipes the backup mirror. Low data impact (R2 is source of truth) but silent-destruction pattern. **Fix:** `[ -d "$DATA_DIR/media" ] || exit 0` guard; consider dropping `--delete`.
- **[Medium] No container resource limits** — `docker-compose.yml`. An unbounded transcode (sharp/ffmpeg) can OOM the host and drop tailscaled/cloudflared (whole fleet's control plane). **Fix:** `mem_limit`/`cpus` + bound ffmpeg concurrency in-app.
- **[Medium] SSE/WS proxy headers + send-timeout on the tailnet block** — `ops/nginx/lanka.conf` WS location lacks the shared proxy headers (X-Real-IP/XFF) and `proxy_send_timeout`. **Fix:** add `proxy_send_timeout 1h` + the proxy snippet to the WS location.
- **[Medium] Large-upload proxy buffering/timeout** — public `location /` buffers the whole upload and default `proxy_read_timeout 60s` can fire during transcode. **Fix:** dedicated upload location with `proxy_request_buffering off; proxy_read_timeout 600s`.
- **[Medium] systemd dual restart supervisors** — `ops/lanka.service` (`Restart=`) + compose `restart: unless-stopped` can fight; `Requires=tailscaled` takes the app down on a tailnet blip. **Fix:** pick one restart authority; consider `Wants=` for tailscaled.
- **[Medium] `0003` username→email rename has no validation/backfill** — non-email usernames would break email-login post-migration. Acceptable given seed emails; ensure the pre-migrate backup (above) covers it.
- **[Low] Base image not digest-pinned** — `Dockerfile` `node:22-bookworm-slim`. **Fix:** pin `@sha256:` + refresh deliberately.
- **[Low] Runtime image ships dev deps; `drizzle-kit` is a devDep needed at runtime** — `Dockerfile:33` copies full `node_modules`; a prod-only prune would break the entrypoint migrate. **Fix:** move `drizzle-kit` to deps or run migrations from a dedicated step; prune dev deps to slim the image.
- **[Low] No nginx security headers** — public block. **Fix:** HSTS / X-Content-Type-Options / Referrer-Policy / X-Frame-Options (+ CSP `frame-ancestors` ties into the NativeFS iframe residual).
- **[Low] Manual nginx/cloudflared placeholders + tailnet-IP SPOF** — `ops/nginx/lanka.conf` `TAILSCALE_IP`, `ops/cloudflared/config.yml` `<TUNNEL_UUID>` substituted by hand; a tailnet-IP change needs a manual edit. **Fix:** templatize into deploy.
- **[Low] Single-box SPOF; offsite DB backup unimplemented; R2 versioning** — `scripts/backup.sh:31` references a non-existent `offsite.sh`; R2 object versioning likely off. **Fix:** implement offsite (rclone), enable R2 versioning, document RPO/RTO.
- **[Follow-up] nginx `real_ip` for accurate public-path rate limiting** — add `set_real_ip_from <Cloudflare ranges>; real_ip_header X-Forwarded-For; real_ip_recursive on;` so the app's per-IP limiter sees the true client on the Cloudflare path (today it collapses to cloudflared's loopback there; per-account limits guard it).

## Frontend / web player / tests

- **[High] Store mutations don't set `error`** — all `app/stores/*` mutating actions re-throw without setting store `error`; only `refresh()` sets it. Inconsistent surfacing; a future call site that forgets to catch fails silently. **Fix:** standardize (set `error` + re-throw, or make the catch-contract explicit).
- **[High] Player-boot wiring + client auth guard untested** — `usePlayerBoot.ts`, `useTelemetry.ts`, `useNativeDevice.ts`, `auth.global.ts` have no tests; a wiring regression black-screens the fleet uncaught (CLAUDE.md notes the guard already silently broke once). **Fix:** add a `usePlayerBoot` wiring test (screen transitions on manifest/null/error) + a guard test (redirect targets incl. `/player` exemption).
- **[Medium] Hierarchy/cross-store staleness** — `groups.ts`/`addresses.ts`/`playlists.ts`/`media.ts`. In-place list patches ignore the Address→Group→Device cascade and derived counts (`usedInPlaylists`, `itemCount`). **Fix:** re-`refresh()` (with active filter) after cascade-affecting edits.
- **[Medium] `refresh()` no concurrency guard; `devices.refresh()` drops its filter** — `app/stores/*`. Overlapping refreshes race (last-settle wins); SSE updates can be clobbered. **Fix:** sequence-token guard; persist active filter; merge SSE against latest.
- **[Medium] `users.create` fabricates server fields** — `app/stores/users.ts:27-34` injects `organizationName:null` + client-clock `createdAt`. **Fix:** `refresh()` after create, or return the full row.
- **[Medium] `_api` in Pinia state is reactive-wrapped** — every store. Identity surprises in tests; root reason SSR is blocked. **Fix:** `markRaw()` or a module-level ref (keep the `$patch({_api})` test hook).
- **[Low] `getManifest` casts `res._data as Manifest` with no validation** — `useApiClient.ts:195`; scheduler reads `m.items.length`. Defensive only (server always emits an array). **Fix:** `Array.isArray(m.items)` guard.
- **[Low] Device-screenshot data-URI in `<img :src>`** — `devices/[id].vue:425`. Not XSS (img src can't run JS); add a `data:image/` prefix sanity check.
- **[Low] Test quality** — `useCommandChannel` close-test asserts a constant; several wall-clock `toBeGreaterThan` waits (flaky); `transcode.test.ts` spawns real ffmpeg (slow/env-dependent); Vue UI layer largely untested (1/18 components, 0/18 pages, 5/8 stores). **Fix:** fake timers / `>=`; gate the ffmpeg integration test behind an env flag.

---

## Per-device-secret residuals (after the TOFU change)

- **[Low] nginx access log records `?secret=` for `/ws`** — `ops/nginx/lanka.conf` tailnet `/ws` block. The default access-log format logs `$request`, so each device's secret lands in the box's access log at rest (tailnet-only, disk-local). **Fix:** a `/ws`-scoped `log_format` that strips the query (or `access_log off` for `/ws`).
- **[Low] Web command-channel has no in-app recovery if localStorage is cleared after adoption** — `app/composables/player/usePlayerBoot.ts`. The device's WS then rejects (active + no secret); playback is unaffected (manifest/SSE/telemetry independent) but the command channel is dead until the device row is deleted + re-registered. **Fix/doc:** surface a telemetry warning on repeated active-rejections so the dashboard flags it; document the admin recovery path.

## Manual / out-of-band (not code)

- Push `main` to origin.
- On-box verification: OTA sha/signer path, the non-root container start (migrate writing `data/signage.db` as uid 10001 then healthz), and the nginx config (`nginx -t` + dashboard works over `app.lanka.live`).
- Deploy the manual nginx config changes (scp + substitute TAILSCALE_IP + `nginx -t && systemctl reload`).
