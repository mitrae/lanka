import type { H3Event } from 'h3'
// createError / getRequestHeader / setResponseHeader are Nitro auto-imports
// (globals at runtime; stubbed in tests). They're only referenced inside the
// request helpers below, which tests never invoke (tests hit the pure handlers).

export interface RateLimitOptions {
  windowMs: number
  max: number
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number
}

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

/**
 * In-memory fixed-window rate limiter. The app runs as a single Nitro process
 * bound to loopback, so a process-local Map is sufficient (no Redis).
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()
  private lastSweep: number
  private readonly clock: () => number

  constructor(private readonly opts: RateLimitOptions) {
    this.clock = opts.now ?? Date.now
    this.lastSweep = this.clock()
  }

  hit(key: string): RateLimitDecision {
    const now = this.clock()
    this.maybeSweep(now)

    const entry = this.hits.get(key)
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.opts.windowMs })
      return { allowed: true, remaining: this.opts.max - 1, retryAfterMs: 0 }
    }
    if (entry.count >= this.opts.max) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now }
    }
    entry.count++
    return { allowed: true, remaining: this.opts.max - entry.count, retryAfterMs: 0 }
  }

  /** Drop expired entries at most once per window so the Map can't grow forever. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.opts.windowMs) return
    this.lastSweep = now
    for (const [k, v] of this.hits) {
      if (now >= v.resetAt) this.hits.delete(k)
    }
  }

  size(): number {
    return this.hits.size
  }

  reset(): void {
    this.hits.clear()
    this.lastSweep = this.clock()
  }
}

const MIN = 60_000

/**
 * Shared limiter instances. Per-account (email) limits are the primary, IP-
 * independent brute-force/flood protection; per-IP limits are a generous backstop
 * that is only as accurate as the client IP nginx forwards (X-Forwarded-For) —
 * if the tailnet nginx block doesn't set it, per-IP collapses toward per-proxy,
 * so the per-account limits carry the real weight.
 */
export const authLimiters = {
  loginIp: new RateLimiter({ windowMs: 15 * MIN, max: 100 }),
  loginAccount: new RateLimiter({ windowMs: 15 * MIN, max: 8 }),
  forgotIp: new RateLimiter({ windowMs: 60 * MIN, max: 60 }),
  forgotAccount: new RateLimiter({ windowMs: 60 * MIN, max: 4 }),
  googleIp: new RateLimiter({ windowMs: 15 * MIN, max: 60 }),
  // Generous: a subnet-router/Linux player fronts many boxes under one tailnet IP,
  // and boxes re-register on each reconcile error, so a fleet boot/outage storm
  // must not 429 legit registrations. Only job is bounding runaway row creation.
  registerIp: new RateLimiter({ windowMs: 1 * MIN, max: 600 })
}

/**
 * Pick the client IP from proxy headers, trusting only values a client can't
 * forge. X-Real-IP is primary: nginx OVERWRITES it with `$remote_addr` (the TCP
 * peer it sees), so it can't be spoofed. X-Forwarded-For is NOT trusted at its
 * leftmost entry — nginx APPENDS the real peer to whatever the client sent, so
 * the leftmost is attacker-controlled (it would let an attacker rotate the key);
 * we take the RIGHTMOST hop (the one nginx appended) as a fallback when X-Real-IP
 * is absent (non-nginx/dev), then the socket address.
 *
 * Caveat: on the public Cloudflare path `$remote_addr` is cloudflared's loopback,
 * so per-IP collapses to one bucket there — acceptable (dashboard is small and
 * per-account limits are the real guard). True per-IP on that path needs nginx
 * `real_ip` config trusting Cloudflare ranges (manual follow-up).
 */
export function pickClientIp(h: {
  xRealIp?: string | null
  xForwardedFor?: string | null
  remoteAddr?: string | null
}): string {
  if (h.xRealIp && h.xRealIp.trim()) return h.xRealIp.trim()
  if (h.xForwardedFor && h.xForwardedFor.trim()) {
    const parts = h.xForwardedFor.split(',')
    return parts[parts.length - 1]!.trim()
  }
  return h.remoteAddr?.trim() || 'unknown'
}

/** Best-effort, spoof-resistant client IP for keying rate limits. */
export function clientIp(event: H3Event): string {
  return pickClientIp({
    xRealIp: getRequestHeader(event, 'x-real-ip') ?? null,
    xForwardedFor: getRequestHeader(event, 'x-forwarded-for') ?? null,
    remoteAddr: event.node?.req?.socket?.remoteAddress ?? null
  })
}

/** Count a hit against [limiter]/[key]; throw 429 (+ Retry-After) when over. */
export function enforceRateLimit(event: H3Event, limiter: RateLimiter, key: string): void {
  const d = limiter.hit(key)
  if (!d.allowed) {
    setResponseHeader(event, 'Retry-After', Math.ceil(d.retryAfterMs / 1000).toString())
    throw createError({
      statusCode: 429,
      statusMessage: 'Too Many Requests',
      message: 'Too many requests — please wait and try again.'
    })
  }
}
