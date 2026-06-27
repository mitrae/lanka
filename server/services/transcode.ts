import { join } from 'node:path'
import ffmpegPath from '@ffmpeg-installer/ffmpeg'
import ffprobePath from '@ffprobe-installer/ffprobe'
import ffmpeg from 'fluent-ffmpeg'

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

      resolve({
        codec: videoStream.codec_name ?? '',
        profile: videoStream.profile ?? '',
        pixFmt: videoStream.pix_fmt ?? '',
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        durationMs: Math.round(parseFloat(rawDuration) * 1000),
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
 *   - Scale: short side ≤720, no upscale, even dimensions
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
      // Scale: landscape → limit long side to 1280 (short ≤720); portrait → limit long side to 720.
      // Uses -2 to ensure even dimensions. No upscale.
      .outputOptions([
        '-vf',
        "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'",
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
      .on('end', () => resolve())
      .on('error', (err) => reject(err))

    const timer = setTimeout(() => {
      command.kill('SIGKILL')
      reject(new Error(`Transcode timeout after ${TRANSCODE_TIMEOUT_MS}ms: ${inPath}`))
    }, TRANSCODE_TIMEOUT_MS)

    command.on('end', () => clearTimeout(timer))
    command.on('error', () => clearTimeout(timer))

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
