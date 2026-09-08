import { mkdtempSync, createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import ffmpegPath from '@ffmpeg-installer/ffmpeg'
import ffmpeg from 'fluent-ffmpeg'
import type { MediaStore } from './media-store'

ffmpeg.setFfmpegPath(ffmpegPath.path)

const MAX_DIM = 256

/**
 * Reads the full image from the stream, produces a JPEG thumbnail sized so
 * its largest dimension is MAX_DIM. Preserves aspect ratio.
 */
export async function generateImageThumbnail(
  stream: Readable
): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const input = Buffer.concat(chunks)

  return sharp(input)
    .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: false })
    .jpeg({ quality: 80 })
    .toBuffer()
}

/**
 * Extracts the first frame of a video as a JPEG thumbnail via ffmpeg.
 * Requires a seekable source, so we buffer to a tmp file first.
 */
export async function generateVideoThumbnail(
  stream: Readable
): Promise<Buffer> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lanka-thumb-'))
  const videoPath = join(tmpDir, 'in.bin')
  const thumbPath = join(tmpDir, 'out.jpg')
  try {
    await pipeline(stream, createWriteStream(videoPath))
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput('00:00:01')
        .frames(1)
        .size(`${MAX_DIM}x?`)
        .output(thumbPath)
        .on('end', () => resolve())
        .on('error', reject)
        .run()
    })
    const chunks: Buffer[] = []
    for await (const chunk of createReadStream(thumbPath))
      chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Generates the thumbnail for `filePath` and stores it under `sha`, so the
 * object always lands on the same hash the media row will carry. Returns the
 * byte length to write to `media.thumbnail_bytes`.
 *
 * Any caller that changes a row's `sha256` (the transcode backfill) must call
 * this with the new sha: the thumbnail is keyed by content hash, so an
 * unmigrated thumb is invisible to `/media/:sha/thumb` and the dashboard shows
 * a broken image forever. See server/services/thumbnail-repair.ts.
 */
export async function storeThumbnailFromFile(
  store: MediaStore,
  sha: string,
  kind: 'video' | 'image',
  filePath: string
): Promise<number> {
  const buf =
    kind === 'image'
      ? await generateImageThumbnail(createReadStream(filePath))
      : await generateVideoThumbnail(createReadStream(filePath))
  await store.putThumbnail(sha, Readable.from([buf]))
  return buf.length
}
