// Warn loudly at boot about a misconfiguration that only surfaces in a real
// email: if Resend is enabled but no base URL is set, password-reset links are
// built relative (e.g. `/reset-password?token=…`) and are dead in an email
// client. mailBaseUrl comes from APP_BASE_URL (bridged to NUXT_MAIL_BASE_URL by
// scripts/entrypoint.sh in production).
export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()
  if (config.resendApiKey && !config.mailBaseUrl) {
    // eslint-disable-next-line no-console
    console.warn(
      '[mail] RESEND_API_KEY is set but APP_BASE_URL is empty — password-reset ' +
        'emails will contain relative (broken) links. Set APP_BASE_URL (e.g. https://app.lanka.live).'
    )
  }
})
