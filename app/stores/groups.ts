// app/stores/groups.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Group } from '~/app/types/api'

interface State {
  list: Group[]
  loading: boolean
  error: string | null
  _api: Pick<
    ApiClient,
    'listGroups' | 'createGroup' | 'updateGroup' | 'deleteGroup'
  >
}

export const useGroupsStore = defineStore('groups', {
  state: (): State => ({
    list: [],
    loading: false,
    error: null,
    _api: useApiClient()
  }),
  actions: {
    async refresh(filters: { addressId?: number } = {}) {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listGroups(filters)
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },
    async create(body: { addressId: number; name: string }): Promise<Group> {
      const row = await this._api.createGroup(body)
      this.list.push(row)
      return row
    },
    async update(
      id: number,
      body: { name?: string; addressId?: number }
    ): Promise<Group> {
      const row = await this._api.updateGroup(id, body)
      const idx = this.list.findIndex((x) => x.id === id)
      if (idx >= 0) this.list[idx] = row
      return row
    },
    async delete(id: number): Promise<void> {
      await this._api.deleteGroup(id)
      this.list = this.list.filter((x) => x.id !== id)
    }
  }
})
