import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import formidable from 'formidable'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { MediaStore } from '~/server/services/media-store'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'

// APKs are tens of MB; cap well above that but low enough to protect the small
// box from an OOM on a runaway upload. Streamed to a temp file, never buffered.
const MAX_APK_BYTES = 300 * 1024 * 1024 // 300 MB

export interface UploadApkInput {
  sha256: string
  version: string
  size: number
  stream: Readable
  uploadedBy: number | null
}

export async function handleUploadApk(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  input: UploadApkInput
) {
  await store.put(input.sha256, input.stream, 'application/vnd.android.package-archive')
  const [row] = await db
    .insert(schema.apkReleases)
    .values({
      version: input.version,
      sha256: input.sha256,
      size: input.size,
      uploadedBy: input.uploadedBy
    })
    .returning()
  return row
}

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }

  const form = formidable({ maxFileSize: MAX_APK_BYTES })
  const [fields, files] = await form.parse(event.node.req)

  const file = Array.isArray(files.file) ? files.file[0] : files.file
  if (!file) throw createError({ statusCode: 400, message: 'Missing file' })

  try {
    const versionRaw = Array.isArray(fields.version) ? fields.version[0] : fields.version
    const version = versionRaw?.trim()
    if (!version) throw createError({ statusCode: 400, message: 'version must not be empty' })

    // Hash the temp file incrementally — never load the whole APK into RAM.
    const hash = createHash('sha256')
    await pipeline(
      createReadStream(file.filepath),
      new Writable({
        write(chunk, _enc, cb) {
          hash.update(chunk)
          cb()
        }
      })
    )
    const sha256 = hash.digest('hex')

    return await handleUploadApk(useDb(), useMediaStore(), {
      sha256,
      version,
      size: file.size,
      stream: createReadStream(file.filepath),
      uploadedBy: user.id
    })
  } finally {
    await rm(file.filepath, { force: true })
  }
})
