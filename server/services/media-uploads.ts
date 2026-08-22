import * as schema from '~/server/db/schema'
import type { IngestedMedia } from './media-ingest'
import type { QualityPreset } from './transcode'

export type UploadJobRow = typeof schema.mediaUploads.$inferSelect
export interface UploadJob extends UploadJobRow {
  media?: IngestedMedia | null
}

export const ACTIVE_UPLOAD_STATUSES = ['pending', 'queued', 'processing'] as const
export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3 // 2 GiB
/** R2 accepts at most 5 GiB in a single PUT; the design uses single PUTs, so never allow more. */
export const HARD_MAX_UPLOAD_BYTES = 5 * 1024 ** 3

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const QUALITIES: readonly QualityPreset[] = ['low', 'standard', 'high']

/** Route params become store keys (`uploads/<id>`): only accept UUID v4. */
export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s)
}

export function parseKind(raw: unknown): 'video' | 'image' {
  if (raw === 'video' || raw === 'image') return raw
  throw createError({ statusCode: 400, message: 'kind must be "video" or "image"' })
}

export function parseQuality(raw: unknown): QualityPreset {
  if (raw === undefined || raw === null || raw === '') return 'standard'
  if (typeof raw === 'string' && (QUALITIES as readonly string[]).includes(raw)) {
    return raw as QualityPreset
  }
  throw createError({ statusCode: 400, message: 'quality must be "low", "standard", or "high"' })
}

export function toUploadJob(row: UploadJobRow, media: IngestedMedia | null = null): UploadJob {
  return { ...row, media }
}
