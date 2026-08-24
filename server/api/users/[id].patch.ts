import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import {
  findAdminUser,
  requireManageableUser,
  type AdminUserRow
} from '~/server/services/user-admin'
import type { SessionUser } from '~/server/services/sessions'

const UpdateSchema = z
  .object({
    email: z.email().max(254).optional(),
    role: z.enum(['admin', 'client']).optional(),
    organizationId: z.number().int().positive().nullable().optional()
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided'
  })

export async function handleUpdateUser(
  db: BetterSQLite3Database<typeof schema>,
  caller: SessionUser,
  id: number,
  rawBody: unknown
): Promise<AdminUserRow> {
  const body = UpdateSchema.parse(rawBody)
  const target = await requireManageableUser(db, caller, id)

  const nextRole = body.role ?? target.role
  if (caller.role === 'admin' && nextRole !== 'client') {
    throw createError({ statusCode: 403, message: 'Admins may only manage client users' })
  }

  // A role flip with no explicit organization still has to land on a legal
  // combination: promoting to admin drops the org, demoting to client keeps
  // whatever was there (null for an admin) and fails the check below — which
  // is the intended nudge to pass one.
  let nextOrganizationId: number | null
  if (body.organizationId !== undefined) {
    nextOrganizationId = body.organizationId
  } else if (nextRole === 'admin') {
    nextOrganizationId = null
  } else {
    nextOrganizationId = target.organizationId
  }

  // Mirrors the users_role_org_chk constraint, with a message worth reading.
  if (nextRole === 'client' && nextOrganizationId == null) {
    throw createError({ statusCode: 400, message: 'A client must be assigned to an organization' })
  }
  if (nextRole === 'admin' && nextOrganizationId != null) {
    throw createError({ statusCode: 400, message: 'Admins are not tied to an organization' })
  }

  try {
    await db
      .update(schema.users)
      .set({
        ...(body.email !== undefined ? { email: body.email.toLowerCase() } : {}),
        role: nextRole,
        organizationId: nextOrganizationId,
        updatedAt: new Date()
      })
      .where(eq(schema.users.id, id))
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw createError({ statusCode: 409, message: 'A user with that email already exists' })
    }
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw createError({ statusCode: 400, message: 'Unknown organizationId' })
    }
    throw err
  }
  return (await findAdminUser(db, id))!
}

export default defineEventHandler(async (event) => {
  const caller = requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'Bad user id' })
  const body = await readBody(event)
  try {
    return await handleUpdateUser(useDb(), caller, id, body)
  } catch (err: any) {
    if (err instanceof z.ZodError) throw createError({ statusCode: 400, message: err.message })
    throw err
  }
})
