import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleUploadApk } from '~/server/api/apk/upload.post'
import * as schema from '~/server/db/schema'
import { eq } from 'drizzle-orm'

const fakeStore = {
  put: async (_sha: string, _s: Readable) => {},
  has: async (_sha: string) => false,
  delete: async (_sha: string) => {},
  stat: async (_sha: string) => ({ bytes: 3 }),
  open: async (_sha: string) => Readable.from(Buffer.from([1, 2, 3])),
  putThumbnail: async () => {},
  hasThumbnail: async () => false,
  openThumbnail: async () => Readable.from(Buffer.from('')),
  deleteThumbnail: async () => {}
}

describe('handleUploadApk', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('persists version, sha256 and size — and no flavor (one APK serves both surfaces)', async () => {
    const row = await handleUploadApk(db, fakeStore, {
      sha256: 'a'.repeat(64),
      version: '0.3.0-surface',
      size: 3,
      stream: Readable.from(Buffer.from([1, 2, 3])),
      uploadedBy: null
    })
    const [r] = await db.select().from(schema.apkReleases).where(eq(schema.apkReleases.id, row.id))
    expect(r).toMatchObject({ version: '0.3.0-surface', sha256: 'a'.repeat(64), size: 3 })
    expect(r).not.toHaveProperty('flavor')
  })
})
