import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { MediaStore } from '~/server/services/media-store'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'

export interface UploadApkInput {
  sha256: string
  version: string
  size: number
  stream: Readable
  uploadedBy: number | null
  flavor?: 'webview' | 'native'
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
      uploadedBy: input.uploadedBy,
      ...(input.flavor ? { flavor: input.flavor } : {})
    })
    .returning()
  return row
}

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }

  const form = await readMultipartFormData(event)
  if (!form) throw createError({ statusCode: 400, message: 'Multipart body required' })

  const filePart = form.find(p => p.name === 'file')
  const versionPart = form.find(p => p.name === 'version')
  if (!filePart?.data) throw createError({ statusCode: 400, message: 'Missing file' })
  if (!versionPart?.data) throw createError({ statusCode: 400, message: 'Missing version' })

  const version = versionPart.data.toString('utf8').trim()
  if (!version) throw createError({ statusCode: 400, message: 'version must not be empty' })

  const flavorPart = form.find(p => p.name === 'flavor')
  const flavor = flavorPart?.data?.toString('utf8').trim() as 'webview' | 'native' | undefined

  const buf = filePart.data
  const sha256 = createHash('sha256').update(buf).digest('hex')
  const { Readable } = await import('node:stream')
  const stream = Readable.from(buf)

  return handleUploadApk(useDb(), useMediaStore(), {
    sha256,
    version,
    size: buf.length,
    stream,
    uploadedBy: user.id,
    flavor
  })
})
