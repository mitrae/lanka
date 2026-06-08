export interface MailSender {
  sendPasswordReset(to: string, resetUrl: string): Promise<void>
}

/** Dev/test default: prints the reset link to the server log (like seed passwords). */
export class LogMailer implements MailSender {
  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[mailer] password reset for ${to}: ${resetUrl}`)
  }
}

/** Production: one HTTP call to the Resend API. No SDK dependency. */
export class ResendMailer implements MailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string
  ) {}

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: this.from,
        to,
        subject: 'Reset your Lanka password',
        text: `Reset your Lanka password using this link (valid 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
        // resetUrl is built server-side from APP_BASE_URL + an opaque token; no user input reaches here.
        html: `<p>Reset your Lanka password using this link (valid 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`
      })
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Resend API error ${res.status}: ${detail}`)
    }
  }
}

let _mailer: MailSender | null = null

/** Picks ResendMailer when RESEND_API_KEY is set, else LogMailer. */
export function useMailer(): MailSender {
  if (_mailer) return _mailer
  const config = useRuntimeConfig()
  const apiKey = config.resendApiKey
  const from = config.mailFrom
  _mailer = apiKey ? new ResendMailer(apiKey, from) : new LogMailer()
  return _mailer
}

export function _setMailer(m: MailSender | null): void {
  _mailer = m
}
