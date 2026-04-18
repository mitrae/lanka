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
