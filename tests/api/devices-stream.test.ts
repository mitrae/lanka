import { describe, it, expect } from 'vitest'
import { EventsHub } from '~/server/services/events'
import { createDeviceEventSource } from '~/server/api/devices/[id]/stream.get'

describe('createDeviceEventSource', () => {
  it('forwards events for the specified device', () => {
    const hub = new EventsHub()
    const received: Array<{ event: string; data: unknown }> = []
    const src = createDeviceEventSource(hub, 'dev-1')
    src.subscribe((event, data) => received.push({ event, data }))

    hub.emitDevice('dev-1', 'manifest-changed', { playlistId: 1 })
    hub.emitDevice('dev-2', 'manifest-changed', { playlistId: 2 })
    hub.emitAllDevices('reload', null)

    expect(received).toEqual([
      { event: 'manifest-changed', data: { playlistId: 1 } },
      { event: 'reload', data: null }
    ])
    src.close()
  })

  it('close() unsubscribes from the hub', () => {
    const hub = new EventsHub()
    const received: unknown[] = []
    const src = createDeviceEventSource(hub, 'dev-1')
    src.subscribe((_e, d) => received.push(d))
    src.close()
    hub.emitDevice('dev-1', 'manifest-changed', { x: 1 })
    expect(received).toEqual([])
    expect(hub.deviceSubscriberCount('dev-1')).toBe(0)
  })
})
