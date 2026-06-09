// Vue I18n core options. Module options (locales, strategy, defaultLocale) live
// in nuxt.config.ts; vue-i18n core options (legacy/fallback/pluralRules) live here.

// Ukrainian (CLDR) plural categories → message form index:
//   one  → 0  (n%10==1 && n%100!=11):            1, 21, 31, 101…
//   few  → 1  (n%10 in 2..4 && n%100 not 12..14): 2, 3, 4, 22…
//   many → 2  (everything else):                  0, 5..20, 11..14, 25…
// So a message "файл | файли | файлів" maps one|few|many correctly.
function ukrainianPluralRule(choice: number): number {
  const n = Math.abs(choice)
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 0
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1
  return 2
}

export default defineI18nConfig(() => ({
  legacy: false,
  fallbackLocale: 'en',
  pluralRules: {
    uk: ukrainianPluralRule
  }
}))
