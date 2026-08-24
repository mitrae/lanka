import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useOrganizationsStore } from '~/app/stores/organizations'
import type { Organization } from '~/app/types/api'

function org(id: number, name: string, over: Partial<Organization> = {}): Organization {
  return {
    id,
    name,
    phone: null,
    email: null,
    notes: null,
    mediaCount: 0,
    userCount: 0,
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

const acme = org(1, 'Acme')
const beta = org(2, 'Beta')

function api(over: Record<string, unknown> = {}) {
  return {
    listOrganizations: async () => [],
    createOrganization: async () => acme,
    updateOrganization: async () => acme,
    deleteOrganization: async () => {},
    ...over
  }
}

describe('organizations store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('refresh loads the list', async () => {
    const s = useOrganizationsStore()
    s.$patch({ _api: api({ listOrganizations: async () => [acme, beta] }) })
    await s.refresh()
    expect(s.list).toEqual([acme, beta])
  })

  it('refresh records the error instead of throwing', async () => {
    const s = useOrganizationsStore()
    s.$patch({ _api: api({ listOrganizations: async () => { throw new Error('boom') } }) })
    await s.refresh()
    expect(s.error).toBe('boom')
    expect(s.loading).toBe(false)
  })

  it('create inserts in alphabetical order', async () => {
    const s = useOrganizationsStore()
    s.$patch({ list: [beta], _api: api({ createOrganization: async () => acme }) })
    await s.create({ name: 'Acme' })
    expect(s.list.map((o) => o.name)).toEqual(['Acme', 'Beta'])
  })

  it('update replaces the row and re-sorts', async () => {
    const s = useOrganizationsStore()
    const renamed = org(2, 'Aardvark')
    const updateOrganization = vi.fn(async () => renamed)
    s.$patch({ list: [acme, beta], _api: api({ updateOrganization }) })
    await s.update(2, { name: 'Aardvark' })
    expect(updateOrganization).toHaveBeenCalledWith(2, { name: 'Aardvark' })
    expect(s.list.map((o) => o.name)).toEqual(['Aardvark', 'Acme'])
  })

  it('remove passes force through and drops the row', async () => {
    const s = useOrganizationsStore()
    const deleteOrganization = vi.fn(async () => {})
    s.$patch({ list: [acme, beta], _api: api({ deleteOrganization }) })
    await s.remove(1, { force: true })
    expect(deleteOrganization).toHaveBeenCalledWith(1, { force: true })
    expect(s.list.map((o) => o.id)).toEqual([2])
  })
})
