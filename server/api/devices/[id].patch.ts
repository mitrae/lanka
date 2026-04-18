import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const UpdateSchema = z
  .object({
    name: z.string().min(1).max(200).nullable().optional(),
    groupId: z.number().int().positive().nullable().optional()
  })
  .refine((v) => v.name !== undefined || v.groupId !== undefined, {
    message: 'At least one field must be provided'
  })

export async function handleUpdateDevice(
  db: BetterSQLite3Database<typeof schema>,
  id: string,
  rawBody: unknown
) {
  const body = UpdateSchema.parse(rawBody)
  try {
    const [row] = await db
      .update(schema.devices)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.devices.id, id))
      .returning()
    if (!row) {
      throw createError({ statusCode: 404, message: `Device ${id} not found` })
    }
    return row
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw createError({ statusCode: 400, message: 'Unknown groupId' })
    }
    throw err
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleUpdateDevice(useDb(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
