// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: (process.env.DATABASE_URL ?? 'file:./data/signage.db').replace(/^file:/, '')
  }
})
