import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { generateImageThumbnail } from '~/server/services/thumbnails'

describe('generateImageThumbnail', () => {
  it('produces a JPEG with max dimension 256', async () => {
    const input = await sharp({
      create: {
        width: 1000,
        height: 500,
        channels: 3,
        background: { r: 255, g: 0, b: 0 }
      }
    })
      .png()
      .toBuffer()

    const thumbBuf = await generateImageThumbnail(Readable.from([input]))

    // Verify JPEG magic bytes
    expect(thumbBuf[0]).toBe(0xff)
    expect(thumbBuf[1]).toBe(0xd8)
    expect(thumbBuf[2]).toBe(0xff)

    const meta = await sharp(thumbBuf).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(256)
    expect(meta.width).toBe(256)
    expect(meta.height).toBe(128)
  })

  it('rejects non-image input', async () => {
    await expect(
      generateImageThumbnail(Readable.from([Buffer.from('not an image')]))
    ).rejects.toThrow()
  })
})
