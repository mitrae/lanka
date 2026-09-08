// server/services/interrupt.ts
//
// The one place the scheduled interrupt's time logic lives.
//
// Why the server owns this: the box must never do timezone or DST arithmetic.
// Ukraine's DST rules have been legislatively unsettled, and an Android TV's
// tzdata is whatever its ROM shipped with. Resolving here means a Node package
// update fixes the whole fleet.
import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '../db/schema'
import { resolvePlaylistForDevice } from './resolver'

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

export interface InterruptConfig {
  mediaId: number
  mediaFilename: string
  sha256: string
  durationMs: number
  atMinutes: number
  timezone: string
  enabled: boolean
  label: string | null
}

export interface InterruptDeviceStatus {
  id: string
  name: string | null
  lastInterruptAt: number | null
  observedToday: boolean
  hasPlaylist: boolean
  lastSeenAt: number | null
}

export interface InterruptStatus {
  config: InterruptConfig | null
  window: InterruptWindow | null
  devices: InterruptDeviceStatus[]
}

export const InterruptPutSchema = z.object({
  mediaId: z.number().int().positive(),
  atMinutes: z.number().int().min(0).max(1439),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean(),
  label: z.string().max(200).nullable().optional()
})
export type InterruptPutBody = z.infer<typeof InterruptPutSchema>

async function buildStatus(
  db: BetterSQLite3Database<typeof schema>,
  nowMs: number
): Promise<InterruptStatus> {
  const row = await getInterrupt(db)
  if (!row) return { config: null, window: null, devices: [] }

  const [clip] = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.id, row.mediaId))

  // A configured interrupt whose media vanished cannot be a window. The delete
  // guard in media/[id].delete.ts should make this unreachable; treating it as
  // "no config" rather than throwing keeps the dashboard loadable if it isn't.
  if (!clip) return { config: null, window: null, devices: [] }

  const durationMs = clip.durationMs ?? 0
  const config: InterruptConfig = {
    mediaId: clip.id,
    mediaFilename: clip.filename,
    sha256: clip.sha256,
    durationMs,
    atMinutes: row.atMinutes,
    timezone: row.timezone,
    enabled: row.enabled,
    label: row.label
  }
  const window = row.enabled
    ? nextWindow(nowMs, row.atMinutes, row.timezone, durationMs)
    : null

  // Deliberately todaysWindow, NOT `window`. `window` is what the box is told to
  // wait for and rolls to tomorrow the instant today's ends — using it here
  // would make every screen read "not yet due" from 09:01 onwards, which is
  // exactly when an operator looks at this page. Before today's start there is
  // nothing to have observed yet, so todayStart stays null.
  const todays = row.enabled
    ? todaysWindow(nowMs, row.atMinutes, row.timezone, durationMs)
    : null
  const todayStart = todays && nowMs >= todays.startsAt ? todays.startsAt : null

  const deviceRows = await db
    .select({
      id: schema.devices.id,
      name: schema.devices.name,
      lastInterruptAt: schema.devices.lastInterruptAt,
      lastSeenAt: schema.devices.lastSeenAt
    })
    .from(schema.devices)
    .orderBy(asc(schema.devices.id))

  const devices: InterruptDeviceStatus[] = []
  for (const d of deviceRows) {
    const resolved = await resolvePlaylistForDevice(db, d.id)
    const reported = d.lastInterruptAt ? d.lastInterruptAt.getTime() : null
    devices.push({
      id: d.id,
      name: d.name,
      lastInterruptAt: reported,
      observedToday: todayStart !== null && reported === todayStart,
      hasPlaylist: resolved !== null,
      lastSeenAt: d.lastSeenAt ? d.lastSeenAt.getTime() : null
    })
  }

  return { config, window, devices }
}

export async function handleGetInterrupt(
  db: BetterSQLite3Database<typeof schema>,
  nowMs: number
): Promise<InterruptStatus> {
  return buildStatus(db, nowMs)
}

export async function handlePutInterrupt(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown,
  nowMs: number
): Promise<InterruptStatus> {
  const parsed = InterruptPutSchema.safeParse(rawBody)
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: parsed.error.message })
  }
  const body = parsed.data

  const [clip] = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.id, body.mediaId))
  if (!clip) {
    throw createError({ statusCode: 400, message: `Unknown media: ${body.mediaId}` })
  }
  if (clip.kind !== 'video') {
    throw createError({ statusCode: 400, message: 'The interrupt clip must be a video' })
  }

  const values = {
    id: INTERRUPT_ID,
    mediaId: body.mediaId,
    atMinutes: body.atMinutes,
    timezone: body.timezone ?? 'Europe/Kyiv',
    enabled: body.enabled,
    label: body.label ?? null,
    updatedAt: new Date()
  }
  await db
    .insert(schema.interrupts)
    .values(values)
    .onConflictDoUpdate({ target: schema.interrupts.id, set: values })

  return buildStatus(db, nowMs)
}
