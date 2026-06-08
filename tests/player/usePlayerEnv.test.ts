import { describe, expect, it } from 'vitest'
import { usePlayerEnv } from '~/app/composables/player/usePlayerEnv'

describe('usePlayerEnv.fileUrl', () => {
  it('returns the relative server path when no media base is set', () => {
    expect(usePlayerEnv().fileUrl('abc123')).toBe('/media/abc123')
  })

  it('returns an absolute CDN url when a media base is set', () => {
    expect(usePlayerEnv('https://media.lanka.live').fileUrl('abc123')).toBe(
      'https://media.lanka.live/abc123'
    )
  })

  it('does not double-slash when sha is appended', () => {
    expect(usePlayerEnv('https://media.lanka.live').fileUrl('zz')).toBe(
      'https://media.lanka.live/zz'
    )
  })
})
