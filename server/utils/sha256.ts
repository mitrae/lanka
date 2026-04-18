import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function sha256Stream(stream: Readable): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}
