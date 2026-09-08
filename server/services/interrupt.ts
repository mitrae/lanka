// server/services/interrupt.ts
//
// The one place the scheduled interrupt's time logic lives.
//
// Why the server owns this: the box must never do timezone or DST arithmetic.
// Ukraine's DST rules have been legislatively unsettled, and an Android TV's
// tzdata is whatever its ROM shipped with. Resolving here means a Node package
// update fixes the whole fleet.
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

/** The single row's primary key. */
export const INTERRUPT_ID = 1

export interface InterruptWindow {
  startsAt: number
  endsAt: number
}

/** Offset, in ms, that `tz` was from UTC at instant `ts`. */
function tzOffsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(ts)
  const p: Record<string, string> = {}
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value
  // Some engines render midnight as hour "24" under hour12:false.
  const hour = Number(p.hour) % 24
  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second)
  )
  return asIfUtc - ts
}

/** Epoch ms of a wall-clock local time in `tz`. */
function zonedTimeToEpoch(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string
): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const first = guess - tzOffsetMs(guess, tz)
  // One correction pass: the offset AT the candidate instant may differ from
  // the offset at the guess when the guess lands on the other side of a DST
  // boundary.
  const second = guess - tzOffsetMs(first, tz)
  return second
}

/** Local calendar date at instant `ts` in `tz`. */
function localDate(ts: number, tz: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(ts)
  const p: Record<string, string> = {}
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value
  return { y: Number(p.y ?? p.year), m: Number(p.month), d: Number(p.day) }
}

const DAY_MS = 86_400_000

/**
 * The next occurrence that has not yet ENDED.
 *
 * Returning today's window while it is still running (rather than skipping to
 * tomorrow the moment it starts) is what lets a box that booted at 09:00:35
 * join in progress instead of missing the day.
 */
export function nextWindow(
  nowMs: number,
  atMinutes: number,
  timezone: string,
  durationMs: number
): InterruptWindow | null {
  if (durationMs <= 0) return null
  const hh = Math.floor(atMinutes / 60)
  const mm = atMinutes % 60
  // Yesterday covers a window still running across local midnight; tomorrow
  // covers today's already being over. Ascending, so the first hit is the
  // earliest not-yet-ended occurrence.
  for (const dayOffset of [-1, 0, 1]) {
    const { y, m, d } = localDate(nowMs + dayOffset * DAY_MS, timezone)
    const startsAt = zonedTimeToEpoch(y, m, d, hh, mm, timezone)
    const endsAt = startsAt + durationMs
    if (nowMs < endsAt) return { startsAt, endsAt }
  }
  return null
}

/**
 * The occurrence on the local calendar date of `nowMs`, whether or not it has
 * already passed.
 *
 * Deliberately NOT nextWindow: that one rolls to tomorrow the instant today's
 * window ends, because its job is to tell a box what to wait for. The dashboard
 * needs the opposite — "which occurrence was today" — to compare each device's
 * reported observance against. Deriving the status from nextWindow would make
 * every screen read "not yet due" from 09:01 onwards.
 */
export function todaysWindow(
  nowMs: number,
  atMinutes: number,
  timezone: string,
  durationMs: number
): InterruptWindow | null {
  if (durationMs <= 0) return null
  const hh = Math.floor(atMinutes / 60)
  const mm = atMinutes % 60
  const { y, m, d } = localDate(nowMs, timezone)
  const startsAt = zonedTimeToEpoch(y, m, d, hh, mm, timezone)
  return { startsAt, endsAt: startsAt + durationMs }
}

export type InterruptRow = typeof schema.interrupts.$inferSelect

export async function getInterrupt(
  db: BetterSQLite3Database<typeof schema>
): Promise<InterruptRow | null> {
  const [row] = await db
    .select()
    .from(schema.interrupts)
    .where(eq(schema.interrupts.id, INTERRUPT_ID))
  return row ?? null
}
