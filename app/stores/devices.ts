// app/stores/devices.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { DeviceEventPayload } from '~/app/composables/useDashboardStream'
import type { Device, DeviceListRow, DeviceStatus } from '~/app/types/api'

function computeStatus(lastSeenAt: string | null): DeviceStatus {
  if (!lastSeenAt) return 'offline'
  const ageMs = Date.now() - new Date(lastSeenAt).getTime()
  if (ageMs <= 60_000) return 'online'
  if (ageMs <= 5 * 60_000) return 'idle'
  return 'offline'
}

interface State {
  list: DeviceListRow[]
  loading: boolean
  error: string | null
  _api: Pick<ApiClient, 'listDevices' | 'updateDevice' | 'deleteDevice' | 'reloadDevice'>
}

export const useDevicesStore = defineStore('devices', {
  state: (): State => ({
    list: [],
    loading: false,
    error: null,
    _api: useApiClient()
  }),

  actions: {
    async refresh(
      filters: { groupId?: number; addressId?: number; unclaimed?: boolean } = {}
    ) {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listDevices(filters)
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },

    async updateDevice(
      id: string,
      body: { name?: string | null; groupId?: number | null }
    ): Promise<Device> {
      const updated = await this._api.updateDevice(id, body)
      const idx = this.list.findIndex((d) => d.id === id)
      if (idx >= 0) {
        this.list[idx] = {
          ...this.list[idx],
          ...updated,
          status: computeStatus(updated.lastSeenAt)
        }
      }
      return updated
    },

    async deleteDevice(id: string): Promise<void> {
      await this._api.deleteDevice(id)
      this.list = this.list.filter((d) => d.id !== id)
    },

    async reloadDevice(id: string): Promise<void> {
      await this._api.reloadDevice(id)
    },

    applyDeviceEvent(payload: DeviceEventPayload, now = new Date()) {
      const idx = this.list.findIndex((d) => d.id === payload.deviceId)
      if (idx < 0) return
      const iso = now.toISOString()
      this.list[idx] = {
        ...this.list[idx],
        lastSeenAt: iso,
        status: 'online'
      }
    }
  }
})
