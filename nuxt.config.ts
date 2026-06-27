// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2026-04-01',
  devtools: { enabled: true },
  ssr: false,
  srcDir: '.',
  modules: ['@nuxt/ui', '@nuxt/fonts', '@nuxtjs/color-mode', '@pinia/nuxt', '@nuxtjs/i18n'],
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
  i18n: {
    strategy: 'no_prefix',          // leave every URL unchanged — auth-guard path checks rely on this
    defaultLocale: 'uk',
    detectBrowserLanguage: false,   // always Ukrainian, never sniff the browser
    vueI18n: 'i18n.config.ts',      // resolved inside the i18n/ restructureDir
    locales: [
      { code: 'uk', name: 'Українська', file: 'uk.json' },
      { code: 'en', name: 'English', file: 'en.json' }
    ]
    // langDir defaults to 'locales', resolved inside the i18n/ restructureDir → <root>/i18n/locales/
  },
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
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    mailFrom: process.env.MAIL_FROM ?? 'Lanka <no-reply@lanka.live>',
    // Absolute base URL used to build emailed password-reset links (from APP_BASE_URL,
    // e.g. https://app.lanka.live). NOT named `appBaseUrl` on purpose: the NUXT_APP_BASE_URL
    // runtime-override env collides with Nuxt's reserved `app.baseURL` (router base) and
    // would re-base every route. `mailBaseUrl` ⇒ override is NUXT_MAIL_BASE_URL (see entrypoint.sh).
    // Required when RESEND_API_KEY is set — empty string yields relative (broken) reset links.
    mailBaseUrl: process.env.APP_BASE_URL ?? '',
    // Cloudflare R2 (S3-compatible). When all four are set, media is stored in
    // R2 instead of mediaDir; the server still proxies bytes over the tailnet.
    // Server-only (not under `public`), so credentials never reach the client.
    r2: {
      endpoint: process.env.R2_ENDPOINT ?? '',
      bucket: process.env.R2_BUCKET ?? '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? ''
    },
    public: {
      // Public CDN base for media (e.g. https://media.lanka.live). Baked at
      // build time via the Dockerfile ARG because this is an SPA (ssr:false).
      // Empty in dev → the player falls back to the relative /media/<sha> path.
      mediaPublicBase: process.env.MEDIA_PUBLIC_BASE ?? '',
      // Google OAuth public Client ID for "Sign in with Google". Public by
      // design (not a secret). Plain GOOGLE_CLIENT_ID name — mirrors
      // MEDIA_PUBLIC_BASE: read here at build time and baked into the SPA via
      // the Dockerfile ARG. NOT NUXT_PUBLIC_* — SPA public values are frozen at
      // build time, so a runtime override can't reach the client bundle.
      // Empty ⇒ the Google button is hidden; password login is unaffected.
      googleClientId: process.env.GOOGLE_CLIENT_ID ?? ''
    }
  },
  nitro: {
    experimental: {
      tasks: false,
      // Enables Nitro/crossws WebSocket upgrades so the device command channel
      // (/api/devices/:id/ws — reboot, screenshot, OTA, kiosk-lock) works.
      // Without this the node server answers WS upgrades with HTTP 426.
      websocket: true
    }
  }
})
