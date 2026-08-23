import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

// Mock the AWS SDK so the store can be exercised without network/credentials.
// Hoisted so the (hoisted) vi.mock factories below can reference them, and
// declared as classes so `new S3Client()` / `new Upload()` are constructable.
const { sendMock, uploadCtor, uploadDone, getSignedUrlMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  uploadCtor: vi.fn(),
  uploadDone: vi.fn().mockResolvedValue(undefined),
  getSignedUrlMock: vi.fn().mockResolvedValue('https://acct.r2.cloudflarestorage.com/signed')
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
    DeleteObjectCommand: class extends Cmd {},
    PutObjectCommand: class extends Cmd {}
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

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: getSignedUrlMock }))

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
    getSignedUrlMock.mockClear()
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

  it('createStagedUpload presigns a 1h PUT for uploads/<id> bound to the content type', async () => {
    const store = new R2Store(cfg)
    const id = '44444444-4444-4444-8444-444444444444'
    const t = await store.createStagedUpload(id, { contentType: 'video/mp4', bytes: 5 })
    expect(t.method).toBe('PUT')
    expect(t.url).toBe('https://acct.r2.cloudflarestorage.com/signed')
    expect(t.headers).toEqual({ 'content-type': 'video/mp4' })
    const [, cmd, opts] = getSignedUrlMock.mock.calls[0]
    expect(cmd.input).toEqual({ Bucket: 'lanka-media', Key: `uploads/${id}`, ContentType: 'video/mp4' })
    expect(opts).toEqual({ expiresIn: 3600 })
  })

  it('statStaged returns the size or null on 404; openStaged/deleteStaged use uploads/<id>', async () => {
    const store = new R2Store(cfg)
    const id = '55555555-5555-4555-8555-555555555555'
    sendMock.mockResolvedValueOnce({ ContentLength: 42 })
    expect(await store.statStaged(id)).toEqual({ bytes: 42 })
    expect(lastInput().Key).toBe(`uploads/${id}`)
    sendMock.mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
    expect(await store.statStaged(id)).toBeNull()
    const body = Readable.from([Buffer.from('z')])
    sendMock.mockResolvedValueOnce({ Body: body })
    expect(await store.openStaged(id)).toBe(body)
    sendMock.mockResolvedValueOnce({})
    await store.deleteStaged(id)
    expect(lastInput().Key).toBe(`uploads/${id}`)
  })

  it('putStaged streams to uploads/<id> with the content type', async () => {
    const store = new R2Store(cfg)
    await store.putStaged('66666666-6666-4666-8666-666666666666', Readable.from([Buffer.from('q')]), 'image/png')
    expect(uploadCtor.mock.calls[0][0].params).toMatchObject({
      Bucket: 'lanka-media',
      Key: 'uploads/66666666-6666-4666-8666-666666666666',
      ContentType: 'image/png'
    })
  })
})
