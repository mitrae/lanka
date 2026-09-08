# Scheduled Interrupt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One fleet-wide daily clip that interrupts every playlist at a fixed local time (09:00 Europe/Kyiv, the minute of silence) and hands the screen back exactly where it left off.

**Architecture:** The server publishes the next occurrence as an absolute epoch in the device manifest, so no TV ever does timezone or DST arithmetic. A pure timer in the player compares a server-corrected clock against that epoch and fires locally — from a schedule it already holds, so a dead socket or a failed 09:00 poll cannot stop it. An overlay above the existing A/B slots plays the clip while the playlist scheduler is paused and the front video is left *paused, not torn down*, which resumes it frame-exact with no seek and no decoder re-prime.

**Tech Stack:** Nuxt 4 (SPA), Nitro, Drizzle + better-sqlite3, Vitest, Vue 3 `<script setup>`, Kotlin/Media3 for the native surface, Gradle JVM unit tests.

**Spec:** `docs/superpowers/specs/2026-09-07-scheduled-interrupt-design.md`

## Global Constraints

- **Decoder budget is fixed at two.** Normal playback holds a front and a back (`preload="auto"`) video decoder. The back slot MUST be emptied before the overlay is given a source. Never allow three live decoders, even for one frame.
- **The stall watchdog MUST be stopped for the whole window.** `createStallWatchdog` / `StallWatchdog` deliberately do not exempt a paused element — a paused front video is a fault they exist to recover from. Leaving sampling on reloads the page ~8 s into the observance.
- **The overlay ends on the wall clock**, not on the video's `ended` event. Whatever the clip is doing at `endsAt`, the playlist resumes.
- **No audio, ever.** The overlay `<video>` is `muted`; the native overlay player is `volume = 0f`. Do not add an audio path.
- **Kotlin has no `suspend` function name** (`suspend` is a modifier keyword). Both sides therefore use **`pause()` / `resume()`** on the scheduler, not `suspend()`/`resume()` as written in the spec prose.
- **i18n parity is enforced.** Every key added to `i18n/locales/en.json` must land in `i18n/locales/uk.json`; `tests/i18n/plurals.test.ts` fails otherwise. `uk` plurals are `one | few | many` with **no zero slot**; `en` is `zero | singular | plural`.
- **Timezone default is `Europe/Kyiv`**, stored explicitly in the row, never inferred from the box or the server host.
- **Tests are the gate, not typecheck.** `pnpm test` and `pnpm build` must pass. `pnpm typecheck` has ~381 pre-existing errors and is not a gate.
- **Nitro auto-imports:** tests call `handleXxx` functions directly. Any new auto-import used by a server file that tests import must be stubbed in `tests/helpers/nuxt-stubs.ts`.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `server/services/interrupt.ts` | The one place time logic lives: `nextWindow` (pure) + row read/write |
| `server/api/interrupt.get.ts` | Config + today's window + per-device observance status |
| `server/api/interrupt.put.ts` | Update config, kick every device's SSE |
| `app/composables/player/createInterruptTimer.ts` | Pure fire decision: corrected clock, join offset, fired latch |
| `app/composables/player/fetchBlobUrl.ts` | Shared same-origin blob fallback (extracted from `PlayerStage`) |
| `app/components/player/InterruptOverlay.vue` | The fullscreen muted `<video>` on black |
| `app/pages/schedule.vue` | Dashboard: configuration + observance status |
| `android/…/player/InterruptTimer.kt` | 1:1 Kotlin port of `createInterruptTimer` |
| `tests/services/interrupt.test.ts`, `tests/api/interrupt.test.ts`, `tests/player/createInterruptTimer.test.ts` | |
| `android/…/src/test/kotlin/…/player/InterruptTimerTest.kt` | |

**Modified**

| Path | Change |
|---|---|
| `server/db/schema.ts` | `interrupts` table; `devices.lastInterruptAt` |
| `server/db/migrations/0017_*.sql` | generated |
| `server/api/devices/[id]/manifest.get.ts` | `serverNow` + `interrupt` fields |
| `server/api/devices/[id]/telemetry.post.ts` | accept + store `interruptAt` |
| `server/api/media/[id].delete.ts` | 409 guard; `force` disables the interrupt in-transaction |
| `app/composables/player/createPlayerScheduler.ts` | `pause()` / `resume()` |
| `app/composables/player/useReconciler.ts` | `onClock` channel; interrupt pre-download + eviction keep |
| `app/composables/player/usePlayerBoot.ts` | interrupt state machine + wiring |
| `app/composables/player/useTelemetry.ts` | `interruptStarted` |
| `app/components/player/PlayerStage.vue` | `suspended` prop, `stood-down` emit, watchdog gate |
| `app/pages/player.vue` | render the overlay, pass `suspended` |
| `app/composables/useApiClient.ts`, `app/types/api.ts` | interrupt endpoints + types |
| `app/components/AppNav.vue`, `i18n/locales/{en,uk}.json` | nav + strings |
| `android/…/player/{Manifest,Scheduler,ManifestClient,TelemetryClient,PlaybackView}.kt`, `NativeSurface.kt`, `res/layout/activity_player.xml` | native port |
| `android/version.properties`, `CLAUDE.md` | release + docs |

---

### Task 1: Schema, migration, and `nextWindow`

**Files:**
- Modify: `server/db/schema.ts`
- Create: `server/services/interrupt.ts`
- Create: `tests/services/interrupt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `schema.interrupts` — columns `id`, `mediaId`, `atMinutes`, `timezone`, `enabled`, `label`, `updatedAt`
  - `schema.devices.lastInterruptAt` — `integer('last_interrupt_at', { mode: 'timestamp_ms' })`, nullable
  - `export const INTERRUPT_ID = 1`
  - `export interface InterruptWindow { startsAt: number; endsAt: number }`
  - `export function nextWindow(nowMs: number, atMinutes: number, timezone: string, durationMs: number): InterruptWindow | null`
  - `export function todaysWindow(nowMs: number, atMinutes: number, timezone: string, durationMs: number): InterruptWindow | null`

- [ ] **Step 1: Write the failing test**

Create `tests/services/interrupt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { nextWindow, todaysWindow } from '~/server/services/interrupt'

const KYIV = 'Europe/Kyiv'
const MIN = 60_000
const AT_9AM = 9 * 60

/** Epoch ms for a wall-clock instant expressed with an explicit offset. */
const at = (iso: string) => new Date(iso).getTime()

describe('nextWindow', () => {
  it('returns today 09:00 local when now is before it', () => {
    // 2026-07-01 06:00 Kyiv (UTC+3 in summer)
    const now = at('2026-07-01T06:00:00+03:00')
    const w = nextWindow(now, AT_9AM, KYIV, MIN)
    expect(w).toEqual({
      startsAt: at('2026-07-01T09:00:00+03:00'),
      endsAt: at('2026-07-01T09:01:00+03:00')
    })
  })

  it('still returns TODAY while the window is running — this is what lets a box join in progress', () => {
    const now = at('2026-07-01T09:00:35+03:00')
    const w = nextWindow(now, AT_9AM, KYIV, MIN)
    expect(w!.startsAt).toBe(at('2026-07-01T09:00:00+03:00'))
  })

  it('rolls to tomorrow the instant the window ends', () => {
    const now = at('2026-07-01T09:01:00+03:00')
    const w = nextWindow(now, AT_9AM, KYIV, MIN)
    expect(w!.startsAt).toBe(at('2026-07-02T09:00:00+03:00'))
  })

  it('keeps 09:00 LOCAL across the spring-forward transition', () => {
    // Ukraine springs forward on the last Sunday of March (2026-03-29).
    const now = at('2026-03-28T12:00:00+02:00') // Saturday, still UTC+2
    const w = nextWindow(now, AT_9AM, KYIV, MIN)
    expect(w!.startsAt).toBe(at('2026-03-29T09:00:00+03:00')) // Sunday, now UTC+3
  })

  it('keeps 09:00 LOCAL across the fall-back transition', () => {
    // Ukraine falls back on the last Sunday of October (2026-10-25).
    const now = at('2026-10-24T12:00:00+03:00')
    const w = nextWindow(now, AT_9AM, KYIV, MIN)
    expect(w!.startsAt).toBe(at('2026-10-25T09:00:00+02:00'))
  })

  it('honours a non-zero minute', () => {
    const now = at('2026-07-01T06:00:00+03:00')
    const w = nextWindow(now, 9 * 60 + 30, KYIV, MIN)
    expect(w!.startsAt).toBe(at('2026-07-01T09:30:00+03:00'))
  })

  it('returns null for a zero or negative duration — a window with no length is not a window', () => {
    expect(nextWindow(Date.now(), AT_9AM, KYIV, 0)).toBeNull()
    expect(nextWindow(Date.now(), AT_9AM, KYIV, -1)).toBeNull()
  })
})

describe('todaysWindow', () => {
  // Distinct from nextWindow on purpose. nextWindow answers "what should the box
  // be told to wait for", so it rolls to tomorrow the moment today's ends.
  // todaysWindow answers "which occurrence was today", which is what the
  // dashboard compares each device's report against — and it must NOT roll over,
  // or from 09:01 onwards every screen would read as "not yet due".
  it('returns today\'s occurrence before it has happened', () => {
    const now = at('2026-07-01T06:00:00+03:00')
    expect(todaysWindow(now, AT_9AM, KYIV, MIN)!.startsAt).toBe(
      at('2026-07-01T09:00:00+03:00')
    )
  })

  it('returns today\'s occurrence AFTER it has ended — where nextWindow rolls over', () => {
    const now = at('2026-07-01T10:00:00+03:00')
    expect(todaysWindow(now, AT_9AM, KYIV, MIN)!.startsAt).toBe(
      at('2026-07-01T09:00:00+03:00')
    )
    expect(nextWindow(now, AT_9AM, KYIV, MIN)!.startsAt).toBe(
      at('2026-07-02T09:00:00+03:00')
    )
  })

  it('uses the LOCAL calendar date, not the server\'s', () => {
    // 23:30 UTC on 30 June is already 02:30 on 1 July in Kyiv.
    const now = at('2026-06-30T23:30:00Z')
    expect(todaysWindow(now, AT_9AM, KYIV, MIN)!.startsAt).toBe(
      at('2026-07-01T09:00:00+03:00')
    )
  })

  it('returns null for a zero duration', () => {
    expect(todaysWindow(Date.now(), AT_9AM, KYIV, 0)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/services/interrupt.test.ts`
Expected: FAIL — `Cannot find module '~/server/services/interrupt'`

- [ ] **Step 3: Add the schema**

In `server/db/schema.ts`, add to the `devices` table definition (after `commandSecretActive`):

```ts
  // The interrupt window `startsAt` this device last reported observing.
  // Absent = never observed. Compared against today's window to tell an
  // operator, at 09:05, which screens actually played the clip.
  lastInterruptAt: integer('last_interrupt_at', { mode: 'timestamp_ms' })
```

And append a new table (after `apkReleases` is fine — order is cosmetic):

```ts
/**
 * The one fleet-wide daily interrupt (Ukraine's 09:00 minute of silence).
 *
 * Exactly one row, id = INTERRUPT_ID, enforced by the service rather than the
 * schema — a second row would be silently ignored by the manifest, so the
 * constraint lives where it can produce an error.
 *
 * The window LENGTH is deliberately not stored: it comes from
 * media.duration_ms, so it can never disagree with the bytes on the box.
 */
export const interrupts = sqliteTable('interrupts', {
  id: integer('id').primaryKey(),
  mediaId: integer('media_id')
    .notNull()
    .references(() => media.id),
  // Minutes since local midnight. 540 = 09:00.
  atMinutes: integer('at_minutes').notNull(),
  // Stored explicitly, never inferred from the box or the server host.
  timezone: text('timezone').notNull().default('Europe/Kyiv'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  label: text('label'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `server/db/migrations/0017_*.sql` containing `CREATE TABLE interrupts` and `ALTER TABLE devices ADD last_interrupt_at`.

Inspect it. It must NOT rebuild the `media` table (see the FK-drift note in `CLAUDE.md`).

- [ ] **Step 5: Write `nextWindow`**

Create `server/services/interrupt.ts`:

```ts
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
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/services/interrupt.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 7: Run the full suite so the new migration is proven against every existing test**

Run: `pnpm test`
Expected: PASS. `tests/helpers/test-db.ts` runs the migration folder, so a bad migration fails everything.

- [ ] **Step 8: Commit**

```bash
git add server/db/schema.ts server/db/migrations server/services/interrupt.ts tests/services/interrupt.test.ts
git commit -m "feat(interrupt): interrupts table and the pure nextWindow occurrence calculator"
```

---

### Task 2: `GET` / `PUT /api/interrupt`

**Files:**
- Modify: `server/services/interrupt.ts`
- Create: `server/api/interrupt.get.ts`, `server/api/interrupt.put.ts`
- Create: `tests/api/interrupt.test.ts`

**Interfaces:**
- Consumes: `INTERRUPT_ID`, `getInterrupt`, `nextWindow`, `todaysWindow` (Task 1).
- Produces:
  - `handleGetInterrupt(db, nowMs): Promise<InterruptStatus>`
  - `handlePutInterrupt(db, body, nowMs): Promise<InterruptStatus>`
  - ```ts
    interface InterruptConfig {
      mediaId: number; mediaFilename: string; sha256: string
      durationMs: number; atMinutes: number; timezone: string
      enabled: boolean; label: string | null
    }
    interface InterruptDeviceStatus {
      id: string; name: string | null; lastInterruptAt: number | null
      observedToday: boolean; hasPlaylist: boolean; lastSeenAt: number | null
    }
    interface InterruptStatus {
      config: InterruptConfig | null
      window: { startsAt: number; endsAt: number } | null
      devices: InterruptDeviceStatus[]
    }
    ```

- [ ] **Step 1: Write the failing test**

Create `tests/api/interrupt.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  assign, seedAddress, seedDevice, seedGroup, seedMedia, seedPlaylist
} from '../helpers/fixtures'
import { handleGetInterrupt, handlePutInterrupt } from '~/server/services/interrupt'

const AT_9AM = 9 * 60
const at = (iso: string) => new Date(iso).getTime()

describe('interrupt config API', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('reports no config on a fresh database', async () => {
    const res = await handleGetInterrupt(db, Date.now())
    expect(res.config).toBeNull()
    expect(res.window).toBeNull()
  })

  it('stores a config and computes the next window from the media duration', async () => {
    const m = await seedMedia(db, { sha256: 'clip', kind: 'video', durationMs: 60_000 })
    const now = at('2026-07-01T06:00:00+03:00')
    const res = await handlePutInterrupt(
      db,
      { mediaId: m.id, atMinutes: AT_9AM, enabled: true, label: 'Хвилина мовчання' },
      now
    )
    expect(res.config).toMatchObject({ mediaId: m.id, atMinutes: AT_9AM, durationMs: 60_000 })
    expect(res.window).toEqual({
      startsAt: at('2026-07-01T09:00:00+03:00'),
      endsAt: at('2026-07-01T09:01:00+03:00')
    })
  })

  it('keeps exactly one row across repeated PUTs', async () => {
    const a = await seedMedia(db, { sha256: 'a', kind: 'video', durationMs: 60_000 })
    const b = await seedMedia(db, { sha256: 'b', kind: 'video', durationMs: 30_000 })
    await handlePutInterrupt(db, { mediaId: a.id, atMinutes: AT_9AM, enabled: true }, Date.now())
    const res = await handlePutInterrupt(db, { mediaId: b.id, atMinutes: 600, enabled: true }, Date.now())
    expect(res.config).toMatchObject({ mediaId: b.id, atMinutes: 600 })
    const rows = await db.select().from((await import('~/server/db/schema')).interrupts)
    expect(rows).toHaveLength(1)
  })

  it('reports no window while disabled, but keeps the config', async () => {
    const m = await seedMedia(db, { sha256: 'clip', kind: 'video', durationMs: 60_000 })
    const res = await handlePutInterrupt(
      db, { mediaId: m.id, atMinutes: AT_9AM, enabled: false }, Date.now()
    )
    expect(res.config!.enabled).toBe(false)
    expect(res.window).toBeNull()
  })

  it('rejects an image — the interrupt is a video clip', async () => {
    const img = await seedMedia(db, { sha256: 'img', kind: 'image' })
    await expect(
      handlePutInterrupt(db, { mediaId: img.id, atMinutes: AT_9AM, enabled: true }, Date.now())
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects media that does not exist', async () => {
    await expect(
      handlePutInterrupt(db, { mediaId: 999, atMinutes: AT_9AM, enabled: true }, Date.now())
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects an out-of-range time', async () => {
    const m = await seedMedia(db, { sha256: 'clip', kind: 'video', durationMs: 60_000 })
    await expect(
      handlePutInterrupt(db, { mediaId: m.id, atMinutes: 1440, enabled: true }, Date.now())
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('flags devices with no playlist — they receive a 204 and cannot observe', async () => {
    const m = await seedMedia(db, { sha256: 'clip', kind: 'video', durationMs: 60_000 })
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'assigned', groupId: grp.id })
    await seedDevice(db, { id: 'orphan', groupId: grp.id })
    const pl = await seedPlaylist(db, { name: 'P', items: [{ mediaId: m.id }] })
    await assign(db, { deviceId: 'assigned', playlistId: pl.id })

    await handlePutInterrupt(db, { mediaId: m.id, atMinutes: AT_9AM, enabled: true }, Date.now())
    const res = await handleGetInterrupt(db, Date.now())
    const byId = Object.fromEntries(res.devices.map((d) => [d.id, d]))
    expect(byId.assigned.hasPlaylist).toBe(true)
    expect(byId.orphan.hasPlaylist).toBe(false)
  })

  it('marks a device observed only when its report matches TODAY\'s window', async () => {
    const m = await seedMedia(db, { sha256: 'clip', kind: 'video', durationMs: 60_000 })
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'today', groupId: grp.id })
    await seedDevice(db, { id: 'yesterday', groupId: grp.id })
    const now = at('2026-07-01T10:00:00+03:00')
    await handlePutInterrupt(db, { mediaId: m.id, atMinutes: AT_9AM, enabled: true }, now)

    const schema = await import('~/server/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.update(schema.devices)
      .set({ lastInterruptAt: new Date(at('2026-07-01T09:00:00+03:00')) })
      .where(eq(schema.devices.id, 'today'))
    await db.update(schema.devices)
      .set({ lastInterruptAt: new Date(at('2026-06-30T09:00:00+03:00')) })
      .where(eq(schema.devices.id, 'yesterday'))

    const res = await handleGetInterrupt(db, now)
    const byId = Object.fromEntries(res.devices.map((d) => [d.id, d]))
    expect(byId.today.observedToday).toBe(true)
    expect(byId.yesterday.observedToday).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/api/interrupt.test.ts`
Expected: FAIL — `handleGetInterrupt is not exported`

- [ ] **Step 3: Implement the handlers**

Append to `server/services/interrupt.ts`:

```ts
import { z } from 'zod'
import { resolvePlaylistForDevice } from './resolver'
// NOTE: merge `asc` into the existing `import { eq } from 'drizzle-orm'` at the
// top of this file rather than adding a second import statement from it.
import { asc } from 'drizzle-orm'

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
  const body = InterruptPutSchema.parse(rawBody)

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
```

Note the `zod` error path: `InterruptPutSchema.parse` throws a `ZodError`, which the route wrapper converts to a 400 — but the *tests* call the handler directly and assert `statusCode: 400`. So convert inside the handler instead:

Replace `const body = InterruptPutSchema.parse(rawBody)` with:

```ts
  const parsed = InterruptPutSchema.safeParse(rawBody)
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: parsed.error.message })
  }
  const body = parsed.data
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/api/interrupt.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Add the routes**

Create `server/api/interrupt.get.ts`:

```ts
import { useDb } from '~/server/db/client'
import { handleGetInterrupt } from '~/server/services/interrupt'

export default defineEventHandler(async () => handleGetInterrupt(useDb(), Date.now()))
```

Create `server/api/interrupt.put.ts`:

```ts
import { useDb } from '~/server/db/client'
import * as schema from '~/server/db/schema'
import { useEventsHub } from '~/server/services/events'
import { handlePutInterrupt } from '~/server/services/interrupt'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const db = useDb()
  const status = await handlePutInterrupt(db, body, Date.now())

  // Kick every device so a change lands without waiting out the 30 s poll.
  // The interrupt rides the manifest, so `manifest-changed` is the right event
  // even though no playlist version moved.
  const hub = useEventsHub()
  const devices = await db.select({ id: schema.devices.id }).from(schema.devices)
  for (const d of devices) hub.emitDevice(d.id, 'manifest-changed', null)

  return status
})
```

`/api/interrupt` is not in `isPublicRoute`, so the global auth middleware already restricts it to `admin`/`super` — no extra guard needed. Confirm by reading `server/services/auth-guard.ts#decideAccess`.

- [ ] **Step 6: Verify the route files compile into a build**

Run: `pnpm build`
Expected: build succeeds; `/api/interrupt` appears in the Nitro route list.

- [ ] **Step 7: Commit**

```bash
git add server/services/interrupt.ts server/api/interrupt.get.ts server/api/interrupt.put.ts tests/api/interrupt.test.ts
git commit -m "feat(interrupt): GET/PUT /api/interrupt with per-device observance status"
```

---

### Task 3: Publish the window in the device manifest

**Files:**
- Modify: `server/api/devices/[id]/manifest.get.ts`
- Modify: `tests/api/devices-manifest.test.ts`

**Interfaces:**
- Consumes: `getInterrupt`, `nextWindow` (Task 1).
- Produces: `Manifest.serverNow?: number`, `Manifest.interrupt?: ManifestInterrupt`, and
  ```ts
  export type ManifestInterrupt = {
    mediaId: number; sha256: string; durationMs: number
    startsAt: number; endsAt: number
  }
  ```

- [ ] **Step 1: Write the failing test**

Append to `tests/api/devices-manifest.test.ts`, inside the existing `describe`:

```ts
  it('carries serverNow and the next interrupt window', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const v = await seedMedia(db, { sha256: 'aaa', kind: 'video', durationMs: 15000 })
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    const pl = await seedPlaylist(db, { name: 'P', items: [{ mediaId: v.id }] })
    await assign(db, { deviceId: 'dev-1', playlistId: pl.id })
    await db.insert(schema.interrupts).values({
      id: 1, mediaId: clip.id, atMinutes: 9 * 60, timezone: 'Europe/Kyiv', enabled: true
    })

    const now = new Date('2026-07-01T06:00:00+03:00').getTime()
    const result = await handleManifest(db, 'dev-1', now)

    expect(result!.serverNow).toBe(now)
    expect(result!.interrupt).toEqual({
      mediaId: clip.id,
      sha256: 'silence',
      durationMs: 60000,
      startsAt: new Date('2026-07-01T09:00:00+03:00').getTime(),
      endsAt: new Date('2026-07-01T09:01:00+03:00').getTime()
    })
  })

  it('omits the interrupt when it is disabled, but still sends serverNow', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const v = await seedMedia(db, { sha256: 'aaa', kind: 'video', durationMs: 15000 })
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    const pl = await seedPlaylist(db, { name: 'P', items: [{ mediaId: v.id }] })
    await assign(db, { deviceId: 'dev-1', playlistId: pl.id })
    await db.insert(schema.interrupts).values({
      id: 1, mediaId: clip.id, atMinutes: 9 * 60, timezone: 'Europe/Kyiv', enabled: false
    })

    const result = await handleManifest(db, 'dev-1', Date.now())
    expect(result!.interrupt).toBeUndefined()
    expect(typeof result!.serverNow).toBe('number')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/api/devices-manifest.test.ts`
Expected: FAIL — `handleManifest` takes 2 arguments; `serverNow` undefined.

- [ ] **Step 3: Implement**

In `server/api/devices/[id]/manifest.get.ts`:

Add the import and types:

```ts
import { getInterrupt, nextWindow } from '~/server/services/interrupt'

export type ManifestInterrupt = {
  mediaId: number
  sha256: string
  durationMs: number
  startsAt: number
  endsAt: number
}
```

Extend the `Manifest` type:

```ts
  /** Server clock at response time. The player derives an offset from it, so a
   *  TV that boots with a wrong system clock still fires at the right moment. */
  serverNow?: number
  /** The next interrupt occurrence that has not yet ended. Absent when none is
   *  configured or it is disabled. */
  interrupt?: ManifestInterrupt
```

Change the signature and the return:

```ts
export async function handleManifest(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string,
  nowMs: number = Date.now()
): Promise<Manifest | null> {
```

…and just before `return {`:

```ts
  const interruptRow = await getInterrupt(db)
  let interrupt: ManifestInterrupt | undefined
  if (interruptRow?.enabled) {
    const [clip] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, interruptRow.mediaId))
    const durationMs = clip?.durationMs ?? 0
    const w = clip
      ? nextWindow(nowMs, interruptRow.atMinutes, interruptRow.timezone, durationMs)
      : null
    if (clip && w) {
      interrupt = {
        mediaId: clip.id,
        sha256: clip.sha256,
        durationMs,
        startsAt: w.startsAt,
        endsAt: w.endsAt
      }
    }
  }
```

Add both fields to the returned object:

```ts
    serverNow: nowMs,
    ...(interrupt ? { interrupt } : {}),
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/api/devices-manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/api/devices/\[id\]/manifest.get.ts tests/api/devices-manifest.test.ts
git commit -m "feat(interrupt): publish serverNow and the next window in the device manifest"
```

---

### Task 4: Protect the clip from deletion

**Files:**
- Modify: `server/api/media/[id].delete.ts`
- Create: `tests/api/media-delete-interrupt.test.ts`

**Interfaces:**
- Consumes: `schema.interrupts`, `INTERRUPT_ID`.
- Produces: nothing new; changes `handleDeleteMedia` behaviour only.

- [ ] **Step 1: Write the failing test**

Create `tests/api/media-delete-interrupt.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia } from '../helpers/fixtures'
import { handleDeleteMedia } from '~/server/api/media/[id].delete'
import * as schema from '~/server/db/schema'

const noopStore = {
  put: async () => {},
  open: async () => { throw new Error('unused') },
  openThumbnail: async () => { throw new Error('unused') },
  putThumbnail: async () => {},
  delete: async () => {},
  deleteThumbnail: async () => {},
  exists: async () => false
} as any

describe('deleting the interrupt clip', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  async function configure(mediaId: number) {
    await db.insert(schema.interrupts).values({
      id: 1, mediaId, atMinutes: 540, timezone: 'Europe/Kyiv', enabled: true
    })
  }

  it('409s rather than leaving a schedule that silently never plays', async () => {
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    await configure(clip.id)
    await expect(
      handleDeleteMedia(db, noopStore, clip.id, { force: false })
    ).rejects.toMatchObject({ statusCode: 409 })
    const still = await db.select().from(schema.media).where(eq(schema.media.id, clip.id))
    expect(still).toHaveLength(1)
  })

  it('force disables the interrupt in the same transaction', async () => {
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    await configure(clip.id)
    await handleDeleteMedia(db, noopStore, clip.id, { force: true })

    const media = await db.select().from(schema.media).where(eq(schema.media.id, clip.id))
    expect(media).toHaveLength(0)
    const rows = await db.select().from(schema.interrupts)
    expect(rows).toHaveLength(0)
  })

  it('leaves unrelated media alone', async () => {
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    const other = await seedMedia(db, { sha256: 'other', kind: 'video', durationMs: 5000 })
    await configure(clip.id)
    await handleDeleteMedia(db, noopStore, other.id, { force: false })
    const rows = await db.select().from(schema.interrupts)
    expect(rows).toHaveLength(1)
  })
})
```

Note: the interrupt row is **deleted**, not flag-flipped — a row whose `media_id` FK no longer resolves is not a valid disabled config, and `handleGetInterrupt` already treats a missing clip as "no config".

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/api/media-delete-interrupt.test.ts`
Expected: FAIL — the delete succeeds without a 409 (or fails on the FK).

- [ ] **Step 3: Implement**

In `server/api/media/[id].delete.ts`, after the `referencingItems` 409 check, add:

```ts
  const interruptRows = await db
    .select({ id: schema.interrupts.id })
    .from(schema.interrupts)
    .where(eq(schema.interrupts.mediaId, id))

  if (interruptRows.length > 0 && !opts.force) {
    throw createError({
      statusCode: 409,
      message:
        `Media ${id} is the scheduled interrupt clip. Deleting it would leave a ` +
        `schedule that silently never plays. Pass force=true to delete it and ` +
        `clear the schedule.`
    })
  }
```

And inside the existing `db.transaction((tx) => { … })`, immediately before `tx.delete(schema.media)…`:

```ts
    if (interruptRows.length > 0) {
      // Same transaction as the media delete: a configured interrupt must never
      // outlive its clip, not even for the width of a failed statement.
      tx.delete(schema.interrupts).where(eq(schema.interrupts.mediaId, id)).run()
    }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/api/media-delete-interrupt.test.ts tests/api/media-force-delete.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/api/media/\[id\].delete.ts tests/api/media-delete-interrupt.test.ts
git commit -m "feat(interrupt): refuse to delete the interrupt clip out from under its schedule"
```

---

### Task 5: Record the observance (`interruptAt` telemetry)

**Files:**
- Modify: `server/api/devices/[id]/telemetry.post.ts`
- Modify: `tests/api/devices-telemetry.test.ts`

**Interfaces:**
- Consumes: `schema.devices.lastInterruptAt` (Task 1).
- Produces: `TelemetryBody.interruptAt?: number` → writes `devices.lastInterruptAt`.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/devices-telemetry.test.ts`:

```ts
  it('records interruptAt without touching the current item or play counts', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const m = await seedMedia(db, { sha256: 'aaa', kind: 'video', durationMs: 1000 })
    const pl = await seedPlaylist(db, { name: 'P', items: [{ mediaId: m.id }] })
    const [item] = await db.select().from(schema.playlistItems)

    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    const startsAt = new Date('2026-07-01T09:00:00+03:00').getTime()
    await handleTelemetry(db, 'dev-1', { interruptAt: startsAt })

    const [dev] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-1'))
    expect(dev.lastInterruptAt?.getTime()).toBe(startsAt)
    // The playlist item survives: an interrupt is not a playlist play.
    expect(dev.currentItemId).toBe(item.id)
    const [media] = await db.select().from(schema.media).where(eq(schema.media.id, m.id))
    expect(media.playCount).toBe(1)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/api/devices-telemetry.test.ts`
Expected: FAIL — `lastInterruptAt` is null (the field is stripped by the zod schema).

- [ ] **Step 3: Implement**

In `server/api/devices/[id]/telemetry.post.ts`, add to `BodySchema`:

```ts
  // The `startsAt` of the interrupt window the player just began showing.
  // Deliberately separate from currentItemId: the interrupt is not a playlist
  // item and must not touch the current item or media.play_count.
  interruptAt: z.number().int().positive().optional(),
```

And in the `.set({ … })` object of the devices update, alongside the other spreads:

```ts
      ...(body.interruptAt !== undefined
        ? { lastInterruptAt: new Date(body.interruptAt) }
        : {}),
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/api/devices-telemetry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/api/devices/\[id\]/telemetry.post.ts tests/api/devices-telemetry.test.ts
git commit -m "feat(interrupt): accept interruptAt telemetry as proof of observance"
```

---

### Task 6: `createInterruptTimer` — the fire decision

**Files:**
- Create: `app/composables/player/createInterruptTimer.ts`
- Create: `tests/player/createInterruptTimer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface InterruptSchedule {
    sha256: string; durationMs: number; startsAt: number; endsAt: number
  }
  export type InterruptState =
    | { active: false }
    | { active: true; schedule: InterruptSchedule; offsetMs: number }
  export interface InterruptTimerHandle {
    setSchedule(schedule: InterruptSchedule | null, serverNow: number | null, clientNow: number): void
    observe(clientNow: number): InterruptState
    markDone(): void
  }
  export function createInterruptTimer(): InterruptTimerHandle
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/player/createInterruptTimer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createInterruptTimer, type InterruptSchedule } from '~/app/composables/player/createInterruptTimer'

const START = 1_800_000_000_000
const sched: InterruptSchedule = {
  sha256: 'silence',
  durationMs: 60_000,
  startsAt: START,
  endsAt: START + 60_000
}

describe('createInterruptTimer', () => {
  it('is inactive with no schedule', () => {
    const t = createInterruptTimer()
    expect(t.observe(START).active).toBe(false)
  })

  it('is inactive before the window', () => {
    const t = createInterruptTimer()
    t.setSchedule(sched, START - 10_000, START - 10_000)
    expect(t.observe(START - 1).active).toBe(false)
  })

  it('activates at startsAt with a zero offset', () => {
    const t = createInterruptTimer()
    t.setSchedule(sched, START - 10_000, START - 10_000)
    const s = t.observe(START)
    expect(s).toEqual({ active: true, schedule: sched, offsetMs: 0 })
  })

  it('joins in progress with the elapsed offset', () => {
    const t = createInterruptTimer()
    t.setSchedule(sched, START + 35_000, START + 35_000)
    const s = t.observe(START + 35_000)
    expect(s.active && s.offsetMs).toBe(35_000)
  })

  it('goes inactive at endsAt', () => {
    const t = createInterruptTimer()
    t.setSchedule(sched, START, START)
    expect(t.observe(START + 59_999).active).toBe(true)
    expect(t.observe(START + 60_000).active).toBe(false)
  })

  it('corrects a wrong client clock from serverNow', () => {
    const t = createInterruptTimer()
    // The TV's clock is an hour behind the server's.
    const clientNow = START - 3_600_000 - 10_000
    t.setSchedule(sched, START - 10_000, clientNow)
    expect(t.observe(clientNow).active).toBe(false)
    expect(t.observe(clientNow + 10_000).active).toBe(true)
  })

  it('refuses to start when the join offset already exceeds the clip duration', () => {
    const t = createInterruptTimer()
    // A window declared longer than its clip: nothing left to show.
    const short: InterruptSchedule = { ...sched, durationMs: 10_000 }
    t.setSchedule(short, START + 20_000, START + 20_000)
    expect(t.observe(START + 20_000).active).toBe(false)
  })

  it('does not replay a window already marked done, even if the clock jumps backwards', () => {
    const t = createInterruptTimer()
    t.setSchedule(sched, START + 30_000, START + 30_000)
    expect(t.observe(START + 30_000).active).toBe(true)
    t.markDone()
    expect(t.observe(START + 30_000).active).toBe(false)
    expect(t.observe(START + 1_000).active).toBe(false)
  })

  it('clears the done latch when a NEW window arrives', () => {
    const t = createInterruptTimer()
    t.setSchedule(sched, START, START)
    t.markDone()
    const tomorrow: InterruptSchedule = {
      ...sched,
      startsAt: START + 86_400_000,
      endsAt: START + 86_400_000 + 60_000
    }
    t.setSchedule(tomorrow, START + 86_400_000, START + 86_400_000)
    expect(t.observe(START + 86_400_000).active).toBe(true)
  })

  it('keeps the latch when the SAME window is re-published by a later poll', () => {
    const t = createInterruptTimer()
    t.setSchedule(sched, START, START)
    t.markDone()
    t.setSchedule(sched, START + 5_000, START + 5_000)
    expect(t.observe(START + 5_000).active).toBe(false)
  })

  it('keeps the latch across a WITHDRAWAL and republish of the same window', () => {
    // The reachable replay path: a device 204s (unassigned), or an admin
    // toggles `enabled` off and on again, inside a window that already played.
    // The server recomputes the interrupt deterministically, so the republished
    // window has the identical startsAt — and must not fire a second time.
    const t = createInterruptTimer()
    t.setSchedule(sched, START, START)
    t.markDone()
    t.setSchedule(null, null, START + 5_000)
    t.setSchedule(sched, START + 10_000, START + 10_000)
    expect(t.observe(START + 10_000).active).toBe(false)
  })

  it('stops at endsAt even when the clip is LONGER than the window', () => {
    // Discriminating for the endsAt cutoff specifically: with durationMs equal
    // to the window length, the duration guard masks the endsAt guard, so
    // neither test proves the other.
    const t = createInterruptTimer()
    const longClip: InterruptSchedule = { ...sched, durationMs: 600_000 }
    t.setSchedule(longClip, START, START)
    expect(t.observe(START + 59_999).active).toBe(true)
    expect(t.observe(START + 60_000).active).toBe(false)
  })

  it('keeps a previously derived offset when serverNow is null', () => {
    const t = createInterruptTimer()
    const clientNow = START - 3_600_000
    t.setSchedule(sched, START, clientNow) // offset = +1h
    t.setSchedule(sched, null, clientNow)  // no clock sample: keep the offset
    expect(t.observe(clientNow).active).toBe(true)
  })

  it('goes inactive when the schedule is withdrawn', () => {
    const t = createInterruptTimer()
    t.setSchedule(sched, START, START)
    expect(t.observe(START).active).toBe(true)
    t.setSchedule(null, null, START)
    expect(t.observe(START).active).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/player/createInterruptTimer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `app/composables/player/createInterruptTimer.ts`:

```ts
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

    markDone() {
      if (schedule) doneFor = schedule.startsAt
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/player/createInterruptTimer.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add app/composables/player/createInterruptTimer.ts tests/player/createInterruptTimer.test.ts
git commit -m "feat(player): pure interrupt timer — corrected clock, join offset, replay latch"
```

---

### Task 7: `pause()` / `resume()` on the playlist scheduler

**Files:**
- Modify: `app/composables/player/createPlayerScheduler.ts`
- Modify: `tests/player/createPlayerScheduler.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SchedulerHandle.pause(): void`, `SchedulerHandle.resume(): void`.

- [ ] **Step 1: Write the failing test**

Append to `tests/player/createPlayerScheduler.test.ts`. Match the existing file's fake-clock helper; if it does not have one, use this self-contained harness:

```ts
describe('pause/resume', () => {
  function harness(items: any[]) {
    let now = 0
    const timers: { id: number; at: number; cb: () => void }[] = []
    let nextId = 1
    const deps = {
      now: () => now,
      setTimeout: (cb: () => void, ms: number) => {
        const id = nextId++
        timers.push({ id, at: now + ms, cb })
        return id
      },
      clearTimeout: (h: unknown) => {
        const i = timers.findIndex((t) => t.id === h)
        if (i >= 0) timers.splice(i, 1)
      }
    }
    const advance = (ms: number) => {
      now += ms
      for (const t of [...timers]) {
        if (t.at <= now) {
          const i = timers.indexOf(t)
          if (i >= 0) timers.splice(i, 1)
          t.cb()
        }
      }
    }
    return { deps, advance, get pending() { return timers.length } }
  }

  const twoImages = [
    { id: 1, type: 'image', sha256: 'a', durationMs: 10_000 },
    { id: 2, type: 'image', sha256: 'b', durationMs: 10_000 }
  ]

  it('does not advance while paused', () => {
    const h = harness(twoImages)
    const s = createPlayerScheduler(twoImages as any, h.deps)
    const transitions: number[] = []
    s.onTransition((e) => transitions.push(e.to))
    s.start()

    h.advance(4_000)
    s.pause()
    h.advance(60_000) // a whole interrupt window, and then some
    expect(transitions).toEqual([])
    expect(s.getFrontIndex()).toBe(0)
  })

  it('resumes with the REMAINING time, not a fresh full duration', () => {
    const h = harness(twoImages)
    const s = createPlayerScheduler(twoImages as any, h.deps)
    const transitions: number[] = []
    s.onTransition((e) => transitions.push(e.to))
    s.start()

    h.advance(4_000)
    s.pause()
    h.advance(60_000)
    s.resume()

    h.advance(5_999)
    expect(transitions).toEqual([]) // 6 s remained
    h.advance(1)
    expect(transitions).toEqual([1])
  })

  it('is idempotent in both directions', () => {
    const h = harness(twoImages)
    const s = createPlayerScheduler(twoImages as any, h.deps)
    s.start()
    h.advance(4_000)
    s.pause()
    s.pause()
    s.resume()
    s.resume()
    h.advance(6_000)
    expect(s.getFrontIndex()).toBe(1)
  })

  it('resume is a no-op when nothing was paused', () => {
    const h = harness(twoImages)
    const s = createPlayerScheduler(twoImages as any, h.deps)
    s.start()
    s.resume()
    h.advance(10_000)
    expect(s.getFrontIndex()).toBe(1)
  })

  it('stop() while paused leaves no timer behind', () => {
    const h = harness(twoImages)
    const s = createPlayerScheduler(twoImages as any, h.deps)
    s.start()
    s.pause()
    s.stop()
    s.resume()
    h.advance(60_000)
    expect(h.pending).toBe(0)
  })

  it('does not advance on itemEnded while paused', () => {
    const h = harness(twoImages)
    const s = createPlayerScheduler(twoImages as any, h.deps)
    const transitions: number[] = []
    s.onTransition((e) => transitions.push(e.to))
    s.start()
    s.pause()
    s.itemEnded(0)
    expect(transitions).toEqual([])
    expect(s.getFrontIndex()).toBe(0)
  })

  it('still REPORTS itemErrored while paused, but does not advance', () => {
    // A decoder that dies mid-observance must reach device_errors; what it must
    // not do is move the front index out from under the element the stage is
    // about to resume.
    const h = harness(twoImages)
    const s = createPlayerScheduler(twoImages as any, h.deps)
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
    const h = harness(twoImages)
    const s = createPlayerScheduler(twoImages as any, h.deps)
    s.start()
    h.advance(4_000)
    s.pause()
    s.itemEnded(0) // dropped
    s.resume()
    expect(h.pending).toBe(1)
  })

  it('single-video mode has no timer to pause and survives both calls', () => {
    const one = [{ id: 1, type: 'video', sha256: 'v', durationMs: 5_000 }]
    const h = harness(one)
    const s = createPlayerScheduler(one as any, h.deps)
    s.start()
    s.pause()
    s.resume()
    expect(s.mode).toBe('single-video')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/player/createPlayerScheduler.test.ts`
Expected: FAIL — `s.pause is not a function`

- [ ] **Step 3: Implement**

In `app/composables/player/createPlayerScheduler.ts`:

Add to the `SchedulerHandle` interface, after `stop()`:

```ts
  /**
   * Freeze the playlist for a scheduled interrupt: cancel the image slide
   * timer, remembering how much of it was left. No transitions, no item starts.
   * Idempotent.
   *
   * While paused the scheduler REFUSES to advance. `itemEnded` is dropped and
   * `itemErrored` still reports but does not move the front index — see the
   * guards in those methods for why.
   */
  pause(): void
  /** Re-arm the slide timer with its REMAINING time. Idempotent. */
  resume(): void
```

**Guard the advancing paths against a paused scheduler.** `pause()` promises
"no transitions", but nothing enforces it: the stage keeps feeding events during
the interrupt, and the front video — paused, not torn down — can still fire
`error` when its decoder dies, which is a documented Amlogic failure. An
`ended` can also race the pause boundary.

If `advance()` runs while paused the damage is not merely a leaked timer: the
scheduler's front index moves while the visible element is still the old,
paused item, so `standUp()` restores the back slot from the new index and calls
`play()` on the wrong element — a broken screen once the observance ends.

In `itemEnded`, change the first line to:

```ts
    itemEnded(index) {
      // Dropped while paused: advancing here would desync the front index from
      // the element the stage is about to resume.
      if (stopped || paused) return
```

In `itemErrored`, keep the report but refuse the advance — a failure during the
observance must still reach `device_errors`:

```ts
    itemErrored(index, msg) {
      if (stopped) return
      emitError(index, msg)
      // Report, never advance: same desync hazard as itemEnded.
      if (paused) return
```

`noteError` needs no guard — it only emits and never advances.

Also guard `start()`, and make `armImageTimer` defensive about an existing
handle. Overwriting `imageTimer` without clearing leaks the old handle, which
is a latent bug independent of pausing:

```ts
    start() {
      if (stopped || paused) return
      if (mode === 'empty') return
```

```ts
  function armImageTimer(index: number, ms: number): void {
    clearImageTimer() // never overwrite a live handle — that leaks it
    imageTimerIndex = index
```

Replace the timer state and `armImageTimerIfNeeded` with:

```ts
  let imageTimer: unknown = null
  let imageTimerIndex = -1
  let imageTimerArmedAt = 0
  let imageTimerMs = 0
  let paused = false
  let pausedRemainingMs: number | null = null

  function clearImageTimer(): void {
    if (imageTimer !== null) {
      deps.clearTimeout(imageTimer)
      imageTimer = null
    }
  }

  function armImageTimerIfNeeded(index: number): void {
    const item = items[index]
    if (!item || item.type !== 'image') return
    armImageTimer(index, Math.max(0, item.durationMs | 0))
  }

  function armImageTimer(index: number, ms: number): void {
    imageTimerIndex = index
    imageTimerArmedAt = deps.now()
    imageTimerMs = ms
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
    }, ms)
  }
```

(The body of the timer callback is unchanged from the original — only the arming is factored out so `resume()` can arm a partial one.)

Add to the returned object, after `stop()`:

```ts
    pause() {
      if (stopped || paused) return
      paused = true
      if (imageTimer === null) {
        pausedRemainingMs = null
        return
      }
      const elapsed = deps.now() - imageTimerArmedAt
      pausedRemainingMs = Math.max(0, imageTimerMs - elapsed)
      clearImageTimer()
    },
    resume() {
      if (stopped || !paused) return
      paused = false
      if (pausedRemainingMs === null) return
      const index = imageTimerIndex
      const remaining = pausedRemainingMs
      pausedRemainingMs = null
      armImageTimer(index, remaining)
    },
```

And in `stop()`, clear the paused state so a `resume()` after `stop()` cannot arm anything:

```ts
    stop() {
      stopped = true
      paused = false
      pausedRemainingMs = null
      clearImageTimer()
      itemStartHandlers.clear()
      transitionHandlers.clear()
      errorHandlers.clear()
    },
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/player/createPlayerScheduler.test.ts`
Expected: PASS (existing tests + 6 new)

- [ ] **Step 5: Commit**

```bash
git add app/composables/player/createPlayerScheduler.ts tests/player/createPlayerScheduler.test.ts
git commit -m "feat(player): scheduler pause/resume that preserves the remaining slide time"
```

---

### Task 8: The reconciler's clock channel

**Files:**
- Modify: `app/composables/player/useReconciler.ts`
- Modify: `app/types/api.ts`
- Modify: `tests/player/useReconciler.test.ts`

**Interfaces:**
- Consumes: `Manifest.serverNow` / `Manifest.interrupt` (Task 3), `InterruptSchedule` (Task 6).
- Produces:
  ```ts
  export interface ClockSample {
    serverNow: number | null
    interrupt: InterruptSchedule | null
  }
  // on ReconcilerHandle:
  onClock(fn: (c: ClockSample) => void): () => void
  ```

- [ ] **Step 1: Add the mirrored types**

In `app/types/api.ts`, extend the `Manifest` interface (find it; it mirrors the server type) with:

```ts
  /** Server clock at response time; the player derives its offset from it. */
  serverNow?: number
  /** Next interrupt occurrence that has not yet ended. */
  interrupt?: {
    mediaId: number
    sha256: string
    durationMs: number
    startsAt: number
    endsAt: number
  }
```

- [ ] **Step 2: Write the failing test**

Append to `tests/player/useReconciler.test.ts` (reuse the file's existing fake-api helper; the shape below assumes `createReconciler({ api, deviceId })` with an `api.getManifest` stub, matching the existing tests):

```ts
describe('clock channel', () => {
  const base = {
    playlistId: 1,
    playlistName: 'P',
    version: 1,
    items: [{ id: 1, type: 'video', sha256: 'a', durationMs: 1000 }]
  }
  // What the server sends on the manifest…
  const interrupt = {
    mediaId: 9, sha256: 'silence', durationMs: 60_000,
    startsAt: 1_800_000_000_000, endsAt: 1_800_000_060_000
  }
  // …and what the clock channel emits. `mediaId` is deliberately dropped: the
  // player addresses media by sha256 and never needs the row id, so
  // InterruptSchedule stays the narrow thing createInterruptTimer consumes.
  const schedule = {
    sha256: 'silence', durationMs: 60_000,
    startsAt: 1_800_000_000_000, endsAt: 1_800_000_060_000
  }

  it('emits on EVERY successful fetch, even when the manifest key is unchanged', async () => {
    const api = { getManifest: async () => ({ ...base, serverNow: 123, interrupt }) } as any
    const r = createReconciler({ api, deviceId: 'd1' })
    const clocks: any[] = []
    const manifests: any[] = []
    r.onClock((c) => clocks.push(c))
    r.onManifest((m) => manifests.push(m))

    await r.reconcile()
    await r.reconcile()
    await r.reconcile()

    expect(clocks).toHaveLength(3)
    expect(clocks[2]).toEqual({ serverNow: 123, interrupt: schedule })
    // The stage must NOT be remounted by an unchanged manifest.
    expect(manifests).toHaveLength(1)
  })

  it('clears the schedule on a 204 — an unassigned device does not observe', async () => {
    let manifest: any = { ...base, serverNow: 1, interrupt }
    const api = { getManifest: async () => manifest } as any
    const r = createReconciler({ api, deviceId: 'd1' })
    const clocks: any[] = []
    r.onClock((c) => clocks.push(c))

    await r.reconcile()
    manifest = null
    await r.reconcile()

    expect(clocks[1]).toEqual({ serverNow: null, interrupt: null })
  })

  it('pre-downloads the interrupt clip and keeps it through an eviction', async () => {
    const cached = new Set<string>()
    const downloaded: string[] = []
    let keptJson = ''
    const nativeFS = {
      exists: (s: string) => cached.has(s),
      download: (s: string) => { cached.add(s); downloaded.push(s); return true },
      evictExcept: (json: string) => { keptJson = json }
    } as any
    const api = { getManifest: async () => ({ ...base, serverNow: 1, interrupt }) } as any
    const r = createReconciler({
      api, deviceId: 'd1', nativeFS, cdnUrl: (s: string) => `/media/${s}`
    })

    await r.reconcile()

    expect(downloaded).toContain('silence')
    expect(JSON.parse(keptJson)).toContain('silence')
  })

  it('does not re-download an interrupt clip that is already cached', async () => {
    const downloaded: string[] = []
    const nativeFS = {
      exists: () => true,
      download: (s: string) => { downloaded.push(s); return true },
      evictExcept: () => {}
    } as any
    const api = { getManifest: async () => ({ ...base, serverNow: 1, interrupt }) } as any
    const r = createReconciler({
      api, deviceId: 'd1', nativeFS, cdnUrl: (s: string) => `/media/${s}`
    })
    await r.reconcile()
    await r.reconcile()
    expect(downloaded).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/player/useReconciler.test.ts`
Expected: FAIL — `r.onClock is not a function`

- [ ] **Step 4: Implement**

In `app/composables/player/useReconciler.ts`:

Add the type and handle member:

```ts
import type { InterruptSchedule } from './createInterruptTimer'

/**
 * Emitted on EVERY successful manifest fetch, unlike onManifest which is gated
 * by shouldReconcile. The interrupt window rolls to tomorrow after each fire
 * and the clock offset must stay fresh, but neither may remount the stage —
 * a remount would restart the playing video.
 */
export interface ClockSample {
  serverNow: number | null
  interrupt: InterruptSchedule | null
}
```

On `ReconcilerHandle`:

```ts
  onClock(fn: (c: ClockSample) => void): () => void
```

Inside `createReconciler`, add the handler set and emitter next to the others:

```ts
  const clockHandlers = new Set<(c: ClockSample) => void>()
  function emitClock(c: ClockSample): void {
    for (const fn of clockHandlers) fn(c)
  }
```

In `reconcile()`, in the `m === null` branch, before the existing `if (last !== null || !hasEmitted)` block:

```ts
        // An unassigned device receives no manifest and therefore no schedule.
        emitClock({ serverNow: null, interrupt: null })
```

And in the success path, **after** the `staleBundle(m)` check and **before** the `shouldReconcile` early return:

```ts
      const interrupt: InterruptSchedule | null = m.interrupt
        ? {
            sha256: m.interrupt.sha256,
            durationMs: m.interrupt.durationMs,
            startsAt: m.interrupt.startsAt,
            endsAt: m.interrupt.endsAt
          }
        : null
      emitClock({ serverNow: m.serverNow ?? null, interrupt })

      // The clip must be on disk long before the window opens; a cache miss at
      // 09:00 means a CDN fetch over the venue uplink. Only when missing —
      // download() blocks the JS thread.
      if (deps.nativeFS && deps.cdnUrl && interrupt && !deps.nativeFS.exists(interrupt.sha256)) {
        emitSyncing(true)
        deps.nativeFS.download(interrupt.sha256, deps.cdnUrl(interrupt.sha256))
        emitSyncing(false)
      }
```

In the existing pre-download block, keep the interrupt sha alive through eviction:

```ts
      if (deps.nativeFS && deps.cdnUrl) {
        const sha256s = m.items.map(i => i.sha256)
        const uncached = sha256s.filter(s => !deps.nativeFS!.exists(s))
        if (uncached.length > 0) {
          emitSyncing(true)
          for (const sha256 of uncached) {
            deps.nativeFS!.download(sha256, deps.cdnUrl!(sha256))
          }
          emitSyncing(false)
        }
        // The interrupt clip is not a playlist item — without this it would be
        // evicted on the next playlist change and be missing at 09:00.
        const keep = interrupt ? [...sha256s, interrupt.sha256] : sha256s
        deps.nativeFS!.evictExcept(JSON.stringify(keep))
      }
```

Register the accessor in the returned object and clear the set in `close()`:

```ts
    onClock(fn) {
      clockHandlers.add(fn)
      return () => clockHandlers.delete(fn)
    },
```

```ts
    clockHandlers.clear()   // inside close(), beside the other .clear() calls
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/player/useReconciler.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/composables/player/useReconciler.ts app/types/api.ts tests/player/useReconciler.test.ts
git commit -m "feat(player): reconciler clock channel — fresh window every poll, no stage remount"
```

---

### Task 9: Extract the blob fallback and build the overlay

**Files:**
- Create: `app/composables/player/fetchBlobUrl.ts`
- Modify: `app/components/player/PlayerStage.vue`
- Create: `app/components/player/InterruptOverlay.vue`
- Create: `tests/components/InterruptOverlay.test.ts`

**Interfaces:**
- Consumes: `describeMediaError` (existing).
- Produces:
  - `export async function fetchBlobUrl(sha256: string): Promise<string>`
  - `InterruptOverlay` props `{ sha256: string; src: string; startOffsetMs: number }`, emits `started`, `failed: (message: string)`

- [ ] **Step 1: Write the failing test**

Create `tests/components/InterruptOverlay.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import InterruptOverlay from '~/app/components/player/InterruptOverlay.vue'

/** jsdom's HTMLMediaElement has no real playback; stub the bits we drive. */
function stubMedia() {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined)
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    configurable: true,
    value: vi.fn()
  })
}

describe('InterruptOverlay', () => {
  beforeEach(() => {
    stubMedia()
    vi.useFakeTimers()
  })

  it('seeks to the join offset once metadata is available, then plays', async () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 35_000 }
    })
    const video = w.find('video').element as HTMLVideoElement
    await w.find('video').trigger('loadedmetadata')
    expect(video.currentTime).toBe(35)
    expect(video.play).toHaveBeenCalled()
  })

  it('emits started once playback actually begins', async () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
    })
    await w.find('video').trigger('playing')
    expect(w.emitted('started')).toBeTruthy()
  })

  it('emits failed if nothing decodes within the startup budget', async () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
    })
    vi.advanceTimersByTime(5_000)
    expect(w.emitted('failed')).toBeTruthy()
  })

  it('does not emit failed once playback has started', async () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
    })
    await w.find('video').trigger('playing')
    vi.advanceTimersByTime(10_000)
    expect(w.emitted('failed')).toBeFalsy()
  })

  it('is muted — a second decoder is exactly what must not exist here', () => {
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
    })
    // Vue sets `muted` as a DOM PROPERTY, not an attribute — asserting
    // attributes('muted') can never pass, in jsdom or a real browser.
    expect((w.find('video').element as HTMLVideoElement).muted).toBe(true)
  })

  it('does not re-arm the element, leak the blob, or emit after unmount', async () => {
    // The parent tears this component down on the window's wall-clock end,
    // which can land while a blob retry is still in flight.
    let resolveFetch: (b: Blob) => void = () => {}
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(
      Promise.resolve({ ok: true, blob: () => new Promise<Blob>((r) => { resolveFetch = r }) })
    ))
    const w = mount(InterruptOverlay, {
      props: { sha256: 'silence', src: '/media/silence', startOffsetMs: 0 }
    })
    const video = w.find('video').element as HTMLVideoElement
    await w.find('video').trigger('error') // starts the blob retry
    w.unmount()
    resolveFetch(new Blob(['x']))
    await new Promise((r) => setTimeout(r, 0))

    expect(video.getAttribute('src')).toBeNull()
    expect(revoke).toHaveBeenCalled()
    expect(w.emitted('failed')).toBeFalsy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/InterruptOverlay.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Extract `fetchBlobUrl`**

Create `app/composables/player/fetchBlobUrl.ts`:

```ts
// app/composables/player/fetchBlobUrl.ts
//
// Same-origin blob fallback, shared by PlayerStage and InterruptOverlay.
//
// Why it exists: on at least one TV (Haier, Chrome 152 WebView) the media
// pipeline rejects the APK interceptor's cached response outright, while
// fetch() reads the same bytes happily. The fetch MUST stay same-origin — an
// intercepted response carries no CORS headers, so a CDN URL would fail.
export async function fetchBlobUrl(sha256: string): Promise<string> {
  const res = await fetch(`/media/${sha256}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return URL.createObjectURL(await res.blob())
}
```

In `PlayerStage.vue`, import it and replace the fetch pair inside `playViaBlob`:

```ts
import { fetchBlobUrl } from '~/app/composables/player/fetchBlobUrl'
```

```ts
  try {
    const blobUrl = await fetchBlobUrl(item.sha256)
    // The slot may have moved on while we were fetching.
    const stillHere = (slot === 'A' ? itemInA.value : itemInB.value)?.id === item.id
    if (!stillHere) {
      URL.revokeObjectURL(blobUrl)
      return
    }
    releaseBlob(slot)
    blobUrlBySlot[slot] = blobUrl
    video.src = blobUrl
    video.load()
    resetProgressTracking()
    if (slot === frontSlot()) playFrontVideoIfNeeded()
  } catch (e) {
    blobState.set(item.id, 'failed')
    onSlotError(slot, `blob fetch failed: ${(e as Error).message}`)
  }
```

(The previous code created the object URL before the `stillHere` check; revoking on the early return closes that leak.)

- [ ] **Step 4: Write the overlay**

Create `app/components/player/InterruptOverlay.vue`:

```vue
<!-- app/components/player/InterruptOverlay.vue -->
<!--
  The scheduled interrupt's clip, rendered ABOVE everything the player is
  otherwise showing — including the standby and no-content screens.

  Two rules from the design that live here:
  - It never decides when to stop. The parent tears it down at the window's
    wall-clock end, so a hung or stalled clip cannot hold a venue's screen.
  - Failure is loud and immediate: no decoded frame within STARTUP_BUDGET_MS
    and we emit `failed`, the parent resumes the playlist and a device_errors
    row is written. A blank screen is never an acceptable observance.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { describeMediaError } from '~/app/composables/player/describeMediaError'
import { fetchBlobUrl } from '~/app/composables/player/fetchBlobUrl'

const props = defineProps<{
  sha256: string
  /** Network URL for the clip (CDN or the /media proxy). */
  src: string
  /** How far into the clip to start, so every screen stays frame-aligned. */
  startOffsetMs: number
}>()

const emit = defineEmits<{
  started: []
  failed: [message: string]
}>()

/** No decoded frame by then and we give the screen back to the playlist. */
const STARTUP_BUDGET_MS = 5_000

const video = ref<HTMLVideoElement | null>(null)
let startupTimer: number | null = null
let playing = false
let blobUrl: string | null = null
let triedBlob = false
let failed = false
/** Set on unmount. The parent tears this component down on the window's
 *  wall-clock end, which can land while a blob retry is still in flight. */
let disposed = false

function clearStartupTimer(): void {
  if (startupTimer !== null) {
    window.clearTimeout(startupTimer)
    startupTimer = null
  }
}

function fail(message: string): void {
  // `failed` is emitted at most once, and never after teardown: a late error
  // from a still-in-flight load would otherwise fire into a parent that has
  // already resumed the playlist.
  if (playing || failed || disposed) return
  failed = true
  clearStartupTimer()
  emit('failed', message)
}

function onLoadedMetadata(): void {
  const el = video.value
  if (!el) return
  // Seek before playing: joining in progress is what keeps every screen in the
  // country showing the same second.
  if (props.startOffsetMs > 0) el.currentTime = props.startOffsetMs / 1000
  void el.play().catch(() => {
    /* muted autoplay; a real failure surfaces as `error` or the budget */
  })
}

function onPlaying(): void {
  playing = true
  clearStartupTimer()
  emit('started')
}

async function onError(): Promise<void> {
  const el = video.value
  const detail = el
    ? describeMediaError(el.error, {
        networkState: el.networkState,
        readyState: el.readyState,
        source: blobUrl ? 'blob' : undefined
      })
    : 'interrupt video decode/load error'

  // One blob attempt, same escape hatch the stage uses for a cached response
  // the media pipeline refuses.
  if (!triedBlob && el) {
    triedBlob = true
    try {
      const url = await fetchBlobUrl(props.sha256)
      // The parent may have torn us down at the window's wall-clock end while
      // this fetch was in flight. Re-arming `src` here would put a decoder back
      // on an element onBeforeUnmount deliberately released — on hardware with
      // a handful of decoder instances — and the URL would never be revoked,
      // since the one revoke on the unmount path already ran.
      if (disposed) {
        URL.revokeObjectURL(url)
        return
      }
      blobUrl = url
      el.src = blobUrl
      el.load()
      return
    } catch (e) {
      fail(`${detail} → blob fetch failed: ${(e as Error).message}`)
      return
    }
  }
  fail(detail)
}

onMounted(() => {
  const el = video.value
  if (el) {
    el.src = props.src
    el.load()
  }
  startupTimer = window.setTimeout(() => {
    startupTimer = null
    fail('interrupt clip never started')
  }, STARTUP_BUDGET_MS)
})

onBeforeUnmount(() => {
  disposed = true
  clearStartupTimer()
  const el = video.value
  if (el) {
    el.pause()
    el.removeAttribute('src')
    el.load() // genuinely release the decoder; display:none frees nothing
  }
  if (blobUrl) URL.revokeObjectURL(blobUrl)
})
</script>

<template>
  <div class="interrupt-overlay">
    <video
      ref="video"
      muted
      playsinline
      preload="auto"
      @loadedmetadata="onLoadedMetadata"
      @playing="onPlaying"
      @error="onError"
    />
  </div>
</template>

<style scoped>
.interrupt-overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
</style>
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/components/InterruptOverlay.test.ts tests/components`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/composables/player/fetchBlobUrl.ts app/components/player/InterruptOverlay.vue app/components/player/PlayerStage.vue tests/components/InterruptOverlay.test.ts
git commit -m "feat(player): interrupt overlay with the shared same-origin blob fallback"
```

---

### Task 10: Make the stage stand down

**Files:**
- Modify: `app/components/player/PlayerStage.vue`
- Create: `tests/components/PlayerStage.interrupt.test.ts`

**Interfaces:**
- Consumes: `SchedulerHandle.pause/resume` (Task 7).
- Produces: `PlayerStage` prop `suspended?: boolean`, emit `stood-down`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/PlayerStage.interrupt.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import PlayerStage from '~/app/components/player/PlayerStage.vue'
import { createPlayerScheduler } from '~/app/composables/player/createPlayerScheduler'

const items = [
  { id: 1, type: 'video' as const, sha256: 'a', durationMs: 30_000 },
  { id: 2, type: 'video' as const, sha256: 'b', durationMs: 30_000 }
]
const manifest = { playlistId: 1, playlistName: 'P', version: 1, items }
const env = { fileUrl: (sha: string) => `/media/${sha}` }

function stubMedia() {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true, value: vi.fn().mockResolvedValue(undefined)
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true, value: vi.fn()
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    configurable: true, value: vi.fn()
  })
}

function mountStage() {
  const scheduler = createPlayerScheduler(items, {
    now: () => Date.now(),
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
    clearTimeout: (h) => window.clearTimeout(h as number)
  })
  const w = mount(PlayerStage, {
    props: { manifest, scheduler, env, suspended: false } as any
  })
  return { w, scheduler }
}

describe('PlayerStage suspension', () => {
  beforeEach(() => stubMedia())

  it('pauses the front video, empties the back slot and acknowledges', async () => {
    const { w, scheduler } = mountStage()
    const pauseSpy = vi.spyOn(scheduler, 'pause')
    const videos = w.findAll('video')

    await w.setProps({ suspended: true })

    expect(pauseSpy).toHaveBeenCalled()
    expect(w.emitted('stood-down')).toBeTruthy()
    // Back slot released: its src attribute is gone.
    expect(videos[1].attributes('src')).toBeUndefined()
  })

  it('stops watchdog sampling while suspended — otherwise a paused front video reloads the page', async () => {
    // NOTE: do NOT write this as "advance timers and assert nothing happened".
    // Under jsdom `currentSrc` never populates, so sampleProgress can never trip
    // a stall regardless of whether the interval was cleared — such a test
    // passes even with the clearInterval deleted. Pin the mechanism instead:
    // spy on window.clearInterval and assert the sampling handle is cleared on
    // suspend and a fresh one created on resume. Verify by sabotage — delete the
    // clearInterval call and confirm your test goes red.
    const clearSpy = vi.spyOn(window, 'clearInterval')
    const setSpy = vi.spyOn(window, 'setInterval')
    const { w } = mountStage()
    const setCallsAtMount = setSpy.mock.calls.length

    await w.setProps({ suspended: true })
    expect(clearSpy).toHaveBeenCalled()

    await w.setProps({ suspended: false })
    expect(setSpy.mock.calls.length).toBeGreaterThan(setCallsAtMount)
  })

  it('resumes the front video WITHOUT reloading it — frame-exact resume', async () => {
    const { w, scheduler } = mountStage()
    const resumeSpy = vi.spyOn(scheduler, 'resume')
    const front = w.findAll('video')[0].element as HTMLVideoElement
    const srcBefore = front.src

    await w.setProps({ suspended: true })
    await w.setProps({ suspended: false })

    expect(resumeSpy).toHaveBeenCalled()
    expect(front.src).toBe(srcBefore) // never re-assigned → currentTime preserved
    expect(front.play).toHaveBeenCalled()
  })

  it('cancels a pending stall recovery while suspended, and re-arms it on resume', async () => {
    // A stage already mid-backoff when the interrupt fires would otherwise run
    // mountInitial() during the observance: front re-primed, back re-armed,
    // three live decoders alongside the overlay.
    vi.useFakeTimers()
    const { w } = mountStage()
    // Drive the stage into the stalled state, then suspend mid-backoff.
    ;(w.vm as any).stalled = true
    await w.setProps({ suspended: true })
    const loadCallsBefore = (HTMLMediaElement.prototype.load as any).mock.calls.length
    vi.advanceTimersByTime(30_000) // past RECOVERY_DELAY_MS
    expect((HTMLMediaElement.prototype.load as any).mock.calls.length).toBe(loadCallsBefore)
    vi.useRealTimers()
  })

  it('restores the back-slot preload on resume', async () => {
    const { w } = mountStage()
    await w.setProps({ suspended: true })
    await w.setProps({ suspended: false })
    const back = w.findAll('video')[1].element as HTMLVideoElement
    expect(back.src).toContain('/media/b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/PlayerStage.interrupt.test.ts`
Expected: FAIL — no `stood-down` event.

- [ ] **Step 3: Implement**

In `app/components/player/PlayerStage.vue`:

Change the props/emits declaration:

```ts
const props = defineProps<{
  manifest: Manifest
  scheduler: SchedulerHandle
  env: PlayerEnv
  /** True while a scheduled interrupt owns the screen. See standDown(). */
  suspended?: boolean
}>()

const emit = defineEmits<{ 'stood-down': [] }>()
```

Add `watch` to the Vue import, and add these functions next to `mountInitial`:

```ts
/**
 * Hand the screen to the interrupt overlay.
 *
 * Order matters. The back preload slot is released BEFORE the overlay is given
 * a source, so the box never holds three live decoders — on Amlogic hardware
 * that is the fastest way to starve the visible one.
 *
 * The front video is PAUSED, never torn down: a paused <video> keeps its
 * currentTime and its decoder, which is what makes the resume frame-exact with
 * no seek and no re-prime.
 */
function standDown(): void {
  props.scheduler.pause()
  const item = frontItem()
  if (item?.type === 'video') {
    const { video } = elementsFor(frontSlot())
    video?.pause()
  }
  setItemInSlot(backSlot(), null)
  // A stage already mid-backoff has a recovery timer armed. Left running it
  // fires mountInitial() DURING the observance, which re-assigns src on both
  // slots: the paused front decoder is re-primed (destroying the frame-exact
  // resume, and re-priming is what killed a prod TV) and the back slot is
  // re-armed, putting three live decoders on a box that has a handful — while
  // the overlay is on screen. standUp() re-arms it if we are still stalled.
  clearRecoveryTimer()
  // The watchdog does NOT exempt a paused element — a paused front video is a
  // fault it exists to recover from. Left running it would reload the page
  // about 8 s into the observance, which looks like success while actually
  // restarting the playlist.
  if (stallTimer !== null) {
    window.clearInterval(stallTimer)
    stallTimer = null
  }
  emit('stood-down')
}

/** Take the screen back. */
function standUp(): void {
  const frontIdx = props.scheduler.getFrontIndex()
  const backIdx = props.scheduler.getBackIndex()
  const back = backIdx === frontIdx ? null : (props.manifest.items[backIdx] ?? null)
  setItemInSlot(backSlot(), back)
  playFrontVideoIfNeeded()
  resetProgressTracking()
  props.scheduler.resume()
  if (stallTimer === null) {
    stallTimer = window.setInterval(sampleProgress, STALL_SAMPLE_MS)
  }
  // Re-arm the backoff we cancelled on the way down, or a stage that entered
  // the observance stalled would sit stalled forever with no timer to heal it.
  if (stalled.value) scheduleRecovery()
}
```

Inside `onMounted`, after the timer is started, add the watcher — **and a
mount-time catch-up**:

```ts
  // This component is keyed on playlistId:version, so a manifest change during
  // an interrupt REMOUNTS it with `suspended` already true. The watch below is
  // not immediate, so without this the fresh stage would preload the back slot
  // and play the playlist underneath a live overlay: three decoders on a box
  // with a handful, and the watchdog reloading the page ~8 s in.
  // The emit is harmless here — the parent is already past `arming`, so its
  // handler is a no-op.
  if (props.suspended) standDown()

  const stopSuspendWatch = watch(
    () => props.suspended === true,
    (on) => (on ? standDown() : standUp())
  )
```

…and unsubscribe it in the existing `onBeforeUnmount`:

```ts
    stopSuspendWatch()
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/components/PlayerStage.interrupt.test.ts`
Expected: PASS

- [ ] **Step 5: Run the whole player suite for regressions**

Run: `pnpm vitest run tests/player tests/components`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/components/player/PlayerStage.vue tests/components/PlayerStage.interrupt.test.ts
git commit -m "feat(player): stage stands down for an interrupt — paused front, empty back, watchdog off"
```

---

### Task 11: Wire the state machine into the player

**Files:**
- Modify: `app/composables/player/usePlayerBoot.ts`
- Modify: `app/composables/player/useTelemetry.ts`
- Modify: `app/composables/useApiClient.ts`
- Modify: `app/pages/player.vue`

**Interfaces:**
- Consumes: `createInterruptTimer` (6), `onClock` (8), `InterruptOverlay` (9), `suspended`/`stood-down` (10).
- Produces on `PlayerBootState`:
  ```ts
  interruptPhase: Ref<'idle' | 'arming' | 'playing'>
  interruptSrc: Ref<string | null>
  interruptSha: Ref<string | null>
  interruptOffsetMs: Ref<number>
  onStageStoodDown(): void
  onInterruptStarted(): void
  onInterruptFailed(message: string): void
  ```
  and `Telemetry.interruptStarted(deviceId: string, startsAt: number): void`

- [ ] **Step 1: Extend the telemetry client**

In `app/composables/useApiClient.ts`, widen the `postTelemetry` body type:

```ts
  postTelemetry(
    deviceId: string,
    body: {
      currentItemId?: number | null
      interruptAt?: number
      error?: { sha256?: string; message: string }
      [k: string]: unknown
    }
  ): Promise<void>
```

(If the existing signature is narrower and used positionally elsewhere, keep the existing members and only add `interruptAt?: number`.)

In `app/composables/player/useTelemetry.ts`, add to the `Telemetry` interface:

```ts
  /** Proof of observance: the window's startsAt, posted when the clip actually
   *  begins playing. Carries no currentItemId — the interrupt is not a playlist
   *  item and must not disturb the current item or media.play_count. */
  interruptStarted(deviceId: string, startsAt: number): void
```

Widen the internal `fire` body type with `interruptAt?: number`, and add the implementation beside `itemStarted`:

```ts
    interruptStarted(deviceId, startsAt) {
      fire(deviceId, { interruptAt: startsAt })
    },
```

- [ ] **Step 2: Add the state machine to `usePlayerBoot`**

Add the import and the reactive state:

```ts
import { createInterruptTimer, type InterruptTimerHandle } from './createInterruptTimer'
```

```ts
export type InterruptPhase = 'idle' | 'arming' | 'playing'
```

In `PlayerBootState`:

```ts
  interruptPhase: Ref<InterruptPhase>
  interruptSrc: Ref<string | null>
  interruptSha: Ref<string | null>
  interruptOffsetMs: Ref<number>
  onStageStoodDown: () => void
  onInterruptStarted: () => void
  onInterruptFailed: (message: string) => void
```

Inside `usePlayerBoot`, near the other refs:

```ts
  const interruptPhase = ref<InterruptPhase>('idle')
  const interruptSrc = ref<string | null>(null)
  const interruptSha = ref<string | null>(null)
  const interruptOffsetMs = ref(0)
  const interruptTimer: InterruptTimerHandle = createInterruptTimer()
  let interruptStartsAt = 0
  let armTimer: number | null = null
  let interruptTick: number | null = null

  /** How often the corrected clock is compared against the window. */
  const INTERRUPT_SAMPLE_MS = 500
  /** A stage that never acknowledges must not be able to block the observance. */
  const ARM_TIMEOUT_MS = 500

  function clearArmTimer(): void {
    if (armTimer !== null) {
      window.clearTimeout(armTimer)
      armTimer = null
    }
  }

  function onStageStoodDown(): void {
    clearArmTimer()
    if (interruptPhase.value !== 'arming') return
    interruptPhase.value = 'playing'
  }

  /**
   * Proof of observance, posted only once the clip has genuinely decoded a
   * frame — NOT at handover. A screen where the clip fails to play must read as
   * missed, or `devices.last_interrupt_at` would report an observance that
   * never appeared on the glass, which is the one thing this field exists to
   * rule out.
   */
  function onInterruptStarted(): void {
    if (interruptPhase.value !== 'playing') return
    telemetry.interruptStarted(deviceId.value, interruptStartsAt)
  }

  function endInterrupt(): void {
    clearArmTimer()
    if (interruptPhase.value === 'idle') return
    interruptTimer.markDone()
    interruptPhase.value = 'idle'
    interruptSrc.value = null
    interruptSha.value = null
    interruptOffsetMs.value = 0
  }

  function onInterruptFailed(message: string): void {
    // A late `error` can arrive in the same tick the wall-clock branch already
    // closed the window, before Vue unmounts the overlay. Without this guard
    // that posts a device_errors row for a window that ended normally.
    if (interruptPhase.value === 'idle') return
    // Loud, never blank: the playlist comes back and the failure is on record.
    telemetry.itemFailed(
      deviceId.value,
      null,
      interruptSha.value ?? undefined,
      `interrupt: ${message}`
    )
    endInterrupt()
  }

  function sampleInterrupt(): void {
    const state = interruptTimer.observe(Date.now())
    if (state.active) {
      if (interruptPhase.value !== 'idle') return
      interruptStartsAt = state.schedule.startsAt
      interruptSha.value = state.schedule.sha256
      interruptSrc.value = env.fileUrl(state.schedule.sha256)
      interruptOffsetMs.value = state.offsetMs
      interruptPhase.value = 'arming'
      // No stage on screen (standby / no-content): nobody will acknowledge.
      if (screen.value !== 'playing') {
        onStageStoodDown()
        return
      }
      armTimer = window.setTimeout(onStageStoodDown, ARM_TIMEOUT_MS)
      return
    }
    // NOTE on the `screen.value !== 'playing'` branch above: with today's
    // contract it is defensive rather than live. A device with no playlist gets
    // a bare 204, and the reconciler's 204 path zeroes the schedule too, so
    // screen and clock cannot diverge. It is kept deliberately: the 204
    // behaviour is a decision that was taken explicitly and may be revisited
    // (delivering the observance to unassigned screens was considered and
    // deferred), and without this branch that change would deadlock the
    // handshake on a stage that will never acknowledge.
    // The window closed — on the wall clock, whatever the clip was doing.
    if (interruptPhase.value !== 'idle') endInterrupt()
  }
```

In `boot()`, after `reconciler.onSyncing(...)`:

```ts
    reconciler.onClock((c) => {
      interruptTimer.setSchedule(c.interrupt, c.serverNow, Date.now())
    })
```

…and after the reconciler is started (next to the visibility `sampleTimer`):

```ts
    interruptTick = window.setInterval(sampleInterrupt, INTERRUPT_SAMPLE_MS)
```

In the top-level `onBeforeUnmount`:

```ts
    clearArmTimer()
    if (interruptTick !== null) {
      window.clearInterval(interruptTick)
      interruptTick = null
    }
```

And add all six members to the returned object.

- [ ] **Step 3: Render it**

In `app/pages/player.vue`, destructure the new members and update the template:

```ts
const {
  screen, manifest, scheduler, env, deviceId, lastError,
  interruptPhase, interruptSrc, interruptSha, interruptOffsetMs,
  onStageStoodDown, onInterruptStarted, onInterruptFailed
} = usePlayerBoot()
```

```vue
<script setup lang="ts">
import InterruptOverlay from '~/app/components/player/InterruptOverlay.vue'
</script>
```

```vue
    <PlayerStage
      v-else-if="screen === 'playing' && manifest && scheduler"
      :key="manifest.playlistId + ':' + manifest.version"
      :manifest="manifest"
      :scheduler="scheduler"
      :env="env"
      :suspended="interruptPhase !== 'idle'"
      @stood-down="onStageStoodDown"
    />
    <!-- Sibling of the screen switch, not a child of the stage: the observance
         must also cover the standby and no-content screens, and no manifest
         change may remount it mid-window. -->
    <InterruptOverlay
      v-if="interruptPhase === 'playing' && interruptSrc && interruptSha"
      :sha256="interruptSha"
      :src="interruptSrc"
      :start-offset-ms="interruptOffsetMs"
      @started="onInterruptStarted"
      @failed="onInterruptFailed"
    />
```

- [ ] **Step 4: Verify the app builds and the suite is green**

Run: `pnpm test && pnpm build`
Expected: PASS, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/composables/player/usePlayerBoot.ts app/composables/player/useTelemetry.ts app/composables/useApiClient.ts app/pages/player.vue
git commit -m "feat(player): wire the interrupt state machine — arming handshake, wall-clock end"
```

---

### Task 12: Dashboard — the Schedule page

**Files:**
- Modify: `app/types/api.ts`, `app/composables/useApiClient.ts`, `app/components/AppNav.vue`
- Modify: `i18n/locales/en.json`, `i18n/locales/uk.json`
- Create: `app/pages/schedule.vue`

**Interfaces:**
- Consumes: `GET`/`PUT /api/interrupt` (Task 2).
- Produces: `ApiClient.getInterrupt()`, `ApiClient.putInterrupt(body)`, types `InterruptStatus`, `InterruptConfig`, `InterruptDeviceStatus`.

- [ ] **Step 1: Add the client types**

In `app/types/api.ts`:

```ts
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

/** GET/PUT /api/interrupt */
export interface InterruptStatus {
  config: InterruptConfig | null
  window: { startsAt: number; endsAt: number } | null
  devices: InterruptDeviceStatus[]
}

export interface InterruptPut {
  mediaId: number
  atMinutes: number
  enabled: boolean
  label?: string | null
  timezone?: string
}
```

In `app/composables/useApiClient.ts`, add to the `ApiClient` interface and the implementation:

```ts
  getInterrupt(): Promise<InterruptStatus>
  putInterrupt(body: InterruptPut): Promise<InterruptStatus>
```

```ts
    getInterrupt: () => fetch<InterruptStatus>('/api/interrupt'),
    putInterrupt: (body) =>
      fetch<InterruptStatus>('/api/interrupt', { method: 'PUT', body }),
```

- [ ] **Step 2: Add the i18n keys**

In `i18n/locales/en.json`:

```json
  "nav": { "schedule": "Schedule" },
  "schedule": {
    "title": "Schedule",
    "subtitle": "One clip, played on every screen at a fixed time each day.",
    "enabled": "Enabled",
    "clip": "Clip",
    "clipHint": "Videos only. The clip's own length defines the window.",
    "time": "Time",
    "timezone": "Timezone",
    "label": "Label",
    "labelPlaceholder": "Minute of silence",
    "duration": "Duration: {seconds}s",
    "nextWindow": "Next: {time}",
    "notScheduled": "Not scheduled",
    "save": "Save schedule",
    "saved": "Schedule saved",
    "statusTitle": "Today's observance",
    "observedAt": "Observed at {time}",
    "missed": "Missed",
    "notYet": "Not yet due",
    "noPlaylistWarning": "These devices have no playlist assigned. They receive no manifest and will not observe."
  }
```

Add the identical key set to `i18n/locales/uk.json`. **Mind the plural order** — `uk` is `one | few | many` with no zero slot:

```json
  "nav": { "schedule": "Розклад" },
  "schedule": {
    "title": "Розклад",
    "subtitle": "Один ролик, який відтворюється на всіх екранах у визначений час щодня.",
    "enabled": "Увімкнено",
    "clip": "Ролик",
    "clipHint": "Лише відео. Тривалість вікна визначає сам ролик.",
    "time": "Час",
    "timezone": "Часовий пояс",
    "label": "Назва",
    "labelPlaceholder": "Хвилина мовчання",
    "duration": "Тривалість: {seconds} с",
    "nextWindow": "Наступний запуск: {time}",
    "notScheduled": "Не заплановано",
    "save": "Зберегти розклад",
    "saved": "Розклад збережено",
    "statusTitle": "Сьогоднішнє вшанування",
    "observedAt": "Відтворено о {time}",
    "missed": "Пропущено",
    "notYet": "Ще не час",
    "noPlaylistWarning": "Цим пристроям не призначено плейлист. Вони не отримують маніфест і не відтворять ролик."
  }
```

Add the nav entry in `app/components/AppNav.vue`, in the group that holds media/playlists:

```ts
      { label: t('nav.schedule'), icon: 'i-lucide-alarm-clock', to: '/schedule' }
```

- [ ] **Step 3: Verify i18n parity**

Run: `pnpm vitest run tests/i18n/plurals.test.ts`
Expected: PASS. A missing `uk` key fails here.

- [ ] **Step 4: Build the page**

Create `app/pages/schedule.vue`. Match the Nuxt UI card/table idiom of `app/pages/playlists/index.vue`. **Do not use `<template #header>`** anywhere — it breaks the production Vue compiler (see `CLAUDE.md`).

```vue
<!-- app/pages/schedule.vue -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { InterruptStatus, MediaListRow } from '~/app/types/api'

const { t } = useI18n()
const api = useApiClient()
const toast = useToast()

const status = ref<InterruptStatus | null>(null)
const videos = ref<MediaListRow[]>([])
const loading = ref(true)
const saving = ref(false)

const mediaId = ref<number | null>(null)
const atMinutes = ref(9 * 60)
const enabled = ref(true)
const label = ref('')

/** `HH:MM` <-> minutes since local midnight, both directions. */
const timeString = computed({
  get: () => {
    const h = String(Math.floor(atMinutes.value / 60)).padStart(2, '0')
    const m = String(atMinutes.value % 60).padStart(2, '0')
    return `${h}:${m}`
  },
  set: (v: string) => {
    const [h, m] = v.split(':').map(Number)
    if (Number.isFinite(h) && Number.isFinite(m)) atMinutes.value = h * 60 + m
  }
})

/** The window's length is the clip's length — never a stored number. */
const durationSeconds = computed(() => {
  const clip = videos.value.find((v) => v.id === mediaId.value)
  return clip?.durationMs ? Math.round(clip.durationMs / 1000) : null
})

const timezone = computed(() => status.value?.config?.timezone ?? 'Europe/Kyiv')

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })

/** Devices that receive a 204 and therefore cannot observe. */
const withoutPlaylist = computed(() =>
  (status.value?.devices ?? []).filter((d) => !d.hasPlaylist)
)

function applyStatus(next: InterruptStatus): void {
  status.value = next
  if (next.config) {
    mediaId.value = next.config.mediaId
    atMinutes.value = next.config.atMinutes
    enabled.value = next.config.enabled
    label.value = next.config.label ?? ''
  }
}

/** Today's outcome for one device. */
function deviceState(d: InterruptStatus['devices'][number]): string {
  if (d.observedToday && d.lastInterruptAt) {
    return t('schedule.observedAt', { time: fmtTime(d.lastInterruptAt) })
  }
  const w = status.value?.window
  const due = w !== null && w !== undefined && Date.now() >= w.startsAt
  return due ? t('schedule.missed') : t('schedule.notYet')
}

async function save(): Promise<void> {
  if (mediaId.value === null) return
  saving.value = true
  try {
    applyStatus(
      await api.putInterrupt({
        mediaId: mediaId.value,
        atMinutes: atMinutes.value,
        enabled: enabled.value,
        label: label.value || null
      })
    )
    toast.add({ title: t('schedule.saved') })
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    const [s, media] = await Promise.all([api.getInterrupt(), api.listMedia()])
    videos.value = media.filter((m) => m.kind === 'video')
    applyStatus(s)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold">{{ t('schedule.title') }}</h1>
      <p class="text-sm text-gray-500">{{ t('schedule.subtitle') }}</p>
    </div>

    <UCard v-if="!loading">
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField :label="t('schedule.enabled')">
          <USwitch v-model="enabled" />
        </UFormField>

        <UFormField :label="t('schedule.clip')" :hint="t('schedule.clipHint')">
          <USelectMenu
            v-model="mediaId"
            :items="videos.map((v) => ({ label: v.filename, value: v.id }))"
            value-key="value"
          />
        </UFormField>

        <UFormField :label="t('schedule.time')">
          <UInput v-model="timeString" type="time" />
          <p v-if="durationSeconds !== null" class="mt-1 text-xs text-gray-500">
            {{ t('schedule.duration', { seconds: durationSeconds }) }}
          </p>
        </UFormField>

        <UFormField :label="t('schedule.timezone')">
          <UInput :model-value="timezone" disabled />
        </UFormField>

        <UFormField :label="t('schedule.label')">
          <UInput v-model="label" :placeholder="t('schedule.labelPlaceholder')" />
        </UFormField>
      </div>

      <div class="mt-4 flex items-center gap-3">
        <UButton :loading="saving" :disabled="mediaId === null" @click="save">
          {{ t('schedule.save') }}
        </UButton>
        <span class="text-sm text-gray-500">
          {{ status?.window
            ? t('schedule.nextWindow', { time: fmtTime(status.window.startsAt) })
            : t('schedule.notScheduled') }}
        </span>
      </div>
    </UCard>

    <UCard v-if="!loading && status">
      <h2 class="mb-3 font-medium">{{ t('schedule.statusTitle') }}</h2>

      <UAlert
        v-if="withoutPlaylist.length > 0"
        color="warning"
        class="mb-4"
        :title="t('schedule.noPlaylistWarning')"
        :description="withoutPlaylist.map((d) => d.name ?? d.id).join(', ')"
      />

      <UTable
        :rows="status.devices"
        :columns="[
          { key: 'name', label: t('schedule.title') },
          { key: 'state', label: t('schedule.statusTitle') }
        ]"
      >
        <template #name-data="{ row }">{{ row.name ?? row.id }}</template>
        <template #state-data="{ row }">{{ deviceState(row) }}</template>
      </UTable>
    </UCard>
  </div>
</template>
```

If a Nuxt UI v3 prop name differs in this project's version, follow whatever `app/pages/playlists/index.vue` and `app/pages/devices/index.vue` already use — they are the authority, not this snippet.

**Extract the status derivation.** `deviceState`'s "missed vs not yet due"
judgment must stay in lockstep with the server's `todaysWindow` /
`observedToday` semantics, and it is the single piece of reasoning this plan
has gotten wrong more than once. It does not belong inside a component where
no test can reach it. Put the decision in `app/utils/interruptStatus.ts` as a
plain function over plain data — the clock read and all `Intl` work stay at the
call site, so the module never knows about timezones:

```ts
export type InterruptOutcome = 'observed' | 'missed' | 'notYet' | 'notScheduled'

export function deviceInterruptOutcome(
  device: Pick<InterruptDeviceStatus, 'observedToday' | 'lastInterruptAt'>,
  config: Pick<InterruptConfig, 'enabled' | 'atMinutes'> | null,
  nowMinutes: number
): InterruptOutcome {
  if (device.observedToday && device.lastInterruptAt !== null) return 'observed'
  if (!config || !config.enabled) return 'notScheduled'
  return nowMinutes >= config.atMinutes ? 'missed' : 'notYet'
}
```

`tests/utils/interruptStatus.test.ts` pins the boundary explicitly: `atMinutes:
540` with `nowMinutes: 540` → `'missed'`, `539` → `'notYet'`, plus the observed
and disabled/unconfigured branches.

**Both load paths must surface failure.** `onMounted` and the manual refresh
each need a `catch` that toasts via the codebase's `err.data?.message ??
err.message` idiom, and the 30 s poll must be armed whether or not the first
load succeeded. Without that, a failed load renders identically to a fresh
unconfigured install — on the page whose whole job is proving the fleet
observed, that is the worst available failure mode.

- [ ] **Step 5: Badge the clip on the media page**

The 409 from Task 4 stops an accidental deletion, but only after the operator has tried. Surface it before they do: in `app/pages/media.vue` (and `MediaDetailDrawer` if the delete button lives there), fetch `api.getInterrupt()` once and render a `UBadge` on the row whose `id === config.mediaId`, labelled `t('schedule.title')`.

Add the key used by the badge tooltip to both locale files:

```json
  "schedule": { "clipInUse": "Used by the daily schedule" }
```

- [ ] **Step 6: Verify**

Run: `pnpm build && pnpm vitest run tests/i18n/plurals.test.ts`
Expected: build succeeds (a Vue template error fails the prod build — see the `<template #header>` note in `CLAUDE.md`; do not use that syntax) and i18n parity holds.

Then, manually: `PORT=5100 pnpm dev`, log in as `super@lanka.live` / `lanka-dev`, open `/schedule`, save a config, and confirm `GET /api/interrupt` returns it.

- [ ] **Step 7: Commit**

```bash
git add app/pages/schedule.vue app/pages/media.vue app/types/api.ts app/composables/useApiClient.ts app/components/AppNav.vue i18n/locales
git commit -m "feat(dashboard): schedule page — interrupt config and per-device observance status"
```

---

### Task 13: Native — manifest fields, timer, scheduler

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/player/Manifest.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/player/Scheduler.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/player/InterruptTimer.kt`
- Create: `android/app/src/test/kotlin/ai/lanka/kiosk/player/InterruptTimerTest.kt`
- Create: `android/app/src/test/kotlin/ai/lanka/kiosk/player/SchedulerPauseTest.kt`

**Interfaces:**
- Consumes: the manifest contract from Task 3.
- Produces:
  ```kotlin
  data class ManifestInterrupt(val mediaId: Int, val sha256: String, val durationMs: Int, val startsAt: Long, val endsAt: Long)
  // Manifest gains: serverNow: Long? = null, interrupt: ManifestInterrupt? = null
  sealed class InterruptState { object Inactive; data class Active(val schedule: ManifestInterrupt, val offsetMs: Long) }
  class InterruptTimer { fun setSchedule(s: ManifestInterrupt?, serverNow: Long?, clientNow: Long); fun observe(clientNow: Long): InterruptState; fun markDone() }
  // Scheduler gains: fun pause(); fun resume()
  ```

- [ ] **Step 1: Write the failing tests**

Create `android/app/src/test/kotlin/ai/lanka/kiosk/player/InterruptTimerTest.kt` — the **same table** as `tests/player/createInterruptTimer.test.ts`. Identical tables are what stop the two implementations drifting.

```kotlin
package ai.lanka.kiosk.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InterruptTimerTest {
    private val start = 1_800_000_000_000L
    private val sched = ManifestInterrupt(9, "silence", 60_000, start, start + 60_000)

    private fun isActive(s: InterruptState) = s is InterruptState.Active

    @Test fun `inactive with no schedule`() {
        assertTrue(!isActive(InterruptTimer().observe(start)))
    }

    @Test fun `inactive before the window`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start - 10_000, start - 10_000)
        assertTrue(!isActive(t.observe(start - 1)))
    }

    @Test fun `activates at startsAt with zero offset`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start - 10_000, start - 10_000)
        val s = t.observe(start)
        assertTrue(s is InterruptState.Active)
        assertEquals(0L, (s as InterruptState.Active).offsetMs)
    }

    @Test fun `joins in progress with the elapsed offset`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start + 35_000, start + 35_000)
        val s = t.observe(start + 35_000) as InterruptState.Active
        assertEquals(35_000L, s.offsetMs)
    }

    @Test fun `goes inactive at endsAt`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        assertTrue(isActive(t.observe(start + 59_999)))
        assertTrue(!isActive(t.observe(start + 60_000)))
    }

    @Test fun `corrects a wrong client clock from serverNow`() {
        val t = InterruptTimer()
        val clientNow = start - 3_600_000 - 10_000
        t.setSchedule(sched, start - 10_000, clientNow)
        assertTrue(!isActive(t.observe(clientNow)))
        assertTrue(isActive(t.observe(clientNow + 10_000)))
    }

    @Test fun `refuses when the join offset exceeds the clip duration`() {
        val t = InterruptTimer()
        t.setSchedule(sched.copy(durationMs = 10_000), start + 20_000, start + 20_000)
        assertTrue(!isActive(t.observe(start + 20_000)))
    }

    @Test fun `does not replay a window already done`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start + 30_000, start + 30_000)
        assertTrue(isActive(t.observe(start + 30_000)))
        t.markDone()
        assertTrue(!isActive(t.observe(start + 30_000)))
        assertTrue(!isActive(t.observe(start + 1_000)))
    }

    @Test fun `clears the latch on a new window`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        t.markDone()
        val tomorrow = sched.copy(startsAt = start + 86_400_000, endsAt = start + 86_400_000 + 60_000)
        t.setSchedule(tomorrow, start + 86_400_000, start + 86_400_000)
        assertTrue(isActive(t.observe(start + 86_400_000)))
    }

    @Test fun `keeps the latch when the same window is republished`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        t.markDone()
        t.setSchedule(sched, start + 5_000, start + 5_000)
        assertTrue(!isActive(t.observe(start + 5_000)))
    }

    @Test fun `keeps the latch across a withdrawal and republish`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        t.markDone()
        t.setSchedule(null, null, start + 5_000)
        t.setSchedule(sched, start + 10_000, start + 10_000)
        assertTrue(!isActive(t.observe(start + 10_000)))
    }

    @Test fun `stops at endsAt even when the clip is longer than the window`() {
        val t = InterruptTimer()
        t.setSchedule(sched.copy(durationMs = 600_000), start, start)
        assertTrue(isActive(t.observe(start + 59_999)))
        assertTrue(!isActive(t.observe(start + 60_000)))
    }

    @Test fun `keeps a previously derived offset when serverNow is null`() {
        val t = InterruptTimer()
        val clientNow = start - 3_600_000
        t.setSchedule(sched, start, clientNow)
        t.setSchedule(sched, null, clientNow)
        assertTrue(isActive(t.observe(clientNow)))
    }

    @Test fun `goes inactive when the schedule is withdrawn`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        assertTrue(isActive(t.observe(start)))
        t.setSchedule(null, null, start)
        assertTrue(!isActive(t.observe(start)))
    }
}
```

Create `android/app/src/test/kotlin/ai/lanka/kiosk/player/SchedulerPauseTest.kt`:

```kotlin
package ai.lanka.kiosk.player

import org.junit.Assert.assertEquals
import org.junit.Test

/** Virtual clock + timer queue, so pause/resume can be tested without Android. */
private class FakeDeps : SchedulerDeps {
    // Named `clock`, not `now`: SchedulerDeps.now() is the method it overrides,
    // and android.os.SystemClock (the production default) does not exist in the
    // JVM unit-test source set.
    var clock = 0L
    private data class T(val id: Long, val at: Long, val cb: () -> Unit)
    private val timers = mutableListOf<T>()
    private var nextId = 1L
    val pending: Int get() = timers.size

    override fun now(): Long = clock

    override fun setTimeout(cb: () -> Unit, ms: Long): Any {
        val id = nextId++
        timers.add(T(id, clock + ms, cb))
        return id
    }
    override fun clearTimeout(handle: Any) {
        timers.removeAll { it.id == handle }
    }
    fun advance(ms: Long) {
        clock += ms
        for (t in timers.toList()) {
            if (t.at <= clock) { timers.remove(t); t.cb() }
        }
    }
}

class SchedulerPauseTest {
    private val twoImages = listOf(
        ManifestItem(1, "image", "a", 10_000),
        ManifestItem(2, "image", "b", 10_000)
    )

    @Test fun `does not advance while paused`() {
        val deps = FakeDeps()
        val s = Scheduler(twoImages, deps)
        s.start()
        deps.advance(4_000)
        s.pause()
        deps.advance(60_000)
        assertEquals(0, s.getFrontIndex())
    }

    @Test fun `resumes with the remaining time`() {
        val deps = FakeDeps()
        val s = Scheduler(twoImages, deps)
        s.start()
        deps.advance(4_000)
        s.pause()
        deps.advance(60_000)
        s.resume()
        deps.advance(5_999)
        assertEquals(0, s.getFrontIndex())
        deps.advance(1)
        assertEquals(1, s.getFrontIndex())
    }

    @Test fun `pause and resume are idempotent`() {
        val deps = FakeDeps()
        val s = Scheduler(twoImages, deps)
        s.start()
        deps.advance(4_000)
        s.pause(); s.pause(); s.resume(); s.resume()
        deps.advance(6_000)
        assertEquals(1, s.getFrontIndex())
    }

    @Test fun `does not advance on itemEnded while paused`() {
        val deps = FakeDeps()
        val s = Scheduler(twoImages, deps)
        s.start()
        s.pause()
        s.itemEnded(0)
        assertEquals(0, s.getFrontIndex())
    }

    @Test fun `reports itemErrored while paused without advancing`() {
        val deps = FakeDeps()
        val s = Scheduler(twoImages, deps)
        val errors = mutableListOf<String>()
        s.onItemError { _, m -> errors.add(m) }
        s.start()
        s.pause()
        s.itemErrored(0, "decoder died")
        assertEquals(listOf("decoder died"), errors)
        assertEquals(0, s.getFrontIndex())
    }

    @Test fun `stop while paused leaves no timer`() {
        val deps = FakeDeps()
        val s = Scheduler(twoImages, deps)
        s.start()
        s.pause()
        s.stop()
        s.resume()
        assertEquals(0, deps.pending)
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd android && ./gradlew test`
Expected: FAIL — `InterruptTimer` unresolved, `Scheduler.pause` unresolved.

- [ ] **Step 3: Extend `Manifest.kt`**

```kotlin
@Serializable
data class ManifestInterrupt(
    val mediaId: Int,
    val sha256: String,
    val durationMs: Int,
    val startsAt: Long,
    val endsAt: Long
)

@Serializable
data class Manifest(
    val playlistId: Int,
    val playlistName: String,
    val version: Int,
    val items: List<ManifestItem>,
    // Null-defaulted so an older server (or a 204) still parses.
    val serverNow: Long? = null,
    val interrupt: ManifestInterrupt? = null
)
```

- [ ] **Step 4: Write `InterruptTimer.kt`**

```kotlin
package ai.lanka.kiosk.player

/**
 * Pure decision core for the scheduled interrupt — a 1:1 port of the web
 * player's `createInterruptTimer.ts`. Keep the two test tables identical.
 *
 * Everything here exists because the box's clock cannot be trusted and the
 * network may be gone: the window arrives as an absolute epoch computed by the
 * server (no timezone or DST logic on the TV), `serverNow` supplies a
 * correction offset, and a done latch stops a backwards clock jump replaying a
 * window we already played.
 */
sealed class InterruptState {
    object Inactive : InterruptState()
    data class Active(val schedule: ManifestInterrupt, val offsetMs: Long) : InterruptState()
}

class InterruptTimer {
    private var schedule: ManifestInterrupt? = null
    private var offsetMs = 0L
    private var doneFor: Long? = null

    /**
     * Publish the current schedule and re-derive the clock offset. Passing null
     * withdraws the schedule without disturbing the done latch.
     */
    fun setSchedule(next: ManifestInterrupt?, serverNow: Long?, clientNow: Long) {
        if (serverNow != null) offsetMs = serverNow - clientNow
        // doneFor is deliberately never cleared here — see the TS twin. observe()
        // compares it against the CURRENT schedule's startsAt, so a stale latch is
        // already inert, and clearing it on a withdrawal would reopen the replay
        // this latch exists to prevent.
        schedule = next
    }

    fun observe(clientNow: Long): InterruptState {
        val s = schedule ?: return InterruptState.Inactive
        if (doneFor == s.startsAt) return InterruptState.Inactive
        val now = clientNow + offsetMs
        if (now < s.startsAt) return InterruptState.Inactive
        if (now >= s.endsAt) return InterruptState.Inactive
        val offset = now - s.startsAt
        // Nothing left to play: the window outlives the clip.
        if (offset >= s.durationMs) return InterruptState.Inactive
        return InterruptState.Active(s, offset)
    }

    /** Mark the current window consumed. */
    fun markDone() {
        schedule?.let { doneFor = it.startsAt }
    }
}
```

- [ ] **Step 5: Add `pause()` / `resume()` to `Scheduler.kt`**

`suspend` is a Kotlin modifier keyword, so these are named `pause`/`resume` on both surfaces.

Replace the timer state and arming:

```kotlin
    private var imageTimer: Any? = null
    private var imageTimerIndex = -1
    private var imageTimerArmedAt = 0L
    private var imageTimerMs = 0L
    private var paused = false
    private var pausedRemainingMs: Long? = null

    private fun armImageTimerIfNeeded(index: Int) {
        val item = items.getOrNull(index) ?: return
        if (item.type != "image") return
        armImageTimer(index, maxOf(0, item.durationMs).toLong())
    }

    private fun armImageTimer(index: Int, ms: Long) {
        clearImageTimer() // never overwrite a live handle — that leaks it
        imageTimerIndex = index
        imageTimerArmedAt = nowMs()
        imageTimerMs = ms
        imageTimer = deps.setTimeout({
            imageTimer = null
            if (stopped) return@setTimeout
            if (mode == SchedulerMode.SINGLE_IMAGE) {
                emitItemStart(0); armImageTimerIfNeeded(0); return@setTimeout
            }
            advance()
        }, ms)
    }
```

`SchedulerDeps` has no clock, so add one with a default so existing callers and `AndroidSchedulerDeps` keep compiling:

```kotlin
interface SchedulerDeps {
    fun setTimeout(cb: () -> Unit, ms: Long): Any
    fun clearTimeout(handle: Any)
    /** Virtualised in tests; System.uptimeMillis() in production. */
    fun now(): Long = android.os.SystemClock.uptimeMillis()
}
```

**In the JVM unit-test source set `android.os.SystemClock` is unavailable**, which is why `FakeDeps` above overrides `now()`.

In `Scheduler`, reference it as `private fun nowMs() = deps.now()`.

**Guard the advancing paths**, exactly as the TypeScript twin does and for the
same reason — a paused front player can still surface an error, and advancing
would desync the front index from the surface the host is about to resume:

```kotlin
    fun start() {
        if (stopped || paused || mode == SchedulerMode.EMPTY) return
        emitItemStart(0); armImageTimerIfNeeded(0)
    }

    fun itemEnded(index: Int) {
        // Dropped while paused — see the TS twin.
        if (stopped || paused) return
        if (mode == SchedulerMode.EMPTY || mode == SchedulerMode.SINGLE_VIDEO || mode == SchedulerMode.SINGLE_IMAGE) return
        if (index != front) return
        advance()
    }

    fun itemErrored(index: Int, message: String) {
        if (stopped) return
        emitError(index, message)
        if (paused) return // report, never advance
        if (mode == SchedulerMode.EMPTY || mode == SchedulerMode.SINGLE_VIDEO || mode == SchedulerMode.SINGLE_IMAGE) return
        if (index != front) return
        advance()
    }
```

`noteError` needs no guard — it only emits.

Add the two methods:

```kotlin
    /**
     * Freeze the playlist for a scheduled interrupt: cancel the slide timer,
     * remembering how much of it was left. While paused the scheduler refuses
     * to advance. Idempotent.
     */
    fun pause() {
        if (stopped || paused) return
        paused = true
        if (imageTimer == null) { pausedRemainingMs = null; return }
        val elapsed = nowMs() - imageTimerArmedAt
        pausedRemainingMs = maxOf(0L, imageTimerMs - elapsed)
        clearImageTimer()
    }

    /** Re-arm the slide timer with its REMAINING time. Idempotent. */
    fun resume() {
        if (stopped || !paused) return
        paused = false
        val remaining = pausedRemainingMs ?: return
        pausedRemainingMs = null
        armImageTimer(imageTimerIndex, remaining)
    }
```

And in `stop()`, add `paused = false; pausedRemainingMs = null`.

- [ ] **Step 6: Run the tests**

Run: `cd android && ./gradlew test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/player/{Manifest,Scheduler,InterruptTimer}.kt android/app/src/test/kotlin/ai/lanka/kiosk/player/{InterruptTimerTest,SchedulerPauseTest}.kt
git commit -m "feat(kiosk): interrupt timer and scheduler pause/resume on the native surface"
```

---

### Task 14: Native — stand down, overlay, wiring

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/player/PlaybackView.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/player/ManifestClient.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/player/TelemetryClient.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/NativeSurface.kt`

**Interfaces:**
- Consumes: `InterruptTimer`, `ManifestInterrupt`, `Scheduler.pause/resume` (Task 13).
- Produces:
  - `PlaybackView.standDown()`, `PlaybackView.standUp()`
  - `ManifestClient(onClock: ((Long?, ManifestInterrupt?) -> Unit)? = null)`
  - `TelemetryClient.interruptStarted(deviceId: String, startsAt: Long)`

**Design note — deviating from the spec.** The spec proposed reattaching the back `ExoPlayer` to an overlay `PlayerView`. This task instead gives **`NativeSurface`** its own overlay player, created on demand at the window and released after. Two reasons: the decoder budget is identical (the back slot is emptied, so it is still front-paused + overlay = 2), and it is the only version that also observes when there is **no** `PlaybackView` on screen — the standby and no-content states, which the web overlay covers by construction. Update the spec's "Native surface" bullet to match.

- [ ] **Step 1: Add `standDown` / `standUp` to `PlaybackView`**

```kotlin
    /**
     * Hand the screen to a scheduled interrupt.
     *
     * Order matters: the back slot is released BEFORE the overlay player is
     * built, so the box never holds three decoders — on Amlogic that is the
     * fastest way to starve the visible one.
     *
     * The front player is PAUSED, never re-prepared: it keeps its position and
     * its codec, which is what makes the resume frame-exact.
     */
    fun standDown() {
        if (released) return
        scheduler?.pause()
        val front = exoFor(frontSlot())
        front.playWhenReady = false
        front.pause()
        setItemInSlot(backSlot(), null)
        // The watchdog does NOT exempt a paused player — left running it would
        // re-prepare the front video about 8 s into the observance.
        mainHandler.removeCallbacks(stallRunnable)
    }

    /** Take the screen back. */
    fun standUp() {
        if (released) return
        val m = manifest ?: return
        val sched = scheduler ?: return
        val frontIdx = sched.getFrontIndex()
        val backIdx = sched.getBackIndex()
        val backItem = if (backIdx == frontIdx) null else m.items.getOrNull(backIdx)
        setItemInSlot(backSlot(), backItem)
        playFrontVideoIfNeeded()
        resetProgressTracking()
        sched.resume()
        mainHandler.removeCallbacks(stallRunnable)
        mainHandler.postDelayed(stallRunnable, STALL_SAMPLE_MS)
    }
```

- [ ] **Step 2: Add the clock channel to `ManifestClient`**

Add a constructor parameter:

```kotlin
    // Invoked on EVERY successful fetch, unlike onManifest which the differ
    // gates. The window rolls to tomorrow after each fire and the clock offset
    // must stay fresh, but neither may remount the PlaybackView.
    private val onClock: ((Long?, ManifestInterrupt?) -> Unit)? = null
```

In `reconcile()`, immediately after the manifest is parsed and before `differ.onFetched(manifest)`:

```kotlin
                onClock?.invoke(manifest?.serverNow, manifest?.interrupt)
```

And in `prefetch`, keep the clip cached and un-evicted:

```kotlin
    private fun prefetch(m: Manifest) {
        val shas = m.items.map { it.sha256 }
        shas.filterNot { mediaCache.exists(it) }.forEach { sha ->
            runCatching { mediaCache.downloadSync(sha, mediaUrl(sha)) }
        }
        // The interrupt clip is not a playlist item — without this it is evicted
        // on the next playlist change and missing at 09:00.
        val keep = m.interrupt?.sha256?.let { shas + it } ?: shas
        m.interrupt?.sha256?.let { sha ->
            if (!mediaCache.exists(sha)) runCatching { mediaCache.downloadSync(sha, mediaUrl(sha)) }
        }
        mediaCache.evictExcept(keep.toSet())
    }
```

**Note:** `prefetch` currently runs only on `ManifestDecision.Emit`. Move the interrupt half of it to run on every fetch — extract it:

```kotlin
    private fun prefetchInterrupt(i: ManifestInterrupt?) {
        val sha = i?.sha256 ?: return
        if (mediaCache.exists(sha)) return
        runCatching { mediaCache.downloadSync(sha, mediaUrl(sha)) }
    }
```

…and call it from `reconcile()` right after `onClock?.invoke(...)`.

- [ ] **Step 3: Add `interruptStarted` to `TelemetryClient`**

```kotlin
    /**
     * Proof of observance: the window's startsAt, posted when the clip actually
     * begins. Carries no currentItemId — the interrupt is not a playlist item
     * and must not disturb the current item or media.play_count.
     */
    fun interruptStarted(deviceId: String, startsAt: Long) = poster.post(
        deviceId,
        buildJsonObject {
            put("apkVersion", apkVersion)
            put("surface", surface)
            put("interruptAt", startsAt)
            putVisibility()
        }.toString()
    )
```

- [ ] **Step 4: Wire `NativeSurface`**

Add fields:

```kotlin
    private val interruptTimer = InterruptTimer()
    private var interruptPlayer: ExoPlayer? = null
    private var interruptView: PlayerView? = null
    private var interruptStartsAt = 0L
    private val interruptExec = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "interrupt-tick").apply { isDaemon = true }
    }
```

Pass the clock channel when building `ManifestClient`:

```kotlin
            onClock = { serverNow, interrupt ->
                interruptTimer.setSchedule(interrupt, serverNow, System.currentTimeMillis())
            },
```

Start the tick in `start()`, beside the visibility sampler:

```kotlin
        // 500 ms so the observance starts within half a second of 09:00:00.
        interruptExec.scheduleWithFixedDelay({
            runCatching {
                if (stopped) return@runCatching
                val state = interruptTimer.observe(System.currentTimeMillis())
                onUi { applyInterrupt(state) }
            }
        }, 500, 500, TimeUnit.MILLISECONDS)
```

Add the handlers (all UI thread — ExoPlayer is not thread-safe):

```kotlin
    /** Enter or leave the interrupt window. Idempotent per state. */
    private fun applyInterrupt(state: InterruptState) {
        when (state) {
            is InterruptState.Active -> if (interruptPlayer == null) beginInterrupt(state)
            is InterruptState.Inactive -> if (interruptPlayer != null) endInterrupt()
        }
    }

    private fun beginInterrupt(state: InterruptState.Active) {
        val sha = state.schedule.sha256
        // Stand the stage down FIRST: the back slot must be released before a
        // third decoder could exist.
        playbackView?.standDown()

        val uri =
            if (mediaCache.exists(sha)) Uri.fromFile(mediaCache.file(sha))
            else Uri.parse("${BuildConfig.LANKA_SERVER_URL}/media/$sha")

        val exo = ExoPlayer.Builder(activity).build().apply {
            volume = 0f // no audio, ever
            repeatMode = Player.REPEAT_MODE_OFF
            addListener(object : Player.Listener {
                override fun onPlayerError(error: PlaybackException) {
                    // Loud, never blank: give the screen back and record it.
                    telemetry.itemFailed(deviceId, null, sha, "interrupt: ${error.errorCodeName}")
                    onUi { endInterrupt() }
                }
            })
            setMediaItem(MediaItem.fromUri(uri))
            // Joining in progress keeps every screen frame-aligned.
            if (state.offsetMs > 0) seekTo(state.offsetMs)
            prepare()
            playWhenReady = true
        }
        val view = PlayerView(activity).apply {
            useController = false
            setBackgroundColor(Color.BLACK)
            player = exo
        }
        interruptPlayer = exo
        interruptView = view
        interruptStartsAt = state.schedule.startsAt
        root.addView(view, matchParent())
        view.bringToFront()
        telemetry.interruptStarted(deviceId, interruptStartsAt)
    }

    /**
     * Leave the window. Driven by the wall clock (the tick), never by the
     * clip's own end — so a hung clip cannot hold the screen.
     */
    private fun endInterrupt() {
        interruptView?.let { v -> v.player = null; root.removeView(v) }
        interruptView = null
        interruptPlayer?.let { runCatching { it.release() } }
        interruptPlayer = null
        interruptTimer.markDone()
        playbackView?.standUp()
    }
```

In `stop()`, honour the ownership rule:

```kotlin
        endInterrupt()
        interruptExec.shutdownNow()
```

Imports to add: `androidx.media3.common.MediaItem`, `androidx.media3.common.PlaybackException`, `androidx.media3.common.Player`, `androidx.media3.exoplayer.ExoPlayer`, `androidx.media3.ui.PlayerView`, `ai.lanka.kiosk.player.InterruptState`, `ai.lanka.kiosk.player.InterruptTimer`, `ai.lanka.kiosk.player.ManifestInterrupt`.

- [ ] **Step 5: Build and test**

Run: `cd android && ./gradlew test && ./gradlew :app:assembleDebug`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/
git commit -m "feat(kiosk): native interrupt overlay — stage stands down, wall-clock end"
```

---

### Task 15: Docs, spec correction, and the release

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-07-scheduled-interrupt-design.md`
- Modify: `android/version.properties`

- [ ] **Step 1: Correct the spec's native bullet**

In the spec's *Native surface* section, replace the `PlaybackView.kt` bullet with the design actually built (see Task 14's design note): `NativeSurface` owns an overlay `ExoPlayer` created on demand, `PlaybackView` gains `standDown()`/`standUp()`. State the two reasons: identical decoder budget, and it also covers the standby / no-content screens.

Also change `suspend()`/`resume()` to `pause()`/`resume()` wherever the spec names them — `suspend` is a Kotlin keyword.

- [ ] **Step 2: Add the `CLAUDE.md` section**

Add under the player/architecture notes:

```markdown
- **A scheduled interrupt is a wall-clock overlay, not a playlist item.** The
  09:00 minute of silence is one fleet-wide row in `interrupts` (single row,
  `id = 1`, enforced in `server/services/interrupt.ts`; the window's LENGTH
  comes from `media.duration_ms`, never stored). The server publishes the next
  occurrence as an **absolute epoch** in the manifest (`interrupt.startsAt` /
  `endsAt`) plus `serverNow` — so no TV ever does timezone or DST arithmetic,
  and a box whose clock booted wrong still fires on time. The box holds the
  window from its 08:59 poll and fires **with the network down**. Three traps:
  (1) `shouldReconcile` gates `onManifest` on `playlistId:version`, so the
  interrupt rides a **separate `onClock` channel** emitted on every fetch — a
  remount would restart the playing video; (2) the interrupt's sha must be
  added to the `evictExcept` keep-list or it is evicted by the next playlist
  change and missing at 09:00; (3) **the stall watchdog must be stopped for the
  window** — it deliberately does not exempt a paused element, so leaving it on
  reloads the page ~8 s in, which looks like success while restarting the
  playlist. Resume is frame-exact because the front `<video>` is *paused, not
  torn down* (it keeps `currentTime` and its decoder — no re-prime, the thing
  that killed the Haier TV). Decoder budget stays at two: the back preload slot
  is emptied before the overlay gets a source, which is what the `arming`
  handshake exists to sequence. The overlay ends on the **wall clock**, never on
  `ended`, so a hung clip cannot hold a venue's screen. Devices with no
  playlist get a `204`, carry no schedule and **do not observe** — the
  `/schedule` page warns about them. `devices.last_interrupt_at` (posted as
  telemetry `interruptAt`) is the proof-of-observance signal; it deliberately
  does not touch `currentItemId` or `media.play_count`. Kotlin forbids a
  function named `suspend`, so both surfaces use `Scheduler.pause()/resume()`.
```

Also correct the two "**Still unverified on real hardware**, like the rest of native" notes — the native surface has now been run on a TV.

- [ ] **Step 3: Bump the APK version**

In `android/version.properties`, raise `versionName` and `versionCode`. An APK shipped under an already-reported `versionName` is indistinguishable from the running one in the dashboard, and the OTA downgrade guard cannot tell them apart.

- [ ] **Step 4: Full verification**

Run: `pnpm test && pnpm build && cd android && ./gradlew test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-07-scheduled-interrupt-design.md android/version.properties
git commit -m "docs(interrupt): CLAUDE.md notes, spec correction, APK version bump"
```

---

## On-box verification (not a code task — run before prod)

No unit test reaches the part that actually matters. Build a **production** bundle (`pnpm build` + `node .output/server/index.mjs`, never `pnpm dev` — the unbundled dev graph is too heavy for the box), point a test box at it, and set the interrupt two minutes ahead.

1. Multi-item playlist with a video playing: it pauses, and afterwards resumes **at the same second**, not from zero.
2. Single-video playlist — the freeze-prone mode — same result.
3. Image playlist: the slide does not advance during the window and honours its remaining time afterwards.
4. **No page reload during the window.** This is the watchdog gate; its failure looks like success unless you watch for it.
5. `device_errors` stays clean; `devices.last_interrupt_at` lands within a second or two of the window start, and `/schedule` shows the device as observed.
6. Late join: start the box mid-window; it enters at the right offset and still ends on time.
7. Pull the network before the window: it fires anyway, from the schedule it already holds, off the local cache.
8. Repeat on the native surface (`set-surface native`).

## Rollout

Two independent steps.

- **WebView** is server-side only: deploy, and boxes take the new bundle through the existing `playerBuild` mismatch reload. No APK needed.
- **Native** needs a release: `scripts/build-apk.sh` (never bare gradle — the fleet keystore and `LANKA_KIOSK_PIN` come from there), verify `BuildConfig.KIOSK_PIN_LENGTH == 4`, then OTA.

Sequence: server + web to the test box → verify against the checklist → prod deploy → APK for native. The migration is additive and runs from `scripts/entrypoint.sh`.
