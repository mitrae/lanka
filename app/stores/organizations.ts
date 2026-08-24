import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Organization, OrganizationInput } from '~/app/types/api'

interface State {
  list: Organization[]
  loading: boolean
  error: string | null
  _api: Pick<
    ApiClient,
    | 'listOrganizations'
    | 'createOrganization'
    | 'updateOrganization'
    | 'deleteOrganization'
  >
}

const byName = (a: Organization, b: Organization) => a.name.localeCompare(b.name)

export const useOrganizationsStore = defineStore('organizations', {
  state: (): State => ({ list: [], loading: false, error: null, _api: useApiClient() }),
  actions: {
    async refresh() {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listOrganizations()
      } catch (e: any) {
        this.error = e?.message ?? String(e)
      } finally {
        this.loading = false
      }
    },
    async create(input: OrganizationInput & { name: string }) {
      const org = await this._api.createOrganization(input)
      this.list = [...this.list, org].sort(byName)
      return org
    },
    async update(id: number, patch: OrganizationInput) {
      const org = await this._api.updateOrganization(id, patch)
      this.list = this.list.map((o) => (o.id === id ? org : o)).sort(byName)
      return org
    },
    async remove(id: number, opts: { force?: boolean } = {}) {
      await this._api.deleteOrganization(id, opts)
      this.list = this.list.filter((o) => o.id !== id)
    }
  }
})
