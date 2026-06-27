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
  // The APK serves cached bytes locally via the shouldInterceptRequest
  // interceptor on the SAME /media/<sha> URL — never file://. An http-origin
  // player page can't load file:// resources ("Not allowed to load local
  // resource"), so fileUrl must return the http(s) URL even when cached.

  it('returns the /media/<sha> URL (never file://) even when NativeFS reports cached', () => {
    vi.stubGlobal('NativeFS', {
      exists: vi.fn().mockReturnValue(true),
      fileUrl: vi.fn().mockReturnValue('file:///data/user/0/ai.lanka.kiosk/files/media-cache/abc123'),
    })
    const url = usePlayerEnv('https://media.lanka.live').fileUrl('abc123')
    expect(url).toBe('https://media.lanka.live/media/abc123')
    expect(url.startsWith('file://')).toBe(false)
  })

  it('returns the relative /media/<sha> URL on the APK when no media base is set', () => {
    vi.stubGlobal('NativeFS', {
      exists: vi.fn().mockReturnValue(true),
      fileUrl: vi.fn().mockReturnValue('file:///whatever'),
    })
    expect(usePlayerEnv().fileUrl('abc123')).toBe('/media/abc123')
  })

  it('falls back to server path when NativeFS is absent (no bridge)', () => {
    vi.stubGlobal('NativeFS', undefined)
    expect(usePlayerEnv().fileUrl('abc123')).toBe('/media/abc123')
  })
})
