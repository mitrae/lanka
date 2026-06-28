import { createHash, randomBytes } from 'node:crypto'

/** sha256 hex of a raw device secret (what we store; never the raw). */
export function hashDeviceSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** A fresh high-entropy device secret: the raw token (handed to the device once)
 *  and its sha256 hash (stored server-side). */
export function generateDeviceSecret(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url')
  return { raw, hash: hashDeviceSecret(raw) }
}

export interface WsAuthInput {
  exists: boolean
  storedHash: string | null
  active: boolean
  /** sha256 of the secret the connecting client presented, or null if none. */
  presentedHash: string | null
}

export interface WsAuthDecision {
  allow: boolean
  /** Ratchet: flip the device's command_secret_active flag on. */
  activate: boolean
  closeCode?: number
  reason?: string
}

/**
 * Ratchet trust-on-first-use auth for the command-channel WS:
 * - unknown device → reject (1008).
 * - active (already enforcing) → require a matching secret, else reject.
 * - inactive + a correct secret presented → allow AND activate (a real client
 *   has adopted the secret; enforce from now on).
 * - inactive otherwise → grace-allow (legacy/un-upgraded boxes keep working and
 *   stay OTA-able; an attacker can't activate without the real secret).
 */
export function decideWsAuth(i: WsAuthInput): WsAuthDecision {
  if (!i.exists) {
    return { allow: false, activate: false, closeCode: 1008, reason: 'unknown device' }
  }
  const matches =
    !!i.storedHash && !!i.presentedHash && i.presentedHash === i.storedHash
  if (i.active) {
    return matches
      ? { allow: true, activate: false }
      : { allow: false, activate: false, closeCode: 1008, reason: 'invalid device secret' }
  }
  // Not yet enforcing: a correct secret means a real client has adopted it →
  // ratchet enforcement on. Anything else is grace-allowed.
  if (matches) return { allow: true, activate: true }
  return { allow: true, activate: false }
}
