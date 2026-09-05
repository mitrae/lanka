import { z } from 'zod'
import { eq, desc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useCommandHub } from '~/server/services/command-hub'

const COMMAND_TYPES = ['ota', 'reboot', 'screenshot', 'log-request', 'kiosk-lock', 'kiosk-unlock', 'set-surface'] as const

// Validated here, not trusted from the dashboard: a typo'd surface must never
// reach a box (the APK would refuse it, but the operator would only see "failed").
const EnqueueSchema = z.object({
  cmd: z.enum(COMMAND_TYPES),
  releaseId: z.number().int().positive().optional(),
  surface: z.enum(['webview', 'native']).optional(),
  /** ota only: send even if the box already runs this versionCode or newer. */
  force: z.boolean().optional()
})

export type EnqueueInput = z.infer<typeof EnqueueSchema>

export async function handleEnqueueCommand(
  db: BetterSQLite3Database<typeof schema>,
  hub: ReturnType<typeof useCommandHub>,
  deviceId: string,
  rawInput: unknown
): Promise<{ commandId: number }> {
  const parsed = EnqueueSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: `invalid command: ${parsed.error.issues[0]?.message ?? 'bad body'}` })
  }
  const input = parsed.data

  const [device] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
  if (!device) throw createError({ statusCode: 404, message: `Device ${deviceId} not found` })

  let payload: Record<string, unknown> | null = null
  if (input.cmd === 'ota') {
    if (!input.releaseId) throw createError({ statusCode: 400, message: 'releaseId required for ota command' })
    const [release] = await db
      .select()
      .from(schema.apkReleases)
      .where(eq(schema.apkReleases.id, input.releaseId))
    if (!release) throw createError({ statusCode: 404, message: 'APK release not found' })
    if (!input.force) {
      const current = await currentReleaseOf(db, device.apkVersion)
      if (current?.versionCode != null && release.versionCode != null && release.versionCode <= current.versionCode) {
        throw createError({
          statusCode: 409,
          message: `box already runs ${current.version} (code ${current.versionCode}); ` +
            `${release.version} is code ${release.versionCode}. Pass force to send it anyway.`
        })
      }
    }
    payload = {
      releaseId: release.id,
      version: release.version,
      sha256: release.sha256,
      url: `/api/apk/${release.id}/download`
    }
  }
  if (input.cmd === 'set-surface') {
    if (!input.surface) throw createError({ statusCode: 400, message: 'surface required for set-surface command' })
    payload = { surface: input.surface }
  }

  const commandId = await hub.enqueue(db, deviceId, input.cmd, payload)
  return { commandId }
}

/**
 * The release the box currently runs, judged by the versionName it reports.
 * Labels may extend versionName with a suffix ("0.5.0-hotfix"), so match on
 * equality or `<versionName>-…` and take the highest code among matches. null
 * when the box's build was never uploaded here (sideloaded, or pre-dates
 * manifest reading) -- an unknown current version never blocks an OTA.
 */
async function currentReleaseOf(
  db: BetterSQLite3Database<typeof schema>,
  apkVersion: string | null
) {
  if (!apkVersion) return null
  const rows = await db.select().from(schema.apkReleases)
  const matching = rows.filter(
    (r) => r.version === apkVersion || r.version.startsWith(`${apkVersion}-`)
  )
  if (matching.length === 0) return null
  return matching.reduce((best, r) =>
    (r.versionCode ?? -1) > (best.versionCode ?? -1) ? r : best
  )
}

export async function handleListCommands(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string
) {
  return db
    .select()
    .from(schema.deviceCommands)
    .where(eq(schema.deviceCommands.deviceId, deviceId))
    .orderBy(desc(schema.deviceCommands.createdAt), desc(schema.deviceCommands.id))
    .limit(50)
}

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  return handleEnqueueCommand(useDb(), useCommandHub(), id, body)
})
