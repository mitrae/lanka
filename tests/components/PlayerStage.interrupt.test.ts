// @vitest-environment jsdom
//
// PlayerStage's suspension handshake for the scheduled interrupt. Needs a real
// DOM (mounted <video> elements) — see InterruptOverlay.test.ts for the idiom.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import PlayerStage from '~/app/components/player/PlayerStage.vue'
import { createPlayerScheduler } from '~/app/composables/player/createPlayerScheduler'

const items = [
  { id: 1, type: 'video' as const, sha256: 'a', durationMs: 30_000 },
  { id: 2, type: 'video' as const, sha256: 'b', durationMs: 30_000 }
]
const manifest = { playlistId: 1, playlistName: 'P', version: 1, items }
const env = { fileUrl: (sha: string) => `/media/${sha}` }

function stubMedia() {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true, value: vi.fn().mockResolvedValue(undefined)
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true, value: vi.fn()
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    configurable: true, value: vi.fn()
  })
}

function mountStage() {
  const scheduler = createPlayerScheduler(items, {
    now: () => Date.now(),
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
    clearTimeout: (h) => window.clearTimeout(h as number)
  })
  const w = mount(PlayerStage, {
    props: { manifest, scheduler, env, suspended: false } as any
  })
  return { w, scheduler }
}

describe('PlayerStage suspension', () => {
  beforeEach(() => stubMedia())

  it('pauses the front video, empties the back slot and acknowledges', async () => {
    const { w, scheduler } = mountStage()
    const pauseSpy = vi.spyOn(scheduler, 'pause')
    const videos = w.findAll('video')

    await w.setProps({ suspended: true })

    expect(pauseSpy).toHaveBeenCalled()
    expect(w.emitted('stood-down')).toBeTruthy()
    // Back slot released: its src attribute is gone.
    expect(videos[1].attributes('src')).toBeUndefined()
  })

  it('stops watchdog sampling while suspended, and restarts it on stand-up', async () => {
    // jsdom's HTMLMediaElement never populates `currentSrc` (no real resource
    // selection algorithm), so PlayerStage's sampleProgress() always sees
    // expectPlaying === false and can never actually trip a stall here — a
    // test that just advances fake timers and asserts nothing stall-shaped
    // happened would pass whether or not the sampling interval was ever
    // cleared. Pin the real mechanism instead: the stallTimer's
    // setInterval/clearInterval calls, which is what standDown/standUp
    // actually toggle. Verified by temporarily reverting the clearInterval in
    // standDown() and confirming this test fails (the loose "advance timers +
    // assert nothing" version above did not).
    const setSpy = vi.spyOn(window, 'setInterval')
    const clearSpy = vi.spyOn(window, 'clearInterval')
    const { w } = mountStage()
    expect(setSpy).toHaveBeenCalledTimes(1)
    const mountHandle = setSpy.mock.results[0]!.value

    await w.setProps({ suspended: true })

    expect(w.emitted('stood-down')).toHaveLength(1)
    // The exact interval armed at mount time is cleared — sampling stops.
    expect(clearSpy).toHaveBeenCalledWith(mountHandle)
    expect(setSpy).toHaveBeenCalledTimes(1) // no replacement interval armed

    await w.setProps({ suspended: false })
    expect(setSpy).toHaveBeenCalledTimes(2) // sampling resumes on stand-up

    setSpy.mockRestore()
    clearSpy.mockRestore()
  })

  it('resumes the front video WITHOUT reloading it — frame-exact resume', async () => {
    const { w, scheduler } = mountStage()
    const resumeSpy = vi.spyOn(scheduler, 'resume')
    const front = w.findAll('video')[0].element as HTMLVideoElement
    const srcBefore = front.src

    await w.setProps({ suspended: true })
    await w.setProps({ suspended: false })

    expect(resumeSpy).toHaveBeenCalled()
    expect(front.src).toBe(srcBefore) // never re-assigned → currentTime preserved
    expect(front.play).toHaveBeenCalled()
  })

  it('restores the back-slot preload on resume', async () => {
    const { w } = mountStage()
    await w.setProps({ suspended: true })
    await w.setProps({ suspended: false })
    const back = w.findAll('video')[1].element as HTMLVideoElement
    expect(back.src).toContain('/media/b')
  })

  it('leaves the back slot empty on resume for a single-item manifest — never duplicates the front item', async () => {
    // Single-item modes report back === front (see mountInitial's own
    // comment on this). standUp() mirrors that same null-back rule; a
    // regression here would load the one 176 MB file into a second
    // <video preload="auto">, exactly the two-decoders-on-one-file hazard
    // mountInitial already guards against.
    const singleManifest = {
      playlistId: 2,
      playlistName: 'S',
      version: 1,
      items: [{ id: 1, type: 'video' as const, sha256: 'solo', durationMs: 30_000 }]
    }
    const scheduler = createPlayerScheduler(singleManifest.items, {
      now: () => Date.now(),
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: (h) => window.clearTimeout(h as number)
    })
    const w = mount(PlayerStage, {
      props: { manifest: singleManifest, scheduler, env, suspended: false } as any
    })

    await w.setProps({ suspended: true })
    await w.setProps({ suspended: false })

    const back = w.findAll('video')[1].element as HTMLVideoElement
    expect(back.getAttribute('src')).toBeNull()
  })
})
