// tests/composables/useUploader.test.ts
import { describe, it, expect, vi } from 'vitest'
import { uploadFile, UploadError } from '~/app/composables/useUploader'

class FakeXhr {
  method = ''
  url = ''
  headers: Record<string, string> = {}
  withCredentials = true
  status = 0
  sent: unknown = null
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  send(body: unknown) { this.sent = body }
  abort() { this.onabort?.() }
}

function setup() {
  const xhr = new FakeXhr()
  const factory = () => xhr as unknown as XMLHttpRequest
  const file = new Blob(['hello'])
  return { xhr, factory, file }
}

describe('uploadFile', () => {
  it('PUTs the file with exactly the ticket headers, no credentials, reporting progress', async () => {
    const { xhr, factory, file } = setup()
    const onProgress = vi.fn()
    const p = uploadFile(
      { method: 'PUT', url: 'https://r2.example/signed', headers: { 'content-type': 'video/mp4' }, file, onProgress },
      factory
    )
    expect(xhr.method).toBe('PUT')
    expect(xhr.url).toBe('https://r2.example/signed')
    expect(xhr.headers).toEqual({ 'content-type': 'video/mp4' })
    expect(xhr.withCredentials).toBe(false)
    expect(xhr.sent).toBe(file)
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 50, total: 200 })
    xhr.status = 200
    xhr.onload!()
    await p
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([0.25, 1])
  })

  it('rejects with the HTTP status on non-2xx', async () => {
    const { xhr, factory, file } = setup()
    const p = uploadFile({ method: 'PUT', url: '/u', headers: {}, file }, factory)
    xhr.status = 403
    xhr.onload!()
    const err = await p.catch((e) => e)
    expect(err).toBeInstanceOf(UploadError)
    expect(err).toMatchObject({ status: 403, aborted: false })
  })

  it('rejects on network error and on abort via AbortSignal; abort listener is detached afterwards', async () => {
    const a = setup()
    const p1 = uploadFile({ method: 'PUT', url: '/u', headers: {}, file: a.file }, a.factory)
    a.xhr.onerror!()
    expect(await p1.catch((e) => e)).toMatchObject({ status: null, aborted: false })

    const b = setup()
    const ctrl = new AbortController()
    const p2 = uploadFile({ method: 'PUT', url: '/u', headers: {}, file: b.file, signal: ctrl.signal }, b.factory)
    ctrl.abort()
    expect(await p2.catch((e) => e)).toMatchObject({ aborted: true })

    // completed upload: a later abort() on the same signal must not call xhr.abort()
    const c = setup()
    const ctrl2 = new AbortController()
    const abortSpy = vi.spyOn(c.xhr, 'abort')
    const p3 = uploadFile({ method: 'PUT', url: '/u', headers: {}, file: c.file, signal: ctrl2.signal }, c.factory)
    c.xhr.status = 200
    c.xhr.onload!()
    await p3
    ctrl2.abort()
    expect(abortSpy).not.toHaveBeenCalled()
  })
})
