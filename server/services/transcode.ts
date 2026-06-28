import { join } from 'node:path'
import ffmpegPath from '@ffmpeg-installer/ffmpeg'
import ffprobePath from '@ffprobe-installer/ffprobe'
import ffmpeg from 'fluent-ffmpeg'

// The @ffmpeg-installer / @ffprobe-installer meta-packages resolve+validate
// their platform binary at import time and throw if it's missing. Nitro's prod
// bundle can omit @ffprobe-installer/linux-x64 from .output/server/node_modules
// (pnpm's virtual-store layout trips node-file-trace), which would make this
// import throw and every upload 500. The `postbuild` step
// (scripts/copy-ffmpeg-binaries.mjs) copies the platform binaries into .output
// so the import resolves; see that script.
ffmpeg.setFfmpegPath(ffmpegPath.path)
ffmpeg.setFfprobePath(ffprobePath.path)

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

export type QualityPreset = 'low' | 'standard' | 'high'

/** Resolution cap (scale-down only), CRF, and audio bitrate per preset.
 *  All presets emit H.264 Main / yuv420p / +faststart. `standard` reproduces
 *  the original hardcoded kiosk-safe profile. */
export const QUALITY_PRESETS: Record<QualityPreset, {
  maxLong: number
  maxShort: number
  crf: number
  audioBitrate: string
}> = {
  low: { maxLong: 854, maxShort: 480, crf: 26, audioBitrate: '96k' },
  standard: { maxLong: 1280, maxShort: 720, crf: 23, audioBitrate: '128k' },
  high: { maxLong: 1920, maxShort: 1080, crf: 20, audioBitrate: '128k' },
}

/**
 * Transcodes `inPath` to `outPath` using the specified quality preset:
 *   - H.264 Main profile, yuv420p, veryfast preset, +faststart
 *   - Scale: short side ≤maxShort, long side ≤maxLong, no upscale, even dimensions
 *   - AAC audio at the preset's audioBitrate, stereo
 *
 * Rejects on error or if the encode exceeds TRANSCODE_TIMEOUT_MS.
 */
export async function transcodeToKioskSafe(
  inPath: string,
  outPath: string,
  preset: QualityPreset
): Promise<void> {
  const p = QUALITY_PRESETS[preset]
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inPath)
      .outputOptions([
        '-vf',
        `scale='if(gt(iw,ih),-2,min(${p.maxShort},iw))':'if(gt(iw,ih),min(${p.maxShort},ih),-2)',scale='if(gt(iw,ih),min(${p.maxLong},iw),-2)':'if(gt(iw,ih),-2,min(${p.maxLong},ih))'`,
        '-c:v', 'libx264',
        '-profile:v', 'main',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-crf', String(p.crf),
        '-c:a', 'aac',
        '-b:a', p.audioBitrate,
        '-ac', '2',
        '-movflags', '+faststart',
      ])
      .output(outPath)

    const timer = setTimeout(() => {
      command.kill('SIGKILL')
      reject(new Error(`Transcode timeout after ${TRANSCODE_TIMEOUT_MS}ms`))
    }, TRANSCODE_TIMEOUT_MS)

    command.on('end', () => { clearTimeout(timer); resolve() })
    command.on('error', (err) => { clearTimeout(timer); reject(err) })
    command.run()
  })
}

/**
 * Transcodes a video to the chosen quality preset (always re-encodes), writing
 * to `${tmpDir}/out.mp4`. Returns the output path + a fresh probe.
 */
export async function ensureQuality(
  inPath: string,
  tmpDir: string,
  preset: QualityPreset
): Promise<{ path: string; probe: VideoProbe; transcoded: boolean }> {
  const outPath = join(tmpDir, 'out.mp4')
  await transcodeToKioskSafe(inPath, outPath, preset)
  const outProbe = await probeVideo(outPath)
  return { path: outPath, probe: outProbe, transcoded: true }
}
