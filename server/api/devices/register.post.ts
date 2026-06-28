import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { authLimiters, clientIp, enforceRateLimit } from '~/server/services/rate-limit'

const BodySchema = z.object({
  deviceId: z.string().min(1).max(128),
  playerVersion: z.string().min(1).max(64),
  surface: z.enum(['webview', 'native']).optional()
})

export type RegisterBody = z.infer<typeof BodySchema>
export type RegisterResult = {
  deviceId: string
  claimed: boolean
  name: string | null
  groupId: number | null
}

export async function handleRegister(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
): Promise<RegisterResult> {
  const body = BodySchema.parse(rawBody)
  const now = new Date()

  await db
    .insert(schema.devices)
    .values({
      id: body.deviceId,
      playerVersion: body.playerVersion,
      lastSeenAt: now,
      updatedAt: now,
      ...(body.surface ? { surface: body.surface } : {})
    })
    .onConflictDoUpdate({
      target: schema.devices.id,
      set: {
        playerVersion: body.playerVersion,
        lastSeenAt: now,
        updatedAt: now,
        ...(body.surface ? { surface: body.surface } : {})
      }
    })

  const [row] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, body.deviceId))

  return {
    deviceId: row.id,
    claimed: row.groupId !== null,
    name: row.name,
    groupId: row.groupId
  }
}

export default defineEventHandler(async (event) => {
  // Generous per-IP backstop against unbounded device-row creation. Kept high so
  // a subnet-router/Linux player fronting many boxes (one tailnet IP) isn't
  // throttled during a fleet-wide boot.
  enforceRateLimit(event, authLimiters.registerIp, clientIp(event))
  const body = await readBody(event)
  try {
    return await handleRegister(useDb(), body)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
