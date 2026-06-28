import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleUploadApk, parseApkFlavor } from '~/server/api/apk/upload.post'
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

  it('persists flavor on upload', async () => {
    const row = await handleUploadApk(db, fakeStore, {
      sha256: 'a'.repeat(64),
      version: '1.0.0',
      size: 3,
      stream: Readable.from(Buffer.from([1, 2, 3])),
      uploadedBy: null,
      flavor: 'native'
    })
    const [r] = await db.select().from(schema.apkReleases).where(eq(schema.apkReleases.id, row.id))
    expect(r.flavor).toBe('native')
  })

  it('defaults flavor to webview', async () => {
    const row = await handleUploadApk(db, fakeStore, {
      sha256: 'b'.repeat(64),
      version: '1.0.0',
      size: 3,
      stream: Readable.from(Buffer.from([1, 2, 3])),
      uploadedBy: null
    })
    const [r] = await db.select().from(schema.apkReleases).where(eq(schema.apkReleases.id, row.id))
    expect(r.flavor).toBe('webview')
  })

  it('persists a valid flavor parsed from the form', async () => {
    const flavor = parseApkFlavor('native')
    const row = await handleUploadApk(db, fakeStore, {
      sha256: 'c'.repeat(64),
      version: '1.0.0',
      size: 3,
      stream: Readable.from(Buffer.from([1, 2, 3])),
      uploadedBy: null,
      flavor
    })
    const [r] = await db.select().from(schema.apkReleases).where(eq(schema.apkReleases.id, row.id))
    expect(r.flavor).toBe('native')
  })
})

describe('parseApkFlavor', () => {
  it('returns undefined for an absent flavor field', () => {
    expect(parseApkFlavor(undefined)).toBeUndefined()
    expect(parseApkFlavor('')).toBeUndefined()
  })

  it('accepts webview and native', () => {
    expect(parseApkFlavor('webview')).toBe('webview')
    expect(parseApkFlavor(' native ')).toBe('native')
  })

  it('rejects an unknown flavor with a 400', () => {
    expect(() => parseApkFlavor('desktop')).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    )
  })
})
