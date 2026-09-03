// app/composables/player/createStallWatchdog.ts
//
// Pure stall detector for the player stage.
//
// Why this exists: an HTML5 <video> that freezes mid-clip — a decoder underrun
// on the kiosk box, a hung byte range from the CDN — fires `waiting`/`stalled`,
// never `error`. PlayerStage listened only for `error` and `ended`, so a freeze
// produced no event at all: no loop restart, no scheduler advance, not even a
// device_errors row. The frame just sat there until an operator bumped the
// playlist version. (Prod, 2026-09: a 1080p54fps clip froze ~3 min in and stayed
// frozen; see the level/VBV caps in server/services/transcode.ts for the other
// half of that fix.)
//
// The watchdog is fed periodic samples and reports a stall once media time has
// failed to advance for the applicable threshold while playback was supposed to
// be progressing. No DOM, no timers — the caller owns both, which keeps this
// testable in the plain-node vitest environment.
//
// Two thresholds, because "no progress" means different things before and
// after the first decoded frame. A cold load legitimately sits at currentTime 0
// while the moov atom and first GOP arrive; on a slow link that can exceed a
// mid-clip freeze threshold, and reloading there discards the buffered progress
// and restarts the clock — a loop that never converges. So a load that has not
// yet produced a frame gets the long `startupMs`; once it has, `playingMs`.

export interface StallSample {
  /** Wall-clock milliseconds. */
  nowMs: number
  /** The element's currentTime, in seconds. */
  currentTime: number
  /** False while the element is legitimately not advancing (paused, ended,
   *  no source, not the front slot) — those stretches never count as a stall. */
  expectPlaying: boolean
  /** Whether this load has ever decoded a frame (readyState ≥ HAVE_CURRENT_DATA).
   *  Selects the threshold; defaults to true for callers with a single one. */
  started?: boolean
}

export interface StallWatchdog {
  /** Feed one sample; true means "this looks stalled, try to recover". */
  observe(sample: StallSample): boolean
  /** Forget the window — call after a retry or a source change. */
  reset(): void
}

export interface StallThresholds {
  /** Applies until the load has produced its first frame. */
  startupMs: number
  /** Applies once playback has begun. */
  playingMs: number
}

/** Media time can drift by microseconds on a dead decoder; anything below this
 *  is noise, not progress. Well under one frame at any sane frame rate. */
const PROGRESS_EPSILON_SECS = 0.001

export const DEFAULT_STALL_THRESHOLD_MS = 6000

export function createStallWatchdog(
  thresholds: number | StallThresholds = DEFAULT_STALL_THRESHOLD_MS
): StallWatchdog {
  const t: StallThresholds =
    typeof thresholds === 'number'
      ? { startupMs: thresholds, playingMs: thresholds }
      : thresholds

  let sinceMs: number | null = null
  let atTime = 0

  function restart(sample: StallSample): void {
    sinceMs = sample.nowMs
    atTime = sample.currentTime
  }

  return {
    observe(sample) {
      if (!sample.expectPlaying) {
        sinceMs = null
        return false
      }
      if (sinceMs === null) {
        restart(sample)
        return false
      }
      // Any movement counts, including backwards: a native `loop` restart snaps
      // currentTime to ~0, which is progress, not a freeze.
      if (Math.abs(sample.currentTime - atTime) > PROGRESS_EPSILON_SECS) {
        restart(sample)
        return false
      }
      const threshold = sample.started === false ? t.startupMs : t.playingMs
      if (sample.nowMs - sinceMs >= threshold) {
        // Re-arm rather than latch, so a clip that stays frozen yields one
        // recovery attempt per threshold instead of one per sampling tick.
        restart(sample)
        return true
      }
      return false
    },
    reset() {
      sinceMs = null
    }
  }
}
