import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import { _resetDashboardStream } from '~/app/composables/useDashboardStream'
import type { Role, SessionUser } from '~/app/types/api'

interface State {
  user: SessionUser | null
  ready: boolean
  error: boolean
  _api: Pick<ApiClient, 'login' | 'loginWithGoogle' | 'logout' | 'me'>
}

/**
 * Decide how `fetchMe` should treat a failure. Only a genuine 401 means the
 * session is gone (clear the user); any other failure (500, network blip,
 * timeout) is transient — preserve the prior user so a momentary server hiccup
 * doesn't bounce a logged-in operator to /login mid-session.
 */
export function isUnauthorizedError(err: unknown): boolean {
  const status =
    (err as { statusCode?: number; status?: number; response?: { status?: number } } | null)
      ?.statusCode ??
    (err as { status?: number } | null)?.status ??
    (err as { response?: { status?: number } } | null)?.response?.status
  return status === 401
}

export const useAuthStore = defineStore('auth', {
  state: (): State => ({ user: null, ready: false, error: false, _api: useApiClient() }),
  getters: {
    isAuthenticated: (s): boolean => s.user !== null,
    role: (s): Role | null => s.user?.role ?? null
  },
  actions: {
    async fetchMe() {
      try {
        const { user } = await this._api.me()
        this.user = user
        this.error = false
      } catch (err) {
        if (isUnauthorizedError(err)) {
          // Genuine "no/expired session" — really logged out.
          this.user = null
          this.error = false
        } else {
          // Transient server/network failure: keep the prior user state so we
          // don't redirect a still-authenticated operator to /login.
          this.error = true
        }
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
    async loginWithGoogle(credential: string): Promise<SessionUser> {
      const { user } = await this._api.loginWithGoogle({ credential })
      this.user = user
      this.ready = true
      return user
    },
    async logout() {
      await this._api.logout()
      this.user = null
      this.error = false
      // Tear down the authenticated dashboard SSE so it stops retrying (and
      // 401ing) after the session is gone.
      _resetDashboardStream()
    }
  }
})
