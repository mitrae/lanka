// tests/composables/useApiClient.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApiClient } from '~/app/composables/useApiClient'

describe('useApiClient', () => {
  const fetchFn = vi.fn()
  const client = createApiClient(fetchFn as any)

  beforeEach(() => {
    fetchFn.mockReset()
    fetchFn.mockResolvedValue({})
  })

  it('listAddresses GETs /api/addresses', async () => {
    await client.listAddresses()
    expect(fetchFn).toHaveBeenCalledWith('/api/addresses', { method: 'GET' })
  })

  it('createAddress POSTs body', async () => {
    await client.createAddress({ name: 'A' })
    expect(fetchFn).toHaveBeenCalledWith('/api/addresses', {
      method: 'POST',
      body: { name: 'A' }
    })
  })

  it('updateAddress PATCHes with id in path', async () => {
    await client.updateAddress(7, { name: 'B' })
    expect(fetchFn).toHaveBeenCalledWith('/api/addresses/7', {
      method: 'PATCH',
      body: { name: 'B' }
    })
  })

  it('deleteAddress DELETEs', async () => {
    await client.deleteAddress(7)
    expect(fetchFn).toHaveBeenCalledWith('/api/addresses/7', {
      method: 'DELETE'
    })
  })

  it('listGroups with addressId filter', async () => {
    await client.listGroups({ addressId: 3 })
    expect(fetchFn).toHaveBeenCalledWith('/api/groups', {
      method: 'GET',
      query: { addressId: 3 }
    })
  })

  it('listDevices with multiple filters', async () => {
    await client.listDevices({ groupId: 2, unclaimed: true })
    expect(fetchFn).toHaveBeenCalledWith('/api/devices', {
      method: 'GET',
      query: { groupId: 2, unclaimed: true }
    })
  })

  it('reloadDevice POSTs with no body', async () => {
    await client.reloadDevice('tv-1')
    expect(fetchFn).toHaveBeenCalledWith('/api/devices/tv-1/reload', {
      method: 'POST'
    })
  })

  it('uploadMedia sends FormData as multipart', async () => {
    const form = new FormData()
    form.append('kind', 'image')
    await client.uploadMedia(form)
    expect(fetchFn).toHaveBeenCalledWith('/api/media', {
      method: 'POST',
      body: form
    })
  })

  it('replacePlaylistItems PUTs items array', async () => {
    await client.replacePlaylistItems(4, {
      items: [{ mediaId: 1, durationMsOverride: 5000 }]
    })
    expect(fetchFn).toHaveBeenCalledWith('/api/playlists/4/items', {
      method: 'PUT',
      body: { items: [{ mediaId: 1, durationMsOverride: 5000 }] }
    })
  })

  it('assignDeviceToPlaylist PUTs target endpoint', async () => {
    await client.assignDeviceToPlaylist('tv-1', { playlistId: 9 })
    expect(fetchFn).toHaveBeenCalledWith('/api/assignments/devices/tv-1', {
      method: 'PUT',
      body: { playlistId: 9 }
    })
  })

  it('unassignGroup DELETEs the target endpoint', async () => {
    await client.unassignGroup(3)
    expect(fetchFn).toHaveBeenCalledWith('/api/assignments/groups/3', {
      method: 'DELETE'
    })
  })
})
