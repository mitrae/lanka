// app/utils/interruptStatus.ts
import type { InterruptConfig, InterruptDeviceStatus } from '~/app/types/api'

export type InterruptOutcome = 'observed' | 'missed' | 'notYet' | 'notScheduled'

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
  device: Pick<InterruptDeviceStatus, 'observedToday' | 'lastInterruptAt'>,
  config: Pick<InterruptConfig, 'enabled' | 'atMinutes'> | null,
  nowMinutes: number
): InterruptOutcome {
  if (device.observedToday && device.lastInterruptAt !== null) return 'observed'
  if (!config || !config.enabled) return 'notScheduled'
  return nowMinutes >= config.atMinutes ? 'missed' : 'notYet'
}
