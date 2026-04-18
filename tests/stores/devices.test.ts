// tests/stores/devices.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDevicesStore } from '~/app/stores/devices'

describe('useDevicesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('refresh() populates the list from the api', async () => {
    const store = useDevicesStore()
    const listDevices = vi.fn().mockResolvedValue([
      {
        id: 'tv-1',
        groupId: null,
        name: null,
        lastSeenAt: null,
        playerVersion: '0.1.0',
        currentItemId: null,
        status: 'offline',
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z'
      }
    ])
    store.$patch({ _api: { listDevices } as any })
    await store.refresh()
    expect(listDevices).toHaveBeenCalledWith({})
    expect(store.list).toHaveLength(1)
    expect(store.list[0].id).toBe('tv-1')
  })

  it('applyDeviceEvent updates lastSeenAt and status for known device', () => {
    const store = useDevicesStore()
    const now = new Date()
    store.$patch({
      list: [
        {
          id: 'tv-1',
          groupId: 2,
          name: 'TV',
          lastSeenAt: null,
          playerVersion: '0.1.0',
          currentItemId: null,
          status: 'offline',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z'
        }
      ]
    })
    store.applyDeviceEvent(
      { deviceId: 'tv-1', event: 'manifest-changed', data: null },
      now
    )
    expect(store.list[0].lastSeenAt).toEqual(now.toISOString())
    expect(store.list[0].status).toBe('online')
  })

  it('applyDeviceEvent is a no-op for unknown device', () => {
    const store = useDevicesStore()
    store.$patch({
      list: [
        {
          id: 'tv-1',
          groupId: 2,
          name: 'TV',
          lastSeenAt: null,
          playerVersion: '0.1.0',
          currentItemId: null,
          status: 'offline',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z'
        }
      ]
    })
    store.applyDeviceEvent(
      { deviceId: 'unknown', event: 'manifest-changed', data: null },
      new Date()
    )
    expect(store.list[0].status).toBe('offline')
  })

  it('updateDevice calls api and patches list', async () => {
    const store = useDevicesStore()
    const updateDevice = vi.fn().mockResolvedValue({
      id: 'tv-1',
      groupId: 5,
      name: 'Renamed',
      lastSeenAt: null,
      playerVersion: '0.1.0',
      currentItemId: null,
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:01.000Z'
    })
    store.$patch({
      _api: { updateDevice } as any,
      list: [
        {
          id: 'tv-1',
          groupId: null,
          name: null,
          lastSeenAt: null,
          playerVersion: '0.1.0',
          currentItemId: null,
          status: 'offline',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z'
        }
      ]
    })

    await store.updateDevice('tv-1', { name: 'Renamed', groupId: 5 })

    expect(updateDevice).toHaveBeenCalledWith('tv-1', {
      name: 'Renamed',
      groupId: 5
    })
    expect(store.list[0].name).toBe('Renamed')
    expect(store.list[0].groupId).toBe(5)
  })

  it('deleteDevice removes the entry from the list', async () => {
    const store = useDevicesStore()
    const deleteDevice = vi.fn().mockResolvedValue(undefined)
    store.$patch({
      _api: { deleteDevice } as any,
      list: [
        {
          id: 'a',
          groupId: null,
          name: null,
          lastSeenAt: null,
          playerVersion: null,
          currentItemId: null,
          status: 'offline',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z'
        },
        {
          id: 'b',
          groupId: null,
          name: null,
          lastSeenAt: null,
          playerVersion: null,
          currentItemId: null,
          status: 'offline',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z'
        }
      ]
    })
    await store.deleteDevice('a')
    expect(store.list.map((d: any) => d.id)).toEqual(['b'])
  })
})
