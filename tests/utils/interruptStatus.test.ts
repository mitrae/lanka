import { describe, it, expect } from 'vitest'
import { deviceInterruptOutcome } from '~/app/utils/interruptStatus'

const enabledConfig = { enabled: true, atMinutes: 540 } // 09:00

describe('deviceInterruptOutcome', () => {
  it('is "missed" the instant the scheduled minute arrives (boundary: >=)', () => {
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null, hasPlaylist: true },
      enabledConfig,
      540
    )).toBe('missed')
  })

  it('is "notYet" one minute before the scheduled minute', () => {
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null, hasPlaylist: true },
      enabledConfig,
      539
    )).toBe('notYet')
  })

  it('is "observed" once the device reported today\'s occurrence, regardless of the clock', () => {
    expect(deviceInterruptOutcome(
      { observedToday: true, lastInterruptAt: 1_700_000_000_000, hasPlaylist: true },
      enabledConfig,
      0
    )).toBe('observed')
  })

  it('observedToday true with a null lastInterruptAt does NOT count as observed', () => {
    // Defensive: the two fields should never disagree in practice, but the
    // label is the truth an operator acts on -- never claim an observed time
    // that doesn't exist.
    expect(deviceInterruptOutcome(
      { observedToday: true, lastInterruptAt: null, hasPlaylist: true },
      enabledConfig,
      600
    )).toBe('missed')
  })

  it('is "inProgress", never "missed", while today\'s window is still running', () => {
    // From 09:00:00 the minute comparison alone reads >= atMinutes, but no
    // device can have posted its observance yet — the clip is decoding its
    // first frame and telemetry lands a second later. Painting the whole
    // fleet red for that minute is the false alarm this page must never raise.
    const window = { startsAt: 1_800_000_000_000, endsAt: 1_800_000_060_000 }
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null, hasPlaylist: true },
      enabledConfig,
      540,
      window,
      1_800_000_005_000
    )).toBe('inProgress')
  })

  it('is "missed" once today\'s window has ended, even if the next window is loaded', () => {
    const window = { startsAt: 1_800_000_000_000, endsAt: 1_800_000_060_000 }
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null, hasPlaylist: true },
      enabledConfig,
      541,
      window,
      1_800_000_060_000
    )).toBe('missed')
  })

  it('a reported observance beats "inProgress"', () => {
    const window = { startsAt: 1_800_000_000_000, endsAt: 1_800_000_060_000 }
    expect(deviceInterruptOutcome(
      { observedToday: true, lastInterruptAt: 1_800_000_000_000, hasPlaylist: true },
      enabledConfig,
      540,
      window,
      1_800_000_005_000
    )).toBe('observed')
  })

  it('is "notScheduled" when there is no config at all', () => {
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null, hasPlaylist: true },
      null,
      600
    )).toBe('notScheduled')
  })

  it('is "notScheduled" when the config exists but is disabled, even long past atMinutes', () => {
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null, hasPlaylist: true },
      { enabled: false, atMinutes: 540 },
      1439
    )).toBe('notScheduled')
  })

  it('is "cannotObserve", never "missed", for a device with no playlist', () => {
    // A device with no assigned playlist receives a 204, carries no schedule,
    // and cannot observe. Rendering it red "Missed" every day forever is an
    // accusation, not a warning.
    expect(deviceInterruptOutcome(
      { observedToday: false, lastInterruptAt: null, hasPlaylist: false },
      enabledConfig,
      600
    )).toBe('cannotObserve')
  })

  it('a reported observance beats the no-playlist inference', () => {
    // Ordering matters: a stale resolver read or a race with an assignment
    // change must never overwrite what the device itself reported.
    expect(deviceInterruptOutcome(
      { observedToday: true, lastInterruptAt: 1_700_000_000_000, hasPlaylist: false },
      enabledConfig,
      600
    )).toBe('observed')
  })

  it('the >= boundary holds at the day\'s edges too (atMinutes: 0, midnight)', () => {
    const config = { enabled: true, atMinutes: 0 }
    expect(deviceInterruptOutcome({ observedToday: false, lastInterruptAt: null, hasPlaylist: true }, config, 0)).toBe('missed')
    expect(deviceInterruptOutcome({ observedToday: false, lastInterruptAt: null, hasPlaylist: true }, config, 1439)).toBe('missed')
  })
})
