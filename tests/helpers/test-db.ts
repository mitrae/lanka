// tests/helpers/test-db.ts
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '~/server/db/schema'

export type TestDb = BetterSQLite3Database<typeof schema>

export function createTestDb(): { db: TestDb; close: () => void } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return {
    db,
    close: () => sqlite.close()
  }
}
