import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const UpdateSchema = z.object({ name: z.string().min(1).max(200) })

export async function handleUpdateAddress(
  db: BetterSQLite3Database<typeof schema>,
  id: number,
  rawBody: unknown
) {
  const body = UpdateSchema.parse(rawBody)
  const [row] = await db
    .update(schema.addresses)
    .set({ name: body.name, updatedAt: new Date() })
    .where(eq(schema.addresses.id, id))
    .returning()
  if (!row) {
    throw createError({ statusCode: 404, message: `Address ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleUpdateAddress(useDb(), id, body)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
