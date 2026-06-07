import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'

const BodySchema = z.object({ name: z.string().min(1).max(120) })

export async function handleCreateOrganization(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
) {
  const body = BodySchema.parse(rawBody)
  const [row] = await db.insert(schema.organizations).values({ name: body.name }).returning()
  return row
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  return handleCreateOrganization(useDb(), await readBody(event))
})
