import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUsersStore } from '~/app/stores/users'
import type { User } from '~/app/types/api'

const client: User = { id: 3, email: 'c@x', role: 'client', organizationId: 1, organizationName: 'Acme', createdAt: '' }

describe('users store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('refresh loads the list', async () => {
    const s = useUsersStore()
    s.$patch({ _api: {
      listUsers: async () => [client],
      createUser: async () => ({ user: { id: 9, email: 'n@x', role: 'admin', organizationId: null }, generatedPassword: 'pw' }),
      deleteUser: async () => {}
    } })
    await s.refresh()
    expect(s.list).toEqual([client])
  })

  it('create returns the one-time password and adds the row', async () => {
    const s = useUsersStore()
    s.$patch({ _api: {
      listUsers: async () => [],
      createUser: async () => ({ user: { id: 9, email: 'n@x', role: 'admin', organizationId: null }, generatedPassword: 'secret' }),
      deleteUser: async () => {}
    } })
    const pw = await s.create({ email: 'n@x', role: 'admin' })
    expect(pw).toBe('secret')
    expect(s.list.find((u) => u.id === 9)?.email).toBe('n@x')
  })

  it('remove drops the row', async () => {
    const s = useUsersStore()
    s.$patch({ list: [client], _api: {
      listUsers: async () => [client], createUser: async () => ({} as any), deleteUser: async () => {}
    } })
    await s.remove(client.id)
    expect(s.list).toHaveLength(0)
  })
})
