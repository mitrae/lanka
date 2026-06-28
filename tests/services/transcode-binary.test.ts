import { describe, it, expect } from 'vitest'
import { resolveBinary } from '../../server/services/transcode'

describe('resolveBinary', () => {
  it('returns the installer path when it exists', () => {
    // process.execPath (the node binary) always exists
    expect(resolveBinary(process.execPath, 'fallback-name')).toBe(process.execPath)
  })

  it('falls back to the system name when the installer path is missing', () => {
    expect(resolveBinary('/no/such/path/ffprobe', 'ffprobe')).toBe('ffprobe')
  })
})
