import { useDb } from '~/server/db/client'
import { handleGetInterrupt } from '~/server/services/interrupt'

export default defineEventHandler(async () => handleGetInterrupt(useDb(), Date.now()))
