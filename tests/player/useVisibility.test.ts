import { describe, it, expect, vi } from 'vitest'
import { createVisibility, shouldPost } from '~/app/composables/player/useVisibility'

describe('createVisibility', () => {
  function bridge(state: string, extra: Record<string, unknown> = {}) {
    return {
      visibility: () =>
        JSON.stringify({
          visibility: state,
          snapBacks: 3,
          focusLosses: 1,
          hiddenMs: 1234,
          episodeMs: 5000,
          changeSeq: 7,
          ...extra
        }),
      foregroundPackage: (_ms: number) => 'com.netflix.ninja'
    }
  }

  it('prefers the NativeFS bridge when present', () => {
    const v = createVisibility({ nativeFS: bridge('background') as any })
    expect(v.snapshot()).toEqual({
      visibility: 'background',
      foregroundPackage: 'com.netflix.ninja',
      snapBacks: 3,
      focusLosses: 1,
      hiddenMs: 1234,
      episodeMs: 5000,
      changeSeq: 7
    })
  })

  it('does not probe for a package while in the foreground', () => {
    const b = bridge('foreground')
    const spy = vi.spyOn(b, 'foregroundPackage')
    const v = createVisibility({ nativeFS: b as any })
    expect(v.snapshot().foregroundPackage).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('treats an empty package string as null', () => {
    const b = { ...bridge('background'), foregroundPackage: () => '' }
    expect(createVisibility({ nativeFS: b as any }).snapshot().foregroundPackage).toBeNull()
  })

  it('falls back to foreground when the bridge returns garbage', () => {
    const v = createVisibility({ nativeFS: { visibility: () => 'not json' } as any })
    expect(v.snapshot().visibility).toBe('foreground')
  })

  it('uses the Page Visibility API with no bridge', () => {
    let hidden = false
    const listeners: Array<() => void> = []
    const doc = {
      get hidden() { return hidden },
      addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      removeEventListener: vi.fn()
    }
    let now = 0
    const v = createVisibility({ doc: doc as any, now: () => now })
    expect(v.snapshot().visibility).toBe('foreground')
    const seq0 = v.snapshot().changeSeq

    hidden = true
    listeners.forEach((cb) => cb())
    now = 5_000
    const s = v.snapshot()
    expect(s.visibility).toBe('background')
    expect(s.focusLosses).toBe(1)
    expect(s.hiddenMs).toBe(5_000)
    expect(s.foregroundPackage).toBeNull()
    expect(s.changeSeq).not.toBe(seq0)
  })

  it('never reports obscured from the browser fallback', () => {
    const doc = { hidden: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const v = createVisibility({ doc: doc as any, now: () => 0 })
    expect(v.snapshot().visibility).not.toBe('obscured')
  })

  it('stop() detaches the listener', () => {
    const doc = { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const v = createVisibility({ doc: doc as any, now: () => 0 })
    v.stop()
    expect(doc.removeEventListener).toHaveBeenCalled()
  })
})

describe('shouldPost', () => {
  it('fires on a change or once per heartbeat', () => {
    expect(shouldPost(2, 1, 0)).toBe(true)
    expect(shouldPost(1, 1, 29_999)).toBe(false)
    expect(shouldPost(1, 1, 30_000)).toBe(true)
  })
})
