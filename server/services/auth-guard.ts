import type { Role, SessionUser } from './sessions'

const PUBLIC_EXACT = new Set<string>(['/api/healthz', '/api/devices/register'])
const PUBLIC_DEVICE_RE = /^\/api\/devices\/[^/]+\/(manifest|stream|telemetry|ws)$/

export function isPublicRoute(path: string): boolean {
  const clean = path.split('?')[0]
  if (PUBLIC_EXACT.has(clean)) return true
  if (clean.startsWith('/api/auth/')) return true
  if (PUBLIC_DEVICE_RE.test(clean)) return true
  return false
}

export type AuthDecision = { ok: true } | { ok: false; status: 401 | 403 }

export function decideAccess(path: string, user: SessionUser | null): AuthDecision {
  const clean = path.split('?')[0]
  if (isPublicRoute(clean)) return { ok: true }
  if (!clean.startsWith('/api/')) return { ok: true } // SPA pages/assets — guarded client-side
  if (!user) return { ok: false, status: 401 }
  if (clean.startsWith('/api/portal/')) {
    return user.role === 'client' ? { ok: true } : { ok: false, status: 403 }
  }
  return user.role === 'admin' || user.role === 'super'
    ? { ok: true }
    : { ok: false, status: 403 }
}

export function requireRole(
  user: SessionUser | null | undefined,
  roles: Role[]
): SessionUser {
  if (!user) throw createError({ statusCode: 401, message: 'Authentication required' })
  if (!roles.includes(user.role)) {
    throw createError({ statusCode: 403, message: 'Insufficient permissions' })
  }
  return user
}
