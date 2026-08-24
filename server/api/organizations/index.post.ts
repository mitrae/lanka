import { z } from 'zod'
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

const BodySchema = z.object({
  name: OrgNameSchema,
  phone: OrgPhoneSchema.optional(),
  email: OrgEmailSchema.optional(),
  notes: OrgNotesSchema.optional()
})

export async function handleCreateOrganization(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
): Promise<OrganizationRow> {
  const body = BodySchema.parse(rawBody)
  const [row] = await db
    .insert(schema.organizations)
    .values({
      name: body.name,
      phone: body.phone ?? null,
      email: body.email ?? null,
      notes: body.notes ?? null
    })
    .returning({ id: schema.organizations.id })
  // Re-read so a created org carries the same count fields as a listed one —
  // the dashboard splices this row straight into its list.
  return (await findOrganization(db, row!.id))!
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  const body = await readBody(event)
  try {
    return await handleCreateOrganization(useDb(), body)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
