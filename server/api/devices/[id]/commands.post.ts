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
  surface: z.enum(['webview', 'native']).optional()
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
