import type { SessionUser } from '~/server/services/sessions'

declare module 'h3' {
  interface H3EventContext {
    user: SessionUser | null
  }
}
export {}
