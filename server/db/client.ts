// server/db/client.ts
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

let _db: BetterSQLite3Database<typeof schema> | null = null
let _sqlite: Database.Database | null = null

export function openDatabase(url: string): BetterSQLite3Database<typeof schema> {
  if (_db) return _db
  const path = url.replace(/^file:/, '')
  _sqlite = new Database(path)
  _sqlite.pragma('journal_mode = WAL')
  _sqlite.pragma('foreign_keys = ON')
  _db = drizzle(_sqlite, { schema })
  return _db
}

export function useDb(): BetterSQLite3Database<typeof schema> {
  if (!_db) {
    const config = useRuntimeConfig()
    return openDatabase(config.databaseUrl)
  }
  return _db
}

export function closeDatabase(): void {
  _sqlite?.close()
  _db = null
  _sqlite = null
}
