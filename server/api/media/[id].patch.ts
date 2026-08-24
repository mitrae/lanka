import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'

// `filename` is a display label only — the bytes are addressed by sha256 and
// the type comes from `mimeType`, so nothing downstream parses an extension
// out of it. 255 matches the cap the upload endpoint applies.
const UpdateSchema = z.object({
  filename: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(255))
})

export async function handleUpdateMedia(
  db: BetterSQLite3Database<typeof schema>,
  id: number,
  rawBody: unknown
) {
  const body = UpdateSchema.parse(rawBody)
  const [row] = await db
    .update(schema.media)
    .set({ filename: body.filename })
    .where(eq(schema.media.id, id))
    .returning()
  if (!row) throw createError({ statusCode: 404, message: `Media ${id} not found` })
  return row
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'Bad media id' })
  const body = await readBody(event)
  try {
    return await handleUpdateMedia(useDb(), id, body)
  } catch (err: any) {
    if (err instanceof z.ZodError) throw createError({ statusCode: 400, message: err.message })
    throw err
  }
})
