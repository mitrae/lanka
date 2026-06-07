import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '~/server/services/password'

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('hunter2')
    expect(await verifyPassword('hunter2', hash)).toBe(true)
  })
  it('rejects a wrong password', async () => {
    const hash = await hashPassword('hunter2')
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })
  it('produces a self-describing scrypt string with a unique salt', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a.startsWith('scrypt$')).toBe(true)
    expect(a).not.toEqual(b) // random salt
  })
  it('returns false for a malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
  })
})
