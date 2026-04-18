// app/composables/useApiClient.ts
import type {
  Address,
  Assignment,
  Device,
  DeviceListRow,
  Group,
  Manifest,
  Media,
  MediaListRow,
  Playlist,
  PlaylistDetail,
  PlaylistSummary,
  RegisterResult
} from '~/app/types/api'

type FetchFn = typeof $fetch

export interface ApiClient {
  // addresses
  listAddresses(): Promise<Address[]>
  getAddress(id: number): Promise<Address>
  createAddress(body: { name: string }): Promise<Address>
  updateAddress(id: number, body: { name: string }): Promise<Address>
  deleteAddress(id: number): Promise<void>

  // groups
  listGroups(query?: { addressId?: number }): Promise<Group[]>
  getGroup(id: number): Promise<Group>
  createGroup(body: { addressId: number; name: string }): Promise<Group>
  updateGroup(
    id: number,
    body: { name?: string; addressId?: number }
  ): Promise<Group>
  deleteGroup(id: number): Promise<void>

  // devices
  listDevices(query?: {
    groupId?: number
    addressId?: number
    unclaimed?: boolean
  }): Promise<DeviceListRow[]>
  getDevice(id: string): Promise<Device>
  updateDevice(
    id: string,
    body: { name?: string | null; groupId?: number | null }
  ): Promise<Device>
  deleteDevice(id: string): Promise<void>
  reloadDevice(id: string): Promise<void>

  // player-facing
  register(body: {
    deviceId: string
    playerVersion: string
  }): Promise<RegisterResult>
  getManifest(deviceId: string): Promise<Manifest | null>
  postTelemetry(
    deviceId: string,
    body: {
      currentItemId: number | null
      error?: { sha256?: string; message: string }
    }
  ): Promise<void>

  // media
  listMedia(): Promise<MediaListRow[]>
  getMedia(id: number): Promise<Media>
  deleteMedia(id: number, opts?: { force?: boolean }): Promise<void>
  uploadMedia(body: FormData): Promise<Media>

  // playlists
  listPlaylists(): Promise<PlaylistSummary[]>
  getPlaylist(id: number): Promise<PlaylistDetail>
  createPlaylist(body: { name: string }): Promise<Playlist>
  updatePlaylist(id: number, body: { name: string }): Promise<Playlist>
  deletePlaylist(id: number): Promise<void>
  replacePlaylistItems(
    id: number,
    body: {
      items: Array<{ mediaId: number; durationMsOverride?: number }>
    }
  ): Promise<void>

  // assignments (target-addressed)
  assignDeviceToPlaylist(
    deviceId: string,
    body: { playlistId: number }
  ): Promise<Assignment>
  unassignDevice(deviceId: string): Promise<void>
  assignGroupToPlaylist(
    groupId: number,
    body: { playlistId: number }
  ): Promise<Assignment>
  unassignGroup(groupId: number): Promise<void>
  assignAddressToPlaylist(
    addressId: number,
    body: { playlistId: number }
  ): Promise<Assignment>
  unassignAddress(addressId: number): Promise<void>
}

/**
 * Exposed for testing. Production callers use `useApiClient()`.
 */
export function createApiClient(fetch: FetchFn): ApiClient {
  return {
    // addresses
    listAddresses: () =>
      fetch<Address[]>('/api/addresses', { method: 'GET' }),
    getAddress: (id) =>
      fetch<Address>(`/api/addresses/${id}`, { method: 'GET' }),
    createAddress: (body) =>
      fetch<Address>('/api/addresses', { method: 'POST', body }),
    updateAddress: (id, body) =>
      fetch<Address>(`/api/addresses/${id}`, { method: 'PATCH', body }),
    deleteAddress: (id) =>
      fetch<void>(`/api/addresses/${id}`, { method: 'DELETE' }),

    // groups
    listGroups: (query = {}) =>
      fetch<Group[]>('/api/groups', { method: 'GET', query }),
    getGroup: (id) => fetch<Group>(`/api/groups/${id}`, { method: 'GET' }),
    createGroup: (body) =>
      fetch<Group>('/api/groups', { method: 'POST', body }),
    updateGroup: (id, body) =>
      fetch<Group>(`/api/groups/${id}`, { method: 'PATCH', body }),
    deleteGroup: (id) =>
      fetch<void>(`/api/groups/${id}`, { method: 'DELETE' }),

    // devices
    listDevices: (query = {}) =>
      fetch<DeviceListRow[]>('/api/devices', { method: 'GET', query }),
    getDevice: (id) =>
      fetch<Device>(`/api/devices/${id}`, { method: 'GET' }),
    updateDevice: (id, body) =>
      fetch<Device>(`/api/devices/${id}`, { method: 'PATCH', body }),
    deleteDevice: (id) =>
      fetch<void>(`/api/devices/${id}`, { method: 'DELETE' }),
    reloadDevice: (id) =>
      fetch<void>(`/api/devices/${id}/reload`, { method: 'POST' }),

    // player-facing
    register: (body) =>
      fetch<RegisterResult>('/api/devices/register', {
        method: 'POST',
        body
      }),
    getManifest: async (deviceId) => {
      const res = await (fetch as any).raw(
        `/api/devices/${deviceId}/manifest`,
        { method: 'GET' }
      )
      if (res.status === 204) return null
      return res._data as Manifest
    },
    postTelemetry: (deviceId, body) =>
      fetch<void>(`/api/devices/${deviceId}/telemetry`, {
        method: 'POST',
        body
      }),

    // media
    listMedia: () => fetch<MediaListRow[]>('/api/media', { method: 'GET' }),
    getMedia: (id) => fetch<Media>(`/api/media/${id}`, { method: 'GET' }),
    deleteMedia: (id, opts = {}) =>
      fetch<void>(`/api/media/${id}`, {
        method: 'DELETE',
        query: opts.force ? { force: 'true' } : undefined
      }),
    uploadMedia: (body) =>
      fetch<Media>('/api/media', { method: 'POST', body }),

    // playlists
    listPlaylists: () =>
      fetch<PlaylistSummary[]>('/api/playlists', { method: 'GET' }),
    getPlaylist: (id) =>
      fetch<PlaylistDetail>(`/api/playlists/${id}`, { method: 'GET' }),
    createPlaylist: (body) =>
      fetch<Playlist>('/api/playlists', { method: 'POST', body }),
    updatePlaylist: (id, body) =>
      fetch<Playlist>(`/api/playlists/${id}`, { method: 'PATCH', body }),
    deletePlaylist: (id) =>
      fetch<void>(`/api/playlists/${id}`, { method: 'DELETE' }),
    replacePlaylistItems: (id, body) =>
      fetch<void>(`/api/playlists/${id}/items`, { method: 'PUT', body }),

    // assignments
    assignDeviceToPlaylist: (deviceId, body) =>
      fetch<Assignment>(`/api/assignments/devices/${deviceId}`, {
        method: 'PUT',
        body
      }),
    unassignDevice: (deviceId) =>
      fetch<void>(`/api/assignments/devices/${deviceId}`, { method: 'DELETE' }),
    assignGroupToPlaylist: (groupId, body) =>
      fetch<Assignment>(`/api/assignments/groups/${groupId}`, {
        method: 'PUT',
        body
      }),
    unassignGroup: (groupId) =>
      fetch<void>(`/api/assignments/groups/${groupId}`, { method: 'DELETE' }),
    assignAddressToPlaylist: (addressId, body) =>
      fetch<Assignment>(`/api/assignments/addresses/${addressId}`, {
        method: 'PUT',
        body
      }),
    unassignAddress: (addressId) =>
      fetch<void>(`/api/assignments/addresses/${addressId}`, {
        method: 'DELETE'
      })
  }
}

let _client: ApiClient | null = null

export function useApiClient(): ApiClient {
  if (!_client) _client = createApiClient($fetch as FetchFn)
  return _client
}
