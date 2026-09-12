// @vitest-environment jsdom
//
// This suite is the only one in the project that needs a real DOM: it mounts
// InterruptOverlay with @vue/test-utils and drives its <video> element via
// DOM events. The rest of the suite runs under vitest.config.ts's `node`
// environment (Nitro server tests, no DOM needed) — scoping jsdom to this
// file keeps that baseline untouched.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import InterruptOverlay from '~/app/components/player/InterruptOverlay.vue'

/** jsdom's HTMLMediaElement has no real playback; stub the bits we drive. */
function stubMedia() {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined)
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    configurable: true,
    value: vi.fn()
  })
  // Unmount calls pause() to genuinely release the decoder; jsdom's default
  // throws "not implemented" for it (logged, not thrown, but noisy).
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn()
  })
}

describe('InterruptOverlay', () => {
  beforeEach(() => {
    stubMedia()
    vi.useFakeTimers()
  })

  it('seeks to the join offset once metadata is available, then plays', async () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 35_000 }
    })
    const video = w.find('video').element as HTMLVideoElement
    await w.find('video').trigger('loadedmetadata')
    expect(video.currentTime).toBe(35)
    expect(video.play).toHaveBeenCalled()
  })

  it('emits started once playback actually begins', async () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 0 }
    })
    await w.find('video').trigger('playing')
    expect(w.emitted('started')).toBeTruthy()
  })

  it('emits failed if nothing decodes within the startup budget and the blob retry fails too', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 0 }
    })
    vi.advanceTimersByTime(5_000)
    await flushPromises()
    expect(w.emitted('failed')).toHaveLength(1)
    globalThis.fetch = originalFetch
  })

  it('a startup budget that expires with no frame tries the blob path first, with a FRESH budget', async () => {
    // The direct-URL attempt and the blob retry used to share one 5 s timer:
    // a late-budget error made the retry dead code and forfeited the day.
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url')
    URL.revokeObjectURL = vi.fn()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) })
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 0 }
    })
    const video = w.find('video').element as HTMLVideoElement

    vi.advanceTimersByTime(5_000)
    await flushPromises()
    expect(globalThis.fetch).toHaveBeenCalledWith('/media/silence')
    expect(video.getAttribute('src')).toBe('blob:mock-url')
    expect(w.emitted('failed')).toBeFalsy()

    vi.advanceTimersByTime(4_999)
    expect(w.emitted('failed')).toBeFalsy()
    vi.advanceTimersByTime(1)
    expect(w.emitted('failed')).toHaveLength(1)

    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it('seeks to the offset as of loadedmetadata, not as of mount — every screen lands on the same second', async () => {
    let offset = 300
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => offset }
    })
    offset = 3_500 // a cache-miss box took 3.2 s to reach metadata
    await w.find('video').trigger('loadedmetadata')
    expect((w.find('video').element as HTMLVideoElement).currentTime).toBe(3.5)
  })

  it('the blob retry re-seeks to the LIVE offset, never back to where the first attempt joined', async () => {
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url')
    URL.revokeObjectURL = vi.fn()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) })
    let offset = 0
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => offset }
    })
    const video = w.find('video').element as HTMLVideoElement
    await w.find('video').trigger('loadedmetadata')
    expect(video.currentTime).toBe(0)

    await w.find('video').trigger('error') // the pipeline rejected the direct URL
    await flushPromises()
    offset = 7_000 // 7 s of the window passed while the blob was fetched
    await w.find('video').trigger('loadedmetadata')
    expect(video.currentTime).toBe(7)

    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it('emits failed on a decode error AFTER playback started, once the blob retry also fails — a black overlay is not an observance', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 0 }
    })
    await w.find('video').trigger('playing')
    expect(w.emitted('started')).toBeTruthy()

    await w.find('video').trigger('error')
    await flushPromises()
    expect(w.emitted('failed')).toHaveLength(1)
    globalThis.fetch = originalFetch
  })

  it('a blob retry after a mid-clip error is failed by its own budget if it never produces a frame', async () => {
    // `playing` must describe the element NOW, not "it played once": the
    // retry's budget bailed on the stale flag and a dead blob load sat black
    // until the wall clock.
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url')
    URL.revokeObjectURL = vi.fn()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) })
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 0 }
    })
    await w.find('video').trigger('playing')
    await w.find('video').trigger('error')
    await flushPromises()
    expect(w.emitted('failed')).toBeFalsy()

    vi.advanceTimersByTime(5_000)
    expect(w.emitted('failed')).toHaveLength(1)
    expect(w.emitted('started')).toHaveLength(1) // and never re-emitted

    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it('does not emit failed once playback has started', async () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 0 }
    })
    await w.find('video').trigger('playing')
    vi.advanceTimersByTime(10_000)
    expect(w.emitted('failed')).toBeFalsy()
  })

  it('genuinely releases the video element on unmount, and stops the startup timer', () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 0 }
    })
    const video = w.find('video').element as HTMLVideoElement
    expect(video.getAttribute('src')).toBe('/media/silence')
    const loadCallsBeforeUnmount = (video.load as ReturnType<typeof vi.fn>).mock.calls.length

    w.unmount()

    // display:none frees no decoder — the src must actually be torn down.
    expect(video.getAttribute('src')).toBeNull()
    expect((video.load as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      loadCallsBeforeUnmount
    )
    // The startup timer must be cleared too: advancing past the budget after
    // unmount must not still fire a `failed` emission.
    vi.advanceTimersByTime(10_000)
    expect(w.emitted('failed')).toBeFalsy()
  })

  it('never emits failed twice — a late error after the startup timeout must not double-fire', async () => {
    // The startup timer and the original <video>'s own network load run
    // independently: the timer can trip fail() first, then a late `error`
    // from that still in-flight load reaches onError, tries the one blob
    // fallback, and (here) that fetch itself fails too — a second path to
    // fail() that the `playing` guard alone does not block.
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 0 }
    })
    vi.advanceTimersByTime(5_000)
    await flushPromises() // the budget's own blob attempt fails
    expect(w.emitted('failed')).toHaveLength(1)
    await w.find('video').trigger('error')
    await flushPromises()
    expect(w.emitted('failed')).toHaveLength(1)
    globalThis.fetch = originalFetch
  })

  it('does not re-arm the element, leak the blob, or emit after unmount', async () => {
    // jsdom implements neither createObjectURL nor revokeObjectURL at all —
    // unlike the `fetch` rejection used above, this test needs the blob
    // fetch to actually SUCCEED (to reach the post-await disposed check), so
    // both must be stubbed directly rather than spied on.
    let resolveBlob: (b: Blob) => void = () => {}
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    const revoke = vi.fn()
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url')
    URL.revokeObjectURL = revoke
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        blob: () => new Promise<Blob>((resolve) => { resolveBlob = resolve })
      })
    )

    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 0 }
    })
    const video = w.find('video').element as HTMLVideoElement

    await w.find('video').trigger('error') // starts the one blob retry
    await flushPromises() // let it reach the pending `res.blob()` await
    w.unmount() // the parent tearing down at the window's wall-clock end
    resolveBlob(new Blob(['x'])) // ...then the fetch finally resolves
    await flushPromises()

    expect(video.getAttribute('src')).toBeNull()
    expect(revoke).toHaveBeenCalledWith('blob:mock-url')
    expect(w.emitted('failed')).toBeFalsy()

    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it('is muted — a second decoder is exactly what must not exist here', () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', offsetNow: () => 0 }
    })
    // Not attributes('muted'): Vue sets `muted` as a DOM property
    // (el.muted = true), never as an HTML attribute — true in real browsers
    // too (the `muted` IDL attribute doesn't reflect a content attribute;
    // `defaultMuted` does). Checking the attribute would never pass.
    const video = w.find('video').element as HTMLVideoElement
    expect(video.muted).toBe(true)
  })
})
