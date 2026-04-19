import { sql } from 'drizzle-orm'
import { access, constants } from 'node:fs/promises'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleHealthz(
  db: BetterSQLite3Database<typeof schema>,
  mediaDir: string,
  version: string
): Promise<{ ok: true; version: string }> {
  db.get(sql`SELECT 1`)
  await access(mediaDir, constants.W_OK)
  return { ok: true, version }
}

export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  return handleHealthz(useDb(), config.mediaDir, config.appVersion)
})
