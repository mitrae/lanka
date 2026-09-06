import { describe, expect, it } from 'vitest'
import { describeMediaError } from '~/app/composables/player/describeMediaError'

describe('describeMediaError', () => {
  it('names the MediaError code and keeps the UA message', () => {
    expect(describeMediaError({ code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' }, { networkState: 3, readyState: 0 }))
      .toBe('video error 4 SRC_NOT_SUPPORTED: MEDIA_ELEMENT_ERROR: Format error [network=3 ready=0]')
    expect(describeMediaError({ code: 2, message: '' }, { networkState: 2, readyState: 1 }))
      .toBe('video error 2 NETWORK [network=2 ready=1]')
    expect(describeMediaError({ code: 3, message: 'PIPELINE_ERROR_DECODE' }, { networkState: 1, readyState: 4 }))
      .toBe('video error 3 DECODE: PIPELINE_ERROR_DECODE [network=1 ready=4]')
  })

  it('tolerates a null error object and unknown codes', () => {
    expect(describeMediaError(null, { networkState: 0, readyState: 0 })).toBe('video error ? [network=0 ready=0]')
    expect(describeMediaError({ code: 9, message: 'x' }, { networkState: 0, readyState: 0 })).toBe('video error 9 ?: x [network=0 ready=0]')
  })

  it('appends the source kind so a blob retry is distinguishable from the direct URL', () => {
    expect(describeMediaError({ code: 4, message: 'm' }, { networkState: 3, readyState: 0, source: 'blob' }))
      .toBe('video error 4 SRC_NOT_SUPPORTED: m [network=3 ready=0 src=blob]')
  })

  it('caps a runaway UA message', () => {
    const long = 'x'.repeat(500)
    expect(describeMediaError({ code: 4, message: long }, { networkState: 0, readyState: 0 }).length).toBeLessThan(260)
  })
})
