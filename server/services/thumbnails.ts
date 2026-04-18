import { mkdtempSync, createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import sharp from 'sharp'
import ffmpegPath from '@ffmpeg-installer/ffmpeg'
import ffmpeg from 'fluent-ffmpeg'

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
