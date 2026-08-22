import { describe, expect, it } from 'vitest'
import { restorableManifest } from '~/app/composables/player/restorableManifest'
import type { Manifest, ManifestItem } from '~/app/types/api'

const item = (id: number, sha256: string): ManifestItem => ({
  id,
  type: 'video',
  sha256,
  durationMs: 1000
})

const m = (...shas: string[]): Manifest => ({
  playlistId: 1,
  playlistName: 'p',
  version: 7,
  items: shas.map((s, i) => item(i + 1, s))
})

const allCached = () => true
const noneCached = () => false

describe('restorableManifest', () => {
  it('restores nothing when no manifest was saved', () => {
    expect(restorableManifest(null, allCached)).toEqual({ kind: 'nothing' })
  })

  it('restores nothing for an empty manifest', () => {
    const empty: Manifest = { playlistId: 1, playlistName: 'p', version: 7, items: [] }
    expect(restorableManifest(empty, allCached)).toEqual({ kind: 'nothing' })
  })

  it('restores nothing when none of the media is cached', () => {
    expect(restorableManifest(m('a', 'b'), noneCached)).toEqual({ kind: 'nothing' })
  })

  it('replays a fully cached manifest as complete', () => {
    const d = restorableManifest(m('a', 'b'), allCached)
    expect(d.kind).toBe('replay')
    if (d.kind !== 'replay') return
    expect(d.complete).toBe(true)
    expect(d.manifest.items.map(i => i.sha256)).toEqual(['a', 'b'])
  })

  it('drops uncached items and marks the replay incomplete', () => {
    const d = restorableManifest(m('a', 'b', 'c'), sha => sha !== 'b')
    expect(d.kind).toBe('replay')
    if (d.kind !== 'replay') return
    expect(d.manifest.items.map(i => i.sha256)).toEqual(['a', 'c'])
    // Incomplete must not be adopted as the current key, or the live manifest
    // would look unchanged and the player would be stuck on the partial list.
    expect(d.complete).toBe(false)
  })

  it('preserves playlist identity so the reconciler can dedupe', () => {
    const d = restorableManifest(m('a'), allCached)
    if (d.kind !== 'replay') throw new Error('expected replay')
    expect(d.manifest.playlistId).toBe(1)
    expect(d.manifest.version).toBe(7)
    expect(d.manifest.playlistName).toBe('p')
  })

  it('does not mutate the saved manifest', () => {
    const saved = m('a', 'b')
    restorableManifest(saved, sha => sha === 'a')
    expect(saved.items).toHaveLength(2)
  })
})
