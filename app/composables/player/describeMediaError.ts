// app/composables/player/describeMediaError.ts
//
// Turns a <video> failure into one line for device_errors. The stage used to
// report the fixed string 'video decode/load error' for every failure, which
// left prod (2026-09-06) with 75 identical rows and no way to tell a rejected
// source from a decoder crash from a network drop. Chromium's MediaError.message
// is descriptive ("DEMUXER_ERROR_COULD_NOT_OPEN", "PIPELINE_ERROR_NETWORK", …)
// and the code alone separates the three big classes.

const CODE_NAMES: Record<number, string> = {
  1: 'ABORTED',
  2: 'NETWORK',
  3: 'DECODE',
  4: 'SRC_NOT_SUPPORTED'
}

const MAX_MESSAGE = 200

export interface MediaErrorLike {
  code: number
  message: string
}

export interface MediaErrorContext {
  networkState: number
  readyState: number
  /** 'blob' when the element was playing a blob: URL (the interceptor-bypass
   *  retry) rather than the direct media URL. */
  source?: 'blob'
}

export function describeMediaError(err: MediaErrorLike | null, ctx: MediaErrorContext): string {
  const code = err ? String(err.code) : '?'
  const name = err ? (CODE_NAMES[err.code] ?? '?') : ''
  const msg = err?.message ? `: ${err.message.slice(0, MAX_MESSAGE)}` : ''
  const src = ctx.source ? ` src=${ctx.source}` : ''
  return `video error ${code}${name ? ` ${name}` : ''}${msg} [network=${ctx.networkState} ready=${ctx.readyState}${src}]`
}
