import { useDb } from '~/server/db/client'
import { handleListCommands } from './commands.post'

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  return handleListCommands(useDb(), id)
})
