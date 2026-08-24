// server/services/user-admin.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import type { Role, SessionUser } from '~/server/services/sessions'

export interface AdminUserRow {
  id: number
  email: string
  role: Role
  organizationId: number | null
  organizationName: string | null
  createdAt: Date
}

/**
 * The one place the "who may act on whom" rules live, shared by GET / PATCH /
 * password-reset / DELETE. Mirrors `handleDeleteUser`: super accounts are
 * untouchable through the admin surface (which also stops a super from
 * demoting themselves and locking the fleet out), and an admin may only ever
 * manage clients.
 */
export async function requireManageableUser(
  db: BetterSQLite3Database<typeof schema>,
  caller: SessionUser,
  id: number
): Promise<{ id: number; role: Role; organizationId: number | null }> {
  const [target] = await db
    .select({
      id: schema.users.id,
      role: schema.users.role,
      organizationId: schema.users.organizationId
    })
    .from(schema.users)
    .where(eq(schema.users.id, id))
  if (!target) throw createError({ statusCode: 404, message: `User ${id} not found` })
  if (target.role === 'super') {
    throw createError({ statusCode: 403, message: 'Super accounts cannot be modified here' })
  }
  if (caller.role === 'admin' && target.role !== 'client') {
    throw createError({ statusCode: 403, message: 'Admins may only manage client users' })
  }
  return target as { id: number; role: Role; organizationId: number | null }
}

/** Re-read through the org join so every response has the same shape as the list. */
export async function findAdminUser(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<AdminUserRow | undefined> {
  const [row] = await db
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
    .where(eq(schema.users.id, id))
  return row as AdminUserRow | undefined
}
