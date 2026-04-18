import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { sha256Stream, sha256Buffer } from '~/server/utils/sha256'

describe('sha256', () => {
  it('hashes a buffer', () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(sha256Buffer(Buffer.from('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
  })

  it('hashes a stream', async () => {
    const stream = Readable.from([Buffer.from('hel'), Buffer.from('lo')])
    expect(await sha256Stream(stream)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
  })
})
