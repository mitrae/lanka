import { describe, it, expect, vi } from 'vitest'
import { useTelemetry } from '~/app/composables/player/useTelemetry'

describe('useTelemetry', () => {
  it('reports surface: webview on every post', () => {
    const api = { postTelemetry: vi.fn(() => Promise.resolve()) } as any
    const t = useTelemetry(api)

    t.itemStarted('dev-1', 7)
    expect(api.postTelemetry).toHaveBeenCalledWith(
      'dev-1',
      expect.objectContaining({ currentItemId: 7, surface: 'webview' })
    )

    t.clearedCurrent('dev-1')
    expect(api.postTelemetry).toHaveBeenLastCalledWith(
      'dev-1',
      expect.objectContaining({ currentItemId: null, surface: 'webview' })
    )

    t.itemFailed('dev-1', 7, 'abc', 'boom')
    expect(api.postTelemetry).toHaveBeenLastCalledWith(
      'dev-1',
      expect.objectContaining({ surface: 'webview', error: { sha256: 'abc', message: 'boom' } })
    )
  })
})
