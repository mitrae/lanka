import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore, isUnauthorizedError } from '~/app/stores/auth'
import type { SessionUser } from '~/app/types/api'

vi.mock('~/app/composables/useDashboardStream', () => ({
  _resetDashboardStream: vi.fn(),
  useDashboardStream: vi.fn()
}))

const admin: SessionUser = { id: 1, email: 'admin', role: 'admin', organizationId: null }

describe('isUnauthorizedError', () => {
  it('matches a genuine 401 across error shapes', () => {
    expect(isUnauthorizedError({ statusCode: 401 })).toBe(true)
    expect(isUnauthorizedError({ status: 401 })).toBe(true)
    expect(isUnauthorizedError({ response: { status: 401 } })).toBe(true)
  })

  it('does not match other / transient failures', () => {
    expect(isUnauthorizedError({ statusCode: 500 })).toBe(false)
    expect(isUnauthorizedError(new Error('Failed to fetch'))).toBe(false)
    expect(isUnauthorizedError(null)).toBe(false)
    expect(isUnauthorizedError(undefined)).toBe(false)
  })
})

describe('auth store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('fetchMe sets the user on success', async () => {
    const s = useAuthStore()
    s.$patch({ _api: { me: async () => ({ user: admin }), login: async () => ({ user: admin }), loginWithGoogle: async () => ({ user: admin }), logout: async () => {} } })
    await s.fetchMe()
    expect(s.user).toEqual(admin)
    expect(s.isAuthenticated).toBe(true)
    expect(s.ready).toBe(true)
  })

  it('fetchMe clears the user on a genuine 401', async () => {
    const s = useAuthStore()
    s.user = admin
    s.$patch({ _api: { me: async () => { throw { statusCode: 401 } }, login: async () => ({ user: admin }), loginWithGoogle: async () => ({ user: admin }), logout: async () => {} } })
    await s.fetchMe()
    expect(s.user).toBeNull()
    expect(s.isAuthenticated).toBe(false)
    expect(s.error).toBe(false)
    expect(s.ready).toBe(true)
  })

  it('fetchMe preserves a logged-in user on a transient 500', async () => {
    const s = useAuthStore()
    s.user = admin
    s.$patch({ _api: { me: async () => { throw { statusCode: 500 } }, login: async () => ({ user: admin }), loginWithGoogle: async () => ({ user: admin }), logout: async () => {} } })
    await s.fetchMe()
    expect(s.user).toEqual(admin)
    expect(s.isAuthenticated).toBe(true)
    expect(s.error).toBe(true)
    expect(s.ready).toBe(true)
  })

  it('fetchMe preserves prior state on a network error', async () => {
    const s = useAuthStore()
    s.user = admin
    s.$patch({ _api: { me: async () => { throw new Error('Failed to fetch') }, login: async () => ({ user: admin }), loginWithGoogle: async () => ({ user: admin }), logout: async () => {} } })
    await s.fetchMe()
    expect(s.user).toEqual(admin)
    expect(s.isAuthenticated).toBe(true)
    expect(s.error).toBe(true)
    expect(s.ready).toBe(true)
  })

  it('login stores the returned user', async () => {
    const s = useAuthStore()
    s.$patch({ _api: { me: async () => ({ user: admin }), login: async () => ({ user: admin }), loginWithGoogle: async () => ({ user: admin }), logout: async () => {} } })
    const u = await s.login('admin', 'pw')
    expect(u).toEqual(admin)
    expect(s.role).toBe('admin')
  })

  it('loginWithGoogle stores the returned user', async () => {
    const s = useAuthStore()
    s.$patch({ _api: {
      me: async () => ({ user: admin }),
      login: async () => ({ user: admin }),
      loginWithGoogle: async () => ({ user: admin }),
      logout: async () => {}
    } })
    const u = await s.loginWithGoogle('fake-credential')
    expect(u).toEqual(admin)
    expect(s.role).toBe('admin')
    expect(s.ready).toBe(true)
  })
})
