import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import { findOrganization } from '~/server/services/organizations'

export { handleGetOrganization } from './[id].get'
export { handleUpdateOrganization } from './[id].patch'

/**
 * Deleting an organization is destructive beyond the row itself: the FK on
 * `users.organization_id` is ON DELETE CASCADE, so every client account
 * belonging to it disappears too. Media is only detached. Anything still
 * attached therefore needs an explicit `force`.
 *
 * The media detach is done by hand rather than left to the FK: `schema.ts`
 * declares `onDelete: 'set null'`, but migration 0002 added the column with a
 * bare `ALTER TABLE … REFERENCES organizations(id)`, so the column that
 * actually exists in the DB has NO ACTION and the delete would fail with
 * FOREIGN KEY constraint failed. Fixing that needs a SQLite table rebuild;
 * until then this is the behaviour schema.ts promises.
 */
export async function handleDeleteOrganization(
  db: BetterSQLite3Database<typeof schema>,
  id: number,
  opts: { force?: boolean } = {}
): Promise<void> {
  const org = await findOrganization(db, id)
  if (!org) throw createError({ statusCode: 404, message: `Organization ${id} not found` })

  const attached = org.mediaCount + org.userCount
  if (attached > 0 && !opts.force) {
    throw createError({
      statusCode: 409,
      message:
        `Organization ${id} still has ${org.mediaCount} media file(s) and ` +
        `${org.userCount} user account(s). Retry with force=true.`
    })
  }

  db.transaction((tx) => {
    tx.update(schema.media)
      .set({ organizationId: null })
      .where(eq(schema.media.organizationId, id))
      .run()
    tx.delete(schema.organizations).where(eq(schema.organizations.id, id)).run()
  })
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'Bad organization id' })
  const query = getQuery(event)
  await handleDeleteOrganization(useDb(), id, { force: query.force === 'true' || query.force === true })
  setResponseStatus(event, 204)
  return null
})
