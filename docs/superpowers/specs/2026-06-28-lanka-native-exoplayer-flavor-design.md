# Lanka-vs — Native ExoPlayer player flavor

**Date:** 2026-06-28
**Status:** Design approved, pending implementation plan
**Related:** `2026-04-19-lanka-apk-kiosk-design.md` (WebView kiosk), `2026-06-16` APK offline media cache, `2026-06-28-server-side-upload-transcoding-design.md`

## Summary

Add a second, **fully native** Android player to Lanka that renders video with
ExoPlayer (Media3) instead of the WebView's HTML5 `<video>`. It ships as a
**Gradle product flavor** of the existing `android/` project — `native`
(applicationId `ai.lanka.kiosk.vs`, "Lanka-vs") alongside the unchanged
`webview` flavor (`ai.lanka.kiosk`). The native flavor reimplements the small,
already-tested player orchestration in Kotlin and talks to the **unchanged**
server control plane (manifest / SSE / telemetry / command WS). The existing
WebView APK is preserved byte-for-byte.

## Motivation

The WebView player works, and server-side transcoding (2026-06-28) made its
HTML5 `<video>` reliable by normalizing every upload to H.264 Main/Baseline,
yuv420p, ≤720p. A native surface is wanted as a **more robust player in
addition to** the WebView, targeting all of:

1. **Decode robustness** — Amlogic/Android hardware decodes High profile / 1080p
   / HEVC fine in native apps; only the WebView path is limited. A native player
   makes transcoding an *optimization* rather than a hard requirement (future
   lever — see Non-goals).
2. **Stability over long runs** — escape WebView renderer OOM/GPU/codec crashes
   during hours-long video playback on low-end boxes. A native player has no
   renderer process and a far more predictable decoder/memory lifecycle.
3. **Smoother playback / transitions** — gapless looping, frame-accurate
   preloading, cleaner crossfades than two HTML5 `<video>` elements give on cheap
   hardware.
4. **Fleet resilience** — a second, independent player path so a single decode
   quirk can never black out a screen across the whole fleet.

## Decisions (locked during brainstorming)

- **Packaging:** Gradle product flavor (one tree, two APKs), *not* a separate
  project or a single hybrid APK.
- **Architecture:** Fully native — **Kotlin owns the brain** (reconciler,
  scheduler, telemetry, command WS). No WebView in the native flavor's playback
  path.
- **v1 scope:** Full fleet-citizen parity, including a Kotlin port of the
  command WS (OTA / reboot / screenshot / log-request / kiosk-lock/unlock).
- **Fleet awareness:** the device reports `surface: "native"` so the dashboard
  can distinguish native vs WebView boxes (additive server change).

## Non-goals

- **Relaxing the transcode profile.** Media is shared across the entire fleet;
  as long as *any* box runs the WebView APK, uploads must stay WebView-safe
  (H.264 Main/Baseline, ≤720p). Native boxes simply play that already-safe media
  more reliably. Playing High/1080p/HEVC natively is a *future* lever once a
  deployment is all-native and is explicitly out of scope here.
- **Replacing the WebView APK.** The `webview` flavor stays as the default and is
  unchanged. The two coexist; selection is install-time.
- **Server-driven runtime surface switching.** A box runs whichever APK is
  installed on it. No single-APK runtime toggle (that was the rejected "hybrid"
  option).

## Architecture

### Packaging & source-set layout

A `surface` flavor dimension in `android/app/build.gradle.kts`:

| Flavor | applicationId | Activity / surface |
|---|---|---|
| `webview` (default) | `ai.lanka.kiosk` | `MainActivity` (WebView) — today's code |
| `native` | `ai.lanka.kiosk.vs` (`applicationIdSuffix = ".vs"`) | `PlayerActivity` (ExoPlayer) |

Source sets:

- **`src/main`** — shared, behavior unchanged: `KioskFlags`, `DevicePolicy`,
  `KioskLock`, `BootReceiver`, `LankaDeviceAdminReceiver`, `OtaInstaller` /
  `OtaInstallReceiver` / `OtaResultBus`, `MediaCache`, `AndroidManifest.xml`,
  `device_admin.xml`, strings/styles. The manifest references both
  `.MainActivity` and `.PlayerActivity`; each flavor supplies exactly one of
  those classes, so the merged manifest resolves to the present one per flavor.
- **`src/webview`** — moved verbatim from today's `src/main`: `MainActivity`,
  `LankaWebViewClient`, `LankaChromeClient`, `NativeFSBridge`. The WebView APK is
  byte-for-byte equivalent to the current build.
- **`src/native`** — the new Kotlin brain + ExoPlayer UI (below).

Consequences:

- Distinct `applicationId`s → both APKs install side-by-side on one box (enables
  A/B on identical hardware).
- Build targets: `assembleWebviewDebug` / `assembleNativeDebug`; the
  `-PLANKA_SERVER_URL=…` Gradle property applies to both flavors.
- Sharing `src/main` means the **entire kiosk / self-heal / device-owner story
  comes along for the native flavor for free** — lock-task, HOME launcher, boot
  receiver, OTA installer, `MediaCache`.

### Native player — Kotlin owns the brain

`src/native` mirrors the five web player composables as small,
independently-testable Kotlin units. The HTTP+WS server contract is unchanged;
only the client is reimplemented.

- **`ManifestClient`** ← `useReconciler.ts`. OkHttp. On boot: `register` POST.
  Then manifest GET with a 30s safety poll, plus an SSE connection to
  `/api/devices/:id/stream` (`manifest-changed` → refetch; `reload` → recreate
  activity; `ping` ignored). Error backoff ported from `backoff.ts`. Diffs
  incoming manifests on `playlistId+version` (`shouldReconcile.ts` ported).
  Before emitting a changed manifest, **pre-downloads** uncached items into
  `MediaCache` and evicts stale ones (same sequence as the web reconciler).
  Emits `Manifest?` on the main thread.
- **`Scheduler`** ← `createPlayerScheduler.ts`. A *pure* port of the state
  machine: modes `loop` / `single-video` / `single-image` / `empty`, A/B
  front/back indices, internal image timers, and `onTransition` /
  `onItemStart` / `onItemError` callbacks. The existing vitest cases are the
  spec for the Kotlin unit tests.
- **`PlaybackView`** ← `PlayerStage.vue`. The only substantially new logic.
  Two A/B slots, each a `FrameLayout` holding a Media3 `PlayerView`
  (TextureView output, so it alpha-blends) plus an `ImageView`. Crossfade via
  `ViewPropertyAnimator` alpha on the slots (~120ms). **Two ExoPlayer
  instances** — front plays while back preloads the next item; swap on
  transition. `single-video` mode uses `Player.REPEAT_MODE_ONE` (native loop;
  telemetry counts once per session, matching the web `<video loop>` behavior).
  Ports the consecutive-error → `stalled` → retry-after-15s self-heal.
  ExoPlayer `onPlayerError` / playback-ended events drive
  `Scheduler.itemErrored` / `Scheduler.itemEnded`.
- **`TelemetryClient`** ← `useTelemetry.ts`. Fire-and-forget POSTs to
  `/api/devices/:id/telemetry` on item start / fail / clear, carrying
  `apkVersion` and `surface:"native"`.
- **`CommandClient`** ← `useCommandChannel.ts`. OkHttp WebSocket to
  `/api/devices/:id/ws`. Ports the command switch, but dispatches to Kotlin
  **directly** (no JS bridge hop): `ota` → `OtaInstaller`, `reboot` →
  `DevicePolicy`, `screenshot` → native capture, `log-request` → logcat dump,
  `kiosk-lock`/`kiosk-unlock` → `KioskLock`. Same ack / backoff / "not
  supported" semantics as the web version.

**`PlayerActivity`** wires them together: owns `MediaCache`, constructs the
clients + scheduler + `PlaybackView`, and renders standby / no-content /
playing states as plain Views. No WebView, no JS engine, no renderer process →
the WebView "renderer-gone" failure mode does not exist in this flavor.
Activity-level kiosk (`KioskFlags`, `DevicePolicy`, snap-back, boot recovery)
is reused from `src/main` exactly as the WebView activity uses it.

### Media path (key simplification)

The WebView flavor needs `MediaCache.intercept` + Range serving + Content-Type
sniffing **only** because an http-origin WebView cannot load `file://`
resources. ExoPlayer has no such restriction — it plays a local `File`
directly. So the native offline path is simpler:

- `ManifestClient` pre-downloads each item to `MediaCache` (reusing the existing
  `downloadSync` / LRU / eviction).
- `PlaybackView` hands ExoPlayer `Uri.fromFile(cache.file(sha))` on a cache hit,
  or the CDN/`/media/:sha` URL on a miss (ExoPlayer's default data source
  streams http(s) fine; the background cache fills for the next loop).
- `MediaCache` gains a small `file(sha): File` accessor. Its WebView-only
  `intercept` / sniff methods remain, unused by the native flavor.

### Dependencies (native flavor only)

- `androidx.media3:media3-exoplayer`, `androidx.media3:media3-ui`
- `com.squareup.okhttp3:okhttp` (+ `okhttp-sse`) for manifest GET, SSE,
  telemetry POST, command WS, and media download.

`minSdk 24` is sufficient for all of these. Added as `nativeImplementation(...)`
so the WebView APK does not grow.

### Server / dashboard changes (additive only)

- **Migration:** add `devices.surface text default 'webview'` via
  `pnpm db:generate`.
- **`register.post.ts` + `telemetry.post.ts`:** accept an optional `surface`
  field (`'webview' | 'native'`, zod `.optional()`), persist it. Existing
  WebView APK omits it → defaults preserved.
- **`status.get.ts` / `devices/index.get.ts`:** expose `surface`; dashboard
  device list/detail shows a native/webview badge.
- **OTA artifact matching:** tag `apkReleases` with a `flavor` (or filename
  convention) so the dashboard pushes the matching APK to a native box. The OTA
  command already carries the chosen release's explicit url+sha, so this only
  prevents an operator from pushing a `webview` APK to a `vs` box.

All server changes are additive; the existing WebView fleet, endpoints, and
tests are untouched.

## Self-heal & error handling

- **No renderer process** → the WebView's largest failure mode (renderer-gone
  `recreate()`) is gone. ExoPlayer decode/source errors flow through
  `Scheduler.itemErrored` → advance, with the ported consecutive-error →
  stalled → retry-after-15s safety so a bad item never permanently darkens the
  screen.
- **Manifest fetch failure** → `ManifestClient` backoff retry; standby screen
  until the first successful manifest (mirrors `usePlayerBoot` behavior,
  including the re-register-on-error recovery).
- **Activity-level recovery** (boot reload backoff, kiosk snap-back) reused from
  `src/main`.
- A lightweight ExoPlayer watchdog (restart the player if it wedges in
  buffering for an extended period) is a cheap insurance addition.

## Testing

- **`./gradlew test`** (JVM unit tests, like the existing `MediaCacheTest`):
  - `Scheduler` — port the vitest cases for `createPlayerScheduler` 1:1.
  - `backoff` / `shouldReconcile` ports.
  - `ManifestClient` manifest-diff/emit logic with a faked HTTP layer.
  - `forTesting` seams as today (`MediaCache.forTesting`).
- **WebView regression:** existing `./gradlew test` plus an `assembleWebviewDebug`
  build proving the WebView APK is unchanged.
- **On-box manual verification** against a **production** server build
  (`pnpm build` + `node .output/server/index.mjs`), per the CLAUDE.md box-testing
  rule — never `pnpm dev`.

## Risks & mitigations

- **Two-implementation drift** (Kotlin player logic vs TS composables). Mitigated
  by: the server contract is the single source of truth and is small/stable; the
  ported units are pure state machines with the TS tests as a spec; the scheduler
  and reconciler diff logic get mirrored Kotlin unit tests.
- **Crossfade across two ExoPlayer/TextureView slots** is the main new-code risk.
  TextureView output (not SurfaceView) is required for alpha blending; verify on
  a real box. Fallback if blending is too costly at ≤720p: hard-cut transitions
  (acceptable for signage), kept behind the same `Scheduler` events.
- **Two simultaneous decoders** at item boundaries (front + preloading back).
  Native decode at ≤720p is cheap on these boxes, but confirm on the lowest-end
  target hardware.

## Out-of-scope / future

- Relaxing the transcode profile for all-native deployments (High/1080p/HEVC).
- A single hybrid APK with runtime surface switching.
- Retiring the WebView flavor.
