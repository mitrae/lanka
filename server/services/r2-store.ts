// server/services/r2-store.ts
//
// Cloudflare R2 (S3-compatible) implementation of MediaStore. Selected by
// media-store-singleton when the R2_* runtime config is present; otherwise the
// server falls back to LocalDiskStore.
//
// Serving model: the Nitro server proxies R2. Players keep fetching
// `/media/<sha>` over the tailnet; this store streams the bytes (with Range)
// from R2 to the server, which relays them. R2 has no egress fees, players
// never touch the public internet, and the APK's on-device cache is unchanged.
//
// The AWS SDK is imported lazily (dynamic import) so dev/test runs that use
// LocalDiskStore never load it.
import type { Readable } from 'node:stream'
import type { MediaStore } from './media-store'

export interface R2Config {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export class R2Store implements MediaStore {
  // SDK handles are `any` to keep this adapter decoupled from the heavy
  // @aws-sdk types; it is only loaded when R2 is actually configured.
  private _s3: any = null
  private _mod: any = null

  constructor(private readonly cfg: R2Config) {}

  private async mod(): Promise<any> {
    if (!this._mod) this._mod = await import('@aws-sdk/client-s3')
    return this._mod
  }

  private async s3(): Promise<any> {
    if (!this._s3) {
      const { S3Client } = await this.mod()
      this._s3 = new S3Client({
        region: 'auto', // R2 ignores region but the SDK requires one
        endpoint: this.cfg.endpoint,
        credentials: {
          accessKeyId: this.cfg.accessKeyId,
          secretAccessKey: this.cfg.secretAccessKey
        }
      })
    }
    return this._s3
  }

  private key(sha: string): string {
    return `media/${sha}`
  }

  private thumbKey(sha: string): string {
    return `thumbs/${sha}.jpg`
  }

  // --- writes (streamed via lib-storage so unknown-length streams work) ---

  async put(sha: string, stream: Readable, contentType?: string): Promise<void> {
    // contentType MUST be set: players fetch media bytes straight from the R2
    // public CDN, and an HTML5 <video> rejects a source with no/empty
    // Content-Type (MEDIA_ERR_SRC_NOT_SUPPORTED).
    await this.upload(this.key(sha), stream, contentType)
  }

  async putThumbnail(sha: string, stream: Readable): Promise<void> {
    await this.upload(this.thumbKey(sha), stream, 'image/jpeg')
  }

  private async upload(
    key: string,
    body: Readable,
    contentType?: string
  ): Promise<void> {
    const { Upload } = await import('@aws-sdk/lib-storage')
    const up = new Upload({
      client: await this.s3(),
      params: {
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType
      }
    })
    await up.done()
  }

  // --- existence ---

  async has(sha: string): Promise<boolean> {
    return this.exists(this.key(sha))
  }

  async hasThumbnail(sha: string): Promise<boolean> {
    return this.exists(this.thumbKey(sha))
  }

  private async exists(key: string): Promise<boolean> {
    const { HeadObjectCommand } = await this.mod()
    try {
      const s3 = await this.s3()
      await s3.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
      return true
    } catch (err: any) {
      if (
        err?.$metadata?.httpStatusCode === 404 ||
        err?.name === 'NotFound' ||
        err?.name === 'NoSuchKey'
      ) {
        return false
      }
      throw err
    }
  }

  // --- reads ---

  async open(
    sha: string,
    opts?: { start?: number; end?: number }
  ): Promise<Readable> {
    return this.get(this.key(sha), opts)
  }

  async openThumbnail(sha: string): Promise<Readable> {
    return this.get(this.thumbKey(sha))
  }

  private async get(
    key: string,
    opts?: { start?: number; end?: number }
  ): Promise<Readable> {
    const { GetObjectCommand } = await this.mod()
    const range =
      opts && (opts.start !== undefined || opts.end !== undefined)
        ? `bytes=${opts.start ?? 0}-${opts.end ?? ''}`
        : undefined
    const s3 = await this.s3()
    const res = await s3.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, Range: range })
    )
    // In Node, the S3 GetObject Body is a Node Readable stream.
    return res.Body as Readable
  }

  async stat(sha: string): Promise<{ bytes: number }> {
    const { HeadObjectCommand } = await this.mod()
    const s3 = await this.s3()
    const res = await s3.send(
      new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(sha) })
    )
    return { bytes: res.ContentLength ?? 0 }
  }

  // --- deletes (idempotent: R2 delete of a missing key succeeds) ---

  async delete(sha: string): Promise<void> {
    await this.del(this.key(sha))
  }

  async deleteThumbnail(sha: string): Promise<void> {
    await this.del(this.thumbKey(sha))
  }

  private async del(key: string): Promise<void> {
    const { DeleteObjectCommand } = await this.mod()
    const s3 = await this.s3()
    await s3.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key })
    )
  }
}
