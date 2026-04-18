// tests/helpers/nuxt-stubs.ts
//
// Stubs Nitro/Nuxt auto-imports so server modules can be imported by vitest
// without booting Nuxt. Each stub throws a descriptive error so that a test
// which accidentally exercises a Nitro wrapper (rather than the tested
// handleXxx function) fails loudly instead of passing a silent no-op.
//
// Maintenance: when a new Nitro auto-import is introduced by a server file
// that is transitively imported from tests, add a stub here.

function notInTests(name: string) {
  return (..._args: unknown[]) => {
    throw new Error(
      `${name}() is a Nitro auto-import; it is not available in the test environment. ` +
        `Call the pure handleXxx function directly instead of exercising the default export.`
    )
  }
}

;(globalThis as any).defineEventHandler = (handler: unknown) => handler
;(globalThis as any).readBody = notInTests('readBody')
;(globalThis as any).getRouterParam = notInTests('getRouterParam')
;(globalThis as any).getRequestHeader = notInTests('getRequestHeader')
;(globalThis as any).getQuery = notInTests('getQuery')
;(globalThis as any).sendStream = notInTests('sendStream')
;(globalThis as any).sendRedirect = notInTests('sendRedirect')
;(globalThis as any).setResponseStatus = notInTests('setResponseStatus')
;(globalThis as any).setResponseHeader = notInTests('setResponseHeader')
;(globalThis as any).createEventStream = notInTests('createEventStream')
;(globalThis as any).useRuntimeConfig = notInTests('useRuntimeConfig')

// `createError` IS called from handleXxx functions, so this must be functional.
;(globalThis as any).createError = (opts: {
  statusCode?: number
  message?: string
}) => {
  const err: any = new Error(opts.message ?? `HTTP ${opts.statusCode ?? 500}`)
  err.statusCode = opts.statusCode ?? 500
  return err
}
// useDb is swapped by individual tests that need it; baseline just throws.
;(globalThis as any).useDb = notInTests('useDb')
