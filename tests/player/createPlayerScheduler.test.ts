import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPlayerScheduler,
  type SchedulerDeps
} from '~/app/composables/player/createPlayerScheduler'
import type { ManifestItem } from '~/app/types/api'

function fakeDeps(): SchedulerDeps & {
  advanceTime: (ms: number) => void
  pending: () => number
} {
  type Pending = { cb: () => void; at: number; id: number }
  let now = 0
  let nextId = 1
  const pending: Pending[] = []

  const deps = {
    now: () => now,
    setTimeout: (cb: () => void, ms: number) => {
      const id = nextId++
      pending.push({ cb, at: now + ms, id })
      return id
    },
    clearTimeout: (handle: unknown) => {
      const idx = pending.findIndex((p) => p.id === handle)
      if (idx >= 0) pending.splice(idx, 1)
    },
    advanceTime(ms: number) {
      now += ms
      while (true) {
        const due = pending.filter((p) => p.at <= now)
        if (due.length === 0) break
        pending.splice(pending.indexOf(due[0]), 1)
        due[0].cb()
      }
    },
    pending: () => pending.length
  }

  return deps
}

const video = (id: number, durationMs = 10_000): ManifestItem => ({
  id,
  type: 'video',
  sha256: `sha-${id}`,
  durationMs
})
const image = (id: number, durationMs = 8_000): ManifestItem => ({
  id,
  type: 'image',
  sha256: `sha-${id}`,
  durationMs
})

describe('createPlayerScheduler', () => {
  let deps: ReturnType<typeof fakeDeps>

  beforeEach(() => {
    deps = fakeDeps()
  })

  it('emits onItemStart(0) on start() with multi-item playlist', () => {
    const items = [video(1), video(2), image(3)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()
    expect(starts).toEqual([0])
    expect(s.getFrontIndex()).toBe(0)
    expect(s.getBackIndex()).toBe(1)
    expect(s.mode).toBe('loop')
  })

  it('advances front on itemEnded and emits transition + onItemStart', () => {
    const items = [video(1), video(2), video(3)]
    const s = createPlayerScheduler(items, deps)
    const transitions: Array<{ from: number; to: number; nextPreload: number }> = []
    const starts: number[] = []
    s.onTransition((e) => transitions.push(e))
    s.onItemStart((i) => starts.push(i))
    s.start()

    s.itemEnded(0)
    expect(transitions).toEqual([{ from: 0, to: 1, nextPreload: 2 }])
    expect(starts).toEqual([0, 1])
    expect(s.getFrontIndex()).toBe(1)
    expect(s.getBackIndex()).toBe(2)

    s.itemEnded(1)
    expect(transitions[1]).toEqual({ from: 1, to: 2, nextPreload: 0 })
    expect(s.getFrontIndex()).toBe(2)
    expect(s.getBackIndex()).toBe(0)

    s.itemEnded(2)
    expect(transitions[2]).toEqual({ from: 2, to: 0, nextPreload: 1 })
    expect(s.getFrontIndex()).toBe(0)
  })

  it('ignores stale itemEnded whose index is not the current front', () => {
    const items = [video(1), video(2), video(3)]
    const s = createPlayerScheduler(items, deps)
    const transitions: unknown[] = []
    s.onTransition((e) => transitions.push(e))
    s.start()

    s.itemEnded(0) // legitimate
    expect(transitions.length).toBe(1)

    s.itemEnded(0) // stale — front is now 1
    expect(transitions.length).toBe(1)
  })

  it('arms an image timer for durationMs when the current item is an image', () => {
    const items = [image(1, 5_000), video(2)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()
    expect(deps.pending()).toBe(1)

    deps.advanceTime(4_999)
    expect(starts).toEqual([0])

    deps.advanceTime(1)
    expect(starts).toEqual([0, 1])
    expect(s.getFrontIndex()).toBe(1)
  })

  it('does not arm a timer for video items', () => {
    const items = [video(1), image(2)]
    const s = createPlayerScheduler(items, deps)
    s.start()
    expect(deps.pending()).toBe(0)
  })

  it('clears image timer on itemEnded to prevent late fire', () => {
    const items = [image(1, 5_000), video(2)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()
    expect(deps.pending()).toBe(1)

    // Video element in slot 1 finishes before the image timer (e.g., swap
    // happened early due to error on item 0 handled elsewhere). We call
    // itemEnded(0) — the image — to advance; timer must be cancelled.
    s.itemEnded(0)
    expect(deps.pending()).toBe(0)

    deps.advanceTime(10_000)
    expect(starts).toEqual([0, 1]) // no third start — timer was cancelled
  })

  it('itemErrored emits onItemError and advances like itemEnded', () => {
    const items = [video(1), video(2), video(3)]
    const s = createPlayerScheduler(items, deps)
    const errs: Array<{ index: number; msg: string }> = []
    const transitions: unknown[] = []
    s.onItemError((i, msg) => errs.push({ index: i, msg }))
    s.onTransition((e) => transitions.push(e))
    s.start()

    s.itemErrored(0, 'decode failed')
    expect(errs).toEqual([{ index: 0, msg: 'decode failed' }])
    expect(transitions.length).toBe(1)
    expect(s.getFrontIndex()).toBe(1)
  })

  it('single video item enters single-video mode; no advance on itemEnded', () => {
    const items = [video(1)]
    const s = createPlayerScheduler(items, deps)
    const transitions: unknown[] = []
    const starts: number[] = []
    s.onTransition((e) => transitions.push(e))
    s.onItemStart((i) => starts.push(i))
    s.start()

    expect(s.mode).toBe('single-video')
    expect(starts).toEqual([0])

    s.itemEnded(0)
    expect(transitions.length).toBe(0)
    expect(s.getFrontIndex()).toBe(0)
  })

  it('single image item re-arms timer and re-emits onItemStart(0)', () => {
    const items = [image(1, 3_000)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()

    expect(s.mode).toBe('single-image')
    expect(starts).toEqual([0])
    expect(deps.pending()).toBe(1)

    deps.advanceTime(3_000)
    expect(starts).toEqual([0, 0])
    expect(deps.pending()).toBe(1)

    deps.advanceTime(3_000)
    expect(starts).toEqual([0, 0, 0])
  })

  it('stop() cancels pending image timer and stops emitting', () => {
    const items = [image(1, 5_000)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()
    expect(deps.pending()).toBe(1)

    s.stop()
    expect(deps.pending()).toBe(0)

    deps.advanceTime(10_000)
    expect(starts).toEqual([0]) // no re-fire after stop
  })

  it('zero-length items array goes inert (no starts, no timers)', () => {
    const s = createPlayerScheduler([], deps)
    const starts: number[] = []
    s.onItemStart((i) => starts.push(i))
    s.start()
    expect(starts).toEqual([])
    expect(deps.pending()).toBe(0)
    expect(s.mode).toBe('empty')
  })

  it('advancesOnError is true only for multi-item loops', () => {
    // The stage branches on this: when the scheduler cannot advance past a
    // broken item, the stage must retry the element itself or the screen
    // freezes permanently. See PlayerStage.reportError.
    expect(createPlayerScheduler([video(1), video(2)], deps).advancesOnError).toBe(true)
    expect(createPlayerScheduler([video(1)], deps).advancesOnError).toBe(false)
    expect(createPlayerScheduler([image(1)], deps).advancesOnError).toBe(false)
    expect(createPlayerScheduler([], deps).advancesOnError).toBe(false)
  })

  it('noteError only reports — never advances, in any mode', () => {
    // Used for failures that must reach telemetry but must NOT drive
    // playback: an error in the hidden preload slot, and the 5th consecutive
    // error that trips the stalled state (previously swallowed unreported).
    const items = [video(1), video(2), video(3)]
    const s = createPlayerScheduler(items, deps)
    const errs: { index: number; msg: string }[] = []
    const transitions: unknown[] = []
    s.onItemError((index, msg) => errs.push({ index, msg }))
    s.onTransition((e) => transitions.push(e))
    s.start()

    s.noteError(0, 'preload failed') // index === front, would advance via itemErrored
    expect(errs).toEqual([{ index: 0, msg: 'preload failed' }])
    expect(transitions).toEqual([])
    expect(s.getFrontIndex()).toBe(0)
  })

  it('single-video itemErrored reports the error but never advances', () => {
    const items = [video(1)]
    const s = createPlayerScheduler(items, deps)
    const errs: { index: number; msg: string }[] = []
    const transitions: unknown[] = []
    s.onItemError((index, msg) => errs.push({ index, msg }))
    s.onTransition((e) => transitions.push(e))
    s.start()

    s.itemErrored(0, 'video stalled')
    expect(errs).toEqual([{ index: 0, msg: 'video stalled' }])
    expect(transitions).toEqual([])
    expect(s.getFrontIndex()).toBe(0)
  })

  it('onItemStart returns an unsubscribe function', () => {
    const items = [video(1), video(2)]
    const s = createPlayerScheduler(items, deps)
    const starts: number[] = []
    const unsub = s.onItemStart((i) => starts.push(i))
    s.start()
    unsub()
    s.itemEnded(0)
    expect(starts).toEqual([0])
  })

  describe('pause/resume', () => {
    const twoImages = [image(1, 10_000), image(2, 10_000)]

    it('start() while paused defers the first item start until resume()', () => {
      // A manifest that lands DURING an interrupt window mounts its scheduler
      // under a live overlay. Starting it there emits itemStart(0) — one
      // play_count tick and a current_item_id for an item nobody sees — and
      // arms a slide timer that then runs behind the clip.
      const deps = fakeDeps()
      const s = createPlayerScheduler([image(1, 5_000), video(2)], deps)
      const starts: number[] = []
      s.onItemStart((i) => starts.push(i))

      s.pause()
      s.start()
      expect(starts).toEqual([])
      expect(deps.pending()).toBe(0)

      s.resume()
      expect(starts).toEqual([0])
      expect(deps.pending()).toBe(1) // the slide timer, armed fresh at resume
      deps.advanceTime(5_000)
      expect(s.getFrontIndex()).toBe(1)
    })

    it('does not advance while paused', () => {
      const s = createPlayerScheduler(twoImages, deps)
      const transitions: number[] = []
      s.onTransition((e) => transitions.push(e.to))
      s.start()

      deps.advanceTime(4_000)
      s.pause()
      deps.advanceTime(60_000) // a whole interrupt window, and then some
      expect(transitions).toEqual([])
      expect(s.getFrontIndex()).toBe(0)
    })

    it('resumes with the REMAINING time, not a fresh full duration', () => {
      const s = createPlayerScheduler(twoImages, deps)
      const transitions: number[] = []
      s.onTransition((e) => transitions.push(e.to))
      s.start()

      deps.advanceTime(4_000)
      s.pause()
      deps.advanceTime(60_000)
      s.resume()

      deps.advanceTime(5_999)
      expect(transitions).toEqual([]) // 6 s remained
      deps.advanceTime(1)
      expect(transitions).toEqual([1])
    })

    it('is idempotent in both directions', () => {
      const s = createPlayerScheduler(twoImages, deps)
      s.start()
      deps.advanceTime(4_000)
      s.pause()
      s.pause()
      s.resume()
      s.resume()
      deps.advanceTime(6_000)
      expect(s.getFrontIndex()).toBe(1)
    })

    it('resume is a no-op when nothing was paused', () => {
      const s = createPlayerScheduler(twoImages, deps)
      s.start()
      s.resume()
      deps.advanceTime(10_000)
      expect(s.getFrontIndex()).toBe(1)
    })

    it('stop() while paused leaves no timer behind', () => {
      const s = createPlayerScheduler(twoImages, deps)
      s.start()
      s.pause()
      s.stop()
      s.resume()
      deps.advanceTime(60_000)
      expect(deps.pending()).toBe(0)
    })

    it('single-video mode has no timer to pause and survives both calls', () => {
      const one = [video(1, 5_000)]
      const s = createPlayerScheduler(one, deps)
      s.start()
      s.pause()
      s.resume()
      expect(s.mode).toBe('single-video')
    })

    it('does not advance on itemEnded while paused', () => {
      const s = createPlayerScheduler(twoImages, deps)
      const transitions: number[] = []
      s.onTransition((e) => transitions.push(e.to))
      s.start()
      s.pause()
      s.itemEnded(0)
      expect(transitions).toEqual([])
      expect(s.getFrontIndex()).toBe(0)
    })

    it('still REPORTS itemErrored while paused, but does not advance', () => {
      const s = createPlayerScheduler(twoImages, deps)
      const errors: string[] = []
      const transitions: number[] = []
      s.onItemError((_i, m) => errors.push(m))
      s.onTransition((e) => transitions.push(e.to))
      s.start()
      s.pause()
      s.itemErrored(0, 'decoder died')
      expect(errors).toEqual(['decoder died'])
      expect(transitions).toEqual([])
      expect(s.getFrontIndex()).toBe(0)
    })

    it('leaves exactly one timer after an itemEnded is dropped and the scheduler resumes', () => {
      const s = createPlayerScheduler(twoImages, deps)
      s.start()
      deps.advanceTime(4_000)
      s.pause()
      s.itemEnded(0) // dropped
      s.resume()
      expect(deps.pending()).toBe(1)
    })
  })
})

describe('resume({ restart: true })', () => {
  function harness(items: any[]) {
    let now = 0
    const timers: { id: number; at: number; cb: () => void }[] = []
    let nextId = 1
    const deps = {
      now: () => now,
      setTimeout: (cb: () => void, ms: number) => { const id = nextId++; timers.push({ id, at: now + ms, cb }); return id },
      clearTimeout: (h: unknown) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1) }
    }
    const advance = (ms: number) => {
      now += ms
      for (const t of [...timers]) if (t.at <= now) { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); t.cb() }
    }
    return { deps, advance }
  }
  const twoImages = [
    { id: 1, type: 'image', sha256: 'a', durationMs: 10_000 },
    { id: 2, type: 'image', sha256: 'b', durationMs: 10_000 }
  ]

  it('re-arms the slide with its FULL duration, not the remainder', () => {
    // The restart counterpart of the plain resume(): a slide that was 4 s in
    // when the interrupt began gets its whole 10 s back, not the leftover 6 s.
    const h = harness(twoImages)
    const s = createPlayerScheduler(twoImages as any, h.deps)
    const transitions: number[] = []
    s.onTransition((e) => transitions.push(e.to))
    s.start()
    h.advance(4_000)
    s.pause()
    s.resume({ restart: true })

    h.advance(9_999)
    expect(transitions).toEqual([]) // would already have fired on the 6 s remainder
    h.advance(1)
    expect(transitions).toEqual([1])
  })
})
