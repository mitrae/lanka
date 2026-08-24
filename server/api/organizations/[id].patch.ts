import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import {
  findOrganization,
  OrgEmailSchema,
  OrgNameSchema,
  OrgNotesSchema,
  OrgPhoneSchema,
  type OrganizationRow
} from '~/server/services/organizations'

// Every field optional: an absent key leaves the column alone, an explicit
// null (or "") clears it.
const UpdateSchema = z.object({
  name: OrgNameSchema.optional(),
  phone: OrgPhoneSchema.optional(),
  email: OrgEmailSchema.optional(),
  notes: OrgNotesSchema.optional()
})

export async function handleUpdateOrganization(
  db: BetterSQLite3Database<typeof schema>,
  id: number,
  rawBody: unknown
): Promise<OrganizationRow> {
  const body = UpdateSchema.parse(rawBody)
  const patch: Partial<typeof schema.organizations.$inferInsert> = { updatedAt: new Date() }
  if (body.name !== undefined) patch.name = body.name
  if (body.phone !== undefined) patch.phone = body.phone
  if (body.email !== undefined) patch.email = body.email
  if (body.notes !== undefined) patch.notes = body.notes

  const updated = await db
    .update(schema.organizations)
    .set(patch)
    .where(eq(schema.organizations.id, id))
    .returning({ id: schema.organizations.id })
  if (updated.length === 0) {
    throw createError({ statusCode: 404, message: `Organization ${id} not found` })
  }
  return (await findOrganization(db, id))!
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'Bad organization id' })
  const body = await readBody(event)
  try {
    return await handleUpdateOrganization(useDb(), id, body)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
