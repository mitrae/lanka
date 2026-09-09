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

  it('publishes the DST-Sunday window from the last local hour before spring-forward', () => {
    // Sat 2026-03-28 23:30 EET. The spring-forward day is 23 h long, so +24 h
    // of epoch is already Mon 00:30 EEST — a day walk over epoch skipped
    // Sunday entirely and told every box polling in that hour to wait for
    // Monday.
    const now = at('2026-03-28T23:30:00+02:00')
    const w = nextWindow(now, AT_9AM, KYIV, MIN)
    expect(w!.startsAt).toBe(at('2026-03-29T09:00:00+03:00'))
  })

  it('still finds tomorrow\'s early window just after midnight on the fall-back day', () => {
    // Sun 2026-10-25 00:30 EEST with a 00:10 window: the day is 25 h long, so
    // +24 h of epoch is still Sunday 23:30 EET and the walk found no
    // not-yet-ended occurrence at all.
    const now = at('2026-10-25T00:30:00+03:00')
    const w = nextWindow(now, 10, KYIV, MIN)
    expect(w!.startsAt).toBe(at('2026-10-26T00:10:00+02:00'))
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
