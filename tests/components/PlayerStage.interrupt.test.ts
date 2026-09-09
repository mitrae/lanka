// @vitest-environment jsdom
//
// PlayerStage's suspension handshake for the scheduled interrupt. Needs a real
// DOM (mounted <video> elements) — see InterruptOverlay.test.ts for the idiom.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
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

/**
 * A pause mock that sees ONE element and nothing else.
 *
 * The trap this exists for: stubMedia() installs a single vi.fn() on
 * HTMLMediaElement.prototype, so every <video> in the component shares one
 * mock — and standDown()'s next statement, setItemInSlot(backSlot(), null),
 * pauses the BACK element through that same mock. A prototype-level assertion
 * would therefore pass with the front pause() deleted.
 *
 * `vi.spyOn(el, 'pause')` does NOT fix that: the property descriptor lives on
 * the prototype, so vitest patches the PROTOTYPE (verified — the spy ends up
 * as `HTMLMediaElement.prototype.pause`, and `front.pause === back.pause`
 * still holds). Only defining an own property on the element itself shadows
 * the shared stub.
 */
function stubElementPause(el: HTMLMediaElement) {
  const fn = vi.fn()
  Object.defineProperty(el, 'pause', { configurable: true, value: fn })
  return fn
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

  it('pauses the FRONT element itself — the line the frame-exact resume rests on', async () => {
    const { w } = mountStage()
    const front = w.findAll('video')[0].element as HTMLVideoElement
    const frontPause = stubElementPause(front)

    await w.setProps({ suspended: true })

    expect(frontPause).toHaveBeenCalledTimes(1)
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
    // Per-element stub, not the shared prototype mock — see stubElementPause.
    const frontPause = stubElementPause(front)

    await w.setProps({ suspended: true })
    await w.setProps({ suspended: false })

    expect(resumeSpy).toHaveBeenCalled()
    // Paused AND never re-assigned is the conjunction that makes the resume
    // frame-exact; either half alone asserts half the property.
    expect(frontPause).toHaveBeenCalledTimes(1)
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

  it('cancels a pending stall-recovery timer on suspend, and re-arms it on resume if still stalled', async () => {
    // Drive the stage into its OWN self-heal backoff for real (5 consecutive
    // reportError() calls -> stalled.value = true -> scheduleRecovery() arms
    // a 15s window's recoveryTimer), then prove suspending cancels that exact
    // timer rather than leaving it to fire mountInitial() mid-observance.
    //
    // A single-item video manifest keeps this tractable: the front item never
    // advances (advancesOnError === false), so every 'error' trigger lands on
    // the same <video>, and every error goes through PlayerStage's one-free-
    // blob-attempt gate (blobState) before it is charged against the error
    // budget. blobState is marked 'tried' SYNCHRONOUSLY on the first error, so
    // every subsequent synchronous trigger charges the budget directly; fetch
    // is mocked to reject so the one async blob attempt itself also resolves
    // to a charge, and flushPromises() after each trigger drains it before it
    // can land at an unpredictable time relative to the assertions below.
    const singleManifest = {
      playlistId: 3,
      playlistName: 'X',
      version: 1,
      items: [{ id: 1, type: 'video' as const, sha256: 'solo', durationMs: 30_000 }]
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('no network'))
    const setSpy = vi.spyOn(window, 'setTimeout')
    const clearSpy = vi.spyOn(window, 'clearTimeout')

    const scheduler = createPlayerScheduler(singleManifest.items, {
      now: () => Date.now(),
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: (h) => window.clearTimeout(h as number)
    })
    const w = mount(PlayerStage, {
      props: { manifest: singleManifest, scheduler, env, suspended: false } as any
    })

    for (let i = 0; i < 10 && !w.find('.stalled-banner').exists(); i++) {
      await w.find('video').trigger('error')
      await flushPromises()
    }
    await flushPromises() // drain the one outstanding blob-fetch rejection
    expect(w.find('.stalled-banner').exists()).toBe(true) // sanity: genuinely stalled

    const recoveryCallsBeforeSuspend = setSpy.mock.calls.length
    expect(recoveryCallsBeforeSuspend).toBeGreaterThan(0)
    const recoveryHandle = setSpy.mock.results[recoveryCallsBeforeSuspend - 1]!.value

    await w.setProps({ suspended: true })

    // The pending 15s recovery timeout is cancelled, not merely ignored —
    // left running it fires mountInitial() DURING the observance regardless
    // of suspension: src re-assigned on the paused front (re-priming the
    // decoder) and on the back slot (a third live decoder next to the
    // overlay).
    expect(clearSpy).toHaveBeenCalledWith(recoveryHandle)

    await w.setProps({ suspended: false })

    // Nothing healed the underlying fault, so standing up must re-arm the
    // backoff — cancelling without re-arming would strand the stage stalled
    // forever with no timer left to retry it.
    expect(setSpy.mock.calls.length).toBeGreaterThan(recoveryCallsBeforeSuspend)

    // Real timers here: the stage is left mid-backoff with a live 15 s
    // recovery timeout that would otherwise outlive the test in a shared
    // vitest worker.
    w.unmount()
    globalThis.fetch = originalFetch
    setSpy.mockRestore()
    clearSpy.mockRestore()
  })

  it('a front-video error while suspended is reported, but neither reloads nor plays the paused front', async () => {
    // standDown() only stopped two timers; every event-driven self-heal path
    // still ran. A Range fetch dying under the overlay re-sourced and
    // play()ed the paused front video from 0 — the re-prime that killed a
    // prod TV — and the blob retry did the same from the other direction.
    const { w, scheduler } = mountStage()
    const errors: string[] = []
    scheduler.onItemError((_, msg) => errors.push(msg))
    const front = w.findAll('video')[0].element as HTMLVideoElement
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn().mockRejectedValue(new Error('no network'))
    globalThis.fetch = fetchSpy

    await w.setProps({ suspended: true })
    const loadsBefore = (front.load as ReturnType<typeof vi.fn>).mock.calls.length
    const playsBefore = (front.play as ReturnType<typeof vi.fn>).mock.calls.length

    await w.findAll('video')[0].trigger('error')
    await flushPromises()

    expect(errors).toHaveLength(1) // telemetry never goes blind
    expect(fetchSpy).not.toHaveBeenCalled() // no blob retry under the overlay
    expect((front.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loadsBefore)
    expect((front.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(playsBefore)
    globalThis.fetch = originalFetch
  })

  it('errors while suspended never trip the stalled state or arm the recovery timer', async () => {
    const singleManifest = {
      playlistId: 4,
      playlistName: 'Y',
      version: 1,
      items: [{ id: 1, type: 'video' as const, sha256: 'solo', durationMs: 30_000 }]
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('no network'))
    const setSpy = vi.spyOn(window, 'setTimeout')
    const scheduler = createPlayerScheduler(singleManifest.items, {
      now: () => Date.now(),
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: (h) => window.clearTimeout(h as number)
    })
    const w = mount(PlayerStage, {
      props: { manifest: singleManifest, scheduler, env, suspended: false } as any
    })
    const front = w.find('video').element as HTMLVideoElement
    await w.setProps({ suspended: true })
    const loadsBefore = (front.load as ReturnType<typeof vi.fn>).mock.calls.length

    for (let i = 0; i < 6; i++) {
      await w.find('video').trigger('error')
      await flushPromises()
    }

    expect(w.find('.stalled-banner').exists()).toBe(false)
    expect(setSpy.mock.calls.some(([, ms]) => ms === 15_000)).toBe(false)
    expect((front.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loadsBefore)

    w.unmount()
    globalThis.fetch = originalFetch
    setSpy.mockRestore()
  })

  it('stands down immediately when mounted already suspended — a manifest change during the observance remounts the stage keyed on playlistId:version, with `suspended` already true and no transition for the watcher to react to', async () => {
    // Without a mount-time check, a fresh stage would run mountInitial() (load
    // + play the front item, preload the back item) underneath a still-live
    // overlay: three decoders on a box with a handful, plus the watchdog
    // reloading the page ~8 s in once it notices the front item isn't
    // actually advancing.
    const scheduler = createPlayerScheduler(items, {
      now: () => Date.now(),
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: (h) => window.clearTimeout(h as number)
    })
    const pauseSpy = vi.spyOn(scheduler, 'pause')
    const setSpy = vi.spyOn(window, 'setInterval')
    const clearSpy = vi.spyOn(window, 'clearInterval')

    const w = mount(PlayerStage, {
      props: { manifest, scheduler, env, suspended: true } as any
    })

    expect(pauseSpy).toHaveBeenCalled()
    expect(w.emitted('stood-down')).toBeTruthy()
    const videos = w.findAll('video')
    // Mounted INTO the stood-down state, not mounted live and then stood
    // down: the front item is loaded (one paused decoder, ready for a
    // frame-exact resume) but never played, and the back slot is never
    // preloaded — under a live overlay that was three decoders on a box with
    // a handful, plus a play() nobody saw.
    expect(videos[0].attributes('src')).toContain('/media/a')
    expect(videos[1].attributes('src')).toBeUndefined()
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    // No watchdog interval is armed at all while the fresh stage is suspended.
    expect(setSpy).not.toHaveBeenCalled()
    expect(clearSpy).not.toHaveBeenCalled()

    setSpy.mockRestore()
    clearSpy.mockRestore()
  })
})
