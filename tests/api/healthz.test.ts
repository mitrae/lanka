import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleHealthz } from '~/server/api/healthz.get'

describe('healthz', () => {
  let db: TestDb
  let close: () => void
  let dir: string

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-healthz-'))
  })

  afterEach(() => {
    close()
    // Restore writable mode before rm (in case a test flipped it).
    try { chmodSync(dir, 0o755) } catch {}
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns ok when db responds and mediaDir is writable', async () => {
    const res = await handleHealthz(db, dir, 'test')
    expect(res.ok).toBe(true)
    expect(res.version).toBe('test')
  })

  it('throws when mediaDir is not writable', async () => {
    chmodSync(dir, 0o500) // r-x, no write
    await expect(handleHealthz(db, dir, 'test')).rejects.toThrow()
  })

  it('throws when mediaDir does not exist', async () => {
    await expect(handleHealthz(db, join(dir, 'does-not-exist'), 'test')).rejects.toThrow()
  })
})
