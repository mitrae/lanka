import { describe, expect, it } from 'vitest'
import { shouldReconcile } from '~/app/composables/player/shouldReconcile'

describe('shouldReconcile', () => {
  it('returns true when prev is null', () => {
    expect(shouldReconcile(null, { playlistId: 1, version: 1 })).toBe(true)
  })

  it('returns false when playlistId + version match', () => {
    expect(
      shouldReconcile({ playlistId: 1, version: 1 }, { playlistId: 1, version: 1 })
    ).toBe(false)
  })

  it('returns true when playlistId changed', () => {
    expect(
      shouldReconcile({ playlistId: 1, version: 1 }, { playlistId: 2, version: 1 })
    ).toBe(true)
  })

  it('returns true when version changed', () => {
    expect(
      shouldReconcile({ playlistId: 1, version: 1 }, { playlistId: 1, version: 2 })
    ).toBe(true)
  })
})
