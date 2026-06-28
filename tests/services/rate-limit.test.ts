import { describe, it, expect } from 'vitest'
import { RateLimiter, pickClientIp } from '~/server/services/rate-limit'

describe('pickClientIp', () => {
  it('prefers X-Real-IP (set by nginx to the real peer; unspoofable)', () => {
    expect(
      pickClientIp({ xRealIp: '100.64.0.5', xForwardedFor: 'evil', remoteAddr: '127.0.0.1' })
    ).toBe('100.64.0.5')
  })

  it('ignores an attacker-prepended X-Forwarded-For and uses the rightmost (nginx-appended) hop', () => {
    // nginx appends the real peer, so the trustworthy value is the LAST entry.
    expect(
      pickClientIp({ xRealIp: null, xForwardedFor: '1.2.3.4, 5.6.7.8, 100.64.0.5' })
    ).toBe('100.64.0.5')
  })

  it('uses a single X-Forwarded-For value when there is one hop', () => {
    expect(pickClientIp({ xForwardedFor: '100.64.0.9' })).toBe('100.64.0.9')
  })

  it('falls back to the socket remote address, then unknown', () => {
    expect(pickClientIp({ remoteAddr: '10.0.0.1' })).toBe('10.0.0.1')
    expect(pickClientIp({})).toBe('unknown')
  })

  it('trims whitespace', () => {
    expect(pickClientIp({ xRealIp: '  100.64.0.5  ' })).toBe('100.64.0.5')
  })
})

describe('RateLimiter', () => {
  it('allows up to max hits then denies within the window', () => {
    const rl = new RateLimiter({ windowMs: 1000, max: 3, now: () => 1000 })
    expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('a').allowed).toBe(true)
    const third = rl.hit('a')
    expect(third.allowed).toBe(true)
    expect(third.remaining).toBe(0)
    const fourth = rl.hit('a')
    expect(fourth.allowed).toBe(false)
    expect(fourth.retryAfterMs).toBeGreaterThan(0)
  })

  it('resets after the window elapses', () => {
    let t = 0
    const rl = new RateLimiter({ windowMs: 1000, max: 1, now: () => t })
    expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('a').allowed).toBe(false)
    t = 1000 // window elapsed
    expect(rl.hit('a').allowed).toBe(true)
  })

  it('tracks keys independently', () => {
    const rl = new RateLimiter({ windowMs: 1000, max: 1, now: () => 0 })
    expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('b').allowed).toBe(true) // separate key, own budget
    expect(rl.hit('a').allowed).toBe(false)
  })

  it('reports retryAfterMs as the time left in the window', () => {
    let t = 0
    const rl = new RateLimiter({ windowMs: 1000, max: 1, now: () => t })
    rl.hit('a')
    t = 400
    const d = rl.hit('a')
    expect(d.allowed).toBe(false)
    expect(d.retryAfterMs).toBe(600)
  })

  it('sweeps expired entries so the map does not grow unbounded', () => {
    let t = 0
    const rl = new RateLimiter({ windowMs: 1000, max: 5, now: () => t })
    rl.hit('a'); rl.hit('b'); rl.hit('c')
    expect(rl.size()).toBe(3)
    t = 5000 // well past the window
    rl.hit('d') // a hit far past the window triggers a sweep of expired keys
    expect(rl.size()).toBe(1)
  })
})
