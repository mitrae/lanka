import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from '@ffmpeg-installer/ffmpeg'
import ffmpegLib from 'fluent-ffmpeg'
import { isKioskSafe, ensureKioskSafe } from '../../server/services/transcode'
import type { VideoProbe } from '../../server/services/transcode'

ffmpegLib.setFfmpegPath(ffmpegPath.path)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function probe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    codec: 'h264',
    profile: 'Main',
    pixFmt: 'yuv420p',
    width: 640,
    height: 360,
    durationMs: 5000,
    audioCodec: 'aac',
    ...overrides,
  }
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lanka-transcode-test-'))
}

async function generateClip(
  outPath: string,
  opts: {
    profile: string
    width: number
    height: number
    durationSecs?: number
  }
): Promise<void> {
  const { profile, width, height, durationSecs = 1 } = opts
  return new Promise((resolve, reject) => {
    ffmpegLib()
      .input(`testsrc=duration=${durationSecs}:size=${width}x${height}:rate=10`)
      .inputOptions(['-f', 'lavfi'])
      .outputOptions([
        '-c:v', 'libx264',
        `-profile:v`, profile,
        '-pix_fmt', 'yuv420p',
        '-t', String(durationSecs),
      ])
      .output(outPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run()
  })
}

// ---------------------------------------------------------------------------
// isKioskSafe truth table
// ---------------------------------------------------------------------------

describe('isKioskSafe', () => {
  it('rejects High profile', () => {
    expect(isKioskSafe(probe({ profile: 'High' }))).toBe(false)
  })

  it('accepts Main profile', () => {
    expect(isKioskSafe(probe({ profile: 'Main' }))).toBe(true)
  })

  it('accepts Baseline profile', () => {
    expect(isKioskSafe(probe({ profile: 'Baseline' }))).toBe(true)
  })

  it('accepts Constrained Baseline profile', () => {
    expect(isKioskSafe(probe({ profile: 'Constrained Baseline' }))).toBe(true)
  })

  it('rejects yuv422p pixel format', () => {
    expect(isKioskSafe(probe({ pixFmt: 'yuv422p' }))).toBe(false)
  })

  it('rejects 1080p (1920×1080)', () => {
    expect(isKioskSafe(probe({ width: 1920, height: 1080 }))).toBe(false)
  })

  it('rejects hevc codec', () => {
    expect(isKioskSafe(probe({ codec: 'hevc' }))).toBe(false)
  })

  it('accepts null audioCodec (video-only)', () => {
    expect(isKioskSafe(probe({ audioCodec: null }))).toBe(true)
  })

  it('rejects mp3 audioCodec', () => {
    expect(isKioskSafe(probe({ audioCodec: 'mp3' }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — invoke real ffmpeg
// ---------------------------------------------------------------------------

describe('ensureKioskSafe (integration)', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {})
    }
    tmpDirs.length = 0
  })

  it(
    'transcodes a High-profile 1920×1080 clip to kiosk-safe output',
    async () => {
      const srcDir = makeTmpDir()
      const outDir = makeTmpDir()
      tmpDirs.push(srcDir, outDir)

      const srcPath = join(srcDir, 'high.mp4')
      await generateClip(srcPath, { profile: 'high', width: 1920, height: 1080 })

      const result = await ensureKioskSafe(srcPath, outDir)

      expect(result.transcoded).toBe(true)
      expect(existsSync(result.path)).toBe(true)

      const { probe: p } = result
      expect(p.codec).toBe('h264')
      expect(['Main', 'Baseline', 'Constrained Baseline']).toContain(p.profile)
      expect(p.pixFmt).toBe('yuv420p')
      expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1280)
      expect(Math.min(p.width, p.height)).toBeLessThanOrEqual(720)
    },
    60_000
  )

  it(
    'caps the long side to 1280 for ultra-wide (2560×720) input',
    async () => {
      const srcDir = makeTmpDir()
      const outDir = makeTmpDir()
      tmpDirs.push(srcDir, outDir)

      const srcPath = join(srcDir, 'wide.mp4')
      await generateClip(srcPath, { profile: 'high', width: 2560, height: 720 })

      const result = await ensureKioskSafe(srcPath, outDir)

      expect(result.transcoded).toBe(true)
      const { probe: p } = result
      expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1280)
      expect(Math.min(p.width, p.height)).toBeLessThanOrEqual(720)
    },
    60_000
  )

  it(
    'passes through a conforming Main-profile 640×360 clip unchanged',
    async () => {
      const srcDir = makeTmpDir()
      const outDir = makeTmpDir()
      tmpDirs.push(srcDir, outDir)

      // Add an audio track so it round-trips aac
      const srcPath = join(srcDir, 'main.mp4')
      await new Promise<void>((resolve, reject) => {
        ffmpegLib()
          .input(`testsrc=duration=1:size=640x360:rate=10`)
          .inputOptions(['-f', 'lavfi'])
          .input('sine=frequency=440:duration=1')
          .inputOptions(['-f', 'lavfi'])
          .outputOptions([
            '-c:v', 'libx264',
            '-profile:v', 'main',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-t', '1',
          ])
          .output(srcPath)
          .on('end', () => resolve())
          .on('error', reject)
          .run()
      })

      const result = await ensureKioskSafe(srcPath, outDir)

      expect(result.transcoded).toBe(false)
      expect(result.path).toBe(srcPath)
    },
    60_000
  )
})
