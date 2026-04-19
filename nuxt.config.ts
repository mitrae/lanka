// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2026-04-01',
  devtools: { enabled: true },
  ssr: false,
  srcDir: '.',
  modules: ['@nuxt/ui', '@nuxt/fonts', '@nuxtjs/color-mode', '@pinia/nuxt'],
  css: ['~/app/assets/css/main.css'],
  dir: {
    pages: 'app/pages',
    layouts: 'app/layouts'
  },
  imports: {
    dirs: ['app/composables', 'app/stores']
  },
  components: [{ path: '~/app/components', pathPrefix: false }],
  colorMode: {
    preference: 'dark',
    fallback: 'dark',
    classSuffix: ''
  },
  typescript: {
    strict: true,
    typeCheck: false
  },
  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL ?? 'file:./data/signage.db',
    mediaDir: process.env.MEDIA_DIR ?? './data/media',
    appVersion: process.env.npm_package_version ?? 'dev'
  },
  nitro: {
    experimental: {
      tasks: false
    }
  }
})
