import { describe, it, expect, vi } from 'vitest'
import { LogMailer, ResendMailer } from '~/server/services/mailer'

describe('LogMailer', () => {
  it('logs the reset url and resolves', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await new LogMailer().sendPasswordReset('a@x', 'https://app/reset?token=t')
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('https://app/reset?token=t'))
    spy.mockRestore()
  })
})

describe('ResendMailer', () => {
  it('POSTs to the Resend API with the from/to/link', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await new ResendMailer('key_123', 'Lanka <no-reply@lanka.live>').sendPasswordReset(
      'a@x',
      'https://app/reset?token=t'
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe('Bearer key_123')
    const body = JSON.parse(init.body)
    expect(body.to).toBe('a@x')
    expect(body.from).toBe('Lanka <no-reply@lanka.live>')
    expect(body.text).toContain('https://app/reset?token=t')
    vi.unstubAllGlobals()
  })

  it('throws on a non-2xx Resend response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 422 })))
    await expect(
      new ResendMailer('k', 'f').sendPasswordReset('a@x', 'u')
    ).rejects.toThrow(/422/)
    vi.unstubAllGlobals()
  })
})
