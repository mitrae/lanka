import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { Readable } from 'node:stream'
import { createTestDb, type TestDb } from '../helpers/test-db'
import * as schema from '~/server/db/schema'
import { handleListApkReleases } from '~/server/api/apk/index.get'
import { handleDeleteApkRelease } from '~/server/api/apk/[id].delete'
import { handleUploadApk } from '~/server/api/apk/upload.post'

const fakeStore = {
  put: async (_sha: string, _s: Readable) => {},
  has: async (_sha: string) => false,
  delete: async (_sha: string) => {},
  stat: async (_sha: string) => ({ bytes: 1024 }),
  open: async (_sha: string) => Readable.from(Buffer.from('apkbytes')),
  putThumbnail: async () => {},
  hasThumbnail: async () => false,
  openThumbnail: async () => Readable.from(Buffer.from('')),
  deleteThumbnail: async () => {}
}

describe('APK release API', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('upload creates apk_releases row', async () => {
    const sha256 = 'a'.repeat(64)
    const stream = Readable.from(Buffer.from('apkbytes'))
    const result = await handleUploadApk(db, fakeStore, {
      sha256,
      manifest: { packageName: 'ai.lanka.kiosk', versionName: '1.2.3', versionCode: 7 },
      size: 8,
      stream,
      uploadedBy: null
    })
    expect(result.version).toBe('1.2.3')
    expect(result.versionCode).toBe(7)
    expect(result.sha256).toBe(sha256)
    expect(result.size).toBe(8)
  })

  it('list returns all releases newest first', async () => {
    await db.insert(schema.apkReleases).values({ version: '1.0.0', sha256: 'a'.repeat(64), size: 100 })
    await db.insert(schema.apkReleases).values({ version: '1.1.0', sha256: 'b'.repeat(64), size: 200 })
    const list = await handleListApkReleases(db)
    expect(list).toHaveLength(2)
    expect(list[0].version).toBe('1.1.0')
  })

  it('delete removes row and calls store.delete', async () => {
    const deleted: string[] = []
    const store = { ...fakeStore, delete: async (sha: string) => { deleted.push(sha) } }
    const sha256 = 'c'.repeat(64)
    const [row] = await db.insert(schema.apkReleases).values({ version: '1.0.0', sha256, size: 100 }).returning()
    await handleDeleteApkRelease(db, store, row.id)
    const remaining = await db.select().from(schema.apkReleases).where(eq(schema.apkReleases.id, row.id))
    expect(remaining).toHaveLength(0)
    expect(deleted).toContain(sha256)
  })

  it('delete 404s on unknown id', async () => {
    await expect(handleDeleteApkRelease(db, fakeStore, 999)).rejects.toThrow(/not found/i)
  })
})
