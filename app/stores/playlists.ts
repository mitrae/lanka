// app/stores/playlists.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Playlist, PlaylistSummary } from '~/app/types/api'

interface State {
  list: PlaylistSummary[]
  loading: boolean
  error: string | null
  _api: Pick<
    ApiClient,
    | 'listPlaylists'
    | 'createPlaylist'
    | 'updatePlaylist'
    | 'deletePlaylist'
    | 'replacePlaylistItems'
  >
}

export const usePlaylistsStore = defineStore('playlists', {
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
        this.list = await this._api.listPlaylists()
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },
    async create(body: { name: string }): Promise<Playlist> {
      const row = await this._api.createPlaylist(body)
      await this.refresh()
      return row
    },
    async update(id: number, body: { name: string }): Promise<Playlist> {
      const row = await this._api.updatePlaylist(id, body)
      await this.refresh()
      return row
    },
    async delete(id: number): Promise<void> {
      await this._api.deletePlaylist(id)
      this.list = this.list.filter((p) => p.id !== id)
    },
    async replaceItems(
      id: number,
      items: Array<{ mediaId: number; durationMsOverride?: number }>
    ): Promise<void> {
      await this._api.replacePlaylistItems(id, { items })
      await this.refresh()
    }
  }
})
