import { describe, it, expect } from 'vitest'
import { EventsHub } from '~/server/services/events'
import { createDashboardEventSource } from '~/server/api/dashboard/stream.get'

describe('createDashboardEventSource', () => {
  it('forwards dashboard events', () => {
    const hub = new EventsHub()
    const received: Array<{ event: string; data: unknown }> = []
    const src = createDashboardEventSource(hub)
    src.subscribe((e, d) => received.push({ event: e, data: d }))

    hub.emitDashboard('device-status', { id: 'd1', status: 'online' })
    hub.emitDevice('d1', 'manifest-changed', null)

    expect(received).toEqual([
      { event: 'device-status', data: { id: 'd1', status: 'online' } },
      {
        event: 'device-event',
        data: { deviceId: 'd1', event: 'manifest-changed', data: null }
      }
    ])
    src.close()
  })

  it('close unsubscribes', () => {
    const hub = new EventsHub()
    const received: unknown[] = []
    const src = createDashboardEventSource(hub)
    src.subscribe((_e, d) => received.push(d))
    src.close()
    hub.emitDashboard('x', null)
    expect(received).toEqual([])
    expect(hub.dashboardSubscriberCount()).toBe(0)
  })
})
