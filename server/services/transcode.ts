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

// 30 min: ingest runs in the background worker (services/media-ingest-queue),
// so no HTTP request is held open during transcode; long/`high` clips on the
// 2-vCPU prod box can legitimately take this long.
const TRANSCODE_TIMEOUT_MS = 30 * 60 * 1000

export interface VideoProbe {
  codec: string
  profile: string
  pixFmt: string
  width: number
  height: number
  /** Average frames per second; 0 when ffprobe can't determine it. */
  frameRate: number
  /** The stream's nominal rate (r_frame_rate). For a VFR phone clip this is the
   *  peak the encoder was set to — 60 or 120 for slo-mo — even when the
   *  average sits below 30. 0 when unknown. */
  frameRateNominal: number
  /** H.264 level ×10 (40 = level 4.0); 0 when unknown. */
  level: number
  durationMs: number
  audioCodec: string | null
}

/** Parses ffprobe's "num/den" rate strings; 0 for absent/"0/0"/garbage. */
function parseRate(raw: string | undefined): number {
  if (!raw) return 0
  const [num, den] = raw.split('/')
  const n = Number(num)
  const d = den === undefined ? 1 : Number(den)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0
  return n / d
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
        // avg over r_frame_rate: iPhone clips are variable-rate, and the
        // container's nominal rate overstates what was actually recorded.
        frameRate:
          parseRate(videoStream.avg_frame_rate) ||
          parseRate(videoStream.r_frame_rate),
        frameRateNominal: parseRate(videoStream.r_frame_rate),
        // ffprobe reports -99 for "unknown" on some builds; fold that into 0.
        level: Math.max(0, Number(videoStream.level) || 0),
        durationMs,
        audioCodec: audioStream ? (audioStream.codec_name ?? null) : null,
      })
    })
  })
}

const SAFE_PROFILES = new Set(['Constrained Baseline', 'Baseline', 'Main'])

/** Frames per second the kiosk WebView decoder is reliably good for. Pixels are
 *  only half the budget: a 1080p54 clip has roughly twice the macroblock rate of
 *  1080p30 and pushes past H.264 level 4.0, which is where the Amlogic/Xiaomi
 *  WebView path starts dropping out mid-clip. */
export const MAX_KIOSK_FPS = 30

/** H.264 level ceiling (×10). 4.0 covers 1080p30 and is the highest level these
 *  boxes decode dependably through the WebView. */
export const MAX_KIOSK_LEVEL = 40

/** VFR phone clips probe at 30.03 or 29.98 for a nominal 30; an exact compare
 *  would send a perfectly playable file through another lossy re-encode. The
 *  slack is a hair, not a rounding bucket: 1080p30 already sits at 244,800 of
 *  level 4.0's 245,760 macroblocks/s, so 30.4 fps tips x264 into level 4.1. */
const FPS_TOLERANCE = 0.1

/** Whether a measured frame rate is over the kiosk cap. */
export function exceedsFpsCap(fps: number): boolean {
  return fps > MAX_KIOSK_FPS + FPS_TOLERANCE
}

/**
 * Whether the encoder must resample this source to `maxFps`.
 *
 * Strict, no tolerance: resampling a 30.03 fps source to an exact 30 costs one
 * dropped frame every ~30 s and guarantees the output never exceeds the cap.
 * Judged on the nominal rate as well as the average — a VFR clip averaging 28
 * with 60 fps bursts would otherwise bypass the filter. Unknown (0) means
 * "might be too high": the cost of capping is a duplicated frame or two, the
 * cost of not capping is the freeze this whole rule exists to prevent.
 */
export function needsFpsCap(p: Pick<VideoProbe, 'frameRate' | 'frameRateNominal'>, maxFps: number): boolean {
  const peak = Math.max(p.frameRate, p.frameRateNominal)
  return peak === 0 || peak > maxFps
}

/**
 * Returns true if the probe indicates the video is safe to play on kiosk
 * WebViews (Amlogic/Xiaomi boxes): h264 Main-or-below, yuv420p, ≤720p short
 * side, ≤30 fps, ≤level 4.0, and NO audio track.
 *
 * An UNKNOWN frame rate or level (0) counts as unsafe. This predicate gates the
 * backfill's decision to skip a file, and unproven is not proven: an unreadable
 * field must force the re-encode (whose fps filter then normalises it), not
 * silently pass the file through.
 */
export function isKioskSafe(p: VideoProbe): boolean {
  const peakFps = Math.max(p.frameRate, p.frameRateNominal)
  return (
    p.codec === 'h264' &&
    SAFE_PROFILES.has(p.profile) &&
    p.pixFmt === 'yuv420p' &&
    Math.max(p.width, p.height) <= 1280 &&
    Math.min(p.width, p.height) <= 720 &&
    peakFps > 0 &&
    !exceedsFpsCap(peakFps) &&
    p.level > 0 &&
    p.level <= MAX_KIOSK_LEVEL &&
    // No audio track at all. The player is muted on both surfaces, and an
    // audio DECODE error fails the whole <video> element regardless: a Haier
    // TV's AAC decoder rejected one 6-byte frame at 37.8 s after the loop seek
    // (prod, 2026-09-06 — "Failed to send audio packet for decoding"), and the
    // clip died on every pass from then on. A track nobody can hear is only a
    // second decoder that can fail.
    p.audioCodec === null
  )
}

export type QualityPreset = 'low' | 'standard' | 'high'

/** Resolution cap (scale-down only), frame-rate cap, CRF and VBV ceiling per
 *  preset. All presets emit H.264 Main / yuv420p / level ≤4.0 / +faststart and
 *  NO audio track (see isKioskSafe). `standard` reproduces the original
 *  hardcoded kiosk-safe profile.
 *
 *  `maxrate`/`bufsize` matter as much as the resolution: bare CRF leaves VBV
 *  unconstrained, so a busy scene can spike far above the average — a prod clip
 *  averaging 2.4 Mbps peaked at 11 Mbps and froze the TV in that stretch. The
 *  ceilings turn CRF into capped-CRF: quality-driven where it's cheap, hard
 *  limited where it isn't. */
export const QUALITY_PRESETS: Record<QualityPreset, {
  maxLong: number
  maxShort: number
  maxFps: number
  crf: number
  maxrate: string
  bufsize: string
}> = {
  low: { maxLong: 854, maxShort: 480, maxFps: MAX_KIOSK_FPS, crf: 26, maxrate: '2M', bufsize: '4M' },
  standard: { maxLong: 1280, maxShort: 720, maxFps: MAX_KIOSK_FPS, crf: 23, maxrate: '4M', bufsize: '8M' },
  high: { maxLong: 1920, maxShort: 1080, maxFps: MAX_KIOSK_FPS, crf: 20, maxrate: '6M', bufsize: '12M' },
}

/**
 * Transcodes `inPath` to `outPath` using the specified quality preset:
 *   - H.264 Main profile, level ≤4.0, yuv420p, veryfast preset, +faststart
 *   - Scale: short side ≤maxShort, long side ≤maxLong, no upscale, even dimensions
 *   - Frame rate capped at the preset's maxFps (only when the source exceeds it,
 *     so a 24 fps source is not padded with duplicate frames)
 *   - Capped CRF: quality-driven, hard-limited by maxrate/bufsize
 *   - No audio track (-an): the player is muted, and an audio decoder is one
 *     more thing that can fail the element
 *
 * Rejects on error or if the encode exceeds TRANSCODE_TIMEOUT_MS.
 */
export async function transcodeToKioskSafe(
  inPath: string,
  outPath: string,
  preset: QualityPreset
): Promise<void> {
  const p = QUALITY_PRESETS[preset]

  // The fps filter can only drop or duplicate to hit an exact rate — it has no
  // "cap" mode — so decide from the source. An unreadable rate (0) is treated as
  // "might be too high": capping costs a duplicated frame or two, not capping
  // risks the freeze this whole change exists to prevent.
  let capFps = true // an unprobeable source is capped, never trusted
  try {
    capFps = needsFpsCap(await probeVideo(inPath), p.maxFps)
  } catch {
    /* keep capFps = true */
  }

  const scale = `scale='if(gt(iw,ih),-2,min(${p.maxShort},iw))':'if(gt(iw,ih),min(${p.maxShort},ih),-2)',scale='if(gt(iw,ih),min(${p.maxLong},iw),-2)':'if(gt(iw,ih),-2,min(${p.maxLong},ih))'`
  // Drop frames BEFORE scaling: on a 55 fps 1080p source that is ~45% fewer
  // frames through the scaler, which matters on the 2-vCPU prod box.
  const vf = capFps ? `fps=${p.maxFps},${scale}` : scale

  return new Promise((resolve, reject) => {
    const command = ffmpeg(inPath)
      .outputOptions([
        '-vf', vf,
        '-c:v', 'libx264',
        '-profile:v', 'main',
        // No explicit -level: x264 derives the minimum level that fits the
        // capped resolution/fps/bitrate, which lands at or below
        // MAX_KIOSK_LEVEL. Pinning it to 4.0 would only ever *raise* the
        // declared level (a 720p30 clip needing 3.1 would advertise 4.0 and ask
        // decoders for buffers it doesn't need).
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-crf', String(p.crf),
        '-maxrate', p.maxrate,
        '-bufsize', p.bufsize,
        '-an',
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
 * Checks an encode's probe against the envelope its preset promises. Returns
 * null when it conforms, otherwise a message naming the violated axis.
 *
 * The encoder options *should* make this unreachable, but "should" is not a
 * production boundary: x264 picks the level itself, the fps filter is
 * conditional, and a future option tweak could silently widen the output. A
 * file that fails here must never reach the store, because every TV in the
 * fleet would then fetch it.
 */
export function probeMatchesPreset(p: VideoProbe, preset: QualityPreset): string | null {
  const q = QUALITY_PRESETS[preset]
  if (p.codec !== 'h264') return `codec ${p.codec} (want h264)`
  if (!SAFE_PROFILES.has(p.profile)) return `profile ${p.profile} (want Main or below)`
  if (p.pixFmt !== 'yuv420p') return `pix_fmt ${p.pixFmt} (want yuv420p)`
  if (Math.max(p.width, p.height) > q.maxLong || Math.min(p.width, p.height) > q.maxShort) {
    return `dimensions ${p.width}x${p.height} (want ≤${q.maxLong}x${q.maxShort})`
  }
  const peakFps = Math.max(p.frameRate, p.frameRateNominal)
  if (peakFps > q.maxFps + FPS_TOLERANCE) return `fps ${peakFps.toFixed(2)} (want ≤${q.maxFps})`
  if (p.level > MAX_KIOSK_LEVEL) return `level ${p.level} (want ≤${MAX_KIOSK_LEVEL})`
  if (p.audioCodec !== null) return `audio track ${p.audioCodec} (want none)`
  return null
}

/**
 * Transcodes a video to the chosen quality preset (always re-encodes), writing
 * to `${tmpDir}/out.mp4`. Returns the output path + a fresh probe. Throws if
 * the output does not match the preset's envelope — see probeMatchesPreset.
 */
export async function ensureQuality(
  inPath: string,
  tmpDir: string,
  preset: QualityPreset
): Promise<{ path: string; probe: VideoProbe; transcoded: boolean }> {
  const outPath = join(tmpDir, 'out.mp4')
  await transcodeToKioskSafe(inPath, outPath, preset)
  const outProbe = await probeVideo(outPath)
  const violation = probeMatchesPreset(outProbe, preset)
  if (violation) {
    throw new Error(`transcode output violates preset "${preset}": ${violation}`)
  }
  return { path: outPath, probe: outProbe, transcoded: true }
}
