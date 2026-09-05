// server/services/apk-manifest.ts
//
// Reads package name, versionName and versionCode straight out of an APK's
// binary AndroidManifest.xml. No dependency: the maintained parser on npm
// drags in bluebird-era transitive deps, and the alternatives are abandoned.
// This is ~150 lines of two well-specified formats — the ZIP central directory
// and Android's ResXMLTree ("AXML") — and it is exercised against the real
// manifest of a kiosk build in tests/services/apk-manifest.test.ts.
//
// Why the server reads the APK at all: the version used to be typed by the
// operator and a filename is only a label. The bytes are the truth. Reading
// them lets the upload refuse a foreign package (today that is only caught on
// the box, by OtaInstaller, after a 6 MB download), store versionCode for
// downgrade protection, and drop the mandatory version field that silently
// swallowed an upload when left empty.

import { open } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

export interface ApkManifest {
  packageName: string
  versionName: string
  versionCode: number
}

// ---------------------------------------------------------------------------
// ZIP: locate and extract one entry without reading the whole archive.
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

async function readEntry(path: string, wanted: string): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    // The end-of-central-directory record is within the last 64 KB + 22 bytes.
    const tailLen = Math.min(size, 65_557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
    }
    if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)')
    const cenSize = tail.readUInt32LE(eocd + 12)
    const cenOffset = tail.readUInt32LE(eocd + 16)

    const cen = Buffer.alloc(cenSize)
    await fh.read(cen, 0, cenSize, cenOffset)
    let p = 0
    while (p + 46 <= cen.length && cen.readUInt32LE(p) === CEN_SIG) {
      const method = cen.readUInt16LE(p + 10)
      const compressed = cen.readUInt32LE(p + 20)
      const uncompressed = cen.readUInt32LE(p + 24)
      const nameLen = cen.readUInt16LE(p + 28)
      const extraLen = cen.readUInt16LE(p + 30)
      const commentLen = cen.readUInt16LE(p + 32)
      const localOffset = cen.readUInt32LE(p + 42)
      const name = cen.toString('utf8', p + 46, p + 46 + nameLen)
      if (name === wanted) {
        const loc = Buffer.alloc(30)
        await fh.read(loc, 0, 30, localOffset)
        if (loc.readUInt32LE(0) !== LOC_SIG) throw new Error('corrupt zip (bad local header)')
        const dataStart = localOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28)
        const raw = Buffer.alloc(compressed)
        await fh.read(raw, 0, compressed, dataStart)
        if (method === 0) return raw
        if (method === 8) {
          const out = inflateRawSync(raw)
          if (out.length !== uncompressed) throw new Error('corrupt zip (inflated size mismatch)')
          return out
        }
        throw new Error(`unsupported zip compression method ${method}`)
      }
      p += 46 + nameLen + extraLen + commentLen
    }
    throw new Error(`not an APK (no ${wanted})`)
  } finally {
    await fh.close()
  }
}

// ---------------------------------------------------------------------------
// AXML: walk the chunk stream to the <manifest> start tag and read its
// attributes. Attribute names come from the string pool; aapt2 may leave the
// pool string empty and rely on the resource map instead, so both are tried.
// ---------------------------------------------------------------------------

const RES_XML_TYPE = 0x0003
const RES_STRING_POOL_TYPE = 0x0001
const RES_XML_RESOURCE_MAP_TYPE = 0x0180
const RES_XML_START_ELEMENT_TYPE = 0x0102
const UTF8_FLAG = 0x100

const TYPE_STRING = 0x03
const TYPE_INT_DEC = 0x10
const TYPE_INT_HEX = 0x11

// android:versionCode / android:versionName resource ids (frameworks/base public.xml).
const RES_ID_VERSION_CODE = 0x0101021b
const RES_ID_VERSION_NAME = 0x0101021c

function readStringPool(buf: Buffer, start: number): string[] {
  const count = buf.readUInt32LE(start + 8)
  const flags = buf.readUInt32LE(start + 16)
  const stringsStart = start + buf.readUInt32LE(start + 20)
  const utf8 = (flags & UTF8_FLAG) !== 0
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    let o = stringsStart + buf.readUInt32LE(start + 28 + i * 4)
    if (utf8) {
      // u8 char count (2 bytes if high bit set), u8 byte length (same), bytes, NUL.
      if (buf[o] & 0x80) o += 2; else o += 1
      let len = buf[o]
      if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[o + 1]; o += 2 } else o += 1
      out.push(buf.toString('utf8', o, o + len))
    } else {
      // u16 char count (2 words if high bit set), UTF-16LE chars.
      let len = buf.readUInt16LE(o)
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(o + 2); o += 4 } else o += 2
      out.push(buf.toString('utf16le', o, o + len * 2))
    }
  }
  return out
}

function parseAxml(buf: Buffer): ApkManifest {
  if (buf.length < 8 || buf.readUInt16LE(0) !== RES_XML_TYPE) {
    throw new Error('not an APK (AndroidManifest.xml is not binary XML)')
  }
  let strings: string[] = []
  let resourceMap: number[] = []
  let p = buf.readUInt16LE(2) // header size of the outer chunk

  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p)
    const headerSize = buf.readUInt16LE(p + 2)
    const chunkSize = buf.readUInt32LE(p + 4)
    if (chunkSize < 8) throw new Error('corrupt binary XML')

    if (type === RES_STRING_POOL_TYPE) {
      strings = readStringPool(buf, p)
    } else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      resourceMap = []
      for (let o = p + headerSize; o + 4 <= p + chunkSize; o += 4) resourceMap.push(buf.readUInt32LE(o))
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      const nameIdx = buf.readUInt32LE(p + headerSize + 4)
      if (strings[nameIdx] === 'manifest') {
        const attrStart = p + headerSize + buf.readUInt16LE(p + headerSize + 8)
        const attrSize = buf.readUInt16LE(p + headerSize + 10)
        const attrCount = buf.readUInt16LE(p + headerSize + 12)
        let packageName: string | undefined
        let versionName: string | undefined
        let versionCode: number | undefined
        for (let i = 0; i < attrCount; i++) {
          const a = attrStart + i * attrSize
          const attrNameIdx = buf.readUInt32LE(a + 4)
          const rawValue = buf.readUInt32LE(a + 8)
          const dataType = buf[a + 15]
          const data = buf.readUInt32LE(a + 16)
          const attrName = strings[attrNameIdx] ?? ''
          const resId = resourceMap[attrNameIdx]
          const stringValue = () =>
            rawValue !== 0xffffffff ? strings[rawValue] : dataType === TYPE_STRING ? strings[data] : undefined
          if (attrName === 'package') packageName = stringValue()
          else if (attrName === 'versionName' || resId === RES_ID_VERSION_NAME) versionName = stringValue()
          else if (attrName === 'versionCode' || resId === RES_ID_VERSION_CODE) {
            if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) versionCode = data >>> 0
          }
        }
        if (!packageName) throw new Error('AndroidManifest.xml has no package name')
        if (!versionName) throw new Error('AndroidManifest.xml has no versionName')
        if (versionCode === undefined) throw new Error('AndroidManifest.xml has no versionCode')
        return { packageName, versionName, versionCode }
      }
    }
    p += chunkSize
  }
  throw new Error('AndroidManifest.xml has no <manifest> element')
}

/** Package name, versionName and versionCode of the APK at `path`. Throws on
 *  anything that is not a readable APK. */
export async function readApkManifest(path: string): Promise<ApkManifest> {
  return parseAxml(await readEntry(path, 'AndroidManifest.xml'))
}
