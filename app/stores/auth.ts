import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Role, SessionUser } from '~/app/types/api'

interface State {
  user: SessionUser | null
  ready: boolean
  _api: Pick<ApiClient, 'login' | 'logout' | 'me'>
}

export const useAuthStore = defineStore('auth', {
  state: (): State => ({ user: null, ready: false, _api: useApiClient() }),
  getters: {
    isAuthenticated: (s): boolean => s.user !== null,
    role: (s): Role | null => s.user?.role ?? null
  },
  actions: {
    async fetchMe() {
      try {
        const { user } = await this._api.me()
        this.user = user
      } catch {
        this.user = null
      } finally {
        this.ready = true
      }
    },
    async login(email: string, password: string): Promise<SessionUser> {
      const { user } = await this._api.login({ email, password })
      this.user = user
      this.ready = true
      return user
    },
    async logout() {
      await this._api.logout()
      this.user = null
    }
  }
})
