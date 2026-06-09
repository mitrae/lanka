import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '~/app/stores/auth'
import type { SessionUser } from '~/app/types/api'

const admin: SessionUser = { id: 1, email: 'admin', role: 'admin', organizationId: null }

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

  it('fetchMe clears the user on 401', async () => {
    const s = useAuthStore()
    s.$patch({ _api: { me: async () => { throw new Error('401') }, login: async () => ({ user: admin }), loginWithGoogle: async () => ({ user: admin }), logout: async () => {} } })
    await s.fetchMe()
    expect(s.user).toBeNull()
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
