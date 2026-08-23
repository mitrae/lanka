import type { DeviceCommand } from '~/app/types/api'

export type SurfaceName = 'webview' | 'native'

export interface SurfaceSwitchView {
  /** What the control shows. `idle` = nothing in flight. */
  phase: 'idle' | 'queued' | 'sent' | 'applying' | 'failed'
  /** The surface the operator last asked for (from the newest set-surface row). */
  requested: SurfaceName | null
  /** The box's failure reason when `phase === 'failed'`. */
  reason: string | null
}

/** After an ack, how long we keep saying "applying…" while the reported surface still differs. */
export const APPLYING_WINDOW_MS = 3 * 60_000

function parseSurface(payload: string | null): SurfaceName | null {
  if (!payload) return null
  try {
    const s = (JSON.parse(payload) as { surface?: unknown }).surface
    return s === 'webview' || s === 'native' ? s : null
  } catch {
    return null
  }
}

/**
 * Derives the switch control's state from the device's command list (newest
 * first, as `GET /api/devices/:id/commands` returns it) and the reported
 * surface. The server stores no "desired surface": the newest `set-surface`
 * row IS the request, `devices.surface` (telemetry) is the truth.
 */
export function surfaceSwitchView(
  commands: DeviceCommand[],
  reported: SurfaceName | null,
  now: number
): SurfaceSwitchView {
  const idle: SurfaceSwitchView = { phase: 'idle', requested: null, reason: null }
  const latest = commands.find((c) => c.cmd === 'set-surface')
  if (!latest) return idle
  const requested = parseSurface(latest.payload)
  if (!requested) return idle

  switch (latest.status) {
    case 'pending':
      return { phase: 'queued', requested, reason: null }
    case 'sent':
      return { phase: 'sent', requested, reason: null }
    case 'failed':
      return { phase: 'failed', requested, reason: latest.result }
    case 'acked': {
      const age = now - new Date(latest.updatedAt).getTime()
      const applying = reported !== requested && age >= 0 && age < APPLYING_WINDOW_MS
      return applying ? { phase: 'applying', requested, reason: null } : idle
    }
    default:
      return idle
  }
}
