import { useDb } from '~/server/db/client'
import { deleteSession, SESSION_COOKIE } from '~/server/services/sessions'

export default defineEventHandler(async (event) => {
  await deleteSession(useDb(), getCookie(event, SESSION_COOKIE))
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
  setResponseStatus(event, 204)
  return null
})
