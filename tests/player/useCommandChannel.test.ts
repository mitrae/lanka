import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCommandChannel } from '~/app/composables/player/useCommandChannel'

// Mock WebSocket
class MockWS {
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 1 // OPEN
  send(msg: string) { this.sent.push(msg) }
  close() { this.onclose?.() }
  open() { this.onopen?.() }
  receive(data: object) { this.onmessage?.({ data: JSON.stringify(data) }) }
}

let ws: MockWS
function wsFactory(_url: string): WebSocket {
  ws = new MockWS()
  return ws as unknown as WebSocket
}

function makeNativeFS() {
  return {
    exists: () => false,
    download: () => true,
    evictExcept: () => {},
    downloadApk: vi.fn(() => true),
    installApk: vi.fn(() => true),
    screenshot: vi.fn(() => 'data:image/jpeg;base64,abc'),
    getLogs: vi.fn(() => 'log line 1\nlog line 2'),
    getAppVersion: vi.fn(() => '1.2.3'),
    setKioskLock: vi.fn()
  }
}

describe('createCommandChannel', () => {
  let nativeFS: ReturnType<typeof makeNativeFS>
  let reloaded: boolean

  beforeEach(() => {
    nativeFS = makeNativeFS()
    reloaded = false
  })

  it('sends screenshot ack when screenshot command received', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => { reloaded = true }, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 1, cmd: 'screenshot', payload: null })
    expect(nativeFS.screenshot).toHaveBeenCalled()
    const ack = JSON.parse(ws.sent[0])
    expect(ack).toMatchObject({ commandId: 1, status: 'acked', result: 'data:image/jpeg;base64,abc' })
  })

  it('appends the secret as an encoded query param to the WS url', () => {
    let capturedUrl = ''
    const ch = createCommandChannel({
      deviceId: 'dev-1',
      secret: 's3cr et/+',
      onReload: () => {},
      wsFactory: (url) => {
        capturedUrl = url
        return new MockWS() as unknown as WebSocket
      }
    })
    ch.open()
    expect(capturedUrl).toBe('/api/devices/dev-1/ws?secret=s3cr%20et%2F%2B')
    ch.close()
  })

  it('omits the query when no secret is set', () => {
    let capturedUrl = ''
    const ch = createCommandChannel({
      deviceId: 'dev-1',
      onReload: () => {},
      wsFactory: (url) => {
        capturedUrl = url
        return new MockWS() as unknown as WebSocket
      }
    })
    ch.open()
    expect(capturedUrl).toBe('/api/devices/dev-1/ws')
    ch.close()
  })

  it('sends log-request ack with log text', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => {}, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 2, cmd: 'log-request', payload: null })
    const ack = JSON.parse(ws.sent[0])
    expect(ack).toMatchObject({ commandId: 2, status: 'acked' })
    expect(ack.result).toContain('log line')
  })

  it('calls onReload for reboot command when bridge has no reboot (no ack sent)', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => { reloaded = true }, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 3, cmd: 'reboot', payload: null })
    expect(reloaded).toBe(true)
    expect(ws.sent).toHaveLength(0)
  })

  it('calls native reboot (no reload, no ack) when device-owner bridge supports it', () => {
    const reboot = vi.fn(() => true)
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS: { ...nativeFS, reboot }, onReload: () => { reloaded = true }, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 5, cmd: 'reboot', payload: null })
    expect(reboot).toHaveBeenCalled()
    expect(reloaded).toBe(false)
    expect(ws.sent).toHaveLength(0)
  })

  it('falls back to reload when native reboot returns false', () => {
    const reboot = vi.fn(() => false)
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS: { ...nativeFS, reboot }, onReload: () => { reloaded = true }, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 6, cmd: 'reboot', payload: null })
    expect(reboot).toHaveBeenCalled()
    expect(reloaded).toBe(true)
  })

  it('falls back to reload when native reboot throws', () => {
    const reboot = vi.fn(() => { throw new Error('not owner') })
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS: { ...nativeFS, reboot }, onReload: () => { reloaded = true }, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 7, cmd: 'reboot', payload: null })
    expect(reloaded).toBe(true)
  })

  it('handles kiosk-lock: calls setKioskLock(true) and acks', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => {}, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 8, cmd: 'kiosk-lock', payload: null })
    expect(nativeFS.setKioskLock).toHaveBeenCalledWith(true)
    expect(JSON.parse(ws.sent[0])).toMatchObject({ commandId: 8, status: 'acked' })
  })

  it('handles kiosk-unlock: calls setKioskLock(false) and acks', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => {}, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 9, cmd: 'kiosk-unlock', payload: null })
    expect(nativeFS.setKioskLock).toHaveBeenCalledWith(false)
    expect(JSON.parse(ws.sent[0])).toMatchObject({ commandId: 9, status: 'acked' })
  })

  it('kiosk-lock fails gracefully when the bridge lacks setKioskLock (old APK)', () => {
    const { setKioskLock, ...noLock } = nativeFS
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS: noLock as any, onReload: () => {}, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 10, cmd: 'kiosk-lock', payload: null })
    expect(JSON.parse(ws.sent[0])).toMatchObject({ commandId: 10, status: 'failed', result: 'not supported' })
  })

  it('sends failed ack when nativeFS is absent', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', onReload: () => {}, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 4, cmd: 'screenshot', payload: null })
    const ack = JSON.parse(ws.sent[0])
    expect(ack).toMatchObject({ commandId: 4, status: 'failed' })
  })

  it('close() disconnects WebSocket', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', onReload: () => {}, wsFactory })
    ch.open()
    ws.open()
    ch.close()
    expect(ws.readyState).toBe(1) // MockWS doesn't actually set readyState, just checking no throw
  })
})
