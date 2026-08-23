import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import {
  type AssignmentContext,
  findDirectAssignment,
  withInherited
} from '~/server/services/assignments'

export type GroupDetail = typeof schema.groups.$inferSelect & AssignmentContext

export async function handleGetGroup(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<GroupDetail> {
  const [row] = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Group ${id} not found` })
  }

  const direct = await findDirectAssignment(db, { level: 'group', id })
  const inherited = direct
    ? null
    : await findDirectAssignment(db, { level: 'address', id: row.addressId })

  return {
    ...row,
    ...withInherited(direct, 'group', { assignment: inherited, level: 'address' })
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  return handleGetGroup(useDb(), id)
})
