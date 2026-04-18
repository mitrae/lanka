import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const BodySchema = z.object({
  currentItemId: z.number().int().positive().nullable(),
  error: z
    .object({ sha256: z.string().optional(), message: z.string().max(500) })
    .optional()
})

export type TelemetryBody = z.infer<typeof BodySchema>

export async function handleTelemetry(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string,
  rawBody: unknown
): Promise<void> {
  const body = BodySchema.parse(rawBody)

  const [device] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
  if (!device) {
    throw createError({ statusCode: 404, message: `Unknown device: ${deviceId}` })
  }

  if (body.currentItemId !== null) {
    const [item] = await db
      .select()
      .from(schema.playlistItems)
      .where(eq(schema.playlistItems.id, body.currentItemId))
    if (!item) {
      throw createError({
        statusCode: 400,
        message: `Unknown playlist item: ${body.currentItemId}`
      })
    }
  }

  await db
    .update(schema.devices)
    .set({
      currentItemId: body.currentItemId,
      lastSeenAt: new Date()
    })
    .where(eq(schema.devices.id, deviceId))

  if (body.error) {
    await db.insert(schema.deviceErrors).values({
      deviceId,
      sha256: body.error.sha256 ?? null,
      message: body.error.message
    })
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing device id' })
  const body = await readBody(event)
  try {
    await handleTelemetry(useDb(), id, body)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
  setResponseStatus(event, 204)
  return null
})
