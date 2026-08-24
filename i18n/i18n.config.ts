// Vue I18n core options. Module options (locales, strategy, defaultLocale) live
// in nuxt.config.ts; vue-i18n core options (legacy/fallback/pluralRules) live here.
// The rules themselves are in ./plural-rules.ts so the tests can assert against
// the same functions the app runs.
import { ukrainianPluralRule } from './plural-rules'

export default defineI18nConfig(() => ({
  legacy: false,
  fallbackLocale: 'en',
  pluralRules: {
    uk: ukrainianPluralRule
  }
}))
