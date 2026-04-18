import { describe, expect, it } from 'vitest'
import { backoff } from '~/app/composables/player/backoff'

describe('backoff', () => {
  it('returns 1000ms at attempt 0', () => {
    expect(backoff(0)).toBe(1000)
  })

  it('doubles per attempt: 2s, 4s, 8s, 16s', () => {
    expect(backoff(1)).toBe(2000)
    expect(backoff(2)).toBe(4000)
    expect(backoff(3)).toBe(8000)
    expect(backoff(4)).toBe(16000)
  })

  it('caps at 30 seconds', () => {
    expect(backoff(5)).toBe(30000)
    expect(backoff(10)).toBe(30000)
    expect(backoff(99)).toBe(30000)
  })
})
