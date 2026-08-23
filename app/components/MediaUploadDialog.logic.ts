// app/components/MediaUploadDialog.logic.ts
const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|ts)$/i

/** Browsers report an empty type for unknown extensions (.mkv, .ts); fall back to the extension. */
export function kindOf(f: { name: string; type: string }): 'video' | 'image' {
  if (f.type.startsWith('video/')) return 'video'
  if (f.type.startsWith('image/')) return 'image'
  return VIDEO_EXT.test(f.name) ? 'video' : 'image'
}
