import { describe, it, expect } from 'vitest'
import { quickTestAtMinutes } from '~/app/utils/interruptQuickTest'

// The wall-clock minute is floored, so "now" can be anywhere inside it. The
// target must therefore be N+1 minutes on: N alone would put a "+1 min" test
// fired at hh:mm:59 one second away — too soon for the SSE kick, let alone the
// 30 s poll fallback when a box's stream is half-open.
describe('quickTestAtMinutes', () => {
  it('schedules N+1 minutes past the current (floored) minute', () => {
    expect(quickTestAtMinutes(14 * 60 + 31, 1)).toBe(14 * 60 + 33)
    expect(quickTestAtMinutes(14 * 60 + 31, 5)).toBe(14 * 60 + 37)
  })

  it('always leaves at least N whole minutes of lead, wherever "now" sits in its minute', () => {
    for (const n of [1, 2, 5]) {
      const now = 600
      const target = quickTestAtMinutes(now, n)
      // Worst case "now" is the last second of the floored minute: now + 59 s.
      const worstCaseLeadSeconds = target * 60 - (now * 60 + 59)
      expect(worstCaseLeadSeconds).toBeGreaterThanOrEqual(n * 60)
    }
  })

  it('wraps past midnight', () => {
    expect(quickTestAtMinutes(23 * 60 + 59, 1)).toBe(1) // 00:01
    expect(quickTestAtMinutes(23 * 60 + 58, 5)).toBe(4) // 00:04
  })
})
