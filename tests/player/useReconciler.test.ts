import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReconciler } from '~/app/composables/player/useReconciler'
import type { ApiClient } from '~/app/composables/useApiClient'
import type { Manifest, ManifestItem } from '~/app/types/api'
import type { NativeFSBridge } from '~/app/composables/player/useReconciler'

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

const m = (playlistId: number, version: number, items?: ManifestItem[]): Manifest => ({
  playlistId,
  playlistName: `P${playlistId}`,
  version,
  items: items ?? [{ id: 1, type: 'video', sha256: 'sha1', durationMs: 5000 }]
})

function fakeNativeFS(cachedSha256s: string[] = []): NativeFSBridge {
  const cached = new Set(cachedSha256s)
  return {
    exists: vi.fn((sha256: string) => cached.has(sha256)),
    download: vi.fn((sha256: string, _url: string) => { cached.add(sha256); return true }),
    evictExcept: vi.fn(),
  }
}

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

describe('createReconciler — NativeFS pre-download', () => {
  beforeEach(() => {
    FakeEventSource.lastInstance = null
    vi.useFakeTimers()
  })

  const items: ManifestItem[] = [
    { id: 1, type: 'video', sha256: 'aaa', durationMs: 5000 },
    { id: 2, type: 'image', sha256: 'bbb', durationMs: 3000 },
  ]

  it('downloads uncached items before emitting manifest', async () => {
    const nativeFS = fakeNativeFS([])  // nothing cached
    const cdnUrl = vi.fn((sha: string) => `https://cdn.example.com/media/${sha}`)
    const api = fakeApi({ getManifest: vi.fn().mockResolvedValue(m(1, 1, items)) })
    const got: Array<Manifest | null> = []
    const r = createReconciler({
      api, deviceId: 'tv-1', nativeFS, cdnUrl,
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest(man => got.push(man))

    await r.reconcile()

    expect(nativeFS.download).toHaveBeenCalledWith('aaa', 'https://cdn.example.com/media/aaa')
    expect(nativeFS.download).toHaveBeenCalledWith('bbb', 'https://cdn.example.com/media/bbb')
    expect(got.length).toBe(1)
  })

  it('skips download for already-cached items', async () => {
    const nativeFS = fakeNativeFS(['aaa'])  // aaa already cached
    const cdnUrl = vi.fn((sha: string) => `https://cdn/${sha}`)
    const api = fakeApi({ getManifest: vi.fn().mockResolvedValue(m(1, 1, items)) })
    const r = createReconciler({
      api, deviceId: 'tv-1', nativeFS, cdnUrl,
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest(() => {})

    await r.reconcile()

    expect(nativeFS.download).not.toHaveBeenCalledWith('aaa', expect.any(String))
    expect(nativeFS.download).toHaveBeenCalledWith('bbb', expect.any(String))
  })

  it('calls evictExcept with all current sha256s', async () => {
    const nativeFS = fakeNativeFS([])
    const api = fakeApi({ getManifest: vi.fn().mockResolvedValue(m(1, 1, items)) })
    const r = createReconciler({
      api, deviceId: 'tv-1', nativeFS, cdnUrl: (s) => `https://cdn/${s}`,
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest(() => {})

    await r.reconcile()

    expect(nativeFS.evictExcept).toHaveBeenCalledWith(JSON.stringify(['aaa', 'bbb']))
  })

  it('emits onSyncing(true) then onSyncing(false) around downloads', async () => {
    const nativeFS = fakeNativeFS([])
    const api = fakeApi({ getManifest: vi.fn().mockResolvedValue(m(1, 1, items)) })
    const syncing: boolean[] = []
    const r = createReconciler({
      api, deviceId: 'tv-1', nativeFS, cdnUrl: (s) => `https://cdn/${s}`,
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onSyncing(s => syncing.push(s))

    await r.reconcile()

    expect(syncing).toEqual([true, false])
  })

  it('does not emit onSyncing when all items are already cached', async () => {
    const nativeFS = fakeNativeFS(['aaa', 'bbb'])  // all cached
    const api = fakeApi({ getManifest: vi.fn().mockResolvedValue(m(1, 1, items)) })
    const syncing: boolean[] = []
    const r = createReconciler({
      api, deviceId: 'tv-1', nativeFS, cdnUrl: (s) => `https://cdn/${s}`,
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onSyncing(s => syncing.push(s))

    await r.reconcile()

    expect(syncing).toEqual([])
  })

  it('emits manifest even when a download returns false', async () => {
    const nativeFS: NativeFSBridge = {
      exists: vi.fn().mockReturnValue(false),
      download: vi.fn().mockReturnValue(false),  // always fails
      evictExcept: vi.fn(),
    }
    const api = fakeApi({ getManifest: vi.fn().mockResolvedValue(m(1, 1, items)) })
    const got: Array<Manifest | null> = []
    const r = createReconciler({
      api, deviceId: 'tv-1', nativeFS, cdnUrl: (s) => `https://cdn/${s}`,
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest(man => got.push(man))

    await r.reconcile()

    expect(got.length).toBe(1)  // manifest still emitted — player falls back to CDN
  })

  it('behaves identically to no-NativeFS path when nativeFS dep is absent', async () => {
    const api = fakeApi({ getManifest: vi.fn().mockResolvedValue(m(1, 1, items)) })
    const got: Array<Manifest | null> = []
    const r = createReconciler({
      api, deviceId: 'tv-1',
      eventSourceFactory: (u) => new FakeEventSource(u) as any
    })
    r.onManifest(man => got.push(man))

    await r.reconcile()

    expect(got).toEqual([m(1, 1, items)])
  })
})
