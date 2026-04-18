import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { LocalDiskStore } from '~/server/services/media-store'

describe('LocalDiskStore', () => {
  let dir: string
  let store: LocalDiskStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lanka-test-'))
    store = new LocalDiskStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a stream to sha256 path', async () => {
    const sha = 'abc123'
    await store.put(sha, Readable.from([Buffer.from('hello')]))
    expect(existsSync(join(dir, sha))).toBe(true)
    expect(await store.has(sha)).toBe(true)
  })

  it('reports unknown sha as absent', async () => {
    expect(await store.has('missing')).toBe(false)
  })

  it('opens a readable stream by sha', async () => {
    await store.put('def', Readable.from([Buffer.from('world')]))
    const s = store.open('def')
    const chunks: Buffer[] = []
    for await (const chunk of s) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('world')
  })

  it('returns byte length via stat', async () => {
    await store.put('ghi', Readable.from([Buffer.from('12345')]))
    const stat = await store.stat('ghi')
    expect(stat.bytes).toBe(5)
  })

  it('deletes a file', async () => {
    await store.put('jkl', Readable.from([Buffer.from('x')]))
    await store.delete('jkl')
    expect(await store.has('jkl')).toBe(false)
  })

  it('put is atomic (writes to temp then renames)', async () => {
    // Confirm no stray .tmp files remain
    await store.put('mno', Readable.from([Buffer.from('data')]))
    const fs = await import('node:fs/promises')
    const entries = await fs.readdir(dir)
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })
})
