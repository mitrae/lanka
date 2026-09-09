// app/utils/interruptStatus.ts
import type { InterruptConfig, InterruptDeviceStatus } from '~/app/types/api'

export type InterruptOutcome =
  | 'observed'
  | 'missed'
  | 'inProgress'
  | 'notYet'
  | 'notScheduled'
  | 'cannotObserve'

export interface InterruptWindowLike {
  startsAt: number
  endsAt: number
}

/**
 * Today's outcome for one device, as a pure function of already-known state.
 *
 * Deliberately timezone-free: `nowMinutes` is the caller's job (read the
 * current Kyiv wall-clock minute-of-day via `Intl`, the safe instant-to-zone
 * direction) so this module never has to reason about DST at all — the
 * hazardous direction (wall-clock time -> instant) stays entirely in
 * `server/services/interrupt.ts`, per the scheduled-interrupt design.
 *
 * This boundary has been gotten wrong twice already while building this
 * feature: once server-side (caught before implementation) and once in this
 * page's own first draft, which compared against the server's *next*
 * occurrence (`window.startsAt`) instead of today's — that value rolls over
 * to tomorrow the instant today's window ends, silently relabeling every
 * missed device as "not yet due" for the rest of the day. `nowMinutes >=
 * config.atMinutes` is the same-day comparison that avoids it; pin the exact
 * boundary in tests rather than trusting continued vigilance.
 */
export function deviceInterruptOutcome(
  device: Pick<InterruptDeviceStatus, 'observedToday' | 'lastInterruptAt' | 'hasPlaylist'>,
  config: Pick<InterruptConfig, 'enabled' | 'atMinutes'> | null,
  nowMinutes: number,
  /** The server's next not-yet-ended window (`status.window`) and the epoch
   *  to judge it by. While the window is RUNNING nobody can have observed it
   *  yet — the clip is decoding its first frame and the telemetry lands a
   *  second later — so that minute is "in progress", never "missed". Epochs,
   *  not wall-clock: still no zone arithmetic here. */
  window: InterruptWindowLike | null = null,
  nowMs = 0
): InterruptOutcome {
  // observedToday is checked FIRST, deliberately: if a device somehow reports
  // an observance despite hasPlaylist being false (a stale resolver read, a
  // race with an assignment change), the truth it reported wins over our
  // inference below.
  if (device.observedToday && device.lastInterruptAt !== null) return 'observed'
  if (!config || !config.enabled) return 'notScheduled'
  // A device with no playlist gets a 204, carries no schedule, and cannot
  // observe. That is a configuration warning, never a failed observance — and
  // a permanent block of red in the badge column trains an operator to ignore
  // red on the one page whose job is to say which screen failed.
  if (!device.hasPlaylist) return 'cannotObserve'
  if (window && nowMs >= window.startsAt && nowMs < window.endsAt) return 'inProgress'
  return nowMinutes >= config.atMinutes ? 'missed' : 'notYet'
}
