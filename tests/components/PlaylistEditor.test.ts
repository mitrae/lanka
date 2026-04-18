// tests/components/PlaylistEditor.test.ts
import { describe, it, expect } from 'vitest'
import { reorderItems } from '~/app/components/PlaylistEditor.logic'

describe('reorderItems', () => {
  const items = [
    { id: 1, mediaId: 10, durationMsOverride: null },
    { id: 2, mediaId: 20, durationMsOverride: null },
    { id: 3, mediaId: 30, durationMsOverride: null },
    { id: 4, mediaId: 40, durationMsOverride: null }
  ]

  it('moves item down', () => {
    const r = reorderItems(items, 1, 3) // move B after D
    expect(r.map((x) => x.mediaId)).toEqual([10, 30, 40, 20])
  })

  it('moves item up', () => {
    const r = reorderItems(items, 3, 0) // move D to front
    expect(r.map((x) => x.mediaId)).toEqual([40, 10, 20, 30])
  })

  it('no-op when fromIndex === toIndex', () => {
    const r = reorderItems(items, 2, 2)
    expect(r).toEqual(items)
  })

  it('returns a new array (immutable)', () => {
    const r = reorderItems(items, 0, 1)
    expect(r).not.toBe(items)
  })

  it('out-of-range indices return original array unchanged', () => {
    expect(reorderItems(items, -1, 0)).toEqual(items)
    expect(reorderItems(items, 0, 99)).toEqual(items)
  })
})
