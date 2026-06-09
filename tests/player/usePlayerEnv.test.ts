import { describe, expect, it } from 'vitest'
import { usePlayerEnv } from '~/app/composables/player/usePlayerEnv'

describe('usePlayerEnv.fileUrl', () => {
  it('returns the relative server path when no media base is set', () => {
    expect(usePlayerEnv().fileUrl('abc123')).toBe('/media/abc123')
  })

  it('returns an absolute CDN url (under the media/ prefix) when a media base is set', () => {
    expect(usePlayerEnv('https://media.lanka.live').fileUrl('abc123')).toBe(
      'https://media.lanka.live/media/abc123'
    )
  })

  it('does not double-slash when sha is appended', () => {
    expect(usePlayerEnv('https://media.lanka.live').fileUrl('zz')).toBe(
      'https://media.lanka.live/media/zz'
    )
  })

  it('strips a trailing slash on the media base', () => {
    expect(usePlayerEnv('https://media.lanka.live/').fileUrl('abc')).toBe(
      'https://media.lanka.live/media/abc'
    )
  })
})
