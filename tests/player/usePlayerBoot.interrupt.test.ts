// @vitest-environment jsdom
//
// usePlayerBoot's interrupt state machine end-to-end (sampleInterrupt polling
// the corrected clock, arming the stage, tearing the overlay down on the wall
// clock) is NOT exercised here — sampleInterrupt is a private closure only
// reached once boot() has run all the way through register → reconcile →
// openStream/EventSource → command-channel/WebSocket → the interval that
// calls it, which would need those globals faked wholesale. See
// task-11-report.md for the exact boundary.
//
// What IS reachable through usePlayerBoot's public return value without any
// of that: onStageStoodDown, onInterruptStarted and onInterruptFailed are all
// returned directly, and interruptPhase/interruptSrc/interruptSha/
// interruptOffsetMs are the exact refs the closures close over — so the
// arming guard, the started-vs-handover distinction, and the failure-teardown
// cleanup can all be driven directly, by setting the phase to what
// sampleInterrupt would have set it to and calling the handler, same as
// PlayerStage's own suspension tests drive standDown()/standUp() via
// `suspended` rather than a real interrupt window.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { usePlayerBoot } from '~/app/composables/player/usePlayerBoot'
import { _resetNativeDeviceCache } from '~/app/composables/player/useNativeDevice'

/** A `postTelemetry` spy plus `register`/`getManifest` that never resolve —
 *  boot() parks forever on the first await, so it never reaches EventSource
 *  or WebSocket. Irrelevant here: the functions under test are plain
 *  closures over refs, returned synchronously before boot() is even called. */
function mockApi() {
  return {
    register: vi.fn(() => new Promise(() => {})),
    getManifest: vi.fn(() => new Promise(() => {})),
    postTelemetry: vi.fn(() => Promise.resolve())
  } as any
}

describe('usePlayerBoot interrupt state machine (reachable surface)', () => {
  beforeEach(() => {
    _resetNativeDeviceCache()
    ;(globalThis as any).useRuntimeConfig = () => ({ public: { mediaPublicBase: '' } })
  })
  afterEach(() => {
    delete (globalThis as any).useRuntimeConfig
  })

  it('starts idle and onStageStoodDown is a no-op outside the arming phase', () => {
    const api = mockApi()
    const boot = usePlayerBoot(api)
    expect(boot.interruptPhase.value).toBe('idle')

    boot.onStageStoodDown()

    expect(boot.interruptPhase.value).toBe('idle')
    expect(api.postTelemetry).not.toHaveBeenCalled()
  })

  it('onStageStoodDown advances arming -> playing WITHOUT posting telemetry — handover alone is not proof of observance', () => {
    // This is the semantics the team lead corrected: the plan's original
    // wiring posted interruptStarted from the handover itself, before the
    // clip had decoded a single frame. A screen where the clip then fails to
    // decode would have posted interruptStarted and THEN the failure, so the
    // dashboard would report an observance that never actually appeared on
    // the glass — the one thing devices.last_interrupt_at exists to rule out.
    const api = mockApi()
    const boot = usePlayerBoot(api)
    boot.interruptPhase.value = 'arming'

    boot.onStageStoodDown()

    expect(boot.interruptPhase.value).toBe('playing')
    expect(api.postTelemetry).not.toHaveBeenCalled()

    // A second acknowledgement (e.g. a stray late call) must not re-fire —
    // the phase is no longer 'arming'.
    boot.onStageStoodDown()
    expect(boot.interruptPhase.value).toBe('playing')
    expect(api.postTelemetry).not.toHaveBeenCalled()
  })

  it('onInterruptStarted posts interruptStarted only while the clip is genuinely playing, and is a no-op otherwise', () => {
    const api = mockApi()
    const boot = usePlayerBoot(api)

    // Idle: no window at all.
    boot.onInterruptStarted()
    expect(api.postTelemetry).not.toHaveBeenCalled()

    // Armed but not yet handed over — the overlay isn't even mounted in this
    // phase in production (player.vue gates it on 'playing'), but the guard
    // is pinned defensively anyway.
    boot.interruptPhase.value = 'arming'
    boot.onInterruptStarted()
    expect(api.postTelemetry).not.toHaveBeenCalled()

    // The real path: handover, then the overlay's own `@playing` event.
    boot.onStageStoodDown()
    expect(boot.interruptPhase.value).toBe('playing')
    boot.onInterruptStarted()

    expect(api.postTelemetry).toHaveBeenCalledTimes(1)
    const [deviceId, body] = api.postTelemetry.mock.calls[0]
    expect(typeof deviceId).toBe('string')
    // interruptStarted carries interruptAt, never currentItemId — the
    // interrupt is not a playlist item and must not touch play_count.
    expect('currentItemId' in body).toBe(false)
    expect(typeof body.interruptAt).toBe('number')
  })

  it('onInterruptFailed tears the overlay down loudly: resumes idle and records the sha', async () => {
    const api = mockApi()
    const boot = usePlayerBoot(api)
    boot.interruptPhase.value = 'playing'
    boot.interruptSrc.value = '/media/deadbeef'
    boot.interruptSha.value = 'deadbeef'

    boot.onInterruptFailed('decode error')

    // The overlay is torn down FIRST: src/sha nulled and the phase leaves
    // 'playing', so its <video> releases its decoder on this flush…
    expect(boot.interruptPhase.value).toBe('ending')
    expect(boot.interruptSrc.value).toBeNull()
    expect(boot.interruptSha.value).toBeNull()
    // …and only on the NEXT flush does the stage stand up (suspended -> false).
    // In one flush Vue patches the stage (the earlier sibling) before it
    // unmounts the overlay, which put three live decoders on the box at the
    // exact instant the paused front decoder had to resume.
    await nextTick()
    expect(boot.interruptPhase.value).toBe('idle')
    expect(boot.interruptOffsetNow()).toBe(0)

    expect(api.postTelemetry).toHaveBeenCalledTimes(1)
    const [, body] = api.postTelemetry.mock.calls[0]
    // No currentItemId at all — not even null. The playlist item on screen
    // never changed, and null means "clear the current item": on a
    // single-video playlist nothing would set it again for hours, so one
    // failed observance would leave the device page reading "nothing playing".
    expect('currentItemId' in body).toBe(false)
    expect(body.error).toEqual({ sha256: 'deadbeef', message: 'interrupt: decode error' })
  })

  it('onInterruptFailed while already idle is a true no-op — no stray device_errors row for a window that ended normally', () => {
    // Phase-guarded (added alongside the interruptStarted fix): a late
    // `error` can arrive in the same tick the wall-clock branch already
    // closed the window, before Vue unmounts the overlay. Before this guard,
    // itemFailed still posted unconditionally even from idle — this pins
    // that it no longer does. The overlay itself also dedupes its own
    // `failed` emit (see InterruptOverlay's `failed` guard), so usePlayerBoot
    // should never actually receive two calls for one window in practice;
    // this test covers the defensive case regardless.
    const api = mockApi()
    const boot = usePlayerBoot(api)
    expect(boot.interruptPhase.value).toBe('idle')

    boot.onInterruptFailed('late failure')

    expect(api.postTelemetry).not.toHaveBeenCalled()
    expect(boot.interruptPhase.value).toBe('idle')
    expect(boot.interruptSrc.value).toBeNull()
    expect(boot.interruptSha.value).toBeNull()
  })
})

/** Enough of the browser for boot() to run all the way through
 *  register → reconcile → openStream → command channel → the sample tick. */
class FakeEventSource {
  static last: FakeEventSource | null = null
  private listeners = new Map<string, Array<(e: any) => void>>()
  constructor(public url: string) { FakeEventSource.last = this }
  addEventListener(type: string, fn: (e: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() {}
  fire(type: string) { for (const fn of this.listeners.get(type) ?? []) fn({ data: '{}' }) }
}
class FakeWebSocket {
  readyState = 0
  onopen: any = null
  onmessage: any = null
  onclose: any = null
  onerror: any = null
  constructor(public url: string) {}
  addEventListener() {}
  send() {}
  close() {}
}

describe('usePlayerBoot interrupt (booted, window live)', () => {
  const START = 1_800_000_000_000
  const item = { id: 1, type: 'video' as const, sha256: 'a', durationMs: 30_000 }
  const manifestAt = (version: number, serverNow: number) => ({
    playlistId: 1, playlistName: 'P', version, items: [item], serverNow,
    interrupt: { mediaId: 9, sha256: 'silence', durationMs: 60_000, startsAt: START, endsAt: START + 60_000 }
  })
  function bootedApi(getManifest: (...a: any[]) => any) {
    return {
      register: vi.fn(async () => ({})),
      getManifest: vi.fn(getManifest),
      postTelemetry: vi.fn(async () => {})
    } as any
  }
  const playStarts = (api: any) =>
    api.postTelemetry.mock.calls.filter(([, body]: any[]) => 'currentItemId' in body).length

  beforeEach(() => {
    _resetNativeDeviceCache()
    ;(globalThis as any).useRuntimeConfig = () => ({ public: { mediaPublicBase: '' } })
    ;(globalThis as any).EventSource = FakeEventSource
    ;(globalThis as any).WebSocket = FakeWebSocket
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as any).useRuntimeConfig
    delete (globalThis as any).EventSource
    delete (globalThis as any).WebSocket
  })

  it('the join offset is read off the corrected clock at call time, not snapshotted at arming', async () => {
    vi.setSystemTime(START + 2_000)
    const api = bootedApi(async () => manifestAt(1, Date.now()))
    const boot = usePlayerBoot(api)
    await flushPromises()
    expect(boot.screen.value).toBe('playing')

    vi.advanceTimersByTime(500) // one sample tick inside the window
    expect(boot.interruptPhase.value).toBe('arming')
    boot.onStageStoodDown()
    expect(boot.interruptPhase.value).toBe('playing')
    expect(boot.interruptOffsetNow()).toBe(2_500)

    vi.setSystemTime(START + 6_000) // a slow load reaches loadedmetadata later
    expect(boot.interruptOffsetNow()).toBe(6_000)
  })

  it('a manifest that lands DURING the window mounts its scheduler paused — no play is counted until the stage stands up', async () => {
    vi.setSystemTime(START + 2_000)
    let version = 1
    const api = bootedApi(async () => manifestAt(version, Date.now()))
    const boot = usePlayerBoot(api)
    await flushPromises()
    expect(playStarts(api)).toBe(1)

    vi.advanceTimersByTime(500)
    boot.onStageStoodDown()
    expect(boot.interruptPhase.value).toBe('playing')

    version = 2 // an operator saved the playlist at 09:00:20
    FakeEventSource.last!.fire('manifest-changed')
    await flushPromises()
    expect(boot.manifest.value!.version).toBe(2)
    expect(playStarts(api)).toBe(1) // nothing counted for an item nobody sees

    boot.scheduler.value!.resume() // what the stage's standUp() does
    expect(playStarts(api)).toBe(2)
  })
})
