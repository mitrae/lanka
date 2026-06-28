import { describe, it, expect } from 'vitest'
import {
  generateDeviceSecret,
  hashDeviceSecret,
  decideWsAuth
} from '~/server/services/device-secret'

describe('device secret generation/hashing', () => {
  it('hashDeviceSecret is deterministic sha256 hex', () => {
    const h = hashDeviceSecret('abc')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(hashDeviceSecret('abc')).toBe(h)
    expect(hashDeviceSecret('abd')).not.toBe(h)
  })

  it('generateDeviceSecret returns a raw token whose hash matches, unique per call', () => {
    const a = generateDeviceSecret()
    expect(a.raw.length).toBeGreaterThan(20)
    expect(a.hash).toBe(hashDeviceSecret(a.raw))
    expect(generateDeviceSecret().raw).not.toBe(a.raw)
  })
})

describe('decideWsAuth (ratchet TOFU)', () => {
  const H = 'a'.repeat(64)
  const OTHER = 'b'.repeat(64)

  it('rejects an unknown device', () => {
    const d = decideWsAuth({ exists: false, storedHash: null, active: false, presentedHash: null })
    expect(d.allow).toBe(false)
    expect(d.closeCode).toBe(1008)
  })

  it('active: allows a matching secret without re-activating', () => {
    expect(decideWsAuth({ exists: true, storedHash: H, active: true, presentedHash: H }))
      .toMatchObject({ allow: true, activate: false })
  })

  it('active: rejects a missing or wrong secret', () => {
    expect(decideWsAuth({ exists: true, storedHash: H, active: true, presentedHash: null }).allow).toBe(false)
    expect(decideWsAuth({ exists: true, storedHash: H, active: true, presentedHash: OTHER }).allow).toBe(false)
  })

  it('inactive: a correct secret ratchets enforcement on', () => {
    expect(decideWsAuth({ exists: true, storedHash: H, active: false, presentedHash: H }))
      .toMatchObject({ allow: true, activate: true })
  })

  it('inactive: grace-allows no/wrong secret without activating', () => {
    expect(decideWsAuth({ exists: true, storedHash: H, active: false, presentedHash: null }))
      .toMatchObject({ allow: true, activate: false })
    expect(decideWsAuth({ exists: true, storedHash: H, active: false, presentedHash: OTHER }))
      .toMatchObject({ allow: true, activate: false })
  })

  it('inactive device with no stored secret grace-allows', () => {
    expect(decideWsAuth({ exists: true, storedHash: null, active: false, presentedHash: null }))
      .toMatchObject({ allow: true, activate: false })
  })
})
