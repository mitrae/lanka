import { createReadStream } from 'node:fs'
import formidable from 'formidable'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import { ingestMedia } from '~/server/services/media-ingest'
import type { QualityPreset } from '~/server/services/transcode'

// Legacy synchronous multipart upload. The dashboard no longer uses it (it
// goes through /api/media/uploads — presigned direct-to-store + async ingest);
// kept for curl/scripts. Still subject to Cloudflare's 100 MB body cap and
// the 100 s / 60 s proxy timeouts when reached via app.lanka.live.
export default defineEventHandler(async (event) => {
  const form = formidable({ maxFileSize: 500 * 1024 * 1024 }) // 500 MB
  const [fields, files] = await form.parse(event.node.req)

  const file = Array.isArray(files.file) ? files.file[0] : files.file
  if (!file) {
    throw createError({ statusCode: 400, message: 'No "file" field in upload' })
  }
  const kindRaw = Array.isArray(fields.kind) ? fields.kind[0] : fields.kind
  const kind = (kindRaw ?? '') as 'video' | 'image'
  if (kind !== 'video' && kind !== 'image') {
    throw createError({ statusCode: 400, message: 'kind must be "video" or "image"' })
  }

  const durMs = Array.isArray(fields.durationMs)
    ? fields.durationMs[0]
    : fields.durationMs

  const qualityRaw = Array.isArray(fields.quality) ? fields.quality[0] : fields.quality
  const QUALITIES = ['low', 'standard', 'high'] as const
  let quality: QualityPreset
  if (!qualityRaw) {
    quality = 'standard'
  } else if (QUALITIES.includes(qualityRaw as any)) {
    quality = qualityRaw as QualityPreset
  } else {
    throw createError({ statusCode: 400, message: 'quality must be "low", "standard", or "high"' })
  }

  const result = await ingestMedia(useDb(), useMediaStore(), {
    stream: createReadStream(file.filepath),
    filename: file.originalFilename ?? 'upload.bin',
    kind,
    mimeType: file.mimetype ?? undefined,
    durationMs: durMs ? Number(durMs) : undefined,
    quality
  })

  return result
})
