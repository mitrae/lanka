import { useDb } from '~/server/db/client'
import { seedInitialUsers } from '~/server/services/seed'

export default defineNitroPlugin(async () => {
  const creds = await seedInitialUsers(useDb(), {
    super: process.env.SEED_SUPER_PASSWORD,
    admin: process.env.SEED_ADMIN_PASSWORD,
    client: process.env.SEED_CLIENT_PASSWORD
  })
  for (const c of creds) {
    if (c.generated) {
      // eslint-disable-next-line no-console
      console.log(`[seed] created ${c.role} "${c.username}" — generated password: ${c.password}`)
    } else {
      // eslint-disable-next-line no-console
      console.log(`[seed] created ${c.role} "${c.username}" (password from env)`)
    }
  }
})
