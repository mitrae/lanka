import { randomBytes } from 'node:crypto'
import { isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import type { Role } from './sessions'
import { hashPassword } from './password'

export type SeedCredential = {
  username: string
  role: Role
  password: string
  generated: boolean
}

function resolvePassword(envVal: string | undefined): { password: string; generated: boolean } {
  if (envVal && envVal.length > 0) return { password: envVal, generated: false }
  return { password: randomBytes(12).toString('base64url'), generated: true }
}

export async function seedInitialUsers(
  db: BetterSQLite3Database<typeof schema>,
  env: { super?: string; admin?: string; client?: string } = {}
): Promise<SeedCredential[]> {
  const existing = await db.select({ id: schema.users.id }).from(schema.users).limit(1)
  if (existing.length > 0) return []

  const creds: SeedCredential[] = []

  const su = resolvePassword(env.super)
  await db.insert(schema.users).values({
    username: 'super', role: 'super', passwordHash: await hashPassword(su.password), organizationId: null
  })
  creds.push({ username: 'super', role: 'super', ...su })

  const ad = resolvePassword(env.admin)
  await db.insert(schema.users).values({
    username: 'admin', role: 'admin', passwordHash: await hashPassword(ad.password), organizationId: null
  })
  creds.push({ username: 'admin', role: 'admin', ...ad })

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'Demo Organization' })
    .returning()

  const cl = resolvePassword(env.client)
  await db.insert(schema.users).values({
    username: 'client', role: 'client', passwordHash: await hashPassword(cl.password), organizationId: org.id
  })
  creds.push({ username: 'client', role: 'client', ...cl })

  // Give the demo client something to see: adopt all currently-unowned media.
  await db
    .update(schema.media)
    .set({ organizationId: org.id })
    .where(isNull(schema.media.organizationId))

  return creds
}
