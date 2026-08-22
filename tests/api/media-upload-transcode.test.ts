import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { LocalDiskStore } from '~/server/services/media-store'
import { ingestMedia } from '~/server/services/media-ingest'
import { ensureQuality } from '~/server/services/transcode'
import * as schema from '~/server/db/schema'

vi.mock('~/server/services/transcode')
vi.mock('~/server/services/thumbnails', () => ({
  generateImageThumbnail: vi.fn().mockResolvedValue(Buffer.from('thumb')),
  generateVideoThumbnail: vi.fn().mockResolvedValue(Buffer.from('thumb'))
}))

// Handler-level quality validation (mirrors the `kind` validation in media.post.ts defineEventHandler)
describe('media upload — quality field handler validation', () => {
  const QUALITIES = ['low', 'standard', 'high'] as const
  type QualityPreset = (typeof QUALITIES)[number]

  function parseQuality(qualityRaw: string | undefined): QualityPreset {
    if (!qualityRaw) return 'standard'
    if (QUALITIES.includes(qualityRaw as QualityPreset)) return qualityRaw as QualityPreset
    throw createError({ statusCode: 400, message: 'quality must be "low", "standard", or "high"' })
  }

  it('absent quality defaults to standard', () => {
    expect(parseQuality(undefined)).toBe('standard')
  })

  it('empty string quality defaults to standard', () => {
    expect(parseQuality('')).toBe('standard')
  })

  it('valid quality values are accepted', () => {
    expect(parseQuality('low')).toBe('low')
    expect(parseQuality('standard')).toBe('standard')
    expect(parseQuality('high')).toBe('high')
  })

  it('invalid non-empty quality throws 400', () => {
    expect(() => parseQuality('ultra')).toThrow()
    try {
      parseQuality('ultra')
    } catch (err: any) {
      expect(err.statusCode).toBe(400)
      expect(err.message).toMatch(/quality must be/)
    }
  })
})

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

describe('ingestMedia — video transcode integration', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore
  let tmpFilesDir: string

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-test-transcode-'))
    store = new LocalDiskStore(dir)
    tmpFilesDir = mkdtempSync(join(tmpdir(), 'lanka-test-transcode-files-'))
  })

  afterEach(() => {
    vi.clearAllMocks()
    close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(tmpFilesDir, { recursive: true, force: true })
  })

  function readable(buf: Buffer) {
    return Readable.from([buf])
  }

  // (a) non-conforming video → transcoded to a different file
  it('(a) transcoded video: store.put called with transcoded sha + video/mp4, row has probe dims', async () => {
    const sourceBytes = Buffer.from('FAKE-HIGH-PROFILE-VIDEO-BYTES')
    const transcodedBytes = Buffer.from('TRANSCODED-VIDEO-BYTES-DIFFERENT')
    const sourceSha = sha256Hex(sourceBytes)
    const finalSha = sha256Hex(transcodedBytes)

    // Write a real file the mock will point to
    const transcodedFile = join(tmpFilesDir, 'transcoded.mp4')
    writeFileSync(transcodedFile, transcodedBytes)

    vi.mocked(ensureQuality).mockResolvedValue({
      path: transcodedFile,
      probe: {
        codec: 'h264',
        profile: 'Main',
        pixFmt: 'yuv420p',
        width: 1280,
        height: 720,
        durationMs: 5000,
        audioCodec: 'aac'
      },
      transcoded: true
    })

    const putSpy = vi.spyOn(store, 'put')

    const row = await ingestMedia(db, store, {
      stream: readable(sourceBytes),
      filename: 'video.mp4',
      kind: 'video',
      durationMs: 99999, // client value — should be ignored for videos
      width: 1920,
      height: 1080
    })

    // store.put called with the transcoded sha and video/mp4
    expect(putSpy).toHaveBeenCalledOnce()
    const [putSha, , putMime] = putSpy.mock.calls[0]
    expect(putSha).toBe(finalSha)
    expect(putMime).toBe('video/mp4')

    // Row fields from probe, not client
    expect(row.mimeType).toBe('video/mp4')
    expect(row.width).toBe(1280)
    expect(row.height).toBe(720)
    expect(row.durationMs).toBe(5000)

    // sha256 differs from sourceSha256 because content changed
    expect(row.sourceSha256).toBe(sourceSha)
    expect(row.sha256).toBe(finalSha)
    expect(row.sha256).not.toBe(row.sourceSha256)
  })

  // (b) conforming → passthrough (same path, same bytes → same sha)
  it('(b) passthrough video: sha256 === sourceSha256, store.put called with video/mp4', async () => {
    const sourceBytes = Buffer.from('SAFE-VIDEO-BYTES')
    const sourceSha = sha256Hex(sourceBytes)

    // Passthrough: same path (same bytes), so sha is identical to source sha
    // We need a real file that ensureQuality returns as-is.
    // The mock returns the same path the handler writes to (in.bin inside tmpDir).
    // Since we can't know tmpDir ahead of time, we use mockImplementation to
    // capture the inPath and return it unchanged.
    vi.mocked(ensureQuality).mockImplementation(async (inPath) => ({
      path: inPath,
      probe: {
        codec: 'h264',
        profile: 'Main',
        pixFmt: 'yuv420p',
        width: 1280,
        height: 720,
        durationMs: 3000,
        audioCodec: 'aac'
      },
      transcoded: false
    }))

    const putSpy = vi.spyOn(store, 'put')

    const row = await ingestMedia(db, store, {
      stream: readable(sourceBytes),
      filename: 'safe.mp4',
      kind: 'video'
    })

    expect(putSpy).toHaveBeenCalledOnce()
    const [, , putMime] = putSpy.mock.calls[0]
    expect(putMime).toBe('video/mp4')

    expect(row.sha256).toBe(sourceSha)
    expect(row.sourceSha256).toBe(sourceSha)
  })

  // (c) source dedup: same source bytes → return existing row, no transcode/put
  it('(c) source-dedup: pre-existing sourceSha256 match returns existing row without calling ensureQuality or store.put', async () => {
    const sourceBytes = Buffer.from('DUPLICATE-SOURCE-VIDEO')
    const sourceSha = sha256Hex(sourceBytes)

    // Pre-insert a row with this sourceSha256
    const [preInserted] = await db
      .insert(schema.media)
      .values({
        sha256: sourceSha, // doesn't matter what sha256 is, just must be unique
        sourceSha256: sourceSha,
        kind: 'video',
        filename: 'existing.mp4',
        mimeType: 'video/mp4',
        bytes: sourceBytes.length
      })
      .returning()

    const putSpy = vi.spyOn(store, 'put')

    const row = await ingestMedia(db, store, {
      stream: readable(sourceBytes),
      filename: 'upload.mp4',
      kind: 'video'
    })

    expect(row.id).toBe(preInserted.id)
    expect(vi.mocked(ensureQuality)).not.toHaveBeenCalled()
    expect(putSpy).not.toHaveBeenCalled()
  })

  // (d) transcode failure → 422
  it('(d) transcode failure → 422 error', async () => {
    vi.mocked(ensureQuality).mockRejectedValue(new Error('ffmpeg crashed'))

    await expect(
      ingestMedia(db, store, {
        stream: readable(Buffer.from('BAD-VIDEO')),
        filename: 'bad.mp4',
        kind: 'video'
      })
    ).rejects.toMatchObject({ statusCode: 422, message: 'Could not process this video' })
  })

  // quality: persists chosen preset on the media row
  it('persists the chosen quality on the media row', async () => {
    const sourceBytes = Buffer.from('QUALITY-HIGH-VIDEO-BYTES')
    const transcodedBytes = Buffer.from('QUALITY-HIGH-TRANSCODED-OUTPUT')
    const transcodedFile = join(tmpFilesDir, 'quality-high.mp4')
    writeFileSync(transcodedFile, transcodedBytes)

    vi.mocked(ensureQuality).mockResolvedValue({
      path: transcodedFile,
      probe: {
        codec: 'h264',
        profile: 'Main',
        pixFmt: 'yuv420p',
        width: 1920,
        height: 1080,
        durationMs: 3000,
        audioCodec: 'aac'
      },
      transcoded: true
    })

    const row = await ingestMedia(db, store, {
      stream: readable(sourceBytes),
      filename: 'video-hq.mp4',
      kind: 'video',
      quality: 'high'
    })
    expect(row.quality).toBe('high')
  })

  // quality: dedup on (source, quality) — same source+quality returns same row
  it('dedups on (source, quality): same source+quality returns the same row', async () => {
    const sourceBytes = Buffer.from('DEDUP-SAME-QUALITY-VIDEO')
    const transcodedBytes = Buffer.from('DEDUP-SAME-QUALITY-TRANSCODED')
    const transcodedFile = join(tmpFilesDir, 'dedup-same.mp4')
    writeFileSync(transcodedFile, transcodedBytes)

    vi.mocked(ensureQuality).mockResolvedValue({
      path: transcodedFile,
      probe: {
        codec: 'h264',
        profile: 'Main',
        pixFmt: 'yuv420p',
        width: 1280,
        height: 720,
        durationMs: 2000,
        audioCodec: null
      },
      transcoded: true
    })

    const a = await ingestMedia(db, store, {
      stream: readable(sourceBytes),
      filename: 'clip.mp4',
      kind: 'video',
      quality: 'standard'
    })
    const b = await ingestMedia(db, store, {
      stream: readable(sourceBytes),
      filename: 'clip.mp4',
      kind: 'video',
      quality: 'standard'
    })
    expect(b.id).toBe(a.id)
  })

  // quality: same source at a different quality creates a new row
  it('same source at a different quality creates a new row', async () => {
    const sourceBytes = Buffer.from('DEDUP-DIFF-QUALITY-VIDEO')

    const transcodedBytesStd = Buffer.from('DEDUP-DIFF-QUALITY-STD-TRANSCODED')
    const transcodedFileStd = join(tmpFilesDir, 'dedup-diff-std.mp4')
    writeFileSync(transcodedFileStd, transcodedBytesStd)

    const transcodedBytesHigh = Buffer.from('DEDUP-DIFF-QUALITY-HIGH-TRANSCODED')
    const transcodedFileHigh = join(tmpFilesDir, 'dedup-diff-high.mp4')
    writeFileSync(transcodedFileHigh, transcodedBytesHigh)

    // First call: standard
    vi.mocked(ensureQuality).mockResolvedValueOnce({
      path: transcodedFileStd,
      probe: {
        codec: 'h264',
        profile: 'Main',
        pixFmt: 'yuv420p',
        width: 1280,
        height: 720,
        durationMs: 2000,
        audioCodec: null
      },
      transcoded: true
    })
    // Second call: high
    vi.mocked(ensureQuality).mockResolvedValueOnce({
      path: transcodedFileHigh,
      probe: {
        codec: 'h264',
        profile: 'Main',
        pixFmt: 'yuv420p',
        width: 1920,
        height: 1080,
        durationMs: 2000,
        audioCodec: null
      },
      transcoded: true
    })

    const a = await ingestMedia(db, store, {
      stream: readable(sourceBytes),
      filename: 'clip.mp4',
      kind: 'video',
      quality: 'standard'
    })
    const c = await ingestMedia(db, store, {
      stream: readable(sourceBytes),
      filename: 'clip.mp4',
      kind: 'video',
      quality: 'high'
    })
    expect(c.id).not.toBe(a.id)
  })

  // (e) content dedup: pre-existing sha256 match (from different source) returns existing row
  it('(e) content-dedup: two different sources that transcode to identical bytes return existing row, no UNIQUE violation', async () => {
    const transcodeOutputBytes = Buffer.from('IDENTICAL-TRANSCODED-OUTPUT')
    const transcodeOutputSha = sha256Hex(transcodeOutputBytes)
    const transcodeFile = join(tmpFilesDir, 'identical.mp4')
    writeFileSync(transcodeFile, transcodeOutputBytes)

    // Pre-insert a row with sha256 = transcodeOutputSha (source_sha256 = NULL, as if imported before this feature)
    const [preInserted] = await db
      .insert(schema.media)
      .values({
        sha256: transcodeOutputSha,
        sourceSha256: null,
        kind: 'video',
        filename: 'existing-converted.mp4',
        mimeType: 'video/mp4',
        bytes: transcodeOutputBytes.length
      })
      .returning()

    // Different source bytes → different source sha → no source-dedup hit
    // but ensureQuality returns our identical output file
    vi.mocked(ensureQuality).mockResolvedValue({
      path: transcodeFile,
      probe: {
        codec: 'h264',
        profile: 'Main',
        pixFmt: 'yuv420p',
        width: 640,
        height: 360,
        durationMs: 2000,
        audioCodec: null
      },
      transcoded: true
    })

    const putSpy = vi.spyOn(store, 'put')

    const row = await ingestMedia(db, store, {
      stream: readable(Buffer.from('DIFFERENT-SOURCE-BYTES-X')),
      filename: 'new-upload.mp4',
      kind: 'video'
    })

    // Should return the existing row (content dedup)
    expect(row.id).toBe(preInserted.id)
    // No new row inserted
    const all = await db.select().from(schema.media)
    expect(all).toHaveLength(1)
    // No duplicate put
    expect(putSpy).not.toHaveBeenCalled()
  })
})
