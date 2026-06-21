import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePlayerEnv } from '~/app/composables/player/usePlayerEnv'

describe('usePlayerEnv.fileUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // --- no NativeFS (browser / Pi) ---

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

  // --- NativeFS bridge present (Android APK) ---

  it('returns NativeFS.fileUrl when the file is cached on-device', () => {
    vi.stubGlobal('NativeFS', {
      exists: vi.fn().mockReturnValue(true),
      fileUrl: vi.fn().mockReturnValue('file:///data/user/0/ai.lanka.kiosk/files/media-cache/abc123'),
    })
    expect(usePlayerEnv('https://media.lanka.live').fileUrl('abc123')).toBe(
      'file:///data/user/0/ai.lanka.kiosk/files/media-cache/abc123'
    )
  })

  it('falls back to CDN URL when NativeFS.exists returns false', () => {
    vi.stubGlobal('NativeFS', {
      exists: vi.fn().mockReturnValue(false),
      fileUrl: vi.fn(),
    })
    expect(usePlayerEnv('https://media.lanka.live').fileUrl('abc123')).toBe(
      'https://media.lanka.live/media/abc123'
    )
  })

  it('falls back to server path when NativeFS is absent (no bridge)', () => {
    vi.stubGlobal('NativeFS', undefined)
    expect(usePlayerEnv().fileUrl('abc123')).toBe('/media/abc123')
  })
})
