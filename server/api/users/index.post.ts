import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import { hashPassword, generatePassword } from '~/server/services/password'
import type { SessionUser } from '~/server/services/sessions'

const BodySchema = z.object({
  email: z.email().max(254),
  role: z.enum(['admin', 'client']),
  organizationId: z.number().int().positive().optional()
})

export interface CreateUserResult {
  user: { id: number; email: string; role: 'admin' | 'client'; organizationId: number | null }
  generatedPassword: string
}

export async function handleCreateUser(
  db: BetterSQLite3Database<typeof schema>,
  caller: SessionUser,
  rawBody: unknown
): Promise<CreateUserResult> {
  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(rawBody)
  } catch (err) {
    if (err instanceof z.ZodError) throw createError({ statusCode: 400, message: err.message })
    throw err
  }
  if (caller.role === 'admin' && body.role !== 'client') {
    throw createError({ statusCode: 403, message: 'Admins may only create client users' })
  }
  if (body.role === 'client' && body.organizationId == null) {
    throw createError({ statusCode: 400, message: 'A client must be assigned to an organization' })
  }
  if (body.role === 'admin' && body.organizationId != null) {
    throw createError({ statusCode: 400, message: 'Admins are not tied to an organization' })
  }
  const password = generatePassword()
  const passwordHash = await hashPassword(password)
  try {
    const [row] = await db
      .insert(schema.users)
      .values({
        email: body.email.toLowerCase(),
        role: body.role,
        passwordHash,
        organizationId: body.role === 'client' ? body.organizationId! : null
      })
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        role: schema.users.role,
        organizationId: schema.users.organizationId
      })
    return { user: row as CreateUserResult['user'], generatedPassword: password }
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw createError({ statusCode: 409, message: 'A user with that email already exists' })
    }
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw createError({ statusCode: 400, message: 'Unknown organizationId' })
    }
    throw err
  }
}

export { handleListUsers } from './index.get'

export default defineEventHandler(async (event) => {
  const caller = requireRole(event.context.user, ['admin', 'super'])
  const body = await readBody(event)
  return handleCreateUser(useDb(), caller, body)
})
