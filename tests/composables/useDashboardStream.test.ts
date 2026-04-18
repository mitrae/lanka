import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDashboardStream } from '~/app/composables/useDashboardStream'

type Listener = (event: { data: string }) => void

class FakeEventSource {
  listeners = new Map<string, Listener[]>()
  readyState = 0 // CONNECTING
  closed = false
  constructor(public url: string) {
    FakeEventSource.lastInstance = this
  }
  addEventListener(type: string, fn: Listener) {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener() {}
  close() {
    this.closed = true
  }
  fire(type: string, data: unknown) {
    const arr = this.listeners.get(type) ?? []
    for (const l of arr) l({ data: JSON.stringify(data) })
  }
  fireOpen() {
    this.readyState = 1
    const arr = this.listeners.get('open') ?? []
    for (const l of arr) l({ data: '' } as any)
  }
  static lastInstance: FakeEventSource | null = null
}

describe('useDashboardStream', () => {
  beforeEach(() => {
    FakeEventSource.lastInstance = null
  })

  it('begins in "connecting" state', () => {
    const s = createDashboardStream(
      '/api/dashboard/stream',
      (url) => new FakeEventSource(url) as any
    )
    expect(s.state.value).toBe('connecting')
    s.close()
  })

  it('transitions to "connected" on open event', () => {
    const s = createDashboardStream(
      '/api/dashboard/stream',
      (url) => new FakeEventSource(url) as any
    )
    FakeEventSource.lastInstance!.fireOpen()
    expect(s.state.value).toBe('connected')
    s.close()
  })

  it('emits device-event payloads to subscribers', () => {
    const received: Array<{
      deviceId: string
      event: string
      data: unknown
    }> = []
    const s = createDashboardStream(
      '/api/dashboard/stream',
      (url) => new FakeEventSource(url) as any
    )
    s.onDeviceEvent((payload) => received.push(payload))

    FakeEventSource.lastInstance!.fire('device-event', {
      deviceId: 'tv-1',
      event: 'manifest-changed',
      data: { playlistId: 7 }
    })

    expect(received).toEqual([
      {
        deviceId: 'tv-1',
        event: 'manifest-changed',
        data: { playlistId: 7 }
      }
    ])
    s.close()
  })

  it('close() sets state to disconnected and closes the underlying source', () => {
    const s = createDashboardStream(
      '/api/dashboard/stream',
      (url) => new FakeEventSource(url) as any
    )
    s.close()
    expect(s.state.value).toBe('disconnected')
    expect(FakeEventSource.lastInstance!.closed).toBe(true)
  })

  it('ignores malformed device-event JSON (logs only, no throw)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = createDashboardStream(
      '/api/dashboard/stream',
      (url) => new FakeEventSource(url) as any
    )
    const arr = FakeEventSource.lastInstance!.listeners.get('device-event') ?? []
    expect(() => {
      for (const l of arr) l({ data: '{not valid json' })
    }).not.toThrow()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
    s.close()
  })
})
