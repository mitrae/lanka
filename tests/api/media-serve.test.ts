import { describe, it, expect } from 'vitest'
import { planMediaResponse } from '~/server/routes/media/[sha256].get'

describe('planMediaResponse', () => {
  it('returns 200 with full content when no Range header', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: undefined })
    expect(p).toEqual({
      status: 200,
      start: 0,
      end: 99,
      contentLength: 100,
      contentRange: null
    })
  })

  it('returns 206 with correct byte range for bytes=10-49', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'bytes=10-49' })
    expect(p).toEqual({
      status: 206,
      start: 10,
      end: 49,
      contentLength: 40,
      contentRange: 'bytes 10-49/100'
    })
  })

  it('handles open-ended ranges bytes=50-', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'bytes=50-' })
    expect(p).toEqual({
      status: 206,
      start: 50,
      end: 99,
      contentLength: 50,
      contentRange: 'bytes 50-99/100'
    })
  })

  it('handles suffix ranges bytes=-20 (last 20 bytes)', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'bytes=-20' })
    expect(p).toEqual({
      status: 206,
      start: 80,
      end: 99,
      contentLength: 20,
      contentRange: 'bytes 80-99/100'
    })
  })

  it('clamps end to file size - 1', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'bytes=50-999' })
    expect(p.status).toBe(206)
    expect(p.end).toBe(99)
    expect(p.contentLength).toBe(50)
  })

  it('returns 416 when start is beyond file size', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'bytes=200-300' })
    expect(p.status).toBe(416)
  })

  it('returns 416 for malformed Range', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'banana' })
    expect(p.status).toBe(416)
  })
})
