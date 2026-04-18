import { describe, it, expect, beforeEach } from 'vitest'
import { EventsHub } from '~/server/services/events'

describe('EventsHub', () => {
  let hub: EventsHub

  beforeEach(() => {
    hub = new EventsHub()
  })

  it('delivers device-scoped events to subscribed clients', () => {
    const received: Array<{ event: string; data: unknown }> = []
    const unsubscribe = hub.subscribeDevice('dev-1', (event, data) => {
      received.push({ event, data })
    })

    hub.emitDevice('dev-1', 'manifest-changed', { playlistId: 42 })
    expect(received).toEqual([
      { event: 'manifest-changed', data: { playlistId: 42 } }
    ])

    unsubscribe()
  })

  it('does not deliver to clients of other devices', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    hub.subscribeDevice('dev-a', (_e, d) => a.push(d))
    hub.subscribeDevice('dev-b', (_e, d) => b.push(d))

    hub.emitDevice('dev-a', 'manifest-changed', { x: 1 })

    expect(a).toEqual([{ x: 1 }])
    expect(b).toEqual([])
  })

  it('supports multiple subscribers on the same device', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    hub.subscribeDevice('dev-1', (_e, d) => a.push(d))
    hub.subscribeDevice('dev-1', (_e, d) => b.push(d))

    hub.emitDevice('dev-1', 'reload', null)

    expect(a).toEqual([null])
    expect(b).toEqual([null])
  })

  it('unsubscribe removes the listener', () => {
    const received: unknown[] = []
    const unsub = hub.subscribeDevice('dev-1', (_e, d) => received.push(d))
    unsub()
    hub.emitDevice('dev-1', 'manifest-changed', { y: 2 })
    expect(received).toEqual([])
  })

  it('emitAllDevices delivers to every device subscriber', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    hub.subscribeDevice('dev-a', (_e, d) => a.push(d))
    hub.subscribeDevice('dev-b', (_e, d) => b.push(d))

    hub.emitAllDevices('reload', null)

    expect(a).toEqual([null])
    expect(b).toEqual([null])
  })

  it('tracks subscriber count', () => {
    expect(hub.deviceSubscriberCount('dev-1')).toBe(0)
    const u1 = hub.subscribeDevice('dev-1', () => {})
    const u2 = hub.subscribeDevice('dev-1', () => {})
    expect(hub.deviceSubscriberCount('dev-1')).toBe(2)
    u1()
    expect(hub.deviceSubscriberCount('dev-1')).toBe(1)
    u2()
    expect(hub.deviceSubscriberCount('dev-1')).toBe(0)
  })
})
