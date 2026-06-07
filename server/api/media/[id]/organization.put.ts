import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'

const BodySchema = z.object({ organizationId: z.number().int().positive().nullable() })

export async function handleAssignMediaOrg(
  db: BetterSQLite3Database<typeof schema>,
  mediaId: number,
  rawBody: unknown
) {
  const body = BodySchema.parse(rawBody)
  const [m] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId))
  if (!m) throw createError({ statusCode: 404, message: 'Media not found' })
  if (body.organizationId != null) {
    const [o] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, body.organizationId))
    if (!o) throw createError({ statusCode: 400, message: 'Organization not found' })
  }
  const [row] = await db
    .update(schema.media)
    .set({ organizationId: body.organizationId })
    .where(eq(schema.media.id, mediaId))
    .returning()
  return row
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) throw createError({ statusCode: 400, message: 'Bad media id' })
  return handleAssignMediaOrg(useDb(), id, await readBody(event))
})
