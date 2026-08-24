import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia } from '../helpers/fixtures'
import { handleUpdateMedia } from '~/server/api/media/[id].patch'

describe('media rename API', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  const seed = () =>
    seedMedia(db, { sha256: 'a'.repeat(64), kind: 'video', filename: 'EzZXlNPn5Hrr.mp4' })

  it('renames a file', async () => {
    const m = await seed()
    const row = await handleUpdateMedia(db, m.id, { filename: 'Summer promo.mp4' })
    expect(row.filename).toBe('Summer promo.mp4')
  })

  it('trims surrounding whitespace', async () => {
    const m = await seed()
    const row = await handleUpdateMedia(db, m.id, { filename: '  Spaced out.mp4  ' })
    expect(row.filename).toBe('Spaced out.mp4')
  })

  it('leaves the content address alone', async () => {
    const m = await seed()
    const row = await handleUpdateMedia(db, m.id, { filename: 'Renamed.mp4' })
    expect(row.sha256).toBe(m.sha256)
    expect(row.mimeType).toBe(m.mimeType)
  })

  it('rejects a blank name', async () => {
    const m = await seed()
    await expect(handleUpdateMedia(db, m.id, { filename: '   ' })).rejects.toThrow()
  })

  it('rejects a name over 255 characters', async () => {
    const m = await seed()
    await expect(handleUpdateMedia(db, m.id, { filename: 'x'.repeat(256) })).rejects.toThrow()
  })

  it('404s on unknown media', async () => {
    await expect(
      handleUpdateMedia(db, 999, { filename: 'Nope.mp4' })
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
