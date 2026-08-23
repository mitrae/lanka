import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, stat as fsStat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'

/** Where a client must send the raw bytes of a staged upload (see
 *  /api/media/uploads). On R2 this is a presigned PUT to the S3 endpoint; on
 *  local disk it is the app's own PUT /api/media/uploads/:id/file route. */
export interface StagedUploadTicket {
  method: 'PUT'
  url: string
  headers: Record<string, string>
  expiresAt: number // epoch ms
}

export const STAGED_UPLOAD_TTL_MS = 60 * 60 * 1000 // 1 h

export interface MediaStore {
  put(sha256: string, stream: Readable, contentType?: string): Promise<void>
  has(sha256: string): Promise<boolean>
  // Async so backends that fetch over the network (e.g. R2) fit the contract.
  open(sha256: string, opts?: { start?: number; end?: number }): Promise<Readable>
  stat(sha256: string): Promise<{ bytes: number }>
  delete(sha256: string): Promise<void>

  putThumbnail(sha256: string, stream: Readable): Promise<void>
  hasThumbnail(sha256: string): Promise<boolean>
  openThumbnail(sha256: string): Promise<Readable>
  deleteThumbnail(sha256: string): Promise<void>

  // --- staged uploads (bytes land here first; the ingest worker moves them) ---
  createStagedUpload(
    id: string,
    opts: { contentType: string; bytes: number }
  ): Promise<StagedUploadTicket>
  putStaged(id: string, stream: Readable, contentType: string): Promise<void>
  /** null when no staged object exists for `id`. */
  statStaged(id: string): Promise<{ bytes: number } | null>
  openStaged(id: string): Promise<Readable>
  /** Idempotent. */
  deleteStaged(id: string): Promise<void>
}

export class LocalDiskStore implements MediaStore {
  constructor(private readonly dir: string) {}

  private path(sha: string): string {
    return join(this.dir, sha)
  }

  private thumbPath(sha: string): string {
    return join(this.dir, '.thumbs', `${sha}.jpg`)
  }

  private async putAtomic(finalPath: string, stream: Readable): Promise<void> {
    await mkdir(dirname(finalPath), { recursive: true })
    const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await pipeline(stream, createWriteStream(tmp))
      await rename(tmp, finalPath)
    } catch (err) {
      try {
        await unlink(tmp)
      } catch {
        // ignore
      }
      throw err
    }
  }

  // contentType is ignored on local disk — the /media proxy sets Content-Type
  // from the DB mime_type. R2 has no such proxy, so it must bake it into the
  // object (see R2Store.put).
  async put(sha: string, stream: Readable, _contentType?: string): Promise<void> {
    await this.putAtomic(this.path(sha), stream)
  }

  async has(sha: string): Promise<boolean> {
    return existsSync(this.path(sha))
  }

  async open(
    sha: string,
    opts?: { start?: number; end?: number }
  ): Promise<Readable> {
    return createReadStream(this.path(sha), opts)
  }

  async stat(sha: string): Promise<{ bytes: number }> {
    const s = await fsStat(this.path(sha))
    return { bytes: s.size }
  }

  async delete(sha: string): Promise<void> {
    try {
      await unlink(this.path(sha))
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  async putThumbnail(sha: string, stream: Readable): Promise<void> {
    await this.putAtomic(this.thumbPath(sha), stream)
  }

  async hasThumbnail(sha: string): Promise<boolean> {
    return existsSync(this.thumbPath(sha))
  }

  async openThumbnail(sha: string): Promise<Readable> {
    return createReadStream(this.thumbPath(sha))
  }

  async deleteThumbnail(sha: string): Promise<void> {
    try {
      await unlink(this.thumbPath(sha))
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  private stagedPath(id: string): string {
    return join(this.dir, '.uploads', id)
  }

  async createStagedUpload(
    id: string,
    opts: { contentType: string; bytes: number }
  ): Promise<StagedUploadTicket> {
    return {
      method: 'PUT',
      url: `/api/media/uploads/${id}/file`,
      headers: { 'content-type': opts.contentType },
      expiresAt: Date.now() + STAGED_UPLOAD_TTL_MS
    }
  }

  async putStaged(id: string, stream: Readable, _contentType: string): Promise<void> {
    await this.putAtomic(this.stagedPath(id), stream)
  }

  async statStaged(id: string): Promise<{ bytes: number } | null> {
    try {
      const s = await fsStat(this.stagedPath(id))
      return { bytes: s.size }
    } catch (err: any) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  async openStaged(id: string): Promise<Readable> {
    return createReadStream(this.stagedPath(id))
  }

  async deleteStaged(id: string): Promise<void> {
    try {
      await unlink(this.stagedPath(id))
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }
}
