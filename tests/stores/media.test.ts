// tests/stores/media.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useMediaStore } from '~/app/stores/media'
import type { UploadJob } from '~/app/types/api'

function job(over: Partial<UploadJob> = {}): UploadJob {
  return {
    id: 'j1', filename: 'a.mp4', kind: 'video', quality: 'standard', mimeType: 'video/mp4', bytes: 10,
    status: 'queued', error: null, mediaId: null, attempts: 0,
    createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z', ...over
  }
}
const ticket = { method: 'PUT' as const, url: '/api/media/uploads/j1/file', headers: { 'content-type': 'video/mp4' }, expiresAt: 1 }

describe('useMediaStore uploads', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('startUpload: create → PUT via uploadFn → complete → tracked', async () => {
    const store = useMediaStore()
    const api = {
      createUpload: vi.fn().mockResolvedValue({ ...job({ status: 'pending' }), upload: ticket }),
      completeUpload: vi.fn().mockResolvedValue(job({ status: 'queued' })),
      cancelUpload: vi.fn(),
      listMedia: vi.fn().mockResolvedValue([])
    }
    store.$patch({ _api: api as any })
    const uploadFn = vi.fn().mockResolvedValue(undefined)
    const file = new File([new Uint8Array(10)], 'a.mp4', { type: 'video/mp4' })
    const onProgress = vi.fn()
    const res = await store.startUpload(file, { kind: 'video', quality: 'standard', onProgress, uploadFn })
    expect(api.createUpload).toHaveBeenCalledWith({ filename: 'a.mp4', kind: 'video', quality: 'standard', mimeType: 'video/mp4', bytes: 10 })
    expect(uploadFn).toHaveBeenCalledWith(expect.objectContaining({ ...ticket, file, onProgress }))
    expect(api.completeUpload).toHaveBeenCalledWith('j1')
    expect(res.status).toBe('queued')
    expect(store.uploads.map((u) => u.id)).toEqual(['j1'])
    expect(api.cancelUpload).not.toHaveBeenCalled()
    store.stopPolling()
  })

  it('startUpload cancels the job (best effort) and rethrows when the PUT fails', async () => {
    const store = useMediaStore()
    const api = {
      createUpload: vi.fn().mockResolvedValue({ ...job({ status: 'pending' }), upload: ticket }),
      completeUpload: vi.fn(),
      cancelUpload: vi.fn().mockRejectedValue(new Error('offline'))
    }
    store.$patch({ _api: api as any })
    const uploadFn = vi.fn().mockRejectedValue(new Error('HTTP 403'))
    await expect(
      store.startUpload(new File(['x'], 'a.mp4', { type: 'video/mp4' }), { kind: 'video', quality: 'low', uploadFn })
    ).rejects.toThrow('HTTP 403')
    expect(api.cancelUpload).toHaveBeenCalledWith('j1')
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(store.uploads).toEqual([])
  })

  it('tick(): done → refresh + drop; failed → failedUploads; 404 → drop', async () => {
    const store = useMediaStore()
    const api = {
      listMedia: vi.fn().mockResolvedValue([]),
      getUpload: vi.fn(async (id: string) => {
        if (id === 'j1') return job({ id: 'j1', status: 'done', mediaId: 5 })
        if (id === 'j2') return job({ id: 'j2', status: 'failed', error: 'boom' })
        throw Object.assign(new Error('not found'), { status: 404 })
      })
    }
    store.$patch({ _api: api as any, uploads: [job({ id: 'j1' }), job({ id: 'j2' }), job({ id: 'j3' })] })
    await store.tick()
    expect(api.listMedia).toHaveBeenCalledTimes(1)
    expect(store.uploads).toEqual([])
    expect(store.takeFailedUploads().map((j) => j.id)).toEqual(['j2'])
    expect(store.failedUploads).toEqual([])
    store.stopPolling()
  })

  it('pollUploads seeds from the active list and keeps polling every 3s while active', async () => {
    const store = useMediaStore()
    const api = {
      listActiveUploads: vi.fn().mockResolvedValue([job({ id: 'j1', status: 'processing' })]),
      getUpload: vi.fn().mockResolvedValue(job({ id: 'j1', status: 'processing' })),
      listMedia: vi.fn().mockResolvedValue([])
    }
    store.$patch({ _api: api as any })
    await store.pollUploads()
    expect(store.uploads.map((u) => u.id)).toEqual(['j1'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getUpload).toHaveBeenCalledTimes(2)
    store.stopPolling()
    await vi.advanceTimersByTimeAsync(6000)
    expect(api.getUpload).toHaveBeenCalledTimes(2)
  })

  it('tick() keeps uploads in stable order when jobs stay active', async () => {
    const store = useMediaStore()
    const api = {
      listMedia: vi.fn().mockResolvedValue([]),
      getUpload: vi.fn(async (id: string) => job({ id, status: 'processing' }))
    }
    store.$patch({ _api: api as any, uploads: [job({ id: 'a' }), job({ id: 'b' })] })
    await store.tick()
    expect(store.uploads.map((u) => u.id)).toEqual(['a', 'b'])
    await store.tick()
    expect(store.uploads.map((u) => u.id)).toEqual(['a', 'b'])
    store.stopPolling()
  })

  it('pollUploads() seeds newest-first and keeps the same order on re-seed', async () => {
    const store = useMediaStore()
    const jobs = [job({ id: 'a', status: 'processing' }), job({ id: 'b', status: 'processing' })]
    const api = {
      listActiveUploads: vi.fn().mockResolvedValue(jobs),
      getUpload: vi.fn(),
      listMedia: vi.fn().mockResolvedValue([])
    }
    store.$patch({ _api: api as any })
    await store.pollUploads()
    expect(store.uploads.map((u) => u.id)).toEqual(['a', 'b'])
    await store.pollUploads()
    expect(store.uploads.map((u) => u.id)).toEqual(['a', 'b'])
    store.stopPolling()
  })

  it('pollUploads(): a transient listActiveUploads failure does not throw and still arms polling', async () => {
    const store = useMediaStore()
    const api = {
      listActiveUploads: vi.fn().mockRejectedValue(new Error('HTTP 500')),
      getUpload: vi.fn(),
      listMedia: vi.fn().mockResolvedValue([])
    }
    store.$patch({ _api: api as any })
    await expect(store.pollUploads()).resolves.toBeUndefined()
    expect(store.uploads).toEqual([])
    expect(store._polling).toBe(true)
    // Nothing is tracked (the seed failed), so schedulePoll() is a no-op —
    // no timer got armed, and getUpload is never called.
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getUpload).not.toHaveBeenCalled()
    store.stopPolling()
  })

  it('stopPolling() wins over an in-flight tick() — no re-arm once it resolves', async () => {
    const store = useMediaStore()
    let resolveGetUpload!: (value: UploadJob) => void
    const deferred = new Promise<UploadJob>((resolve) => {
      resolveGetUpload = resolve
    })
    const api = {
      listActiveUploads: vi.fn().mockResolvedValue([job({ id: 'j1', status: 'processing' })]),
      getUpload: vi.fn().mockImplementation(() => deferred),
      listMedia: vi.fn().mockResolvedValue([])
    }
    store.$patch({ _api: api as any })
    await store.pollUploads()
    expect(store.uploads.map((u) => u.id)).toEqual(['j1'])

    // Fire the poll timer: tick() starts and blocks on the in-flight getUpload().
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getUpload).toHaveBeenCalledTimes(1)

    store.stopPolling()
    resolveGetUpload(job({ id: 'j1', status: 'processing' }))
    await vi.advanceTimersByTimeAsync(0) // let the in-flight tick()'s continuation run

    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getUpload).toHaveBeenCalledTimes(1)
  })
})
