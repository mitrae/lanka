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
    layouts: 'app/layouts',
    // srcDir is '.', so the default middleware dir would be ./middleware.
    // The guard lives in app/middleware, so point Nuxt there — otherwise
    // auth.global.ts is silently never scanned and the SPA skips the login redirect.
    middleware: 'app/middleware'
  },
  imports: {
    dirs: ['app/composables', 'app/stores']
  },
  components: [{ path: '~/app/components', pathPrefix: false }],
  colorMode: {
    preference: 'light',
    fallback: 'light',
    classSuffix: ''
  },
  fonts: {
    families: [
      { name: 'Bricolage Grotesque', provider: 'google' },
      { name: 'Hanken Grotesque', provider: 'google' },
      { name: 'JetBrains Mono', provider: 'google' }
    ]
  },
  typescript: {
    strict: true,
    typeCheck: false
  },
  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL ?? 'file:./data/signage.db',
    mediaDir: process.env.MEDIA_DIR ?? './data/media',
    appVersion: process.env.npm_package_version ?? 'dev',
    // Cloudflare R2 (S3-compatible). When all four are set, media is stored in
    // R2 instead of mediaDir; the server still proxies bytes over the tailnet.
    // Server-only (not under `public`), so credentials never reach the client.
    r2: {
      endpoint: process.env.R2_ENDPOINT ?? '',
      bucket: process.env.R2_BUCKET ?? '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? ''
    }
  },
  nitro: {
    experimental: {
      tasks: false
    }
  }
})
