// app/composables/player/useVisibility.ts
//
// Is the player actually on screen? Two sources, in order of trust:
//
//  1. NativeFS — the APK's Activity lifecycle. Authoritative, and the only
//     source that can distinguish `obscured` (a dialog on top, which the
//     snap-back watchdog never fixes) from `background`. Split across two bridge
//     calls on purpose: visibility() is nearly free and safe to call on the 2 s
//     tick, while foregroundPackage() runs a UsageStats query and is called only
//     when a post is going out and we are not in the foreground.
//  2. The Page Visibility API — a plain browser. Reports foreground/background
//     only; document.visibilityState does not change when a dialog is drawn
//     over the app, so `obscured` is unreachable here by construction.

export interface VisibilitySnapshot {
  visibility: 'foreground' | 'obscured' | 'background'
  foregroundPackage: string | null
  snapBacks: number
  focusLosses: number
  hiddenMs: number
  /** Length of the current non-foreground episode; 0 when foreground. */
  episodeMs: number
  /** Bumped whenever the reportable state changes. */
  changeSeq: number
}

export interface VisibilityDeps {
  nativeFS?: { visibility?: () => string; foregroundPackage?: (episodeMs: number) => string }
  /** Injected in tests; defaults to globalThis.document. */
  doc?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>
  /** Injected in tests; defaults to Date.now. */
  now?: () => number
}

export interface VisibilityHandle {
  snapshot(): VisibilitySnapshot
  stop(): void
}

/** Post when the reportable state moved, or once per heartbeat interval.
 *  Mirrors KioskVisibility.shouldPost in Kotlin — keep the two in step. */
export const HEARTBEAT_MS = 30_000

export function shouldPost(seq: number, lastSeq: number, sinceLastPostMs: number): boolean {
  return seq !== lastSeq || sinceLastPostMs >= HEARTBEAT_MS
}

const FOREGROUND: VisibilitySnapshot = {
  visibility: 'foreground',
  foregroundPackage: null,
  snapBacks: 0,
  focusLosses: 0,
  hiddenMs: 0,
  episodeMs: 0,
  changeSeq: 0
}

export function createVisibility(deps: VisibilityDeps = {}): VisibilityHandle {
  const readState = deps.nativeFS?.visibility

  if (readState) {
    const readPackage = deps.nativeFS?.foregroundPackage
    return {
      snapshot(): VisibilitySnapshot {
        try {
          const p = JSON.parse(readState())
          // Trust the shape only as far as the enum — a bridge returning
          // anything unexpected must not poison the dashboard.
          if (
            p?.visibility === 'foreground' ||
            p?.visibility === 'obscured' ||
            p?.visibility === 'background'
          ) {
            const episodeMs = Number(p.episodeMs ?? 0)
            let pkg: string | null = null
            if (p.visibility !== 'foreground' && readPackage) {
              try {
                pkg = readPackage(episodeMs) || null
              }
              catch {
                pkg = null
              }
            }
            return {
              visibility: p.visibility,
              foregroundPackage: pkg,
              snapBacks: Number(p.snapBacks ?? 0),
              focusLosses: Number(p.focusLosses ?? 0),
              hiddenMs: Number(p.hiddenMs ?? 0),
              episodeMs,
              changeSeq: Number(p.changeSeq ?? 0)
            }
          }
        }
        catch {
          /* fall through */
        }
        return { ...FOREGROUND }
      },
      stop() { /* nothing to detach */ }
    }
  }

  const doc = deps.doc ?? (globalThis as any).document
  const now = deps.now ?? Date.now
  if (!doc) {
    return { snapshot: () => ({ ...FOREGROUND }), stop() {} }
  }

  let focusLosses = 0
  let hiddenMs = 0
  let changeSeq = 0
  let lastReported: 'foreground' | 'background' = doc.hidden ? 'background' : 'foreground'
  let hiddenSince: number | null = doc.hidden ? now() : null

  function accrue(): void {
    if (hiddenSince !== null) {
      const t = now()
      const delta = t - hiddenSince
      if (delta > 0) hiddenMs += delta
      hiddenSince = t
    }
  }

  const onChange = (): void => {
    accrue()
    if (doc.hidden) {
      if (hiddenSince === null) {
        hiddenSince = now()
        focusLosses++
      }
    }
    else {
      hiddenSince = null
    }
  }
  doc.addEventListener('visibilitychange', onChange)

  return {
    snapshot(): VisibilitySnapshot {
      accrue()
      const state: 'foreground' | 'background' = doc.hidden ? 'background' : 'foreground'
      if (state !== lastReported) {
        lastReported = state
        changeSeq++
      }
      return {
        visibility: state,
        foregroundPackage: null,
        snapBacks: 0,
        focusLosses,
        hiddenMs,
        episodeMs: hiddenSince === null ? 0 : Math.max(0, now() - hiddenSince),
        changeSeq
      }
    },
    stop() {
      doc.removeEventListener('visibilitychange', onChange)
    }
  }
}
