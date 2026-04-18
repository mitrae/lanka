# Lanka Player — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/player` Nuxt route — a fullscreen page that registers the device, resolves its playlist via the existing API, plays items in a loop with double-buffered video/image rendering, syncs via SSE + 30s poll, reports telemetry, and degrades gracefully to standby / no-content screens.

**Architecture:** Plan 3 is web-only (no APK bridge). A thin `NativeDevice` web shim provides `deviceId`/`reload`. Reconcile loop diffs `{playlistId, version}` and drives a pure scheduler state machine over the manifest `items[]`. The stage is four always-mounted elements (2 `<video>` + 2 `<img>`) with CSS-based front/back swapping. Pure logic (scheduler, manifest diff, backoff, device-id resolution) is unit-tested with fake timers and mocked `ApiClient`; rendering is manual QA.

**Tech Stack:** Nuxt 4 (SPA mode), Nuxt UI v3, existing `useApiClient` composable, browser `EventSource`, vitest, `tests/helpers/nuxt-stubs.ts`, `crypto.randomUUID`.

**Parent spec:** `docs/superpowers/specs/2026-04-18-lanka-player-design.md`
**Prior plans (merged):** Plan 1 (foundation & sync), Plan 2a (dashboard API), Plan 2b (dashboard UI).

---

## Scope

**Delivered:**

- `/player` page with `layout: false`, fullscreen, client-only.
- `useNativeDevice()` web shim — `deviceId`, `reload`, `version`, `serverUrl`.
- `usePlayerEnv()` — `fileUrl(sha256) → /media/<sha256>`.
- `usePlayerBoot()` — register → first reconcile → SSE + 30s safety poll.
- `useReconciler()` — manifest fetch + diff + backoff orchestration.
- `createPlayerScheduler()` — pure state machine (start, itemEnded, itemErrored, stop; single-item mode).
- `useTelemetry()` — fire-and-forget item-start + error POSTs.
- `<PlayerStage>` — 4-element double buffer.
- `<NoContentScreen>`, `<StandbyScreen>`.
- `useApiClient` extended with `register`, `getManifest`, `postTelemetry`.
- Unit tests for: `shouldReconcile`, `resolveDeviceId`, `backoff`, `createPlayerScheduler`, `useReconciler`.

**Deferred (intentional):**

- `NativeFS` bridge + on-disk caching (Plan 5).
- Android APK shell (Plan 5).
- OTA APK updates (Plan 5).
- Audio/unmute policy (Plan 5).
- Component tests of `<PlayerStage>` (JSDOM can't render `<video>` meaningfully — manual QA).
- Screenshot capture / dashboard live preview.

---

## File Structure

```
lanka/
├── app/
│   ├── pages/
│   │   └── player.vue                                # NEW — entry, layout: false
│   ├── components/
│   │   └── player/                                   # NEW — nested to stay out of global autoload
│   │       ├── PlayerStage.vue
│   │       ├── NoContentScreen.vue
│   │       └── StandbyScreen.vue
│   ├── composables/
│   │   ├── useApiClient.ts                           # MODIFIED — add register/getManifest/postTelemetry
│   │   └── player/                                   # NEW — explicit imports only
│   │       ├── shouldReconcile.ts
│   │       ├── backoff.ts
│   │       ├── resolveDeviceId.ts
│   │       ├── createPlayerScheduler.ts
│   │       ├── useNativeDevice.ts
│   │       ├── usePlayerEnv.ts
│   │       ├── useTelemetry.ts
│   │       ├── useReconciler.ts
│   │       └── usePlayerBoot.ts
│   └── types/
│       └── api.ts                                    # MODIFIED — export type already present; no new types needed
├── tests/
│   └── player/                                       # NEW
│       ├── shouldReconcile.test.ts
│       ├── backoff.test.ts
│       ├── resolveDeviceId.test.ts
│       ├── createPlayerScheduler.test.ts
│       └── useReconciler.test.ts
└── README.md                                         # MODIFIED — /player section
```

**Note on auto-imports.** `nuxt.config.ts` has `imports.dirs: ['app/composables', 'app/stores']`. Auto-import is recursive by default, which would expose every `usePlayerBoot`/`createPlayerScheduler`/etc. as a global symbol inside dashboard pages. We avoid that by:

- Placing player composables in a nested `app/composables/player/` folder — **they are still auto-importable** (Nuxt recurses).
- Explicitly importing them in player code (`import { usePlayerBoot } from '~/app/composables/player/usePlayerBoot'`) to signal intent and keep collisions impossible if we later rename globals.
- Putting player components in `app/components/player/` — with `pathPrefix: false` the components resolve as `<PlayerStage/>` (no `Player` prefix). Since the dashboard doesn't use these component names, no collision.

This is simpler than reconfiguring `imports.dirs`. The explicit-import convention is documented inline in `player.vue`.

---

## Task 1: Extend `useApiClient` with player endpoints

The existing client has no `register`, `getManifest`, or `postTelemetry` methods. Add them, mirroring the server handler shapes.

**Files:**
- Modify: `app/composables/useApiClient.ts`
- Test: `tests/composables/useApiClient.test.ts`

- [ ] **Step 1: Add types import reference (no-op if already referenced)**

Open `app/composables/useApiClient.ts`. The existing imports at the top already pull from `~/app/types/api`. Add `Manifest` and `RegisterResult` to that import:

```ts
import type {
  Address,
  Assignment,
  Device,
  DeviceListRow,
  Group,
  Manifest,
  Media,
  MediaListRow,
  Playlist,
  PlaylistDetail,
  PlaylistSummary,
  RegisterResult
} from '~/app/types/api'
```

- [ ] **Step 2: Extend the `ApiClient` interface**

In `app/composables/useApiClient.ts`, add the following methods to the `ApiClient` interface, placed right after the existing device methods (after `reloadDevice`):

```ts
  // player-facing
  register(body: {
    deviceId: string
    playerVersion: string
  }): Promise<RegisterResult>
  getManifest(deviceId: string): Promise<Manifest | null>
  postTelemetry(
    deviceId: string,
    body: {
      currentItemId: number | null
      error?: { sha256?: string; message: string }
    }
  ): Promise<void>
```

- [ ] **Step 3: Implement the three methods inside `createApiClient`**

Inside the object returned by `createApiClient(fetch)`, add these entries after `reloadDevice` (order for readability):

```ts
    // player-facing
    register: (body) =>
      fetch<RegisterResult>('/api/devices/register', {
        method: 'POST',
        body
      }),
    getManifest: async (deviceId) => {
      // Handler returns 204 + null body when no assignment resolves. Use
      // .raw so we can check the status without $fetch treating 204 as an
      // error or silently returning empty string.
      const res = await (fetch as any).raw(
        `/api/devices/${deviceId}/manifest`,
        { method: 'GET' }
      )
      if (res.status === 204) return null
      return res._data as Manifest
    },
    postTelemetry: (deviceId, body) =>
      fetch<void>(`/api/devices/${deviceId}/telemetry`, {
        method: 'POST',
        body
      }),
```

- [ ] **Step 4: Write failing tests for the three methods**

Open `tests/composables/useApiClient.test.ts`. Add these tests to the existing describe block (they follow the existing test style):

```ts
// Append inside describe('useApiClient', ...) in the existing file.

it('register() POSTs to /api/devices/register', async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const mock = Object.assign(
    (url: string, opts: any) => {
      calls.push({ url, opts })
      return Promise.resolve({
        deviceId: 'tv-1',
        claimed: false,
        name: null,
        groupId: null
      })
    },
    { raw: () => Promise.resolve({ status: 200, _data: null }) }
  ) as any

  const api = createApiClient(mock)
  const out = await api.register({ deviceId: 'tv-1', playerVersion: '3.0.0' })

  expect(calls[0]?.url).toBe('/api/devices/register')
  expect(calls[0]?.opts.method).toBe('POST')
  expect(calls[0]?.opts.body).toEqual({
    deviceId: 'tv-1',
    playerVersion: '3.0.0'
  })
  expect(out.claimed).toBe(false)
})

it('getManifest() returns the body on 200', async () => {
  const manifest = {
    playlistId: 1,
    playlistName: 'P',
    version: 5,
    items: []
  }
  const mock = Object.assign(
    (_u: string, _o: any) => Promise.reject(new Error('should not call fetch')),
    { raw: () => Promise.resolve({ status: 200, _data: manifest }) }
  ) as any

  const api = createApiClient(mock)
  const out = await api.getManifest('tv-1')
  expect(out).toEqual(manifest)
})

it('getManifest() returns null on 204', async () => {
  const mock = Object.assign(
    (_u: string, _o: any) => Promise.reject(new Error('should not call fetch')),
    { raw: () => Promise.resolve({ status: 204, _data: null }) }
  ) as any

  const api = createApiClient(mock)
  const out = await api.getManifest('tv-1')
  expect(out).toBeNull()
})

it('postTelemetry() POSTs { currentItemId, error? }', async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const mock = Object.assign(
    (url: string, opts: any) => {
      calls.push({ url, opts })
      return Promise.resolve(undefined)
    },
    { raw: () => Promise.resolve({ status: 204, _data: null }) }
  ) as any

  const api = createApiClient(mock)
  await api.postTelemetry('tv-1', {
    currentItemId: 42,
    error: { sha256: 'abc', message: 'decode failed' }
  })

  expect(calls[0]?.url).toBe('/api/devices/tv-1/telemetry')
  expect(calls[0]?.opts.method).toBe('POST')
  expect(calls[0]?.opts.body).toEqual({
    currentItemId: 42,
    error: { sha256: 'abc', message: 'decode failed' }
  })
})
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test tests/composables/useApiClient.test.ts
```

Expected: all tests in the file pass, including the four new ones.

- [ ] **Step 6: Commit**

```bash
git add app/composables/useApiClient.ts tests/composables/useApiClient.test.ts
git commit -m "feat(player): extend useApiClient with register, getManifest, postTelemetry"
```

---

## Task 2: Pure helpers — `shouldReconcile`, `backoff`, `resolveDeviceId`

Three small pure modules, TDD'd. Each is its own file for discoverability.

**Files:**
- Create: `app/composables/player/shouldReconcile.ts`
- Create: `app/composables/player/backoff.ts`
- Create: `app/composables/player/resolveDeviceId.ts`
- Create: `tests/player/shouldReconcile.test.ts`
- Create: `tests/player/backoff.test.ts`
- Create: `tests/player/resolveDeviceId.test.ts`

- [ ] **Step 1: Create `tests/player/` directory**

```bash
mkdir -p tests/player
```

- [ ] **Step 2: Write failing test for `shouldReconcile`**

Create `tests/player/shouldReconcile.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { shouldReconcile } from '~/app/composables/player/shouldReconcile'

describe('shouldReconcile', () => {
  it('returns true when prev is null', () => {
    expect(shouldReconcile(null, { playlistId: 1, version: 1 })).toBe(true)
  })

  it('returns false when playlistId + version match', () => {
    expect(
      shouldReconcile({ playlistId: 1, version: 1 }, { playlistId: 1, version: 1 })
    ).toBe(false)
  })

  it('returns true when playlistId changed', () => {
    expect(
      shouldReconcile({ playlistId: 1, version: 1 }, { playlistId: 2, version: 1 })
    ).toBe(true)
  })

  it('returns true when version changed', () => {
    expect(
      shouldReconcile({ playlistId: 1, version: 1 }, { playlistId: 1, version: 2 })
    ).toBe(true)
  })
})
```

- [ ] **Step 3: Run the test — confirm it fails**

```bash
pnpm test tests/player/shouldReconcile.test.ts
```

Expected: module-not-found / import error.

- [ ] **Step 4: Implement `shouldReconcile`**

Create `app/composables/player/shouldReconcile.ts`:

```ts
// app/composables/player/shouldReconcile.ts
export type ManifestKey = { playlistId: number; version: number }

export function shouldReconcile(
  prev: ManifestKey | null,
  next: ManifestKey
): boolean {
  if (!prev) return true
  return prev.playlistId !== next.playlistId || prev.version !== next.version
}
```

- [ ] **Step 5: Re-run the test — confirm it passes**

```bash
pnpm test tests/player/shouldReconcile.test.ts
```

Expected: 4 passed.

- [ ] **Step 6: Write failing test for `backoff`**

Create `tests/player/backoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { backoff } from '~/app/composables/player/backoff'

describe('backoff', () => {
  it('returns 1000ms at attempt 0', () => {
    expect(backoff(0)).toBe(1000)
  })

  it('doubles per attempt: 2s, 4s, 8s, 16s', () => {
    expect(backoff(1)).toBe(2000)
    expect(backoff(2)).toBe(4000)
    expect(backoff(3)).toBe(8000)
    expect(backoff(4)).toBe(16000)
  })

  it('caps at 30 seconds', () => {
    expect(backoff(5)).toBe(30000)
    expect(backoff(10)).toBe(30000)
    expect(backoff(99)).toBe(30000)
  })
})
```

- [ ] **Step 7: Run — confirm it fails**

```bash
pnpm test tests/player/backoff.test.ts
```

Expected: module not found.

- [ ] **Step 8: Implement `backoff`**

Create `app/composables/player/backoff.ts`:

```ts
// app/composables/player/backoff.ts
/**
 * Exponential backoff capped at 30 seconds. Used by the reconciler to
 * space out retries when the manifest fetch fails. Reset the `attempt`
 * argument to 0 on any successful fetch.
 */
export function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000)
}
```

- [ ] **Step 9: Re-run — confirm it passes**

```bash
pnpm test tests/player/backoff.test.ts
```

Expected: 3 passed.

- [ ] **Step 10: Write failing test for `resolveDeviceId`**

Create `tests/player/resolveDeviceId.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { resolveDeviceId } from '~/app/composables/player/resolveDeviceId'

function makeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    get: vi.fn((k: string) => data[k] ?? null),
    set: vi.fn((k: string, v: string) => {
      data[k] = v
    }),
    _data: data
  }
}

describe('resolveDeviceId', () => {
  it('returns the query override without touching storage', () => {
    const storage = makeStorage()
    const id = resolveDeviceId({
      query: 'override-id',
      storage,
      generate: () => 'should-not-call'
    })
    expect(id).toBe('override-id')
    expect(storage.set).not.toHaveBeenCalled()
    expect(storage.get).not.toHaveBeenCalled()
  })

  it('returns storage value when no query override', () => {
    const storage = makeStorage({ 'lanka:deviceId': 'persisted-id' })
    const id = resolveDeviceId({
      query: undefined,
      storage,
      generate: () => 'should-not-call'
    })
    expect(id).toBe('persisted-id')
    expect(storage.set).not.toHaveBeenCalled()
  })

  it('generates and persists when storage is empty', () => {
    const storage = makeStorage()
    const id = resolveDeviceId({
      query: undefined,
      storage,
      generate: () => 'fresh-uuid'
    })
    expect(id).toBe('fresh-uuid')
    expect(storage.set).toHaveBeenCalledWith('lanka:deviceId', 'fresh-uuid')
  })

  it('empty-string query is ignored (treated as absent)', () => {
    const storage = makeStorage({ 'lanka:deviceId': 'persisted-id' })
    const id = resolveDeviceId({
      query: '',
      storage,
      generate: () => 'should-not-call'
    })
    expect(id).toBe('persisted-id')
  })
})
```

- [ ] **Step 11: Run — confirm it fails**

```bash
pnpm test tests/player/resolveDeviceId.test.ts
```

Expected: module not found.

- [ ] **Step 12: Implement `resolveDeviceId`**

Create `app/composables/player/resolveDeviceId.ts`:

```ts
// app/composables/player/resolveDeviceId.ts
export interface DeviceIdStorage {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface ResolveDeviceIdDeps {
  query: string | undefined
  storage: DeviceIdStorage
  generate: () => string
}

export const DEVICE_ID_KEY = 'lanka:deviceId'

export function resolveDeviceId(deps: ResolveDeviceIdDeps): string {
  if (deps.query && deps.query.length > 0) {
    return deps.query
  }
  const fromStorage = deps.storage.get(DEVICE_ID_KEY)
  if (fromStorage) return fromStorage

  const fresh = deps.generate()
  deps.storage.set(DEVICE_ID_KEY, fresh)
  return fresh
}
```

- [ ] **Step 13: Re-run — confirm it passes**

```bash
pnpm test tests/player/resolveDeviceId.test.ts
```

Expected: 4 passed.

- [ ] **Step 14: Commit**

```bash
git add app/composables/player/shouldReconcile.ts \
        app/composables/player/backoff.ts \
        app/composables/player/resolveDeviceId.ts \
        tests/player/shouldReconcile.test.ts \
        tests/player/backoff.test.ts \
        tests/player/resolveDeviceId.test.ts
git commit -m "feat(player): pure helpers (shouldReconcile, backoff, resolveDeviceId)"
```

---

## Task 3: `createPlayerScheduler` state machine

Pure state machine over `items[]`. Dependencies (timers, `now`) are injected so tests drive time deterministically.

**Files:**
- Create: `app/composables/player/createPlayerScheduler.ts`
- Create: `tests/player/createPlayerScheduler.test.ts`

- [ ] **Step 1: Write failing tests (covers all spec cases)**

Create `tests/player/createPlayerScheduler.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPlayerScheduler,
  type SchedulerDeps
} from '~/app/composables/player/createPlayerScheduler'
import type { ManifestItem } from '~/app/types/api'

function fakeDeps(): SchedulerDeps & {
  advanceTime: (ms: number) => void
  pending: () => number
} {
  type Pending = { cb: () => void; at: number; id: number }
  let now = 0
  let nextId = 1
  const pending: Pending[] = []

  const deps = {
    now: () => now,
    setTimeout: (cb: () => void, ms: number) => {
      const id = nextId++
      pending.push({ cb, at: now + ms, id })
      return id
    },
    clearTimeout: (handle: unknown) => {
      const idx = pending.findIndex((p) => p.id === handle)
      if (idx >= 0) pending.splice(idx, 1)
    },
    advanceTime(ms: number) {
      now += ms
      while (true) {
        const due = pending.filter((p) => p.at <= now)
        if (due.length === 0) break
        pending.splice(pending.indexOf(due[0]), 1)
        due[0].cb()
      }
    },
    pending: () => pending.length
  }

  return deps
}

const video = (id: number, durationMs = 10_000): ManifestItem => ({
  id,
  type: 'video',
  sha256: `sha-${id}`,
  durationMs
})
const image = (id: number, durationMs = 8_000): ManifestItem => ({
  id,
  type: 'image',
  sha256: `sha-${id}`,
  durationMs
})

describe('createPlayerScheduler', () => {
  let deps: ReturnType<typeof fakeDeps>

  beforeEach(() => {
    deps = fakeDeps()
  })

  it('emits onItemStart(0) on start() with multi-item playlist', () => {
    const items = [video(1), video(2), image(3)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()
    expect(starts).toEqual([0])
    expect(s.getFrontIndex()).toBe(0)
    expect(s.getBackIndex()).toBe(1)
    expect(s.mode).toBe('loop')
  })

  it('advances front on itemEnded and emits transition + onItemStart', () => {
    const items = [video(1), video(2), video(3)]
    const s = createPlayerScheduler(items, deps)
    const transitions: Array<{ from: number; to: number; nextPreload: number }> = []
    const starts: number[] = []
    s.onTransition((e) => transitions.push(e))
    s.onItemStart((i) => starts.push(i))
    s.start()

    s.itemEnded(0)
    expect(transitions).toEqual([{ from: 0, to: 1, nextPreload: 2 }])
    expect(starts).toEqual([0, 1])
    expect(s.getFrontIndex()).toBe(1)
    expect(s.getBackIndex()).toBe(2)

    s.itemEnded(1)
    expect(transitions[1]).toEqual({ from: 1, to: 2, nextPreload: 0 })
    expect(s.getFrontIndex()).toBe(2)
    expect(s.getBackIndex()).toBe(0)

    s.itemEnded(2)
    expect(transitions[2]).toEqual({ from: 2, to: 0, nextPreload: 1 })
    expect(s.getFrontIndex()).toBe(0)
  })

  it('ignores stale itemEnded whose index is not the current front', () => {
    const items = [video(1), video(2), video(3)]
    const s = createPlayerScheduler(items, deps)
    const transitions: unknown[] = []
    s.onTransition((e) => transitions.push(e))
    s.start()

    s.itemEnded(0) // legitimate
    expect(transitions.length).toBe(1)

    s.itemEnded(0) // stale — front is now 1
    expect(transitions.length).toBe(1)
  })

  it('arms an image timer for durationMs when the current item is an image', () => {
    const items = [image(1, 5_000), video(2)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()
    expect(deps.pending()).toBe(1)

    deps.advanceTime(4_999)
    expect(starts).toEqual([0])

    deps.advanceTime(1)
    expect(starts).toEqual([0, 1])
    expect(s.getFrontIndex()).toBe(1)
  })

  it('does not arm a timer for video items', () => {
    const items = [video(1), image(2)]
    const s = createPlayerScheduler(items, deps)
    s.start()
    expect(deps.pending()).toBe(0)
  })

  it('clears image timer on itemEnded to prevent late fire', () => {
    const items = [image(1, 5_000), video(2)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()
    expect(deps.pending()).toBe(1)

    // Video element in slot 1 finishes before the image timer (e.g., swap
    // happened early due to error on item 0 handled elsewhere). We call
    // itemEnded(0) — the image — to advance; timer must be cancelled.
    s.itemEnded(0)
    expect(deps.pending()).toBe(0)

    deps.advanceTime(10_000)
    expect(starts).toEqual([0, 1]) // no third start — timer was cancelled
  })

  it('itemErrored emits onItemError and advances like itemEnded', () => {
    const items = [video(1), video(2), video(3)]
    const s = createPlayerScheduler(items, deps)
    const errs: Array<{ index: number; msg: string }> = []
    const transitions: unknown[] = []
    s.onItemError((i, msg) => errs.push({ index: i, msg }))
    s.onTransition((e) => transitions.push(e))
    s.start()

    s.itemErrored(0, 'decode failed')
    expect(errs).toEqual([{ index: 0, msg: 'decode failed' }])
    expect(transitions.length).toBe(1)
    expect(s.getFrontIndex()).toBe(1)
  })

  it('single video item enters single-video mode; no advance on itemEnded', () => {
    const items = [video(1)]
    const s = createPlayerScheduler(items, deps)
    const transitions: unknown[] = []
    const starts: number[] = []
    s.onTransition((e) => transitions.push(e))
    s.onItemStart((i) => starts.push(i))
    s.start()

    expect(s.mode).toBe('single-video')
    expect(starts).toEqual([0])

    s.itemEnded(0)
    expect(transitions.length).toBe(0)
    expect(s.getFrontIndex()).toBe(0)
  })

  it('single image item re-arms timer and re-emits onItemStart(0)', () => {
    const items = [image(1, 3_000)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()

    expect(s.mode).toBe('single-image')
    expect(starts).toEqual([0])
    expect(deps.pending()).toBe(1)

    deps.advanceTime(3_000)
    expect(starts).toEqual([0, 0])
    expect(deps.pending()).toBe(1)

    deps.advanceTime(3_000)
    expect(starts).toEqual([0, 0, 0])
  })

  it('stop() cancels pending image timer and stops emitting', () => {
    const items = [image(1, 5_000)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()
    expect(deps.pending()).toBe(1)

    s.stop()
    expect(deps.pending()).toBe(0)

    deps.advanceTime(10_000)
    expect(starts).toEqual([0]) // no re-fire after stop
  })

  it('zero-length items array goes inert (no starts, no timers)', () => {
    const s = createPlayerScheduler([], deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()
    expect(starts).toEqual([])
    expect(deps.pending()).toBe(0)
    expect(s.mode).toBe('empty')
  })

  it('onItemStart returns an unsubscribe function', () => {
    const items = [video(1), video(2)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    const unsub = s.onItemStart((i) => starts.push(i))
    s.start()
    unsub()
    s.itemEnded(0)
    expect(starts).toEqual([0])
  })
})
```

- [ ] **Step 2: Run — confirm it fails**

```bash
pnpm test tests/player/createPlayerScheduler.test.ts
```

Expected: module-not-found error.

- [ ] **Step 3: Implement `createPlayerScheduler`**

Create `app/composables/player/createPlayerScheduler.ts`:

```ts
// app/composables/player/createPlayerScheduler.ts
import type { ManifestItem } from '~/app/types/api'

export type SchedulerMode = 'loop' | 'single-video' | 'single-image' | 'empty'

export interface TransitionEvent {
  from: number
  to: number
  nextPreload: number
}

export interface SchedulerDeps {
  now: () => number
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface SchedulerHandle {
  readonly mode: SchedulerMode
  start(): void
  itemEnded(index: number): void
  itemErrored(index: number, message: string): void
  stop(): void
  getFrontIndex(): number
  getBackIndex(): number
  onTransition(fn: (e: TransitionEvent) => void): () => void
  onItemStart(fn: (index: number) => void): () => void
  onItemError(fn: (index: number, message: string) => void): () => void
}

/**
 * Pure, testable state machine over a playlist's items[]. Drives the
 * double-buffered stage via emitted events. No DOM, no fetch, no timers
 * except those provided via `deps`.
 *
 * - Multi-item: on itemEnded advance front to back, recompute back as
 *   (to+1) % items.length. Images trigger a timer internally; videos
 *   let the stage supply the ended signal.
 * - Single video: no transitions (native <video loop> handles looping).
 * - Single image: re-arms an internal timer and re-emits onItemStart(0).
 * - Empty: inert.
 */
export function createPlayerScheduler(
  items: ManifestItem[],
  deps: SchedulerDeps
): SchedulerHandle {
  const mode: SchedulerMode =
    items.length === 0
      ? 'empty'
      : items.length === 1
        ? items[0].type === 'video'
          ? 'single-video'
          : 'single-image'
        : 'loop'

  let front = 0
  let back = items.length > 1 ? 1 % items.length : 0
  let stopped = false
  let imageTimer: unknown = null

  const itemStartHandlers = new Set<(i: number) => void>()
  const transitionHandlers = new Set<(e: TransitionEvent) => void>()
  const errorHandlers = new Set<(i: number, msg: string) => void>()

  function emitItemStart(i: number): void {
    for (const fn of itemStartHandlers) fn(i)
  }
  function emitTransition(e: TransitionEvent): void {
    for (const fn of transitionHandlers) fn(e)
  }
  function emitError(i: number, msg: string): void {
    for (const fn of errorHandlers) fn(i, msg)
  }

  function clearImageTimer(): void {
    if (imageTimer !== null) {
      deps.clearTimeout(imageTimer)
      imageTimer = null
    }
  }

  function armImageTimerIfNeeded(index: number): void {
    const item = items[index]
    if (!item || item.type !== 'image') return
    const durationMs = Math.max(0, item.durationMs | 0)
    imageTimer = deps.setTimeout(() => {
      imageTimer = null
      if (stopped) return
      if (mode === 'single-image') {
        // Re-start the same item; no slot swap.
        emitItemStart(0)
        armImageTimerIfNeeded(0)
        return
      }
      // Multi-item loop: treat like the stage reporting item ended.
      advance()
    }, durationMs)
  }

  function advance(): void {
    if (stopped || mode === 'empty' || mode === 'single-video') return
    if (mode === 'single-image') {
      // Should not be reached — single-image re-arms inside the timer.
      return
    }
    clearImageTimer()
    const from = front
    const to = back
    front = to
    back = (to + 1) % items.length
    emitTransition({ from, to, nextPreload: back })
    emitItemStart(front)
    armImageTimerIfNeeded(front)
  }

  return {
    get mode() {
      return mode
    },
    start() {
      if (stopped) return
      if (mode === 'empty') return
      emitItemStart(0)
      armImageTimerIfNeeded(0)
    },
    itemEnded(index) {
      if (stopped) return
      if (mode === 'empty' || mode === 'single-video') return
      if (mode === 'single-image') {
        // Stage shouldn't call itemEnded for single-image — timer is
        // internal. Silently ignore to keep behavior defensive.
        return
      }
      if (index !== front) return // stale
      advance()
    },
    itemErrored(index, msg) {
      if (stopped) return
      emitError(index, msg)
      if (mode === 'empty' || mode === 'single-video' || mode === 'single-image') {
        return
      }
      if (index !== front) return
      advance()
    },
    stop() {
      stopped = true
      clearImageTimer()
      itemStartHandlers.clear()
      transitionHandlers.clear()
      errorHandlers.clear()
    },
    getFrontIndex() {
      return front
    },
    getBackIndex() {
      return back
    },
    onTransition(fn) {
      transitionHandlers.add(fn)
      return () => transitionHandlers.delete(fn)
    },
    onItemStart(fn) {
      itemStartHandlers.add(fn)
      return () => itemStartHandlers.delete(fn)
    },
    onItemError(fn) {
      errorHandlers.add(fn)
      return () => errorHandlers.delete(fn)
    }
  }
}
```

- [ ] **Step 4: Re-run — confirm it passes**

```bash
pnpm test tests/player/createPlayerScheduler.test.ts
```

Expected: all tests pass (~12 cases).

- [ ] **Step 5: Run the full test suite to catch any regression**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/composables/player/createPlayerScheduler.ts \
        tests/player/createPlayerScheduler.test.ts
git commit -m "feat(player): pure scheduler state machine with single-item and empty modes"
```

---

## Task 4: `useNativeDevice` + `usePlayerEnv` composables

Two thin composables. `useNativeDevice` resolves the device id (lazily, once per page load) and wraps reload/version/serverUrl; `usePlayerEnv` builds media URLs. No dedicated tests — the underlying `resolveDeviceId` is already covered and the rest is trivial glue.

**Files:**
- Create: `app/composables/player/useNativeDevice.ts`
- Create: `app/composables/player/usePlayerEnv.ts`

- [ ] **Step 1: Implement `useNativeDevice`**

Create `app/composables/player/useNativeDevice.ts`:

```ts
// app/composables/player/useNativeDevice.ts
//
// Web shim for the NativeDevice contract from the parent spec. Plan 5
// (Android APK) will replace this by detecting `window.nativeDevice` and
// delegating; in Plan 3 we always use the web flow.
import { resolveDeviceId } from './resolveDeviceId'

export const PLAYER_VERSION = '3.0.0-web'

export interface NativeDevice {
  deviceId(): string
  reload(): void
  version(): { app: string; os: string; model: string }
  serverUrl(): string
}

let _cachedId: string | null = null

function getQueryDeviceId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const params = new URLSearchParams(window.location.search)
  return params.get('deviceId') ?? undefined
}

function getStorage() {
  // Matches the DeviceIdStorage interface required by resolveDeviceId.
  if (typeof window === 'undefined') {
    return {
      get: () => null,
      set: () => {
        /* noop in SSR — player is client-only, so this path is dead code */
      }
    }
  }
  return {
    get: (k: string) => window.localStorage.getItem(k),
    set: (k: string, v: string) => window.localStorage.setItem(k, v)
  }
}

export function useNativeDevice(): NativeDevice {
  return {
    deviceId() {
      if (_cachedId) return _cachedId
      _cachedId = resolveDeviceId({
        query: getQueryDeviceId(),
        storage: getStorage(),
        generate: () => crypto.randomUUID()
      })
      return _cachedId
    },
    reload() {
      if (typeof window !== 'undefined') window.location.reload()
    },
    version() {
      return {
        app: PLAYER_VERSION,
        os: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        model: 'Browser'
      }
    },
    serverUrl() {
      return typeof window !== 'undefined' ? window.location.origin : ''
    }
  }
}

// Test-only helper — lets unit tests wipe the cached id between runs.
export function _resetNativeDeviceCache(): void {
  _cachedId = null
}
```

- [ ] **Step 2: Implement `usePlayerEnv`**

Create `app/composables/player/usePlayerEnv.ts`:

```ts
// app/composables/player/usePlayerEnv.ts
//
// Player-environment shim. In Plan 3 we serve media directly from the
// Nuxt server; in Plan 5 the APK's WebViewAssetLoader exposes cached
// files at https://appassets.androidplatform.net/media/<sha> and this
// composable's `fileUrl` implementation will be swapped accordingly.

export interface PlayerEnv {
  fileUrl(sha256: string): string
}

export function usePlayerEnv(): PlayerEnv {
  return {
    fileUrl(sha256: string): string {
      return `/media/${sha256}`
    }
  }
}
```

- [ ] **Step 3: Sanity check — TypeScript compiles (via test run)**

```bash
pnpm test
```

Expected: all existing tests still pass (these new files are not imported yet, so nothing changes).

- [ ] **Step 4: Commit**

```bash
git add app/composables/player/useNativeDevice.ts \
        app/composables/player/usePlayerEnv.ts
git commit -m "feat(player): useNativeDevice web shim + usePlayerEnv"
```

---

## Task 5: `useTelemetry`

Fire-and-forget telemetry poster. Wraps the already-added `postTelemetry` API call and swallows failures.

**Files:**
- Create: `app/composables/player/useTelemetry.ts`

- [ ] **Step 1: Implement `useTelemetry`**

Create `app/composables/player/useTelemetry.ts`:

```ts
// app/composables/player/useTelemetry.ts
import type { ApiClient } from '~/app/composables/useApiClient'

export interface Telemetry {
  itemStarted(deviceId: string, currentItemId: number): void
  itemFailed(
    deviceId: string,
    currentItemId: number | null,
    sha256: string | undefined,
    message: string
  ): void
  clearedCurrent(deviceId: string): void
}

/**
 * Fire-and-forget telemetry. Each call returns synchronously; the POST
 * runs in the background. Failures are swallowed after a console.warn
 * because the player must keep playing even if telemetry is unreachable.
 */
export function useTelemetry(api: ApiClient): Telemetry {
  function fire(
    deviceId: string,
    body: {
      currentItemId: number | null
      error?: { sha256?: string; message: string }
    }
  ): void {
    api.postTelemetry(deviceId, body).catch((err) => {
      console.warn('[player] telemetry post failed', err)
    })
  }
  return {
    itemStarted(deviceId, currentItemId) {
      fire(deviceId, { currentItemId })
    },
    itemFailed(deviceId, currentItemId, sha256, message) {
      fire(deviceId, {
        currentItemId,
        error: { sha256, message }
      })
    },
    clearedCurrent(deviceId) {
      fire(deviceId, { currentItemId: null })
    }
  }
}
```

- [ ] **Step 2: Commit (no tests — thin wrapper over already-tested api method)**

```bash
git add app/composables/player/useTelemetry.ts
git commit -m "feat(player): useTelemetry fire-and-forget wrapper"
```

---

## Task 6: `useReconciler`

Ties together the manifest fetch, SSE stream, scheduler factory, and backoff. This is the largest composable; tested end-to-end with a mocked `ApiClient` and a fake `EventSource`.

**Files:**
- Create: `app/composables/player/useReconciler.ts`
- Create: `tests/player/useReconciler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/player/useReconciler.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReconciler } from '~/app/composables/player/useReconciler'
import type { ApiClient } from '~/app/composables/useApiClient'
import type { Manifest } from '~/app/types/api'

type Listener = (event: { data: string }) => void

class FakeEventSource {
  listeners = new Map<string, Listener[]>()
  readyState = 0
  closed = false
  constructor(public url: string) {
    FakeEventSource.lastInstance = this
  }
  addEventListener(type: string, fn: Listener) {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener() {}
  close() {
    this.closed = true
  }
  fire(type: string, data: unknown = {}) {
    const arr = this.listeners.get(type) ?? []
    for (const l of arr) l({ data: JSON.stringify(data) })
  }
  fireOpen() {
    this.readyState = 1
    const arr = this.listeners.get('open') ?? []
    for (const l of arr) l({ data: '' } as any)
  }
  static lastInstance: FakeEventSource | null = null
}

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    register: vi.fn(),
    getManifest: vi.fn(),
    postTelemetry: vi.fn(),
    ...overrides
  } as unknown as ApiClient
}

const m = (playlistId: number, version: number): Manifest => ({
  playlistId,
  playlistName: `P${playlistId}`,
  version,
  items: [
    { id: 1, type: 'video', sha256: 'sha1', durationMs: 5000 }
  ]
})

describe('createReconciler', () => {
  beforeEach(() => {
    FakeEventSource.lastInstance = null
    vi.useFakeTimers()
  })

  it('fetches manifest on reconcile() and emits onManifest when changed', async () => {
    const api = fakeApi({
      getManifest: vi.fn().mockResolvedValue(m(1, 1))
    })
    const got: Array<Manifest | null> = []
    const r = createReconciler({
      api,
      deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest((man) => got.push(man))

    await r.reconcile()
    expect(got).toEqual([m(1, 1)])
  })

  it('does NOT re-emit when playlistId+version are unchanged', async () => {
    const api = fakeApi({
      getManifest: vi.fn().mockResolvedValue(m(1, 1))
    })
    const got: Array<Manifest | null> = []
    const r = createReconciler({
      api,
      deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest((man) => got.push(man))

    await r.reconcile()
    await r.reconcile()
    expect(got.length).toBe(1)
  })

  it('re-emits when version bumps', async () => {
    const getManifest = vi
      .fn<[], Promise<Manifest | null>>()
      .mockResolvedValueOnce(m(1, 1))
      .mockResolvedValueOnce(m(1, 2))
    const api = fakeApi({ getManifest })
    const got: Array<Manifest | null> = []
    const r = createReconciler({
      api,
      deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest((man) => got.push(man))

    await r.reconcile()
    await r.reconcile()
    expect(got.map((x) => x?.version)).toEqual([1, 2])
  })

  it('emits null when manifest is 204', async () => {
    const api = fakeApi({
      getManifest: vi.fn().mockResolvedValue(null)
    })
    const got: Array<Manifest | null> = []
    const r = createReconciler({
      api,
      deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest((man) => got.push(man))

    await r.reconcile()
    expect(got).toEqual([null])
  })

  it('does not re-emit null on repeated 204 polls', async () => {
    const api = fakeApi({
      getManifest: vi.fn().mockResolvedValue(null)
    })
    const got: Array<Manifest | null> = []
    const r = createReconciler({
      api,
      deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest((man) => got.push(man))

    await r.reconcile()
    await r.reconcile()
    await r.reconcile()
    expect(got.length).toBe(1)
  })

  it('fires reconcile() when SSE manifest-changed event arrives', async () => {
    const getManifest = vi
      .fn<[], Promise<Manifest | null>>()
      .mockResolvedValueOnce(m(1, 1))
      .mockResolvedValueOnce(m(1, 2))
    const api = fakeApi({ getManifest })
    const got: Array<Manifest | null> = []
    const r = createReconciler({
      api,
      deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest((man) => got.push(man))

    r.openStream()
    await r.reconcile()
    FakeEventSource.lastInstance!.fire('manifest-changed')
    await vi.runAllTimersAsync() // flush queued promises

    expect(getManifest).toHaveBeenCalledTimes(2)
    expect(got[got.length - 1]?.version).toBe(2)
  })

  it('calls reloadHandler when SSE reload event arrives', async () => {
    const api = fakeApi({
      getManifest: vi.fn().mockResolvedValue(m(1, 1))
    })
    const reload = vi.fn()
    const r = createReconciler({
      api,
      deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any,
      onReload: reload
    })
    r.openStream()
    FakeEventSource.lastInstance!.fire('reload')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('emits onError + schedules retry with backoff on fetch failure', async () => {
    const getManifest = vi
      .fn<[], Promise<Manifest | null>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(m(1, 1))
    const api = fakeApi({ getManifest })
    const errs: unknown[] = []
    const got: Array<Manifest | null> = []
    const r = createReconciler({
      api,
      deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onError((e) => errs.push(e))
    r.onManifest((man) => got.push(man))

    await r.reconcile()
    expect(errs.length).toBe(1)
    expect(got.length).toBe(0)

    // Next attempt is scheduled at backoff(0) = 1000ms.
    await vi.advanceTimersByTimeAsync(999)
    expect(getManifest).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2)
    // Await the microtask queue so the resolved manifest is delivered.
    await vi.runAllTimersAsync()
    expect(getManifest).toHaveBeenCalledTimes(2)
    expect(got.length).toBe(1)
  })

  it('starts the 30s safety poll and reconciles on each tick', async () => {
    const getManifest = vi
      .fn<[], Promise<Manifest | null>>()
      .mockResolvedValue(m(1, 1))
    const api = fakeApi({ getManifest })
    const r = createReconciler({
      api,
      deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.startPolling()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.runAllTimersAsync()
    expect(getManifest).toHaveBeenCalled()
    r.close()
  })

  it('close() cancels polling and closes the event source', () => {
    const api = fakeApi({
      getManifest: vi.fn().mockResolvedValue(m(1, 1))
    })
    const r = createReconciler({
      api,
      deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.openStream()
    r.startPolling()
    r.close()
    expect(FakeEventSource.lastInstance!.closed).toBe(true)
  })
})
```

- [ ] **Step 2: Run — confirm it fails**

```bash
pnpm test tests/player/useReconciler.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement `useReconciler`**

Create `app/composables/player/useReconciler.ts`:

```ts
// app/composables/player/useReconciler.ts
import type { ApiClient } from '~/app/composables/useApiClient'
import type { Manifest } from '~/app/types/api'
import { shouldReconcile } from './shouldReconcile'
import { backoff } from './backoff'

export type StreamState = 'connecting' | 'connected' | 'disconnected'

type EventSourceFactory = (url: string) => EventSource

export interface ReconcilerDeps {
  api: ApiClient
  deviceId: string
  eventSourceFactory?: EventSourceFactory
  onReload?: () => void
}

export interface ReconcilerHandle {
  reconcile(): Promise<void>
  openStream(): void
  startPolling(): void
  close(): void
  onManifest(fn: (m: Manifest | null) => void): () => void
  onError(fn: (e: unknown) => void): () => void
  getStreamState(): StreamState
}

/**
 * Owns the reconcile loop: manifest fetch + diff + SSE + 30s safety
 * poll. Does NOT own the scheduler — it emits `onManifest(m|null)` and
 * lets the caller wire up `<PlayerStage>` / scheduler / no-content
 * screen as appropriate.
 *
 * - On fetch success: if manifest key (playlistId+version) changed,
 *   emit onManifest(m). If null (204), emit onManifest(null).
 * - On fetch failure: emit onError, then schedule a retry at
 *   backoff(attempt); reset attempt on next success.
 * - On SSE `manifest-changed`: trigger reconcile().
 * - On SSE `reload`: invoke deps.onReload().
 */
export function createReconciler(deps: ReconcilerDeps): ReconcilerHandle {
  const factory: EventSourceFactory =
    deps.eventSourceFactory ?? ((url) => new EventSource(url))

  let last: { playlistId: number; version: number } | null = null
  let hasEmitted = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let es: EventSource | null = null
  let streamState: StreamState = 'disconnected'

  const manifestHandlers = new Set<(m: Manifest | null) => void>()
  const errorHandlers = new Set<(e: unknown) => void>()

  function emitManifest(m: Manifest | null): void {
    for (const fn of manifestHandlers) fn(m)
  }
  function emitError(e: unknown): void {
    for (const fn of errorHandlers) fn(e)
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  async function reconcile(): Promise<void> {
    clearRetryTimer()
    try {
      const m = await deps.api.getManifest(deps.deviceId)
      attempt = 0
      if (m === null) {
        // Only emit on first fetch or on the transition from manifest → null.
        // Subsequent null-null polls stay silent so telemetry doesn't fire repeatedly.
        if (last !== null || !hasEmitted) {
          last = null
          hasEmitted = true
          emitManifest(null)
        }
        return
      }
      const key = { playlistId: m.playlistId, version: m.version }
      if (!shouldReconcile(last, key)) return
      last = key
      hasEmitted = true
      emitManifest(m)
    } catch (err) {
      emitError(err)
      retryTimer = setTimeout(() => {
        void reconcile()
      }, backoff(attempt))
      attempt += 1
    }
  }

  function openStream(): void {
    if (es) return
    streamState = 'connecting'
    es = factory(`/api/devices/${deps.deviceId}/stream`)
    es.addEventListener('open', () => {
      streamState = 'connected'
      // Catch up any changes that happened during the disconnect.
      void reconcile()
    })
    es.addEventListener('error', () => {
      // Browser EventSource auto-reconnects; surface current state only.
      streamState = 'connecting'
    })
    es.addEventListener('manifest-changed', () => {
      void reconcile()
    })
    es.addEventListener('reload', () => {
      deps.onReload?.()
    })
    // `ping` is keep-alive only.
  }

  function startPolling(): void {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      void reconcile()
    }, 30_000)
  }

  function close(): void {
    clearRetryTimer()
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (es) {
      es.close()
      es = null
    }
    streamState = 'disconnected'
    manifestHandlers.clear()
    errorHandlers.clear()
  }

  return {
    reconcile,
    openStream,
    startPolling,
    close,
    onManifest(fn) {
      manifestHandlers.add(fn)
      return () => manifestHandlers.delete(fn)
    },
    onError(fn) {
      errorHandlers.add(fn)
      return () => errorHandlers.delete(fn)
    },
    getStreamState() {
      return streamState
    }
  }
}
```

- [ ] **Step 4: Re-run — confirm it passes**

```bash
pnpm test tests/player/useReconciler.test.ts
```

Expected: all 9 cases pass.

- [ ] **Step 5: Run the full suite**

```bash
pnpm test
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add app/composables/player/useReconciler.ts \
        tests/player/useReconciler.test.ts
git commit -m "feat(player): useReconciler — manifest fetch + diff + SSE + 30s poll + backoff"
```

---

## Task 7: `usePlayerBoot` orchestration composable

Wires reconciler + scheduler + telemetry + native device together. Exposes reactive refs the page + stage consume. No dedicated tests — pure glue over tested parts; manual QA covers it.

**Files:**
- Create: `app/composables/player/usePlayerBoot.ts`

- [ ] **Step 1: Implement `usePlayerBoot`**

Create `app/composables/player/usePlayerBoot.ts`:

```ts
// app/composables/player/usePlayerBoot.ts
//
// Top-level orchestrator for the /player route. Glues reconciler +
// scheduler + telemetry + native-device. Exposes reactive state that
// app/pages/player.vue renders.
import { onBeforeUnmount, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Manifest } from '~/app/types/api'
import { useNativeDevice, PLAYER_VERSION } from './useNativeDevice'
import { usePlayerEnv, type PlayerEnv } from './usePlayerEnv'
import { useTelemetry } from './useTelemetry'
import {
  createReconciler,
  type ReconcilerHandle,
  type StreamState
} from './useReconciler'
import {
  createPlayerScheduler,
  type SchedulerHandle
} from './createPlayerScheduler'

export type PlayerScreen = 'booting' | 'standby' | 'no-content' | 'playing'

export interface PlayerBootState {
  screen: Ref<PlayerScreen>
  streamState: Ref<StreamState>
  manifest: ShallowRef<Manifest | null>
  scheduler: ShallowRef<SchedulerHandle | null>
  env: PlayerEnv
  deviceId: Ref<string>
  lastError: Ref<string | null>
}

export function usePlayerBoot(
  apiOverride?: ApiClient
): PlayerBootState {
  const api = apiOverride ?? useApiClient()
  const device = useNativeDevice()
  const env = usePlayerEnv()
  const telemetry = useTelemetry(api)

  const deviceId = ref(device.deviceId())
  const screen = ref<PlayerScreen>('booting')
  const streamState = ref<StreamState>('disconnected')
  const manifest = shallowRef<Manifest | null>(null)
  const scheduler = shallowRef<SchedulerHandle | null>(null)
  const lastError = ref<string | null>(null)

  let reconciler: ReconcilerHandle | null = null

  function mountScheduler(m: Manifest): void {
    // Tear down any existing scheduler first so its timers are cancelled.
    scheduler.value?.stop()

    const sched = createPlayerScheduler(m.items, {
      now: () => Date.now(),
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: (h) => window.clearTimeout(h as number)
    })

    sched.onItemStart((index) => {
      const item = m.items[index]
      if (!item) return
      telemetry.itemStarted(deviceId.value, item.id)
    })
    sched.onItemError((index, msg) => {
      const item = m.items[index]
      telemetry.itemFailed(
        deviceId.value,
        item?.id ?? null,
        item?.sha256,
        msg
      )
    })

    scheduler.value = sched
    sched.start()
  }

  async function boot(): Promise<void> {
    try {
      await api.register({
        deviceId: deviceId.value,
        playerVersion: PLAYER_VERSION
      })
    } catch (err) {
      console.warn('[player] register failed; will rely on reconcile retry', err)
    }

    reconciler = createReconciler({
      api,
      deviceId: deviceId.value,
      onReload: () => device.reload()
    })

    reconciler.onManifest((m) => {
      lastError.value = null
      manifest.value = m
      if (m === null) {
        scheduler.value?.stop()
        scheduler.value = null
        screen.value = 'no-content'
        telemetry.clearedCurrent(deviceId.value)
        return
      }
      mountScheduler(m)
      screen.value = 'playing'
    })
    reconciler.onError((e) => {
      lastError.value = e instanceof Error ? e.message : String(e)
      // Only fall back to standby if we've never played anything yet.
      if (manifest.value === null) screen.value = 'standby'
    })

    // Poll the stream-state ref each event loop tick; cheap and works
    // without reactive wrapping inside createReconciler.
    const stateTimer = window.setInterval(() => {
      if (reconciler) streamState.value = reconciler.getStreamState()
    }, 500)

    onBeforeUnmount(() => {
      window.clearInterval(stateTimer)
    })

    await reconciler.reconcile()
    reconciler.openStream()
    reconciler.startPolling()
  }

  void boot()

  onBeforeUnmount(() => {
    scheduler.value?.stop()
    scheduler.value = null
    reconciler?.close()
    reconciler = null
  })

  return {
    screen,
    streamState,
    manifest,
    scheduler,
    env,
    deviceId,
    lastError
  }
}
```

- [ ] **Step 2: Sanity test — existing tests still pass**

```bash
pnpm test
```

Expected: all previous tests green.

- [ ] **Step 3: Commit**

```bash
git add app/composables/player/usePlayerBoot.ts
git commit -m "feat(player): usePlayerBoot orchestration composable"
```

---

## Task 8: `<PlayerStage>` component (4-element double buffer)

The reactive view that consumes the scheduler's transition emitter and renders playback. No unit tests — JSDOM `<video>` fidelity is poor; manual QA in Task 11.

**Files:**
- Create: `app/components/player/PlayerStage.vue`

- [ ] **Step 1: Implement `<PlayerStage>`**

Create `app/components/player/PlayerStage.vue`:

```vue
<!-- app/components/player/PlayerStage.vue -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Manifest, ManifestItem } from '~/app/types/api'
import type { SchedulerHandle } from '~/app/composables/player/createPlayerScheduler'
import type { PlayerEnv } from '~/app/composables/player/usePlayerEnv'

const props = defineProps<{
  manifest: Manifest
  scheduler: SchedulerHandle
  env: PlayerEnv
}>()

// Slot A/B swap. When `frontIsA` is true, slot A is front (visible), B is back (preloading).
const frontIsA = ref(true)

// Refs to the four media elements. Each slot always has both <video> and <img>;
// `display` is toggled per the item type rather than unmounting.
const videoA = ref<HTMLVideoElement | null>(null)
const imgA = ref<HTMLImageElement | null>(null)
const videoB = ref<HTMLVideoElement | null>(null)
const imgB = ref<HTMLImageElement | null>(null)

// Track which item each slot currently holds (for display-type toggling).
const itemInA = ref<ManifestItem | null>(null)
const itemInB = ref<ManifestItem | null>(null)

// Consecutive error count — bail to a "stalled" state if we can't make progress.
let consecutiveErrors = 0
const stalled = ref(false)

function frontSlot(): 'A' | 'B' {
  return frontIsA.value ? 'A' : 'B'
}
function backSlot(): 'A' | 'B' {
  return frontIsA.value ? 'B' : 'A'
}

function elementsFor(slot: 'A' | 'B'): {
  video: HTMLVideoElement | null
  img: HTMLImageElement | null
} {
  return slot === 'A'
    ? { video: videoA.value, img: imgA.value }
    : { video: videoB.value, img: imgB.value }
}

function setItemInSlot(slot: 'A' | 'B', item: ManifestItem | null): void {
  const { video, img } = elementsFor(slot)
  if (slot === 'A') itemInA.value = item
  else itemInB.value = item

  if (!item || !video || !img) return

  const url = props.env.fileUrl(item.sha256)
  if (item.type === 'video') {
    video.src = url
    video.load()
  } else {
    img.src = url
  }
}

function playFrontVideoIfNeeded(): void {
  const item =
    frontIsA.value ? itemInA.value : itemInB.value
  if (!item || item.type !== 'video') return
  const { video } = elementsFor(frontSlot())
  if (!video) return
  // Single-video mode: let the native loop attribute handle continuous play.
  video.loop = props.scheduler.mode === 'single-video'
  void video.play().catch(() => {
    /* autoplay is muted; failures are swallowed and reported on error */
  })
}

function reportError(index: number, msg: string): void {
  consecutiveErrors += 1
  if (consecutiveErrors >= 5) {
    stalled.value = true
    props.scheduler.stop()
    return
  }
  props.scheduler.itemErrored(index, msg)
}

function onVideoEnded(slot: 'A' | 'B'): void {
  if (slot !== frontSlot()) return
  const item = slot === 'A' ? itemInA.value : itemInB.value
  if (!item) return
  consecutiveErrors = 0
  const index = props.manifest.items.findIndex((i) => i.id === item.id)
  if (index >= 0) props.scheduler.itemEnded(index)
}

function onVideoError(slot: 'A' | 'B'): void {
  const item = slot === 'A' ? itemInA.value : itemInB.value
  if (!item) return
  const index = props.manifest.items.findIndex((i) => i.id === item.id)
  if (index >= 0) reportError(index, 'video decode/load error')
}

function onImgError(slot: 'A' | 'B'): void {
  const item = slot === 'A' ? itemInA.value : itemInB.value
  if (!item) return
  const index = props.manifest.items.findIndex((i) => i.id === item.id)
  if (index >= 0) reportError(index, 'image load error')
}

function onImgLoad(): void {
  consecutiveErrors = 0
}

function mountInitial(): void {
  // Put item 0 in the front slot; item 1 in the back slot (may equal 0
  // in single-item mode — that's fine, the stage's display logic is idempotent).
  const frontItem = props.manifest.items[props.scheduler.getFrontIndex()] ?? null
  const backItem = props.manifest.items[props.scheduler.getBackIndex()] ?? null
  setItemInSlot(frontSlot(), frontItem)
  setItemInSlot(backSlot(), backItem)
  playFrontVideoIfNeeded()
}

onMounted(() => {
  mountInitial()

  const unsubTransition = props.scheduler.onTransition((e) => {
    // The NEW front is the current back slot — flip which slot is front.
    frontIsA.value = !frontIsA.value
    // The old front (now back) becomes the next preload target.
    const nextItem = props.manifest.items[e.nextPreload] ?? null
    setItemInSlot(backSlot(), nextItem)
    playFrontVideoIfNeeded()
  })
  const unsubStart = props.scheduler.onItemStart(() => {
    // For single-image we re-emit onItemStart(0) from inside the scheduler; we
    // don't need to do anything here — the image element stays mounted.
  })

  onBeforeUnmount(() => {
    unsubTransition()
    unsubStart()
  })
})

// NOTE: the parent (`app/pages/player.vue`) passes `:key` bound to
// `manifest.playlistId + ':' + manifest.version` so this component is
// remounted (not re-rendered) on any manifest change. That gives us
// clean scheduler subscription lifecycles without watching props here.
</script>

<template>
  <div class="stage">
    <div class="slot" :class="{ front: frontIsA, back: !frontIsA }">
      <video
        ref="videoA"
        muted
        playsinline
        preload="auto"
        :style="{ display: itemInA?.type === 'video' ? 'block' : 'none' }"
        @ended="onVideoEnded('A')"
        @error="onVideoError('A')"
      />
      <img
        ref="imgA"
        alt=""
        :style="{ display: itemInA?.type === 'image' ? 'block' : 'none' }"
        @load="onImgLoad"
        @error="onImgError('A')"
      />
    </div>
    <div class="slot" :class="{ front: !frontIsA, back: frontIsA }">
      <video
        ref="videoB"
        muted
        playsinline
        preload="auto"
        :style="{ display: itemInB?.type === 'video' ? 'block' : 'none' }"
        @ended="onVideoEnded('B')"
        @error="onVideoError('B')"
      />
      <img
        ref="imgB"
        alt=""
        :style="{ display: itemInB?.type === 'image' ? 'block' : 'none' }"
        @load="onImgLoad"
        @error="onImgError('B')"
      />
    </div>
    <div v-if="stalled" class="stalled-banner">Playback stalled — waiting for next sync…</div>
  </div>
</template>

<style scoped>
.stage {
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
}

.slot {
  position: absolute;
  inset: 0;
  transition: opacity 120ms linear;
}

.slot.front {
  z-index: 2;
  opacity: 1;
}

.slot.back {
  z-index: 1;
  opacity: 0;
}

.slot video,
.slot img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.stalled-banner {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  color: #f4f4f5;
  background: rgba(0, 0, 0, 0.6);
  padding: 8px 16px;
  border-radius: 6px;
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
  z-index: 10;
}
</style>
```

- [ ] **Step 2: Sanity test — all tests still green, build still compiles**

```bash
pnpm test
```

Expected: green (no new test files touched).

- [ ] **Step 3: Commit**

```bash
git add app/components/player/PlayerStage.vue
git commit -m "feat(player): PlayerStage 4-element double buffer component"
```

---

## Task 9: `<NoContentScreen>` + `<StandbyScreen>`

Two presentation-only components.

**Files:**
- Create: `app/components/player/NoContentScreen.vue`
- Create: `app/components/player/StandbyScreen.vue`

- [ ] **Step 1: Implement `<NoContentScreen>`**

Create `app/components/player/NoContentScreen.vue`:

```vue
<!-- app/components/player/NoContentScreen.vue -->
<script setup lang="ts">
defineProps<{ deviceId: string }>()
</script>

<template>
  <div class="screen">
    <div class="center">
      <div class="dot" />
      <div class="title">No content assigned</div>
      <div class="device-id">{{ deviceId }}</div>
    </div>
  </div>
</template>

<style scoped>
.screen {
  position: fixed;
  inset: 0;
  background: #000;
  color: #e4e4e7;
  display: flex;
  align-items: center;
  justify-content: center;
}
.center {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #10b981;
  animation: pulse 1.6s ease-in-out infinite;
}
.title {
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 24px;
  font-weight: 500;
}
.device-id {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: #71717a;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.85);
  }
}
</style>
```

- [ ] **Step 2: Implement `<StandbyScreen>`**

Create `app/components/player/StandbyScreen.vue`:

```vue
<!-- app/components/player/StandbyScreen.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  deviceId: string
  lastError: string | null
}>()

const startedAt = Date.now()
const elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    elapsed.value = Math.floor((Date.now() - startedAt) / 1000)
  }, 1000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const elapsedLabel = computed(() => {
  const s = elapsed.value
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
})
</script>

<template>
  <div class="screen">
    <div class="center">
      <div class="spinner" />
      <div class="title">Connecting…</div>
      <div class="meta">waited {{ elapsedLabel }}</div>
      <div class="device-id">{{ props.deviceId }}</div>
      <div v-if="props.lastError" class="err">{{ props.lastError }}</div>
    </div>
  </div>
</template>

<style scoped>
.screen {
  position: fixed;
  inset: 0;
  background: #000;
  color: #e4e4e7;
  display: flex;
  align-items: center;
  justify-content: center;
}
.center {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 3px solid #27272a;
  border-top-color: #10b981;
  animation: spin 0.9s linear infinite;
}
.title {
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 22px;
  font-weight: 500;
}
.meta {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: #a1a1aa;
}
.device-id {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: #52525b;
}
.err {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: #f87171;
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
```

- [ ] **Step 3: Commit**

```bash
git add app/components/player/NoContentScreen.vue \
        app/components/player/StandbyScreen.vue
git commit -m "feat(player): NoContentScreen + StandbyScreen"
```

---

## Task 10: `/player` page

The entry page. Wires `usePlayerBoot` to the three presentation components.

**Files:**
- Create: `app/pages/player.vue`

- [ ] **Step 1: Implement `app/pages/player.vue`**

Create `app/pages/player.vue`:

```vue
<!-- app/pages/player.vue -->
<!--
  /player route — loaded by the APK's WebView (Plan 5) or a desktop browser
  tab (Plan 3 QA). Fullscreen, layout-less, client-only, no UI chrome.

  Player composables are intentionally imported explicitly from
  `~/app/composables/player/*` rather than relying on Nuxt's recursive
  auto-import, to keep the dashboard's global import namespace clean.
-->
<script setup lang="ts">
import PlayerStage from '~/app/components/player/PlayerStage.vue'
import NoContentScreen from '~/app/components/player/NoContentScreen.vue'
import StandbyScreen from '~/app/components/player/StandbyScreen.vue'
import { usePlayerBoot } from '~/app/composables/player/usePlayerBoot'

definePageMeta({
  layout: false
})

const { screen, manifest, scheduler, env, deviceId, lastError } = usePlayerBoot()

useHead({
  title: 'Lanka Player',
  htmlAttrs: { class: 'lanka-player' }
})
</script>

<template>
  <div class="player-root">
    <StandbyScreen
      v-if="screen === 'booting' || screen === 'standby'"
      :device-id="deviceId"
      :last-error="lastError"
    />
    <NoContentScreen v-else-if="screen === 'no-content'" :device-id="deviceId" />
    <PlayerStage
      v-else-if="screen === 'playing' && manifest && scheduler"
      :key="manifest.playlistId + ':' + manifest.version"
      :manifest="manifest"
      :scheduler="scheduler"
      :env="env"
    />
  </div>
</template>

<style>
html.lanka-player,
html.lanka-player body {
  margin: 0;
  padding: 0;
  background: #000;
  overflow: hidden;
  cursor: none;
  /* Override the dashboard's desktop min-width; the player fills whatever the
     WebView gives it. */
  min-width: 0 !important;
}
</style>

<style scoped>
.player-root {
  position: fixed;
  inset: 0;
  background: #000;
}
</style>
```

- [ ] **Step 2: Run the build to make sure the page compiles**

```bash
pnpm build
```

Expected: build succeeds. If the build warns about `definePageMeta` auto-import, that's a Nuxt-wide macro — ignore.

- [ ] **Step 3: Run the dev server and hit `/player`**

```bash
PORT=5100 pnpm dev &
sleep 8
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5100/player?deviceId=tv-smoke
kill %1 2>/dev/null || true
```

Expected: `200`. Kill the dev server after checking.

- [ ] **Step 4: Run the full test suite**

```bash
pnpm test
```

Expected: all player + existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/pages/player.vue
git commit -m "feat(player): /player route wiring stages, no-content, standby"
```

---

## Task 11: Manual QA + README

No automated component tests for the stage — manual QA is load-bearing. Record the pass in the README so future work has a reproducible checklist.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Smoke-test the empty case (no assignments)**

```bash
# Ensure DB is migrated and empty of assignments. If needed, start fresh:
rm -f data/signage.db
pnpm db:migrate
PORT=5100 pnpm dev
```

In a browser, open `http://localhost:5100/player?deviceId=tv-qa-1`.

Expected:
- Page loads black with the `StandbyScreen` briefly, then transitions to `NoContentScreen` (green pulsing dot + "No content assigned" + deviceId in mono).
- In another tab, open `http://localhost:5100` (dashboard) — the device `tv-qa-1` appears in the Unclaimed tray.

- [ ] **Step 2: Assign a playlist; watch it appear**

In the dashboard:
1. Claim `tv-qa-1` into any group.
2. Upload at least two media items (one video, one image — `.mp4` + `.jpg`).
3. Create a playlist; add both items. Set the image duration to e.g. 5000ms.
4. Assign the playlist to the device (or its group).

Expected:
- Within ~5s the player page transitions from `NoContentScreen` to `PlayerStage`.
- The video plays muted; at `ended` the image appears with no visible black flash.
- After 5s the image swaps back to the video.
- In the dashboard's device detail, "Playing now" updates each transition.

- [ ] **Step 3: Trigger a reconcile via version bump**

In the dashboard, open the playlist editor and change the image duration from 5000ms → 8000ms. Save.

Expected:
- Within ~2s (SSE push) the player rebuilds the scheduler; playback continues seamlessly with the new image duration.

- [ ] **Step 4: Trigger a hard reload**

Add a device action in the dashboard that sends the `reload` event (device detail → Reload). If that button isn't wired to fire `reload` via the API, invoke it manually:

```bash
curl -X POST http://localhost:5100/api/devices/tv-qa-1/reload
```

Expected:
- Player page performs a full `window.location.reload()` within ~1s.

- [ ] **Step 5: Break a media item; confirm skip + red dot**

Corrupt one of the media blobs (a simple way: stop the dev server, truncate a file in `data/media/` to zero bytes, restart):

```bash
# Example — truncate a specific media file to trigger decode failure
truncate -s 0 data/media/<some-sha256>
```

Expected:
- The corrupted item is skipped during playback.
- Telemetry posts an error; the dashboard's device row shows a red dot / error feed entry.
- The loop continues with the remaining items.

- [ ] **Step 6: Disconnect the server; confirm standby and recovery**

```bash
# Ctrl-C the dev server; wait 45s; restart
```

Expected:
- Player stays on the current playlist while the server is down (SSE auto-reconnect, reconcile retries silently).
- After a long outage (> ~30s), the player does NOT flash the `StandbyScreen` as long as a manifest has been loaded (see design: StandbyScreen is only shown if `manifest === null`).
- When the server returns, a `reconcile` on SSE `open` catches up any changes.

- [ ] **Step 7: Single-item playlist test**

Reduce the playlist to a single video. Confirm `<video loop>` takes over: playback is seamless with no visible swap.

Swap that to a single image with 3s duration. Confirm the image re-renders every 3s (visible because the transition class toggles, though the image doesn't change).

- [ ] **Step 8: Update README with `/player` section**

Open `README.md` and append a new section just before the "Testing" or "Commands" section (placement up to the engineer — match existing structure):

```md
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
```

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "docs: player QA checklist + /player route README section"
```

---

## Self-Review Checklist

Before handing this plan to an implementer:

- [ ] **Spec coverage**
  - `useNativeDevice` / `NativeDevice` contract → Task 4
  - `usePlayerEnv` / `fileUrl` → Task 4
  - `resolveDeviceId` — query > storage > generate → Task 2
  - Manifest fetch + shouldReconcile diff → Task 6 (reconciler uses Task 2 helper)
  - SSE: `manifest-changed`, `reload`, `ping` handling → Task 6
  - 30s safety poll → Task 6
  - Backoff on fetch failure → Task 6 (uses Task 2 helper)
  - Scheduler: multi-item + stale-ended guard → Task 3
  - Scheduler: single-video mode (native `<video loop>`) → Task 3 + Task 8 sets `video.loop`
  - Scheduler: single-image mode (internal timer re-arm) → Task 3
  - Scheduler: empty mode → Task 3
  - Image timer cancellation on transition → Task 3
  - 4-element double buffer → Task 8
  - Consecutive-error cap → Task 8 (`reportError` → 5 then `stalled`)
  - Telemetry on item start + errors → Tasks 5 + 7
  - Telemetry `currentItemId: null` on no-content → Task 7
  - Standby + NoContent screens → Tasks 9 + 10
  - Autoplay muted + playsinline → Task 8 (element attributes)
  - `definePageMeta({ layout: false })` → Task 10
  - `register` + `getManifest` + `postTelemetry` in ApiClient → Task 1

- [ ] **Placeholder scan**: no TBD / TODO / "add validation" / unresolved `...`.
- [ ] **Type consistency**: `Manifest`, `ManifestItem`, `ApiClient`, `SchedulerHandle`, `ReconcilerHandle`, `StreamState`, `PlayerEnv`, `NativeDevice`, `DeviceIdStorage`, `SchedulerDeps`, `TransitionEvent`, `PlayerBootState`, `PlayerScreen` — all defined once and used consistently across tasks.
- [ ] **Imports**: every `import` in code blocks resolves to a file this plan creates or an existing file (`~/app/types/api`, `~/app/composables/useApiClient`).
- [ ] **Commit-per-task**: each task ends with a `git commit`.
