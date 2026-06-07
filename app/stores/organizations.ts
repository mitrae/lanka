import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Organization } from '~/app/types/api'

interface State {
  list: Organization[]
  loading: boolean
  error: string | null
  _api: Pick<ApiClient, 'listOrganizations' | 'createOrganization'>
}

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
    async create(name: string) {
      const org = await this._api.createOrganization({ name })
      this.list = [...this.list, org].sort((a, b) => a.name.localeCompare(b.name))
      return org
    }
  }
})
