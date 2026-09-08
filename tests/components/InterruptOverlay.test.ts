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
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 35_000 }
    })
    const video = w.find('video').element as HTMLVideoElement
    await w.find('video').trigger('loadedmetadata')
    expect(video.currentTime).toBe(35)
    expect(video.play).toHaveBeenCalled()
  })

  it('emits started once playback actually begins', async () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
    })
    await w.find('video').trigger('playing')
    expect(w.emitted('started')).toBeTruthy()
  })

  it('emits failed if nothing decodes within the startup budget', async () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
    })
    vi.advanceTimersByTime(5_000)
    expect(w.emitted('failed')).toBeTruthy()
  })

  it('does not emit failed once playback has started', async () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
    })
    await w.find('video').trigger('playing')
    vi.advanceTimersByTime(10_000)
    expect(w.emitted('failed')).toBeFalsy()
  })

  it('genuinely releases the video element on unmount, and stops the startup timer', () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
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
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
    })
    vi.advanceTimersByTime(5_000)
    expect(w.emitted('failed')).toHaveLength(1)
    await w.find('video').trigger('error')
    await flushPromises()
    expect(w.emitted('failed')).toHaveLength(1)
    globalThis.fetch = originalFetch
  })

  it('is muted — a second decoder is exactly what must not exist here', () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
    })
    // Not attributes('muted'): Vue sets `muted` as a DOM property
    // (el.muted = true), never as an HTML attribute — true in real browsers
    // too (the `muted` IDL attribute doesn't reflect a content attribute;
    // `defaultMuted` does). Checking the attribute would never pass.
    const video = w.find('video').element as HTMLVideoElement
    expect(video.muted).toBe(true)
  })
})
