// app/composables/player/createPlayerScheduler.ts
import type { ManifestItem } from '~/app/types/api'

export type SchedulerMode = 'loop' | 'single-video' | 'single-image' | 'empty'

export interface TransitionEvent {
  from: number
  to: number
  nextPreload: number
}

export interface SchedulerDeps {
  now: () => number
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface SchedulerHandle {
  readonly mode: SchedulerMode
  /**
   * Whether `itemErrored` moves playback on to another item.
   *
   * Only a multi-item loop can. In every single-item mode the scheduler records
   * the error and stops there — there is nothing to advance to — so the *stage*
   * has to retry the media element itself, or a broken frame stays on screen
   * forever. PlayerStage branches on this rather than re-deriving it from
   * `mode`.
   */
  readonly advancesOnError: boolean
  start(): void
  itemEnded(index: number): void
  itemErrored(index: number, message: string): void
  stop(): void
  getFrontIndex(): number
  getBackIndex(): number
  onTransition(fn: (e: TransitionEvent) => void): () => void
  onItemStart(fn: (index: number) => void): () => void
  onItemError(fn: (index: number, message: string) => void): () => void
}

/**
 * Pure, testable state machine over a playlist's items[]. Drives the
 * double-buffered stage via emitted events. No DOM, no fetch, no timers
 * except those provided via `deps`.
 *
 * - Multi-item: on itemEnded advance front to back, recompute back as
 *   (to+1) % items.length. Images trigger a timer internally; videos
 *   let the stage supply the ended signal.
 * - Single video: no transitions (native <video loop> handles looping).
 * - Single image: re-arms an internal timer and re-emits onItemStart(0).
 * - Empty: inert.
 */
export function createPlayerScheduler(
  items: ManifestItem[],
  deps: SchedulerDeps
): SchedulerHandle {
  const mode: SchedulerMode =
    items.length === 0
      ? 'empty'
      : items.length === 1
        ? items[0].type === 'video'
          ? 'single-video'
          : 'single-image'
        : 'loop'

  let front = 0
  let back = items.length > 1 ? 1 % items.length : 0
  let stopped = false
  let imageTimer: unknown = null

  const itemStartHandlers = new Set<(i: number) => void>()
  const transitionHandlers = new Set<(e: TransitionEvent) => void>()
  const errorHandlers = new Set<(i: number, msg: string) => void>()

  function emitItemStart(i: number): void {
    for (const fn of itemStartHandlers) fn(i)
  }
  function emitTransition(e: TransitionEvent): void {
    for (const fn of transitionHandlers) fn(e)
  }
  function emitError(i: number, msg: string): void {
    for (const fn of errorHandlers) fn(i, msg)
  }

  function clearImageTimer(): void {
    if (imageTimer !== null) {
      deps.clearTimeout(imageTimer)
      imageTimer = null
    }
  }

  function armImageTimerIfNeeded(index: number): void {
    const item = items[index]
    if (!item || item.type !== 'image') return
    const durationMs = Math.max(0, item.durationMs | 0)
    imageTimer = deps.setTimeout(() => {
      imageTimer = null
      if (stopped) return
      if (mode === 'single-image') {
        // Re-start the same item; no slot swap.
        emitItemStart(0)
        armImageTimerIfNeeded(0)
        return
      }
      // Multi-item loop: treat like the stage reporting item ended.
      advance()
    }, durationMs)
  }

  function advance(): void {
    if (stopped || mode === 'empty' || mode === 'single-video') return
    if (mode === 'single-image') {
      // Should not be reached — single-image re-arms inside the timer.
      return
    }
    clearImageTimer()
    const from = front
    const to = back
    front = to
    back = (to + 1) % items.length
    emitTransition({ from, to, nextPreload: back })
    emitItemStart(front)
    armImageTimerIfNeeded(front)
  }

  return {
    get mode() {
      return mode
    },
    get advancesOnError() {
      return mode === 'loop'
    },
    start() {
      if (stopped) return
      if (mode === 'empty') return
      emitItemStart(0)
      armImageTimerIfNeeded(0)
    },
    itemEnded(index) {
      if (stopped) return
      if (mode === 'empty' || mode === 'single-video') return
      if (mode === 'single-image') {
        // Stage shouldn't call itemEnded for single-image — timer is
        // internal. Silently ignore to keep behavior defensive.
        return
      }
      if (index !== front) return // stale
      advance()
    },
    itemErrored(index, msg) {
      if (stopped) return
      emitError(index, msg)
      if (mode === 'empty' || mode === 'single-video' || mode === 'single-image') {
        return
      }
      if (index !== front) return
      advance()
    },
    stop() {
      stopped = true
      clearImageTimer()
      itemStartHandlers.clear()
      transitionHandlers.clear()
      errorHandlers.clear()
    },
    getFrontIndex() {
      return front
    },
    getBackIndex() {
      return back
    },
    onTransition(fn) {
      transitionHandlers.add(fn)
      return () => transitionHandlers.delete(fn)
    },
    onItemStart(fn) {
      itemStartHandlers.add(fn)
      return () => itemStartHandlers.delete(fn)
    },
    onItemError(fn) {
      errorHandlers.add(fn)
      return () => errorHandlers.delete(fn)
    }
  }
}
