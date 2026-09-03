// tests/components/MediaDetailDrawer.test.ts
import { describe, it, expect } from 'vitest'
import { downloadName, mediaFileUrl } from '~/app/components/MediaDetailDrawer.logic'

describe('mediaFileUrl', () => {
  it('is same-origin so the download attribute is honoured', () => {
    expect(mediaFileUrl('abc123')).toBe('/media/abc123')
  })
})

describe('downloadName', () => {
  it.each([
    // already correct — left alone, case preserved
    ['IMG_0053.MP4', 'video/mp4', 'IMG_0053.MP4'],
    ['clip.mp4', 'video/mp4', 'clip.mp4'],
    // the stored bytes are always mp4 after ingest, whatever the upload was called
    ['IMG_0053.MOV', 'video/mp4', 'IMG_0053.mp4'],
    ['recording.avi', 'video/mp4', 'recording.mp4'],
    // renames drop extensions freely — media.filename is a display label
    ['Store front loop', 'video/mp4', 'Store front loop.mp4'],
    ['poster', 'image/png', 'poster.png'],
    ['photo.jpeg', 'image/jpeg', 'photo.jpg'],
    // dotfile-ish names keep their leading dot rather than losing the stem
    ['.hidden', 'image/png', '.hidden.png'],
    // an interior dot is not an extension — a renamed label like this must
    // not be truncated at it
    ['Summer v1.2 promo', 'video/mp4', 'Summer v1.2 promo.mp4'],
    ['Q3.2026 deck', 'image/png', 'Q3.2026 deck.png'],
    ['archive.tar.gz', 'video/mp4', 'archive.tar.mp4']
  ])('%s + %s → %s', (filename, mime, expected) => {
    expect(downloadName(filename, mime)).toBe(expected)
  })

  it('falls back when the mime type is unknown', () => {
    expect(downloadName('blob.bin', 'application/octet-stream')).toBe('blob.bin')
  })

  it('falls back when the label is empty', () => {
    expect(downloadName('   ', 'video/mp4')).toBe('media.mp4')
    expect(downloadName('', 'application/octet-stream')).toBe('media')
  })
})
