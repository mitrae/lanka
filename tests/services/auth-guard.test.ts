import { describe, it, expect } from 'vitest'
import { isPublicRoute, decideAccess, requireRole } from '~/server/services/auth-guard'
import type { SessionUser } from '~/server/services/sessions'

const admin: SessionUser = { id: 1, email: 'a', role: 'admin', organizationId: null }
const client: SessionUser = { id: 2, email: 'c', role: 'client', organizationId: 9 }

describe('isPublicRoute — device endpoints must stay open', () => {
  const open = [
    '/api/healthz',
    '/api/auth/login',
    '/api/auth/me',
    '/api/devices/register',
    '/api/devices/abc123/manifest',
    '/api/devices/abc123/stream',
    '/api/devices/abc123/telemetry'
  ]
  it.each(open)('treats %s as public', (p) => expect(isPublicRoute(p)).toBe(true))

  const closed = [
    '/api/devices',
    '/api/devices/abc123',
    '/api/devices/abc123/reload',
    '/api/media',
    '/api/dashboard/stream'
  ]
  it.each(closed)('treats %s as protected', (p) => expect(isPublicRoute(p)).toBe(false))
})

describe('decideAccess', () => {
  it('allows public routes with no user', () => {
    expect(decideAccess('/api/devices/x/manifest', null)).toEqual({ ok: true })
  })
  it('allows non-api paths (SPA pages/assets) with no user', () => {
    expect(decideAccess('/login', null)).toEqual({ ok: true })
    expect(decideAccess('/_nuxt/entry.js', null)).toEqual({ ok: true })
  })
  it('401s a protected api route with no user', () => {
    expect(decideAccess('/api/media', null)).toEqual({ ok: false, status: 401 })
  })
  it('403s a client hitting the dashboard tier', () => {
    expect(decideAccess('/api/media', client)).toEqual({ ok: false, status: 403 })
  })
  it('allows admin on the dashboard tier', () => {
    expect(decideAccess('/api/media', admin)).toEqual({ ok: true })
  })
  it('allows client on the portal tier, 403s admin', () => {
    expect(decideAccess('/api/portal/stats', client)).toEqual({ ok: true })
    expect(decideAccess('/api/portal/stats', admin)).toEqual({ ok: false, status: 403 })
  })
})

describe('requireRole', () => {
  it('returns the user when role matches', () => {
    expect(requireRole(admin, ['admin', 'super'])).toBe(admin)
  })
  it('throws 401 when no user', () => {
    expect(() => requireRole(null, ['admin'])).toThrow(/required/i)
  })
  it('throws 403 when role mismatches', () => {
    expect(() => requireRole(client, ['admin', 'super'])).toThrow(/permission/i)
  })
})
