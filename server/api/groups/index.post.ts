import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const CreateSchema = z.object({
  addressId: z.number().int().positive(),
  name: z.string().min(1).max(200)
})

export async function handleCreateGroup(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
) {
  const body = CreateSchema.parse(rawBody)
  try {
    const [row] = await db
      .insert(schema.groups)
      .values({ addressId: body.addressId, name: body.name })
      .returning()
    return row
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw createError({ statusCode: 400, message: 'Unknown addressId' })
    }
    throw err
  }
}

export { handleListGroups } from './index.get'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    return await handleCreateGroup(useDb(), body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
