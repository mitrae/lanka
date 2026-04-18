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
})
