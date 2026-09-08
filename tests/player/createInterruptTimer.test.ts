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

  it('goes inactive when the schedule is withdrawn', () => {
    const t = createInterruptTimer()
    t.setSchedule(sched, START, START)
    expect(t.observe(START).active).toBe(true)
    t.setSchedule(null, null, START)
    expect(t.observe(START).active).toBe(false)
  })
})
