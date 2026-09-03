// app/components/MediaDetailDrawer.logic.ts
//
// Pure helpers for the media detail drawer, split out so they're testable in
// the plain-node vitest environment (same pattern as MediaUploadDialog.logic).

const EXT_BY_MIME: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/**
 * Same-origin URL for the stored bytes.
 *
 * Deliberately NOT the public CDN base: a cross-origin href makes the browser
 * ignore the `download` attribute, so a CDN link opens in a tab and saves as a
 * bare sha256. The app's own `/media/<sha>` route proxies the same object and
 * supports Range, so the inline preview can seek.
 */
export function mediaFileUrl(sha256: string): string {
  return `/media/${sha256}`
}

/**
 * Filename to save the download as.
 *
 * `media.filename` is a display label only — renames are free and nothing
 * derives type from it, so it can carry no extension or one that contradicts
 * the bytes (every video is re-encoded to mp4 at ingest, whatever the upload
 * was called). The stored mimeType is authoritative, so reconcile the two.
 */
export function downloadName(filename: string, mimeType: string): string {
  const ext = EXT_BY_MIME[mimeType]
  const base = filename.trim()
  if (!base) return ext ? `media.${ext}` : 'media'
  if (!ext) return base
  // Only a short alphanumeric suffix counts as an extension. A label like
  // "Summer v1.2 promo" has a dot in it but no extension, and must not be
  // truncated at the "1." — `lastIndexOf('.')` did exactly that.
  const m = /^(.+)\.([a-z0-9]{1,5})$/i.exec(base)
  if (m && m[2].toLowerCase() === ext) return base
  const stem = m ? m[1] : base
  return `${stem}.${ext}`
}
