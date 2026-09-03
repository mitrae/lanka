import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from '@ffmpeg-installer/ffmpeg'
import ffmpegLib from 'fluent-ffmpeg'
import { isKioskSafe, ensureQuality, QUALITY_PRESETS, transcodeToKioskSafe, probeVideo } from '../../server/services/transcode'
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
    frameRate: 25,
    level: 31,
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
    fps?: number
  }
): Promise<void> {
  const { profile, width, height, durationSecs = 1, fps = 10 } = opts
  return new Promise((resolve, reject) => {
    ffmpegLib()
      .input(`testsrc=duration=${durationSecs}:size=${width}x${height}:rate=${fps}`)
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

  it('rejects >30 fps — 1080p54 is what froze a prod TV mid-clip', () => {
    expect(isKioskSafe(probe({ frameRate: 54.5454 }))).toBe(false)
    expect(isKioskSafe(probe({ frameRate: 60 }))).toBe(false)
  })

  it('accepts 30 fps and below', () => {
    expect(isKioskSafe(probe({ frameRate: 30 }))).toBe(true)
    expect(isKioskSafe(probe({ frameRate: 23.976 }))).toBe(true)
  })

  it('tolerates VFR jitter around 30 — a phone "30 fps" clip probes at 30.03', () => {
    expect(isKioskSafe(probe({ frameRate: 30.03 }))).toBe(true)
    expect(isKioskSafe(probe({ frameRate: 30.4 }))).toBe(true)
    expect(isKioskSafe(probe({ frameRate: 31 }))).toBe(false)
  })

  it('accepts an unknown frame rate rather than forcing a re-encode', () => {
    expect(isKioskSafe(probe({ frameRate: 0 }))).toBe(true)
  })

  it('rejects a level above 4.0', () => {
    expect(isKioskSafe(probe({ level: 42 }))).toBe(false)
    expect(isKioskSafe(probe({ level: 40 }))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — invoke real ffmpeg
// ---------------------------------------------------------------------------

describe('ensureQuality (integration)', () => {
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

      const result = await ensureQuality(srcPath, outDir, 'standard')

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

      const result = await ensureQuality(srcPath, outDir, 'standard')

      expect(result.transcoded).toBe(true)
      const { probe: p } = result
      expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1280)
      expect(Math.min(p.width, p.height)).toBeLessThanOrEqual(720)
    },
    60_000
  )

  it(
    'always re-encodes a conforming Main-profile 640×360 clip (transcoded:true)',
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

      const result = await ensureQuality(srcPath, outDir, 'standard')

      expect(result.transcoded).toBe(true)
      expect(result.path).not.toBe(srcPath)
    },
    60_000
  )
})

// ---------------------------------------------------------------------------
// New preset + ensureQuality tests (Task 2)
// ---------------------------------------------------------------------------

describe('QUALITY_PRESETS', () => {
  it('has low/standard/high with the agreed caps + crf', () => {
    expect(QUALITY_PRESETS.low).toEqual({
      maxLong: 854, maxShort: 480, maxFps: 30, crf: 26,
      maxrate: '2M', bufsize: '4M', audioBitrate: '96k',
    })
    expect(QUALITY_PRESETS.standard).toEqual({
      maxLong: 1280, maxShort: 720, maxFps: 30, crf: 23,
      maxrate: '4M', bufsize: '8M', audioBitrate: '128k',
    })
    expect(QUALITY_PRESETS.high).toEqual({
      maxLong: 1920, maxShort: 1080, maxFps: 30, crf: 20,
      maxrate: '6M', bufsize: '12M', audioBitrate: '128k',
    })
  })

  it('caps every preset at 30 fps — the WebView decoder budget, not the pixels', () => {
    for (const p of Object.values(QUALITY_PRESETS)) expect(p.maxFps).toBe(30)
  })
})

describe('transcodeToKioskSafe per preset', () => {
  let dir: string
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it.each([
    ['low', 854, 480],
    ['standard', 1280, 720],
    ['high', 1920, 1080],
  ] as const)('caps a 1080p source to %s (<=%i long / <=%i short), Main/yuv420p', async (preset, long, short) => {
    dir = makeTmpDir()
    const src = join(dir, 'src.mp4')
    const out = join(dir, 'out.mp4')
    await generateClip(src, { profile: 'high', width: 1920, height: 1080, durationSecs: 1 })
    await transcodeToKioskSafe(src, out, preset)
    const p = await probeVideo(out)
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(long)
    expect(Math.min(p.width, p.height)).toBeLessThanOrEqual(short)
    expect(p.profile).toBe('Main')
    expect(p.pixFmt).toBe('yuv420p')
  }, 60_000)
})

describe('frame-rate and bitrate ceilings', () => {
  let dir: string
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('caps a 60 fps 1080p source to <=30 fps at level <=4.0', async () => {
    dir = makeTmpDir()
    const src = join(dir, 'src.mp4')
    const out = join(dir, 'out.mp4')
    await generateClip(src, { profile: 'high', width: 1920, height: 1080, durationSecs: 2, fps: 60 })
    await transcodeToKioskSafe(src, out, 'high')
    const p = await probeVideo(out)
    expect(p.frameRate).toBeLessThanOrEqual(30)
    expect(p.level).toBeLessThanOrEqual(40)
    // NOTE: `high` output is still 1080p, which isKioskSafe rejects on
    // resolution alone — the preset deliberately exceeds the documented ≤720p
    // envelope. fps/level/VBV are now in bounds; the resolution is not.
    expect(isKioskSafe(p)).toBe(false)
  }, 120_000)

  it('a 60 fps 1080p source run through `standard` comes out fully kiosk-safe', async () => {
    dir = makeTmpDir()
    const src = join(dir, 'src.mp4')
    const out = join(dir, 'out.mp4')
    await generateClip(src, { profile: 'high', width: 1920, height: 1080, durationSecs: 2, fps: 60 })
    await transcodeToKioskSafe(src, out, 'standard')
    const p = await probeVideo(out)
    expect(isKioskSafe(p)).toBe(true)
  }, 120_000)

  it('leaves a source already below the cap alone (no frame duplication)', async () => {
    dir = makeTmpDir()
    const src = join(dir, 'src.mp4')
    const out = join(dir, 'out.mp4')
    await generateClip(src, { profile: 'main', width: 640, height: 360, durationSecs: 2, fps: 24 })
    await transcodeToKioskSafe(src, out, 'standard')
    const p = await probeVideo(out)
    expect(p.frameRate).toBeCloseTo(24, 1)
  }, 120_000)
})

describe('ensureQuality always re-encodes', () => {
  let dir: string
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('transcodes even an already-safe source (transcoded:true) and applies the preset', async () => {
    dir = makeTmpDir()
    const src = join(dir, 'src.mp4')
    // already kiosk-safe: Main, 640x360
    await generateClip(src, { profile: 'main', width: 640, height: 360, durationSecs: 1 })
    const res = await ensureQuality(src, dir, 'standard')
    expect(res.transcoded).toBe(true)
    expect(res.path).not.toBe(src)
    expect(res.probe.profile).toBe('Main')
  }, 60_000)
})
