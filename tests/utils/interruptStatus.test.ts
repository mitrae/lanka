import { describe, it, expect } from 'vitest'
import { deviceInterruptOutcome } from '~/app/utils/interruptStatus'

const enabledConfig = { enabled: true, atMinutes: 540 } // 09:00

describe('deviceInterruptOutcome', () => {
  it('is "missed" the instant the scheduled minute arrives (boundary: >=)', () => {
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null },
      enabledConfig,
      540
    )).toBe('missed')
  })

  it('is "notYet" one minute before the scheduled minute', () => {
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null },
      enabledConfig,
      539
    )).toBe('notYet')
  })

  it('is "observed" once the device reported today\'s occurrence, regardless of the clock', () => {
    expect(deviceInterruptOutcome(
      { observedToday: true, lastInterruptAt: 1_700_000_000_000 },
      enabledConfig,
      0
    )).toBe('observed')
  })

  it('observedToday true with a null lastInterruptAt does NOT count as observed', () => {
    // Defensive: the two fields should never disagree in practice, but the
    // label is the truth an operator acts on -- never claim an observed time
    // that doesn't exist.
    expect(deviceInterruptOutcome(
      { observedToday: true, lastInterruptAt: null },
      enabledConfig,
      600
    )).toBe('missed')
  })

  it('is "notScheduled" when there is no config at all', () => {
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null },
      null,
      600
    )).toBe('notScheduled')
  })

  it('is "notScheduled" when the config exists but is disabled, even long past atMinutes', () => {
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null },
      { enabled: false, atMinutes: 540 },
      1439
    )).toBe('notScheduled')
  })

  it('the >= boundary holds at the day\'s edges too (atMinutes: 0, midnight)', () => {
    const config = { enabled: true, atMinutes: 0 }
    expect(deviceInterruptOutcome({ observedToday: false, lastInterruptAt: null }, config, 0)).toBe('missed')
    expect(deviceInterruptOutcome({ observedToday: false, lastInterruptAt: null }, config, 1439)).toBe('missed')
  })
})
