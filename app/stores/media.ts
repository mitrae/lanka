// app/stores/media.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Media, MediaListRow } from '~/app/types/api'

interface State {
  list: MediaListRow[]
  loading: boolean
  error: string | null
  _api: Pick<ApiClient, 'listMedia' | 'uploadMedia' | 'deleteMedia'>
}

export const useMediaStore = defineStore('media', {
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
        this.list = await this._api.listMedia()
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },
    async upload(form: FormData): Promise<Media> {
      const row = await this._api.uploadMedia(form)
      await this.refresh()
      return row
    },
    async delete(id: number, opts: { force?: boolean } = {}): Promise<void> {
      await this._api.deleteMedia(id, opts)
      this.list = this.list.filter((m) => m.id !== id)
    }
  }
})
