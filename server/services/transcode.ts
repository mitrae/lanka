import { join } from 'node:path'
import { existsSync } from 'node:fs'
import ffmpegPath from '@ffmpeg-installer/ffmpeg'
import ffprobePath from '@ffprobe-installer/ffprobe'
import ffmpeg from 'fluent-ffmpeg'

/**
 * Pick the binary to hand fluent-ffmpeg: prefer the pinned
 * `@ffmpeg-installer`/`@ffprobe-installer` binary, but fall back to the
 * system binary on PATH when the bundled one is missing.
 *
 * Why: Nitro's production bundle can omit a platform sub-package from
 * `.output/server/node_modules` — pnpm's virtual-store layout trips the trace
 * for `@ffprobe-installer/linux-x64`, so `ffprobePath.path` points at a file
 * that isn't there and the transcode spawn fails at runtime (a 422 on upload).
 * The system `ffmpeg`/`ffprobe` (resolved via PATH by passing the bare name)
 * keeps a built dev server working. Prod Docker bundles both binaries, so
 * `existsSync` is true there and the pinned binary is used.
 */
export function resolveBinary(installerPath: string, systemName: string): string {
  return existsSync(installerPath) ? installerPath : systemName
}

ffmpeg.setFfmpegPath(resolveBinary(ffmpegPath.path, 'ffmpeg'))
ffmpeg.setFfprobePath(resolveBinary(ffprobePath.path, 'ffprobe'))

const TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

export interface VideoProbe {
  codec: string
  profile: string
  pixFmt: string
  width: number
  height: number
  durationMs: number
  audioCodec: string | null
}

/**
 * Probes a video file and returns key encoding parameters.
 * Throws if no video stream is found.
 */
export async function probeVideo(path: string): Promise<VideoProbe> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path, (err, data) => {
      if (err) return reject(err)

      const videoStream = data.streams.find((s) => s.codec_type === 'video')
      if (!videoStream) {
        return reject(new Error(`No video stream found in: ${path}`))
      }
      const audioStream = data.streams.find((s) => s.codec_type === 'audio')

      const rawDuration =
        videoStream.duration !== undefined
          ? String(videoStream.duration)
          : String(data.format.duration)
      const durationSecs = parseFloat(rawDuration)
      // Both stream and format duration can be absent → NaN. Treat unknown
      // duration as 0 rather than rejecting an otherwise-valid clip.
      const durationMs = Number.isNaN(durationSecs)
        ? 0
        : Math.round(durationSecs * 1000)

      resolve({
        codec: videoStream.codec_name ?? '',
        profile: videoStream.profile ?? '',
        pixFmt: videoStream.pix_fmt ?? '',
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        durationMs,
        audioCodec: audioStream ? (audioStream.codec_name ?? null) : null,
      })
    })
  })
}

const SAFE_PROFILES = new Set(['Constrained Baseline', 'Baseline', 'Main'])

/**
 * Returns true if the probe indicates the video is safe to play on kiosk
 * WebViews (Amlogic/Xiaomi boxes): h264 Main-or-below, yuv420p, ≤720p short
 * side, aac (or no) audio.
 */
export function isKioskSafe(p: VideoProbe): boolean {
  return (
    p.codec === 'h264' &&
    SAFE_PROFILES.has(p.profile) &&
    p.pixFmt === 'yuv420p' &&
    Math.max(p.width, p.height) <= 1280 &&
    Math.min(p.width, p.height) <= 720 &&
    (p.audioCodec === null || p.audioCodec === 'aac')
  )
}

/**
 * Transcodes `inPath` to `outPath` using kiosk-safe settings:
 *   - H.264 Main profile, yuv420p, CRF 23, veryfast preset
 *   - Scale: short side ≤720, long side ≤1280, no upscale, even dimensions
 *   - AAC 128 kbps stereo audio
 *   - faststart for web playback
 *
 * Rejects on error or if the encode exceeds TRANSCODE_TIMEOUT_MS.
 */
export async function transcodeToKioskSafe(
  inPath: string,
  outPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inPath)
      // Two-pass scale: pass 1 caps the short side to 720, pass 2 caps the long
      // side to 1280. Both decrease-only (min) with even dims (-2), no upscale,
      // orientation-correct. Caps wider-than-16:9 input (e.g. 2560×720 → 1280×360).
      .outputOptions([
        '-vf',
        "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)',scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
        '-c:v', 'libx264',
        '-profile:v', 'main',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        '-movflags', '+faststart',
      ])
      .output(outPath)

    const timer = setTimeout(() => {
      command.kill('SIGKILL')
      reject(new Error(`Transcode timeout after ${TRANSCODE_TIMEOUT_MS}ms`))
    }, TRANSCODE_TIMEOUT_MS)

    command.on('end', () => {
      clearTimeout(timer)
      resolve()
    })
    command.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    command.run()
  })
}

/**
 * Ensures a video file is kiosk-safe.
 * - If already safe: returns `{ path: inPath, probe, transcoded: false }`.
 * - If not safe: transcodes to `${tmpDir}/out.mp4`, re-probes, returns the
 *   output path with `transcoded: true`.
 */
export async function ensureKioskSafe(
  inPath: string,
  tmpDir: string
): Promise<{ path: string; probe: VideoProbe; transcoded: boolean }> {
  const probe = await probeVideo(inPath)

  if (isKioskSafe(probe)) {
    return { path: inPath, probe, transcoded: false }
  }

  const outPath = join(tmpDir, 'out.mp4')
  await transcodeToKioskSafe(inPath, outPath)
  const outProbe = await probeVideo(outPath)

  return { path: outPath, probe: outProbe, transcoded: true }
}
