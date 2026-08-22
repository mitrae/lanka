// app/composables/useUploader.ts
//
// Raw-bytes upload with progress. fetch() has no upload progress, so this is
// XMLHttpRequest. Used for both transports handed out by POST /api/media/uploads:
// a cross-origin presigned PUT to R2 (must NOT carry cookies and must send
// exactly the signed headers) and the same-origin PUT /api/media/uploads/:id/file
// (browser attaches the session cookie itself for same-origin requests).

export interface UploadRequest {
  method: 'PUT'
  url: string
  headers: Record<string, string>
  file: Blob
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly aborted = false
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

export type XhrFactory = () => XMLHttpRequest

export function uploadFile(
  req: UploadRequest,
  factory: XhrFactory = () => new XMLHttpRequest()
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = factory()
    const onAbortSignal = () => xhr.abort()
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      req.signal?.removeEventListener('abort', onAbortSignal)
      fn()
    }

    xhr.open(req.method, req.url, true)
    xhr.withCredentials = false
    for (const [k, v] of Object.entries(req.headers)) xhr.setRequestHeader(k, v)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) req.onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () =>
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          req.onProgress?.(1)
          resolve()
        } else {
          reject(new UploadError(`Upload failed with HTTP ${xhr.status}`, xhr.status))
        }
      })
    xhr.onerror = () => settle(() => reject(new UploadError('Network error during upload', null)))
    xhr.onabort = () => settle(() => reject(new UploadError('Upload cancelled', null, true)))

    if (req.signal) {
      if (req.signal.aborted) {
        settle(() => reject(new UploadError('Upload cancelled', null, true)))
        return
      }
      req.signal.addEventListener('abort', onAbortSignal, { once: true })
    }
    xhr.send(req.file)
  })
}
