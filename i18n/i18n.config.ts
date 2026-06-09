// Vue I18n core options. Module options (locales, strategy, defaultLocale) live
// in nuxt.config.ts; vue-i18n core options (legacy/fallback) must live here.
export default defineI18nConfig(() => ({
  legacy: false,
  fallbackLocale: 'en'
}))
