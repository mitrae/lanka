// i18n/plural-rules.ts
//
// Shared by i18n.config.ts and tests/i18n/plurals.test.ts so the rule the app
// runs is the rule the tests assert.

/**
 * Ukrainian (CLDR) plural categories → message form index:
 *   one  → 0  (n%10==1 && n%100!=11):             1, 21, 31, 101…
 *   few  → 1  (n%10 in 2..4 && n%100 not 12..14): 2, 3, 4, 22…
 *   many → 2  (everything else):                  0, 5..20, 11..14, 25…
 * So a message "файл | файли | файлів" maps one|few|many correctly. Note
 * there is **no zero slot** — 0 lands on `many`.
 */
export function ukrainianPluralRule(choice: number): number {
  const n = Math.abs(choice)
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 0
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1
  return 2
}

/**
 * Mirror of `pluralDefault` in `@intlify/core-base` (dist/core-base.mjs) —
 * vue-i18n's built-in default, used for every locale without an override.
 * Two forms → singular | plural; **three forms → zero | singular | plural**
 * (`Math.min(count, 2)`). English messages are written against this, so the
 * singular belongs in slot 1, not slot 0 — authoring them in the Ukrainian
 * one|few|many order renders "1 items".
 */
export function defaultPluralIndex(choice: number, choicesLength: number): number {
  const n = Math.abs(choice)
  if (choicesLength === 2) return n === 1 ? 0 : 1
  return Math.min(n, 2)
}
