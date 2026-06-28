// Post-build: copy the @ffmpeg-installer / @ffprobe-installer platform binaries
// into the Nitro build output.
//
// Why: each meta-package's index.js does `require.resolve('<pkg>/<bin>')` AND
// verifies the file exists AT IMPORT TIME, throwing if it's missing. Nitro's
// production bundle (node-file-trace) can fail to include a platform sub-package
// in `.output/server/node_modules` — on this machine pnpm's virtual-store layout
// trips the trace for `@ffprobe-installer/linux-x64`. The built server then
// throws MODULE_NOT_FOUND on the first transcode and every upload 500s.
//
// This copies the platform package dirs (binary + package.json) into the output
// at the path the meta-package resolves, so the import succeeds. It's a harmless
// no-op when the binary is already bundled (cpSync overwrites with identical
// bytes). Runs after `nuxt build` via the package.json `postbuild` script, so it
// fires for both local `pnpm build` and the prod Docker `RUN pnpm build`.
//
// Failures are non-fatal: a missing/unresolvable installer is warned and skipped
// rather than failing the build (the runtime can still fall back to a system
// binary on PATH if one is installed).
import { createRequire } from 'node:module'
import { cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const OUT = '.output/server/node_modules'
const platform = `${process.platform}-${process.arch}` // e.g. linux-x64

for (const [meta, bin] of [
  ['@ffmpeg-installer', 'ffmpeg'],
  ['@ffprobe-installer', 'ffprobe'],
]) {
  const destDir = join(OUT, meta, platform)
  if (existsSync(join(destDir, bin))) {
    // Already bundled by Nitro (the common case for @ffmpeg-installer).
    continue
  }
  try {
    // require(meta/bin).path → absolute path to the binary in node_modules.
    // dirname() is the platform package dir (contains the binary + package.json).
    const srcDir = dirname(require(`${meta}/${bin}`).path)
    cpSync(srcDir, destDir, { recursive: true })
    console.log(`[copy-ffmpeg-binaries] copied ${meta}/${platform} -> ${destDir}`)
  } catch (err) {
    console.warn(`[copy-ffmpeg-binaries] skipped ${meta}/${bin}: ${err.message}`)
  }
}
