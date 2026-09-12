// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // Only needed to transform the handful of .vue SFCs mounted under
  // tests/components/ (@vue/test-utils). Every other test imports plain .ts
  // modules and never touches this plugin.
  plugins: [vue()],
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/helpers/nuxt-stubs.ts'],
    pool: 'forks' // better-sqlite3 native module isolates per-worker
  },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./', import.meta.url))
    }
  }
})
