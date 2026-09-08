// app/composables/player/createInterruptTimer.ts
//
// Pure decision core for the scheduled interrupt. No DOM, no fetch, no timers
// — the caller polls observe(). Mirrored 1:1 by player/InterruptTimer.kt on the
// native surface; keep the two test tables identical.
//
// Everything here exists because the box's own clock cannot be trusted and the
// network may be gone:
//  - the window arrives as an absolute epoch computed by the server, so no
//    timezone or DST logic runs here;
//  - `serverNow` gives an offset, so a TV that booted with a wrong clock still
//    fires at the right instant;
//  - a `done` latch means a backwards clock jump inside a window we already
//    played cannot replay it.

export interface InterruptSchedule {
  sha256: string
  durationMs: number
  startsAt: number
  endsAt: number
}

export type InterruptState =
  | { active: false }
  | { active: true; schedule: InterruptSchedule; offsetMs: number }

export interface InterruptTimerHandle {
  /**
   * Publish the current schedule and re-derive the clock offset.
   * `serverNow` is the server's epoch at response time; `clientNow` is
   * `Date.now()` when it was received. A schedule with a new `startsAt`
   * clears the done latch.
   */
  setSchedule(
    schedule: InterruptSchedule | null,
    serverNow: number | null,
    clientNow: number
  ): void
  observe(clientNow: number): InterruptState
  /** Mark the current window consumed. */
  markDone(): void
}

const INACTIVE: InterruptState = { active: false }

export function createInterruptTimer(): InterruptTimerHandle {
  let schedule: InterruptSchedule | null = null
  let offsetMs = 0
  let doneFor: number | null = null

  return {
    setSchedule(next, serverNow, clientNow) {
      if (serverNow !== null) offsetMs = serverNow - clientNow
      if (next === null) {
        schedule = null
        return
      }
      if (!schedule || schedule.startsAt !== next.startsAt) doneFor = null
      schedule = next
    },

    observe(clientNow) {
      if (!schedule) return INACTIVE
      if (doneFor === schedule.startsAt) return INACTIVE
      const now = clientNow + offsetMs
      if (now < schedule.startsAt) return INACTIVE
      if (now >= schedule.endsAt) return INACTIVE
      const offset = now - schedule.startsAt
      // Nothing left to play: the window outlives the clip.
      if (offset >= schedule.durationMs) return INACTIVE
      return { active: true, schedule, offsetMs: offset }
    },

    markDone() {
      if (schedule) doneFor = schedule.startsAt
    }
  }
}
