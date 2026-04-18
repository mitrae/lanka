// Stub Nuxt/h3 auto-imports so server route files can be imported in Vitest
// without booting Nuxt. The default export (defineEventHandler) is never called
// in unit tests — only the exported handler functions are exercised directly.
import { vi } from 'vitest'

;(globalThis as any).defineEventHandler = vi.fn((fn: unknown) => fn)
;(globalThis as any).readBody = vi.fn()
;(globalThis as any).createError = vi.fn((opts: { statusCode: number; message: string }) => {
  const err = new Error(opts.message) as any
  err.statusCode = opts.statusCode
  return err
})
;(globalThis as any).useDb = vi.fn()
