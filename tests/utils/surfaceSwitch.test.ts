import { describe, it, expect } from 'vitest'
import { surfaceSwitchView, APPLYING_WINDOW_MS } from '~/app/utils/surfaceSwitch'
import type { DeviceCommand } from '~/app/types/api'

const now = 1_700_000_000_000

function cmd(partial: Partial<DeviceCommand> & Pick<DeviceCommand, 'id' | 'cmd' | 'status'>): DeviceCommand {
  return {
    deviceId: 'dev-1',
    payload: null,
    result: null,
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    ...partial
  }
}

describe('surfaceSwitchView', () => {
  it('is idle with no set-surface command', () => {
    expect(surfaceSwitchView([cmd({ id: 1, cmd: 'screenshot', status: 'acked' })], 'webview', now))
      .toEqual({ phase: 'idle', requested: null, reason: null })
  })

  it('uses the NEWEST set-surface row (list is newest first)', () => {
    const v = surfaceSwitchView([
      cmd({ id: 3, cmd: 'set-surface', status: 'pending', payload: '{"surface":"native"}' }),
      cmd({ id: 2, cmd: 'set-surface', status: 'acked', payload: '{"surface":"webview"}' })
    ], 'webview', now)
    expect(v).toEqual({ phase: 'queued', requested: 'native', reason: null })
  })

  it('shows sent while the box has not acked', () => {
    const v = surfaceSwitchView([cmd({ id: 1, cmd: 'set-surface', status: 'sent', payload: '{"surface":"native"}' })], 'webview', now)
    expect(v.phase).toBe('sent')
  })

  it('shows applying after an ack until telemetry reports the new surface', () => {
    const row = cmd({ id: 1, cmd: 'set-surface', status: 'acked', payload: '{"surface":"native"}', updatedAt: now - 30_000 })
    expect(surfaceSwitchView([row], 'webview', now).phase).toBe('applying')
    expect(surfaceSwitchView([row], 'native', now).phase).toBe('idle')
  })

  it('gives up on applying after the window', () => {
    const row = cmd({ id: 1, cmd: 'set-surface', status: 'acked', payload: '{"surface":"native"}', updatedAt: now - APPLYING_WINDOW_MS - 1 })
    expect(surfaceSwitchView([row], 'webview', now).phase).toBe('idle')
  })

  it('surfaces the failure reason', () => {
    const row = cmd({ id: 1, cmd: 'set-surface', status: 'failed', payload: '{"surface":"native"}', result: 'ota in progress' })
    expect(surfaceSwitchView([row], 'webview', now)).toEqual({ phase: 'failed', requested: 'native', reason: 'ota in progress' })
  })

  it('tolerates a malformed payload', () => {
    const row = cmd({ id: 1, cmd: 'set-surface', status: 'acked', payload: 'not json' })
    expect(surfaceSwitchView([row], 'webview', now)).toEqual({ phase: 'idle', requested: null, reason: null })
  })
})
