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
// of that: onStageStoodDown and onInterruptFailed are returned directly, and
// interruptPhase/interruptSrc/interruptSha/interruptOffsetMs are the exact
// refs the closures close over — so the arming guard and the failure-teardown
// cleanup can be driven directly, by setting the phase to what sampleInterrupt
// would have set it to and calling the handler, same as PlayerStage's own
// suspension tests drive standDown()/standUp() via `suspended` rather than a
// real interrupt window.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

  it('onStageStoodDown advances arming -> playing exactly once and posts interruptStarted', () => {
    const api = mockApi()
    const boot = usePlayerBoot(api)
    boot.interruptPhase.value = 'arming'

    boot.onStageStoodDown()

    expect(boot.interruptPhase.value).toBe('playing')
    expect(api.postTelemetry).toHaveBeenCalledTimes(1)
    const [deviceId, body] = api.postTelemetry.mock.calls[0]
    expect(typeof deviceId).toBe('string')
    // interruptStarted carries interruptAt, never currentItemId — the
    // interrupt is not a playlist item and must not touch play_count.
    expect('currentItemId' in body).toBe(false)
    expect(typeof body.interruptAt).toBe('number')

    // A second acknowledgement (e.g. a stray late call) must not re-fire —
    // the phase is no longer 'arming'.
    boot.onStageStoodDown()
    expect(api.postTelemetry).toHaveBeenCalledTimes(1)
  })

  it('onInterruptFailed tears the overlay down loudly: resumes idle and records the sha', () => {
    const api = mockApi()
    const boot = usePlayerBoot(api)
    boot.interruptPhase.value = 'playing'
    boot.interruptSrc.value = '/media/deadbeef'
    boot.interruptSha.value = 'deadbeef'
    boot.interruptOffsetMs.value = 1234

    boot.onInterruptFailed('decode error')

    // Never blank: the playlist screen is free to take over (suspended
    // becomes false once interruptPhase is 'idle').
    expect(boot.interruptPhase.value).toBe('idle')
    expect(boot.interruptSrc.value).toBeNull()
    expect(boot.interruptSha.value).toBeNull()
    expect(boot.interruptOffsetMs.value).toBe(0)

    expect(api.postTelemetry).toHaveBeenCalledTimes(1)
    const [, body] = api.postTelemetry.mock.calls[0]
    expect(body.currentItemId).toBeNull()
    expect(body.error).toEqual({ sha256: 'deadbeef', message: 'interrupt: decode error' })
  })

  it('onInterruptFailed while already idle does not corrupt state (defensive double-call)', () => {
    // The overlay itself dedupes its own `failed` emit (see
    // InterruptOverlay's `failed` guard), so usePlayerBoot should never
    // actually receive two calls for one window — this pins that a stray
    // extra call stays harmless rather than asserting it is unreachable.
    const api = mockApi()
    const boot = usePlayerBoot(api)
    expect(boot.interruptPhase.value).toBe('idle')

    boot.onInterruptFailed('late failure')

    expect(boot.interruptPhase.value).toBe('idle')
    expect(boot.interruptSrc.value).toBeNull()
    expect(boot.interruptSha.value).toBeNull()
  })
})
