// server/services/google-auth.ts
//
// Verifies a Google Identity Services ID token (JWT) server-side.
// `google-auth-library` is loaded via dynamic import() so that importing this
// module (e.g. from tests via google.post.ts) never loads the SDK — it only
// loads when a token is actually verified. Mirrors R2Store's lazy @aws-sdk load.

export type GoogleIdentity = {
  email: string
  emailVerified: boolean
}

/**
 * Verify a Google ID token. Returns the identity on success, or `null` for ANY
 * verification failure (bad signature, wrong audience, wrong issuer, expired,
 * malformed, missing email). Never throws for verification failures.
 *
 * @param idToken  the `credential` JWT from GIS
 * @param clientId the OAuth Client ID used as the expected `aud`
 */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string
): Promise<GoogleIdentity | null> {
  if (!idToken || !clientId) return null
  try {
    const { OAuth2Client } = await import('google-auth-library')
    const client = new OAuth2Client(clientId)
    const ticket = await client.verifyIdToken({ idToken, audience: clientId })
    const payload = ticket.getPayload()
    if (!payload || !payload.email) return null
    return {
      email: payload.email,
      emailVerified: payload.email_verified === true
    }
  } catch {
    return null
  }
}
