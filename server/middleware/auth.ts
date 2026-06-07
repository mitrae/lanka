import { useDb } from '~/server/db/client'
import { getSessionUser, SESSION_COOKIE } from '~/server/services/sessions'
import { decideAccess } from '~/server/services/auth-guard'

export default defineEventHandler(async (event) => {
  const user = await getSessionUser(useDb(), getCookie(event, SESSION_COOKIE))
  event.context.user = user

  const decision = decideAccess(event.path, user)
  if (!decision.ok) {
    throw createError({
      statusCode: decision.status,
      message: decision.status === 401 ? 'Authentication required' : 'Forbidden'
    })
  }
})
