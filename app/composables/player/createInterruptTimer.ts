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
   * `Date.now()` when it was received. Passing `null` withdraws the schedule
   * without disturbing the done latch.
   */
  setSchedule(
    schedule: InterruptSchedule | null,
    serverNow: number | null,
    clientNow: number
  ): void
  observe(clientNow: number): InterruptState
  /**
   * Mark a window consumed. Takes the `startsAt` of the window that ACTUALLY
   * played, never the currently loaded schedule's: the server rolls
   * `nextWindow` over the instant today's window ends, so a manifest poll
   * landing in the gap between that rollover and the player's next 500 ms tick
   * publishes TOMORROW's window — and latching that on teardown would silently
   * skip tomorrow's observance on that screen. The same argument covers a
   * withdrawal mid-window (`enabled` toggled off), which leaves no schedule to
   * read a `startsAt` off at all.
   */
  markDone(startsAt: number): void
}

const INACTIVE: InterruptState = { active: false }

export function createInterruptTimer(): InterruptTimerHandle {
  let schedule: InterruptSchedule | null = null
  let offsetMs = 0
  let doneFor: number | null = null

  return {
    setSchedule(next, serverNow, clientNow) {
      if (serverNow !== null) offsetMs = serverNow - clientNow
      // `doneFor` is deliberately never cleared here. observe() compares it
      // against the CURRENT schedule's startsAt, so a latch left over from an
      // earlier window is already inert — and clearing it on "we didn't have a
      // schedule a moment ago" would reopen the exact replay this latch exists
      // to prevent: a withdrawal (a 204, or the admin toggling `enabled` off)
      // followed by a republish of the same window inside that window.
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

    markDone(startsAt) {
      doneFor = startsAt
    }
  }
}
