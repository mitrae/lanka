import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import type { Role, SessionUser } from '~/server/services/sessions'

export interface UserRow {
  id: number
  email: string
  role: Role
  organizationId: number | null
  organizationName: string | null
  createdAt: Date
}

export async function handleListUsers(
  db: BetterSQLite3Database<typeof schema>,
  caller: SessionUser
): Promise<UserRow[]> {
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
      organizationId: schema.users.organizationId,
      organizationName: schema.organizations.name,
      createdAt: schema.users.createdAt
    })
    .from(schema.users)
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.users.organizationId))
    .orderBy(asc(schema.users.email))
  const visible = caller.role === 'super' ? rows : rows.filter((r) => r.role === 'client')
  return visible as UserRow[]
}

export default defineEventHandler(async (event) => {
  const caller = requireRole(event.context.user, ['admin', 'super'])
  return handleListUsers(useDb(), caller)
})
