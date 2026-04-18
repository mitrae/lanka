# Lanka Player — Design

**Status:** Design approved 2026-04-18
**Owner:** Solo dev
**Parent spec:** `docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`
**Prior plans (merged):** Plan 1 (foundation & sync), Plan 2a (dashboard API), Plan 2b (dashboard UI)
**Deferred to later plans:** Android APK + on-disk media cache (Plan 5), OTA APK updates.

## Summary

The `/player` Nuxt route. One fullscreen page that runs inside an Android WebView (Plan 5) or a desktop browser tab (Plan 3 QA). It registers the device, fetches the resolved playlist manifest, plays items in a loop with double-buffered video/image rendering, listens on SSE for change events, and reports telemetry. No on-disk caching in Plan 3 — media is fetched on demand and relies on the browser HTTP cache.

## Goals

- Plays the device's resolved playlist in an uninterrupted loop with no visible black flash between items.
- Picks up playlist and playlist-version changes within seconds via SSE.
- Recovers from transient network errors without manual intervention.
- Stays visually quiet when nothing is assigned (no UI chrome, no stack traces on screen).
- Pure logic (manifest diffing, scheduler, backoff, device-id resolution) is extractable from the SFC and unit-testable.

## Non-goals (Plan 3)

- On-disk media caching / `NativeFS` bridge — deferred to Plan 5.
- Android kiosk shell (immersive mode, boot auto-start, HOME/BACK interception) — Plan 5.
- Proof-of-play per-item timestamps — `current_item_id` is enough.
- Audio — playback is muted. Unmuting requires the APK's MediaSession handling (Plan 5).
- Multi-zone layouts, time-of-day scheduling, overlays.
- Authenticated boot / device pairing codes — tailnet-only trust model from the parent spec.

## Endpoints consumed

All already shipped by Plan 1 + Plan 2a. Plan 3 only adds the client.

| Method | Path | Returns |
|---|---|---|
| `POST` | `/api/devices/register` | `{ deviceId, claimed, name, groupId }` (body: `{ deviceId, playerVersion }`) |
| `GET`  | `/api/devices/:id/manifest` | `Manifest` or `204 No Content` |
| `GET`  | `/api/devices/:id/stream` | SSE: `manifest-changed`, `reload`, `ping` |
| `POST` | `/api/devices/:id/telemetry` | `204`; body `{ currentItemId: number\|null, error?: { sha256?, message } }` |
| `GET`  | `/media/:sha256` | Binary (Range-supported, immutable cache) |

`Manifest` shape (from `server/api/devices/[id]/manifest.get.ts`):

```ts
type Manifest = {
  playlistId: number
  playlistName: string
  version: number
  items: Array<{
    id: number
    type: 'video' | 'image'
    sha256: string
    durationMs: number   // image: durationMsOverride; video: media.duration_ms
  }>
}
```

## Architecture

```
/player (page)
  ├─ useNativeDevice()         — web shim: { deviceId, reload, version, serverUrl }
  ├─ usePlayerEnv()            — { fileUrl(sha256) => '/media/' + sha256 }
  ├─ usePlayerBoot()           — register → first reconcile → open SSE + 30s poll
  ├─ useReconciler(api, env)   — fetch manifest; diff; drive scheduler; backoff
  ├─ createPlayerScheduler()   — pure state machine over items[]
  ├─ useTelemetry(api)         — fire-and-forget POSTs on item start + errors
  └─ <PlayerStage/>            — 4-element double buffer (2 <video> + 2 <img>)
       + <NoContentScreen/>    — shown on manifest 204
       + <StandbyScreen/>      — shown during connect / backoff
```

The `player.vue` page is a thin orchestrator: it wires composables, renders `<PlayerStage>` (or a standby/no-content screen), and owns no business logic.

### Why separate the scheduler from the stage

The scheduler is a pure module parameterized by `items` with clock/timer deps injected; it exposes a handle (`start`, `itemEnded`, `itemErrored`, `stop`, transition emitter). The stage is a reactive view that listens for transitions and toggles CSS classes. Splitting them lets us:

- Unit-test the scheduler with fake timers, no DOM.
- Rebuild the stage without touching loop logic.
- Swap the stage later (e.g., canvas-based decoding) without re-testing scheduling.

## Device identity

Boot flow — resolved at startup, stable for the life of the page:

```
resolveDeviceId(query, storage, generate):
  1. if query.deviceId  → return query.deviceId   (ad-hoc override for QA)
  2. if storage.get('lanka:deviceId')  → return it
  3. id = generate()  // crypto.randomUUID()
  4. storage.set('lanka:deviceId', id)
  5. return id
```

- Query override (`/player?deviceId=X`) does **not** write to storage — it's a per-session impersonation.
- Persistent UUID survives reloads, lost if site data is cleared.
- Plan 5 swap: `useNativeDevice().deviceId()` is injected by the APK bridge (Android ID); otherwise falls back to the flow above. The `storage.get('lanka:deviceId')` step is Plan 3-only; the APK's Android ID takes precedence once the bridge exists.

The `NativeDevice` contract (from the parent spec) is introduced in Plan 3 as a web shim so player code talks to a stable API across environments:

```ts
interface NativeDevice {
  deviceId(): string
  reload(): void
  version(): { app: string, os: string, model: string }
  serverUrl(): string
}
```

Web implementation:
- `deviceId()` runs the resolution flow above.
- `reload()` → `location.reload()`.
- `version()` → `{ app: '3.0.0-web', os: navigator.userAgent, model: 'Browser' }`.
- `serverUrl()` → `location.origin`.

`NativeFS` is **not** introduced in Plan 3 — the player uses `/media/<sha256>` URLs directly via `usePlayerEnv().fileUrl(sha256)`. Plan 5 will replace `fileUrl`'s return value with `https://appassets.androidplatform.net/media/<sha256>` (APK-side) without touching the rest of the player.

## Boot and reconcile

### Boot sequence

```
onMounted():
  const device = useNativeDevice()
  const env    = usePlayerEnv()
  const api    = useApiClient()

  try {
    await api.register({ deviceId: device.deviceId(), playerVersion: PLAYER_VERSION })
  } catch { /* swallow — reconcile will retry fetches on its own cadence */ }

  await reconcile()                      // first fetch, drives the stage
  openSSE('/api/devices/:id/stream')     // listens for manifest-changed / reload
  setInterval(reconcile, 30_000)         // safety poll
```

The register call is best-effort: if it fails, the reconciler's own retry loop will still try to fetch a manifest. The server's `handleManifest` returns 404 for unknown devices, which the reconciler treats like a transient error and retries with backoff until register eventually succeeds.

### Reconcile

```
reconcile():
  try:
    m = GET /api/devices/:id/manifest    // Manifest | null (204 -> null)
  catch err:
    transition to Standby; schedule retry with backoff(attempt); return

  reset backoff.attempt to 0

  if m is null:
    show NoContentScreen; last = null; scheduler.stop(); return

  if shouldReconcile(last, m) is false:
    return                                // same playlistId + version, nothing to do

  scheduler = createPlayerScheduler({ items: m.items, ... })
  stage.mount(scheduler)                  // sets front = items[0], back = items[1 % len]
  last = { playlistId: m.playlistId, version: m.version }
```

`shouldReconcile(prev, next)`:

```ts
function shouldReconcile(
  prev: { playlistId: number; version: number } | null,
  next: { playlistId: number; version: number }
): boolean {
  return !prev || prev.playlistId !== next.playlistId || prev.version !== next.version
}
```

### SSE handling

- `EventSource` subscribes to `/api/devices/:id/stream`.
- `manifest-changed` event → `reconcile()`.
- `reload` event → `useNativeDevice().reload()`.
- `ping` → no-op.
- `error` (EventSource) → surface state in `StandbyScreen` if no manifest has been loaded yet; otherwise keep playing current manifest and let the browser auto-reconnect. On `open` after a drop, trigger one reconcile to catch up missed events.

### Backoff

```ts
function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000)   // 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
}
```

Applied to manifest fetch failures only. SSE auto-reconnect is handled by the browser.

## Scheduler (state machine)

Pure module; no DOM, no `EventSource`, no `$fetch`. All side-effecting deps (timers, random, now) are injected for testability.

```ts
type SchedulerDeps = {
  now: () => number
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
}

type TransitionEvent = {
  from: number        // index leaving front
  to: number          // index entering front
  nextPreload: number // index to stage into back after the swap
}

type SchedulerHandle = {
  start(): void                     // kick off item 0
  itemEnded(index: number): void    // called on <video>.ended or image timer fire
  itemErrored(index: number, msg: string): void
  stop(): void                      // cancel timers, go inert
  getFrontIndex(): number
  getBackIndex(): number
  onTransition(fn: (e: TransitionEvent) => void): () => void
  onItemStart(fn: (index: number) => void): () => void
  onItemError(fn: (index: number, msg: string) => void): () => void
}

function createPlayerScheduler(
  items: ManifestItem[],
  deps: SchedulerDeps
): SchedulerHandle
```

### Rules

- `nextIndex(i) = (i + 1) % items.length` — simple modular advance.
- On `start()`: `front = 0`, `back = nextIndex(0)`, emit `onItemStart(0)`, arm image timer if `items[0].type === 'image'`.
- On `itemEnded(index)`:
  - If `index !== front` (stale event from a skipped item) → ignore.
  - `from = front; to = back; back = nextIndex(to)`.
  - Cancel any image timer.
  - Emit `onTransition({ from, to, nextPreload: back })`.
  - Emit `onItemStart(to)`.
  - If `items[to].type === 'image'`, arm a timer for `durationMs`.
- On `itemErrored(index, msg)`: emit `onItemError(index, msg)`; then behave as if `itemEnded(index)` — skip to next.
- On `stop()`: clear any pending image timer; stop emitting.

### Single-item mode

If `items.length === 1`, the scheduler does **not** advance on `itemEnded` — it never fires a transition. Instead, it emits `onItemStart(0)` once and relies on:
- `<video loop autoplay muted playsinline>` for a single video item (native loop, zero gap).
- A re-armed image timer inside the scheduler for a single image item (the timer callback re-emits `onItemStart(0)` to re-trigger stage rendering for telemetry purposes, but does not swap slots).

This branch is detected at construction and exposed via `scheduler.mode: 'loop' | 'single-video' | 'single-image'` to let the stage decide whether to set `loop` on the video element.

### Zero-length manifest

The server guarantees at least one item in a returned manifest (empty playlists would return 204). If `items.length === 0` somehow occurs, the scheduler enters `stop()` mode and the page falls back to `NoContentScreen`.

## Stage rendering

Four always-mounted elements in a single component; visibility driven by two CSS classes applied to wrapping `<div>`s.

```
<PlayerStage>
  <div class="slot" :class="{ front: frontIsA, back: !frontIsA }">
    <video ref="videoA" muted playsinline preload="auto"
           @ended="onVideoEnded('A')" @error="onVideoError('A')" />
    <img   ref="imgA"   @load="onImgLoad('A')" @error="onImgError('A')" />
  </div>
  <div class="slot" :class="{ front: !frontIsA, back: frontIsA }">
    <video ref="videoB" ... />
    <img   ref="imgB"   ... />
  </div>
</PlayerStage>
```

Wrapper classes:
- `.front` — `z-index: 2; opacity: 1;`
- `.back`  — `z-index: 1; opacity: 0;` (still loading/decoding under the hood)

Element visibility within a slot is driven by which one has a current `src`:
- Video item in slot: set `<video>.src`, hide `<img>` via `display: none`.
- Image item in slot: set `<img>.src`, hide `<video>` via `display: none`.

### Preload

When the scheduler emits `onTransition({ to, nextPreload })`:
1. Set the now-`back` slot's media element (per `items[nextPreload].type`) source to `env.fileUrl(items[nextPreload].sha256)`.
2. For a video, call `.load()`; wait for `canplaythrough`. For an image, wait for `load`.
3. On preload success, the back slot is ready for the next swap.
4. If preload emits `error` → the stage reports `itemErrored(nextPreload, ...)` to the scheduler, which advances past that index; the stage then attempts the *new* `nextPreload`.

### Swap timing

- On the scheduler's `onTransition` for the currently playing item (fired at `<video>.ended` or image-timer elapse), the stage flips `frontIsA`. CSS opacity transition (or instant swap) reveals the back slot which has been fully decoded.
- Opacity swap — not `display: none` — keeps the outgoing element rendered for one more frame so there's no blank frame.

### Video vs image playback

- Video: `<video>` autoplays muted when its slot becomes front. `ended` → scheduler.itemEnded.
- Image: when the slot becomes front, stage notifies scheduler of the item starting, which sets an image timer for `durationMs`. On fire, scheduler transitions.

### Error handling on the stage

- Front-slot media element fires `error` during playback → call `scheduler.itemErrored(front, msg)`. Scheduler treats this as a premature end: advance, emit transition.
- Back-slot preload fires `error` → same: `scheduler.itemErrored(nextPreload, msg)`. Scheduler emits a fresh `nextPreload` via its next transition calculation and the stage retries.
- Runaway error loop protection: the stage tracks consecutive error count; after 5 consecutive errors without a successful `onItemStart`, it falls back to `StandbyScreen` and waits for the next reconcile.

### Autoplay and mute

`<video muted playsinline autoplay preload="auto">`. Autoplay with sound is blocked in all major browsers without a user gesture; muted is the universal policy here. Audio is re-introduced in Plan 5 via the APK's MediaSession, which has different autoplay affordances.

### Loop attribute

Set `loop` on the front video element **only** when `scheduler.mode === 'single-video'`. In multi-item mode, `loop` must be off — we use `ended` to drive the state machine. When `reconcile()` rebuilds the scheduler, the stage re-derives `loop` from the new `scheduler.mode` and re-binds the video element attributes accordingly.

## Telemetry

Fire-and-forget posts to `/api/devices/:id/telemetry`:

- On `onItemStart(index)` → `POST { currentItemId: items[index].id }`.
- On `onItemError(index, msg)` → `POST { currentItemId: items[index].id, error: { sha256: items[index].sha256, message: msg } }`.
- On manifest change to `null` (no-content) → `POST { currentItemId: null }`.

No throttling in Plan 3. At 50 devices with typical 8–15s items, this is <10 req/s server-wide. Any future throttling is a pure-function change to `useTelemetry`.

Telemetry failures are swallowed — they do not affect playback and are re-emitted on the next transition.

## Standby / no-content screens

Both are pure Vue components, full-screen, black background.

`<NoContentScreen>`:
- Centered: "No content assigned"
- Below: device id in `font-mono` small gray text
- A small pulsing emerald dot to prove the page is alive

`<StandbyScreen>` (connecting / backoff):
- Centered: "Connecting…"
- Below: elapsed time since last successful fetch (monospace)
- The page stays on this screen until the first successful manifest arrives; after that, connection hiccups don't replace the playing manifest with this screen.

## File layout

```
app/
├── pages/
│   └── player.vue                    # entry; layout: false; client-only page
├── components/
│   └── player/
│       ├── PlayerStage.vue           # 4-element double buffer
│       ├── NoContentScreen.vue
│       └── StandbyScreen.vue
└── composables/
    └── player/                       # nested -> NOT auto-imported globally
        ├── useNativeDevice.ts
        ├── usePlayerEnv.ts
        ├── usePlayerBoot.ts          # wires the whole player together
        ├── useReconciler.ts          # shouldReconcile + backoff orchestration
        ├── createPlayerScheduler.ts  # pure state machine
        ├── useTelemetry.ts           # fire-and-forget wrapper
        ├── shouldReconcile.ts        # pure
        ├── backoff.ts                # pure
        └── resolveDeviceId.ts        # pure

tests/
└── player/
    ├── shouldReconcile.test.ts
    ├── resolveDeviceId.test.ts
    ├── createPlayerScheduler.test.ts
    ├── backoff.test.ts
    └── useReconciler.test.ts         # mocked ApiClient + fake EventSource
```

### Nuxt auto-import caveat

The project config (`nuxt.config.ts`) sets `imports.dirs: ['app/composables', 'app/stores']`. By default Nuxt auto-imports recursively. To avoid polluting the dashboard's global import namespace with player internals, the player composables are nested one level deep (`app/composables/player/`) and imported **explicitly** inside `player.vue` and its components:

```ts
import { usePlayerBoot } from '~/app/composables/player/usePlayerBoot'
```

An alternative — setting `imports.dirs` to explicit paths with `pathDepth: 1` — is possible but risks breaking existing dashboard imports; explicit imports are the lower-risk choice. This is documented inline in `player.vue`.

## Testing

**Unit (vitest)** — pure logic, no DOM.

| Module | Cases |
|---|---|
| `shouldReconcile` | null prev; same id+version; different id; different version |
| `resolveDeviceId` | query wins over storage; storage wins over generate; generate persists to storage; query does NOT persist |
| `backoff` | 0→1s, 1→2s, 5→30s, 10→30s (capped) |
| `createPlayerScheduler` | start emits onItemStart(0); itemEnded advances front; stale itemEnded (wrong index) ignored; itemErrored behaves as itemEnded with extra emit; single-item mode never transitions; zero-length goes inert; stop cancels pending image timer |
| `useReconciler` | on first fetch drives scheduler; on manifest-changed SSE event refetches; on 204 stops scheduler and shows no-content; on fetch error schedules retry with backoff; retry resets attempt on success |

**Manual QA (no automation in v1)**:
- Load `/player?deviceId=<test>` in a browser; confirm video autoplay (muted) and image timer.
- Assign a playlist to that device via the dashboard; confirm reconcile within seconds via SSE.
- Bump a playlist item's duration; confirm version bump propagates and the loop rebuilds cleanly.
- Delete all assignments → confirm `NoContentScreen`.
- `docker stop lanka` (or equivalent) for 30s → confirm `StandbyScreen` and recovery on restart.
- Throw an invalid video file into the playlist → confirm the item is skipped, telemetry posts an error, red dot appears on the dashboard.

Component-level tests of `<PlayerStage>` are deferred. JSDOM's `<video>` support is limited, and the mechanical swap logic is a thin wrapper over the scheduler's emissions — which we do test.

## Out-of-scope / open items

- **Plan 5 — APK**: introduces `NativeFS`, swaps `fileUrl` to an appassets URL, overrides `NativeDevice.deviceId()` with Android ID, unmutes audio via MediaSession, and adds the reconcile-loop `exists`/`download`/`evictExcept` steps from the parent spec.
- **Audio**: muted in Plan 3. Product decision on unmute defaults deferred.
- **Crash telemetry**: per-item error messages only. No `window.onerror` → server channel in Plan 3.
- **Screenshot-on-demand** (for dashboard previews): deferred; would need a canvas-capture endpoint and a round-trip via SSE.
