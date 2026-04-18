// app/stores/addresses.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Address } from '~/app/types/api'

interface State {
  list: Address[]
  loading: boolean
  error: string | null
  _api: Pick<
    ApiClient,
    'listAddresses' | 'createAddress' | 'updateAddress' | 'deleteAddress'
  >
}

export const useAddressesStore = defineStore('addresses', {
  state: (): State => ({
    list: [],
    loading: false,
    error: null,
    _api: useApiClient()
  }),

  actions: {
    async refresh() {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listAddresses()
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },
    async create(body: { name: string }): Promise<Address> {
      const row = await this._api.createAddress(body)
      this.list.push(row)
      return row
    },
    async update(id: number, body: { name: string }): Promise<Address> {
      const row = await this._api.updateAddress(id, body)
      const idx = this.list.findIndex((x) => x.id === id)
      if (idx >= 0) this.list[idx] = row
      return row
    },
    async delete(id: number): Promise<void> {
      await this._api.deleteAddress(id)
      this.list = this.list.filter((x) => x.id !== id)
    }
  }
})
