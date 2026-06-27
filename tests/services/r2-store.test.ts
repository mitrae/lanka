import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

// Mock the AWS SDK so the store can be exercised without network/credentials.
// Hoisted so the (hoisted) vi.mock factories below can reference them, and
// declared as classes so `new S3Client()` / `new Upload()` are constructable.
const { sendMock, uploadCtor, uploadDone } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  uploadCtor: vi.fn(),
  uploadDone: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@aws-sdk/client-s3', () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = sendMock
    },
    GetObjectCommand: class extends Cmd {},
    HeadObjectCommand: class extends Cmd {},
    DeleteObjectCommand: class extends Cmd {}
  }
})

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    done = uploadDone
    constructor(args: unknown) {
      uploadCtor(args)
    }
  }
}))

import { R2Store } from '~/server/services/r2-store'

const cfg = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'lanka-media',
  accessKeyId: 'key',
  secretAccessKey: 'secret'
}

function lastInput() {
  return sendMock.mock.calls.at(-1)![0].input as Record<string, unknown>
}

describe('R2Store', () => {
  beforeEach(() => {
    sendMock.mockReset()
    uploadCtor.mockReset()
    uploadDone.mockClear()
  })

  it('open() requests media/<sha> with an inclusive Range and returns the body', async () => {
    const body = Readable.from([Buffer.from('hello')])
    sendMock.mockResolvedValue({ Body: body })
    const store = new R2Store(cfg)

    const out = await store.open('a'.repeat(64), { start: 2, end: 5 })

    expect(lastInput()).toMatchObject({
      Bucket: 'lanka-media',
      Key: `media/${'a'.repeat(64)}`,
      Range: 'bytes=2-5'
    })
    expect(out).toBe(body)
  })

  it('openThumbnail() reads from the thumbs/ prefix without a Range', async () => {
    sendMock.mockResolvedValue({ Body: Readable.from([Buffer.from('jpg')]) })
    const store = new R2Store(cfg)

    await store.openThumbnail('b'.repeat(64))

    expect(lastInput().Key).toBe(`thumbs/${'b'.repeat(64)}.jpg`)
    expect(lastInput().Range).toBeUndefined()
  })

  it('has() is true when HEAD succeeds and false on a 404', async () => {
    const store = new R2Store(cfg)

    sendMock.mockResolvedValueOnce({ ContentLength: 10 })
    expect(await store.has('c'.repeat(64))).toBe(true)

    sendMock.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
    expect(await store.has('d'.repeat(64))).toBe(false)
  })

  it('has() rethrows non-404 errors', async () => {
    const store = new R2Store(cfg)
    sendMock.mockRejectedValueOnce({ $metadata: { httpStatusCode: 500 } })
    await expect(store.has('e'.repeat(64))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 500 }
    })
  })

  it('stat() returns ContentLength from a HEAD', async () => {
    const store = new R2Store(cfg)
    sendMock.mockResolvedValue({ ContentLength: 4242 })
    expect(await store.stat('f'.repeat(64))).toEqual({ bytes: 4242 })
  })

  it('put() uploads to media/<sha> via lib-storage', async () => {
    const store = new R2Store(cfg)
    await store.put('1'.repeat(64), Readable.from([Buffer.from('x')]))
    expect(uploadCtor).toHaveBeenCalledTimes(1)
    expect(uploadCtor.mock.calls[0][0].params).toMatchObject({
      Bucket: 'lanka-media',
      Key: `media/${'1'.repeat(64)}`
    })
  })

  it('put() sets the Content-Type on the object (so the CDN serves a playable type)', async () => {
    const store = new R2Store(cfg)
    await store.put('4'.repeat(64), Readable.from([Buffer.from('x')]), 'video/mp4')
    expect(uploadCtor.mock.calls[0][0].params).toMatchObject({
      Key: `media/${'4'.repeat(64)}`,
      ContentType: 'video/mp4'
    })
  })

  it('putThumbnail() uploads JPEG to the thumbs/ prefix', async () => {
    const store = new R2Store(cfg)
    await store.putThumbnail('2'.repeat(64), Readable.from([Buffer.from('x')]))
    expect(uploadCtor.mock.calls[0][0].params).toMatchObject({
      Key: `thumbs/${'2'.repeat(64)}.jpg`,
      ContentType: 'image/jpeg'
    })
  })

  it('delete() removes the media object', async () => {
    const store = new R2Store(cfg)
    sendMock.mockResolvedValue({})
    await store.delete('3'.repeat(64))
    expect(lastInput().Key).toBe(`media/${'3'.repeat(64)}`)
  })
})
