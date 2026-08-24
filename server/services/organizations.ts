// server/services/organizations.ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'

/**
 * Contact fields are optional free text. The dashboard sends "" for a cleared
 * input, so blank collapses to NULL — otherwise "has a phone" checks would be
 * true for an empty string.
 */
const blankToNull = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .transform((s) => (s === '' ? null : s))

export const OrgNameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(120))

export const OrgPhoneSchema = blankToNull(60).nullable()
export const OrgNotesSchema = blankToNull(2000).nullable()
export const OrgEmailSchema = blankToNull(200)
  .nullable()
  .refine((v) => v === null || z.string().email().safeParse(v).success, {
    message: 'Invalid email'
  })

/** Media/user tallies drive the delete guard and the list UI. */
export interface OrganizationCounts {
  mediaCount: number
  userCount: number
}

export type OrganizationRow = typeof schema.organizations.$inferSelect & OrganizationCounts

/**
 * Counts come from `db.$count` correlated subqueries, not joins: media and
 * users are two independent one-to-many relations, so a GROUP BY over both
 * joins would multiply each other's rows. They are subqueries rather than a
 * hand-written `sql` template because drizzle renders bare column refs
 * *unqualified* inside a template — `WHERE "organization_id" = "id"` then
 * silently resolves both sides against the subquery's own table.
 */
export function organizationSelection(db: BetterSQLite3Database<typeof schema>) {
  return {
    id: schema.organizations.id,
    name: schema.organizations.name,
    phone: schema.organizations.phone,
    email: schema.organizations.email,
    notes: schema.organizations.notes,
    createdAt: schema.organizations.createdAt,
    updatedAt: schema.organizations.updatedAt,
    mediaCount: db.$count(
      schema.media,
      eq(schema.media.organizationId, schema.organizations.id)
    ),
    userCount: db.$count(
      schema.users,
      eq(schema.users.organizationId, schema.organizations.id)
    )
  }
}

export async function findOrganization(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<OrganizationRow | undefined> {
  const [row] = await db
    .select(organizationSelection(db))
    .from(schema.organizations)
    .where(eq(schema.organizations.id, id))
  return row as OrganizationRow | undefined
}
