import { describe, expect, it } from 'vitest'
import { createStallWatchdog } from '~/app/composables/player/createStallWatchdog'

describe('createStallWatchdog', () => {
  it('reports no stall while media time keeps advancing', () => {
    const w = createStallWatchdog(6000)
    expect(w.observe({ nowMs: 0, currentTime: 0, expectPlaying: true })).toBe(false)
    for (let i = 1; i <= 10; i++) {
      expect(
        w.observe({ nowMs: i * 2000, currentTime: i * 2, expectPlaying: true })
      ).toBe(false)
    }
  })

  it('reports a stall once media time is frozen for the threshold', () => {
    const w = createStallWatchdog(6000)
    expect(w.observe({ nowMs: 0, currentTime: 12.5, expectPlaying: true })).toBe(false)
    expect(w.observe({ nowMs: 2000, currentTime: 12.5, expectPlaying: true })).toBe(false)
    expect(w.observe({ nowMs: 4000, currentTime: 12.5, expectPlaying: true })).toBe(false)
    // 6000 ms with no progress → stalled
    expect(w.observe({ nowMs: 6000, currentTime: 12.5, expectPlaying: true })).toBe(true)
  })

  it('re-arms after firing instead of reporting on every subsequent sample', () => {
    const w = createStallWatchdog(6000)
    w.observe({ nowMs: 0, currentTime: 5, expectPlaying: true })
    expect(w.observe({ nowMs: 6000, currentTime: 5, expectPlaying: true })).toBe(true)
    // Immediately after firing the window restarts — one report per stall episode,
    // so a frozen clip yields one recovery attempt per threshold, not one per tick.
    expect(w.observe({ nowMs: 8000, currentTime: 5, expectPlaying: true })).toBe(false)
    expect(w.observe({ nowMs: 12_000, currentTime: 5, expectPlaying: true })).toBe(true)
  })

  it('never reports a stall while playback is not expected to progress', () => {
    const w = createStallWatchdog(6000)
    w.observe({ nowMs: 0, currentTime: 5, expectPlaying: false })
    expect(w.observe({ nowMs: 60_000, currentTime: 5, expectPlaying: false })).toBe(false)
  })

  it('restarts the window when playback resumes after a pause', () => {
    const w = createStallWatchdog(6000)
    w.observe({ nowMs: 0, currentTime: 5, expectPlaying: true })
    // A long stretch of not-playing must not count toward the stall window.
    w.observe({ nowMs: 30_000, currentTime: 5, expectPlaying: false })
    expect(w.observe({ nowMs: 31_000, currentTime: 5, expectPlaying: true })).toBe(false)
    expect(w.observe({ nowMs: 36_000, currentTime: 5, expectPlaying: true })).toBe(false)
    expect(w.observe({ nowMs: 37_000, currentTime: 5, expectPlaying: true })).toBe(true)
  })

  it('treats a loop restart (currentTime jumping backwards) as progress', () => {
    const w = createStallWatchdog(6000)
    w.observe({ nowMs: 0, currentTime: 604.9, expectPlaying: true })
    expect(w.observe({ nowMs: 2000, currentTime: 0.2, expectPlaying: true })).toBe(false)
    expect(w.observe({ nowMs: 7000, currentTime: 0.2, expectPlaying: true })).toBe(false)
    expect(w.observe({ nowMs: 8001, currentTime: 0.2, expectPlaying: true })).toBe(true)
  })

  it('ignores sub-frame jitter as progress', () => {
    const w = createStallWatchdog(6000)
    w.observe({ nowMs: 0, currentTime: 5, expectPlaying: true })
    // A dead decoder can still report a few microseconds of drift.
    expect(w.observe({ nowMs: 3000, currentTime: 5.000004, expectPlaying: true })).toBe(false)
    expect(w.observe({ nowMs: 6000, currentTime: 5.000009, expectPlaying: true })).toBe(true)
  })

  it('uses the long startup threshold until playback has begun', () => {
    // Cold load: currentTime sits at 0 while the first bytes arrive. Treating
    // that like a mid-clip freeze reloads the element every 8 s and discards
    // the buffered progress each time — a slow link never converges.
    const w = createStallWatchdog({ startupMs: 45_000, playingMs: 8000 })
    w.observe({ nowMs: 0, currentTime: 0, expectPlaying: true, started: false })
    expect(w.observe({ nowMs: 8000, currentTime: 0, expectPlaying: true, started: false })).toBe(false)
    expect(w.observe({ nowMs: 30_000, currentTime: 0, expectPlaying: true, started: false })).toBe(false)
    expect(w.observe({ nowMs: 45_000, currentTime: 0, expectPlaying: true, started: false })).toBe(true)
  })

  it('switches to the short threshold once playback has begun', () => {
    const w = createStallWatchdog({ startupMs: 45_000, playingMs: 8000 })
    w.observe({ nowMs: 0, currentTime: 12, expectPlaying: true, started: true })
    expect(w.observe({ nowMs: 7000, currentTime: 12, expectPlaying: true, started: true })).toBe(false)
    expect(w.observe({ nowMs: 8000, currentTime: 12, expectPlaying: true, started: true })).toBe(true)
  })

  it('a plain number sets both thresholds (existing callers)', () => {
    const w = createStallWatchdog(6000)
    w.observe({ nowMs: 0, currentTime: 0, expectPlaying: true, started: false })
    expect(w.observe({ nowMs: 6000, currentTime: 0, expectPlaying: true, started: false })).toBe(true)
  })

  it('reset() clears the window so a fresh source starts clean', () => {
    const w = createStallWatchdog(6000)
    w.observe({ nowMs: 0, currentTime: 5, expectPlaying: true })
    w.reset()
    expect(w.observe({ nowMs: 6000, currentTime: 5, expectPlaying: true })).toBe(false)
    expect(w.observe({ nowMs: 12_000, currentTime: 5, expectPlaying: true })).toBe(true)
  })
})
