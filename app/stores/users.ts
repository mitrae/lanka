import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { CreateUserBody, User } from '~/app/types/api'

interface State {
  list: User[]
  loading: boolean
  error: string | null
  _api: Pick<ApiClient, 'listUsers' | 'createUser' | 'deleteUser'>
}

export const useUsersStore = defineStore('users', {
  state: (): State => ({ list: [], loading: false, error: null, _api: useApiClient() }),
  actions: {
    async refresh() {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listUsers()
      } catch (e: any) {
        this.error = e?.message ?? String(e)
      } finally {
        this.loading = false
      }
    },
    /** Creates a user and returns the one-time generated password. */
    async create(body: CreateUserBody): Promise<string> {
      const { user, generatedPassword } = await this._api.createUser(body)
      this.list = [
        ...this.list,
        { ...user, organizationName: null, createdAt: new Date().toISOString() }
      ].sort((a, b) => a.email.localeCompare(b.email))
      return generatedPassword
    },
    async remove(id: number): Promise<void> {
      await this._api.deleteUser(id)
      this.list = this.list.filter((u) => u.id !== id)
    }
  }
})
