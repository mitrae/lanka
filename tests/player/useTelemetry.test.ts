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

  it('enriches every post with visibility, not just the heartbeat', () => {
    const posts: any[] = []
    const api = {
      postTelemetry: (_id: string, body: any) => { posts.push(body); return Promise.resolve() }
    } as any
    const vis = {
      snapshot: () => ({
        visibility: 'obscured' as const,
        foregroundPackage: 'com.android.settings',
        snapBacks: 2,
        focusLosses: 5,
        hiddenMs: 900,
        episodeMs: 900,
        changeSeq: 1
      }),
      stop() {}
    }
    const t = useTelemetry(api, vis)
    t.itemStarted('dev-1', 42)
    t.itemFailed('dev-1', 42, 'sha', 'decode failed')
    t.clearedCurrent('dev-1')
    t.heartbeat('dev-1')
    expect(posts).toHaveLength(4)
    for (const p of posts) {
      expect(p.visibility).toBe('obscured')
      expect(p.foregroundPackage).toBe('com.android.settings')
      expect(p.snapBacks).toBe(2)
      expect(p.surface).toBe('webview')
    }
    expect(posts[0].currentItemId).toBe(42)
    expect(posts[2].currentItemId).toBeNull()
    // The heartbeat must omit the field entirely — the server reads an absent
    // currentItemId as "don't touch, don't count".
    expect('currentItemId' in posts[3]).toBe(false)
  })

  it('works without a visibility handle', () => {
    const posts: any[] = []
    const api = {
      postTelemetry: (_id: string, body: any) => { posts.push(body); return Promise.resolve() }
    } as any
    useTelemetry(api).itemStarted('dev-1', 1)
    expect(posts[0].visibility).toBeUndefined()
    expect(posts[0].surface).toBe('webview')
  })
})
