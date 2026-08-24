import { describe, it, expect } from 'vitest'
import en from '~/i18n/locales/en.json'
import uk from '~/i18n/locales/uk.json'
import { defaultPluralIndex, ukrainianPluralRule } from '~/i18n/plural-rules'

type Json = { [k: string]: string | Json }

function get(obj: Json, path: string): string {
  const v = path.split('.').reduce<any>((o, k) => o?.[k], obj)
  if (typeof v !== 'string') throw new Error(`missing key: ${path}`)
  return v
}

function flatten(obj: Json, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[path] = v
    else Object.assign(out, flatten(v, path))
  }
  return out
}

/**
 * Picks the message form the way vue-i18n would, then fills {n}.
 * `defaultPluralIndex` mirrors `@intlify/core-base`'s `pluralDefault`; vue-i18n
 * itself is not a declared dependency here, so it cannot be imported directly.
 */
function render(msg: string, n: number, rule: (n: number, len: number) => number): string {
  const forms = msg.split('|').map((s) => s.trim())
  return forms[rule(n, forms.length)]!.replace(/\{n\}/g, String(n))
}

const enRule = defaultPluralIndex
const ukRule = (n: number) => ukrainianPluralRule(n)

describe('locale files', () => {
  it('en and uk define exactly the same keys', () => {
    expect(Object.keys(flatten(en as Json)).sort()).toEqual(
      Object.keys(flatten(uk as Json)).sort()
    )
  })

  it('every pluralised message has the same form count in both locales', () => {
    const e = flatten(en as Json)
    const u = flatten(uk as Json)
    for (const [key, msg] of Object.entries(e)) {
      if (!msg.includes('|')) continue
      expect(u[key]!.split('|').length, key).toBe(msg.split('|').length)
    }
  })
})

describe('English plurals use zero | singular | plural', () => {
  // Regression: these were authored in the Ukrainian one|few|many order, so a
  // count of 1 selected the plural form and rendered "1 items".
  it.each([
    ['playlists.itemCount', 1, '1 item'],
    ['playlists.itemCount', 2, '2 items'],
    ['playlists.itemCount', 0, '0 items'],
    ['playlists.assignmentCount', 1, '1 assignment'],
    ['playlists.assignmentCount', 3, '3 assignments'],
    ['organizations.mediaCount', 0, 'no media'],
    ['organizations.mediaCount', 1, '1 media file'],
    ['organizations.mediaCount', 4, '4 media files'],
    ['organizations.userCount', 1, '1 account'],
    ['organizations.userCount', 2, '2 accounts']
  ])('%s at n=%i', (key, n, expected) => {
    expect(render(get(en as Json, key), n as number, enRule)).toBe(expected)
  })

  it('singular reads correctly in longer sentences', () => {
    expect(render(get(en as Json, 'media.deleteConfirmUsed'), 1, enRule)).toContain(
      'used in 1 playlist.'
    )
    expect(render(get(en as Json, 'media.deleteConfirmUsed'), 3, enRule)).toContain(
      'used in 3 playlists.'
    )
    expect(render(get(en as Json, 'components.mediaUploadDialog.queuedFiles'), 1, enRule)).toBe(
      '1 file queued for processing'
    )
  })
})

describe('Ukrainian plurals use one | few | many', () => {
  it.each([
    ['playlists.itemCount', 1, '1 елемент'],
    ['playlists.itemCount', 3, '3 елементи'],
    ['playlists.itemCount', 5, '5 елементів'],
    ['playlists.itemCount', 11, '11 елементів'],
    ['playlists.itemCount', 21, '21 елемент'],
    ['organizations.mediaCount', 0, '0 медіафайлів'],
    ['organizations.mediaCount', 1, '1 медіафайл'],
    ['organizations.mediaCount', 2, '2 медіафайли'],
    ['organizations.userCount', 5, '5 акаунтів']
  ])('%s at n=%i', (key, n, expected) => {
    expect(render(get(uk as Json, key), n as number, ukRule)).toBe(expected)
  })
})
