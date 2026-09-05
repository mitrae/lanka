import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readApkManifest } from '~/server/services/apk-manifest'

// Fixtures hold the REAL binary AndroidManifest.xml from a 0.5.0 build of the
// kiosk (extracted, then re-zipped without the 6 MB of dex/resources). Ground
// truth from `aapt dump badging`:
//   package: name='ai.lanka.kiosk' versionCode='3' versionName='0.5.0'
const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))

describe('readApkManifest', () => {
  it('reads package, versionName and versionCode from a deflated manifest entry', async () => {
    const m = await readApkManifest(fixture('lanka-kiosk-0.5.0-manifest-only.apk'))
    expect(m).toEqual({ packageName: 'ai.lanka.kiosk', versionName: '0.5.0', versionCode: 3 })
  })

  it('handles a STORED (uncompressed) manifest entry the same way', async () => {
    // Both compression methods occur in the wild: gradle deflates, some
    // signing/zipalign flows store.
    const m = await readApkManifest(fixture('lanka-kiosk-0.5.0-stored.apk'))
    expect(m).toEqual({ packageName: 'ai.lanka.kiosk', versionName: '0.5.0', versionCode: 3 })
  })

  it('rejects a zip with no AndroidManifest.xml as not an APK', async () => {
    await expect(readApkManifest(fixture('not-an-apk.zip'))).rejects.toThrow(/not an APK/i)
  })

  it('rejects a file that is not a zip at all', async () => {
    await expect(readApkManifest(fixture('../services/apk-manifest.test.ts'))).rejects.toThrow(/not a zip|not an APK/i)
  })
})
