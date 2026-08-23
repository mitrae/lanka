// tests/components/MediaUploadDialog.test.ts
import { describe, it, expect } from 'vitest'
import { kindOf } from '~/app/components/MediaUploadDialog.logic'

describe('kindOf', () => {
  it.each([
    [{ name: 'a.mp4', type: 'video/mp4' }, 'video'],
    [{ name: 'a.png', type: 'image/png' }, 'image'],
    [{ name: 'clip.mkv', type: '' }, 'video'],
    [{ name: 'clip.TS', type: '' }, 'video'],
    [{ name: 'photo.heic', type: '' }, 'image'],
    [{ name: 'weird.mp4', type: 'image/png' }, 'image'] // explicit type wins
  ])('%o → %s', (f, expected) => {
    expect(kindOf(f)).toBe(expected)
  })
})
