import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleUploadApk, resolveReleaseVersion, KIOSK_PACKAGE } from '~/server/api/apk/upload.post'
import type { ApkManifest } from '~/server/services/apk-manifest'

const kiosk = (over: Partial<ApkManifest> = {}): ApkManifest => ({
  packageName: KIOSK_PACKAGE, versionName: '0.5.0', versionCode: 3, ...over
})
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

  it('persists version, versionCode, sha256 and size — and no flavor (one APK serves both surfaces)', async () => {
    const row = await handleUploadApk(db, fakeStore, {
      sha256: 'a'.repeat(64),
      manifest: kiosk({ versionName: '0.3.0-surface', versionCode: 2 }),
      size: 3,
      stream: Readable.from(Buffer.from([1, 2, 3])),
      uploadedBy: null
    })
    const [r] = await db.select().from(schema.apkReleases).where(eq(schema.apkReleases.id, row.id))
    expect(r).toMatchObject({ version: '0.3.0-surface', versionCode: 2, sha256: 'a'.repeat(64), size: 3 })
    expect(r).not.toHaveProperty('flavor')
  })

  it('the version comes from the manifest when no label is given', async () => {
    const row = await handleUploadApk(db, fakeStore, {
      sha256: 'b'.repeat(64), manifest: kiosk(), size: 3,
      stream: Readable.from(Buffer.from([1])), uploadedBy: null
    })
    expect(row.version).toBe('0.5.0')
    expect(row.versionCode).toBe(3)
  })

  it('refuses a package that is not the kiosk, before touching the store', async () => {
    let putCalls = 0
    const store = { ...fakeStore, put: async () => { putCalls++ } }
    await expect(handleUploadApk(db, store, {
      sha256: 'c'.repeat(64), manifest: kiosk({ packageName: 'com.example.other' }), size: 3,
      stream: Readable.from(Buffer.from([1])), uploadedBy: null
    })).rejects.toMatchObject({ statusCode: 400 })
    expect(putCalls).toBe(0)
    expect(await db.select().from(schema.apkReleases)).toHaveLength(0)
  })
})

describe('resolveReleaseVersion', () => {
  it('defaults to versionName; blank or whitespace labels count as absent', () => {
    expect(resolveReleaseVersion(kiosk())).toBe('0.5.0')
    expect(resolveReleaseVersion(kiosk(), '')).toBe('0.5.0')
    expect(resolveReleaseVersion(kiosk(), '   ')).toBe('0.5.0')
  })

  it('accepts a label equal to versionName or extending it with a suffix', () => {
    expect(resolveReleaseVersion(kiosk(), '0.5.0')).toBe('0.5.0')
    expect(resolveReleaseVersion(kiosk(), ' 0.5.0-hotfix ')).toBe('0.5.0-hotfix')
  })

  it('rejects a label that contradicts versionName — a mislabeled upload', () => {
    expect(() => resolveReleaseVersion(kiosk(), '0.6.0')).toThrow(/contradicts/)
    expect(() => resolveReleaseVersion(kiosk(), '0.5.01')).toThrow(/contradicts/)
    expect(() => resolveReleaseVersion(kiosk(), 'latest')).toThrow(/contradicts/)
  })

  it('rejects a foreign package by name', () => {
    expect(() => resolveReleaseVersion(kiosk({ packageName: 'ai.lanka.kiosk.debug' }))).toThrow(/not a Lanka kiosk build/)
  })
})
