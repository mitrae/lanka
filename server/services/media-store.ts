import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, stat as fsStat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'

export interface MediaStore {
  put(sha256: string, stream: Readable): Promise<void>
  has(sha256: string): Promise<boolean>
  open(sha256: string, opts?: { start?: number; end?: number }): Readable
  stat(sha256: string): Promise<{ bytes: number }>
  delete(sha256: string): Promise<void>

  putThumbnail(sha256: string, stream: Readable): Promise<void>
  hasThumbnail(sha256: string): Promise<boolean>
  openThumbnail(sha256: string): Readable
  deleteThumbnail(sha256: string): Promise<void>
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

  async put(sha: string, stream: Readable): Promise<void> {
    await this.putAtomic(this.path(sha), stream)
  }

  async has(sha: string): Promise<boolean> {
    return existsSync(this.path(sha))
  }

  open(sha: string, opts?: { start?: number; end?: number }): Readable {
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

  openThumbnail(sha: string): Readable {
    return createReadStream(this.thumbPath(sha))
  }

  async deleteThumbnail(sha: string): Promise<void> {
    try {
      await unlink(this.thumbPath(sha))
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }
}
