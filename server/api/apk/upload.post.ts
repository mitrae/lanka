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
import { readApkManifest, type ApkManifest } from '~/server/services/apk-manifest'

/** The only package this fleet runs. OtaInstaller refuses anything else on the
 *  box; refusing it here saves every box a 6 MB download first. */
export const KIOSK_PACKAGE = 'ai.lanka.kiosk'

// APKs are tens of MB; cap well above that but low enough to protect the small
// box from an OOM on a runaway upload. Streamed to a temp file, never buffered.
const MAX_APK_BYTES = 300 * 1024 * 1024 // 300 MB

export interface UploadApkInput {
  sha256: string
  /** What the APK's own manifest says. The bytes are the truth; the filename
   *  and the operator's label are not. */
  manifest: ApkManifest
  /** Optional operator label. Defaults to manifest.versionName; may extend it
   *  ("0.5.0-hotfix") but must not contradict it. */
  version?: string
  size: number
  stream: Readable
  uploadedBy: number | null
}

/** Returns the release's display version, or throws 400 for an APK that must
 *  not enter the fleet. Pure policy; the route handler supplies the manifest. */
export function resolveReleaseVersion(manifest: ApkManifest, label?: string): string {
  if (manifest.packageName !== KIOSK_PACKAGE) {
    throw createError({
      statusCode: 400,
      message: `not a Lanka kiosk build: package is ${manifest.packageName}, want ${KIOSK_PACKAGE}`
    })
  }
  const trimmed = label?.trim()
  if (!trimmed) return manifest.versionName
  // A label that does not start with the real versionName is a mislabeled
  // upload -- the exact mistake the typed field used to let through silently.
  if (trimmed !== manifest.versionName && !trimmed.startsWith(`${manifest.versionName}-`)) {
    throw createError({
      statusCode: 400,
      message: `version label "${trimmed}" contradicts the APK's versionName ${manifest.versionName}`
    })
  }
  return trimmed
}

export async function handleUploadApk(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  input: UploadApkInput
) {
  const version = resolveReleaseVersion(input.manifest, input.version)
  await store.put(input.sha256, input.stream, 'application/vnd.android.package-archive')
  const [row] = await db
    .insert(schema.apkReleases)
    .values({
      version,
      versionCode: input.manifest.versionCode,
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

    // Read the manifest before hashing or storing anything: a foreign package
    // or a non-APK is rejected without ever touching the media store.
    let manifest: ApkManifest
    try {
      manifest = await readApkManifest(file.filepath)
    } catch (e) {
      throw createError({ statusCode: 400, message: `unreadable APK: ${(e as Error).message}` })
    }

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
      manifest,
      version: versionRaw,
      size: file.size,
      stream: createReadStream(file.filepath),
      uploadedBy: user.id
    })
  } finally {
    await rm(file.filepath, { force: true })
  }
})
