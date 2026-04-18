import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, stat as fsStat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'

export interface MediaStore {
  put(sha256: string, stream: Readable): Promise<void>
  has(sha256: string): Promise<boolean>
  open(sha256: string): Readable
  stat(sha256: string): Promise<{ bytes: number }>
  delete(sha256: string): Promise<void>
}

export class LocalDiskStore implements MediaStore {
  constructor(private readonly dir: string) {}

  private path(sha: string): string {
    return join(this.dir, sha)
  }

  async put(sha: string, stream: Readable): Promise<void> {
    const final = this.path(sha)
    await mkdir(dirname(final), { recursive: true })
    const tmp = `${final}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await pipeline(stream, createWriteStream(tmp))
      await rename(tmp, final)
    } catch (err) {
      try {
        await unlink(tmp)
      } catch {
        // ignore
      }
      throw err
    }
  }

  async has(sha: string): Promise<boolean> {
    return existsSync(this.path(sha))
  }

  open(sha: string): Readable {
    return createReadStream(this.path(sha))
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
}
