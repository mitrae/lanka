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
    const s = await store.open('def')
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

  it('opens a ranged stream', async () => {
    await store.put('rng', Readable.from([Buffer.from('0123456789')]))
    const s = await store.open('rng', { start: 2, end: 5 })
    const chunks: Buffer[] = []
    for await (const c of s) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('2345')
  })

  it('writes and reads a thumbnail at the .thumbs/ namespace', async () => {
    await store.putThumbnail('thumbsha', Readable.from([Buffer.from('JPEG-BYTES')]))
    expect(await store.hasThumbnail('thumbsha')).toBe(true)

    const s = await store.openThumbnail('thumbsha')
    const chunks: Buffer[] = []
    for await (const c of s) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('JPEG-BYTES')
  })

  it('hasThumbnail returns false when not written', async () => {
    expect(await store.hasThumbnail('no-thumb')).toBe(false)
  })

  it('thumbnail put is atomic (no .tmp leftover)', async () => {
    await store.putThumbnail('atomic', Readable.from([Buffer.from('x')]))
    const fs = await import('node:fs/promises')
    const thumbsDir = join(dir, '.thumbs')
    const entries = await fs.readdir(thumbsDir)
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })
})
