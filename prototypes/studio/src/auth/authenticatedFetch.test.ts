// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { STUDIO_BOOT_HEADER } from '../../shared/studioBoot.ts'
import {
  authenticatedFetch,
  resetModelKeyResendForTesting,
  subscribeToAuthenticationRequired,
  subscribeToModelKeyResend,
} from './authenticatedFetch.ts'

afterEach(() => {
  resetModelKeyResendForTesting()
  document.querySelector('base')?.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('authenticatedFetch', () => {
  it('forces same-origin credentials while preserving the caller request', async () => {
    const response = new Response(null, { status: 204 })
    const request = vi.fn(async () => response)
    vi.stubGlobal('fetch', request)

    await expect(
      authenticatedFetch('/api/project-contexts', {
        method: 'POST',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      }),
    ).resolves.toBe(response)
    expect(request).toHaveBeenCalledWith('/api/project-contexts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
  })

  it('publishes a protected-session transition before returning a 401', async () => {
    const response = Response.json(
      {
        error: {
          code: 'authentication_required',
          message: 'Authentication is required.',
        },
      },
      { status: 401 },
    )
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const transition = vi.fn()
    const unsubscribe = subscribeToAuthenticationRequired(transition)

    await expect(authenticatedFetch('/api/extractions')).resolves.toBe(response)
    expect(transition).toHaveBeenCalledTimes(1)

    unsubscribe()
    await authenticatedFetch('/api/extractions')
    expect(transition).toHaveBeenCalledTimes(1)
  })

  it('targets the configured Studio base path', async () => {
    const base = document.createElement('base')
    base.href = '/free/'
    document.head.prepend(base)
    const request = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', request)

    await authenticatedFetch('/api/project-contexts')

    expect(request).toHaveBeenCalledWith('/free/api/project-contexts', {
      credentials: 'same-origin',
    })
  })
})

describe('authenticatedFetch model key resend', () => {
  const booted = (boot: string, init: ResponseInit = {}) =>
    new Response(null, { ...init, headers: { [STUDIO_BOOT_HEADER]: boot } })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('the first boot ID seen requests no resend', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => booted('boot-1')))
    const resend = vi.fn()
    subscribeToModelKeyResend(resend)

    await authenticatedFetch('/api/model-config')
    await authenticatedFetch('/api/model-config')

    expect(resend).not.toHaveBeenCalled()
  })

  it("a new boot ID requests exactly one resend, recorded before the resend's own response arrives", async () => {
    const boots = ['boot-1', 'boot-2', 'boot-2']
    vi.stubGlobal('fetch', vi.fn(async () => booted(boots.shift()!)))
    const responses: Promise<Response>[] = []
    // The resend's own request goes out from inside the notification, as the page's handoff does.
    const resend = vi.fn(() => {
      responses.push(authenticatedFetch('/api/model-keys', { method: 'PUT' }))
    })
    const unsubscribe = subscribeToModelKeyResend(resend)

    await authenticatedFetch('/api/model-config')
    await authenticatedFetch('/api/model-config')
    await Promise.all(responses)

    expect(resend).toHaveBeenCalledOnce()
    unsubscribe()
    vi.stubGlobal('fetch', vi.fn(async () => booted('boot-3')))
    await authenticatedFetch('/api/model-config')
    expect(resend).toHaveBeenCalledOnce()
  })

  it('a 409 model_key_required response requests a resend; other 409s do not', async () => {
    const conflict = (code: string) =>
      Response.json({ error: { code, message: 'Conflict.' } }, { status: 409 })
    const resend = vi.fn()
    subscribeToModelKeyResend(resend)

    vi.stubGlobal('fetch', vi.fn(async () => conflict('invalid_model_config')))
    await authenticatedFetch('/api/chat', { method: 'POST' })
    await flush()
    expect(resend).not.toHaveBeenCalled()

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 409 })))
    await authenticatedFetch('/api/chat', { method: 'POST' })
    await flush()
    expect(resend).not.toHaveBeenCalled()

    vi.stubGlobal('fetch', vi.fn(async () => conflict('model_key_required')))
    await authenticatedFetch('/api/chat', { method: 'POST' })
    await flush()
    expect(resend).toHaveBeenCalledOnce()
  })

  it('the response body stays readable by the caller after the 409 inspection', async () => {
    const body = { error: { code: 'model_key_required', message: 'Studio does not hold the key.' } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 409 })))

    const response = await authenticatedFetch('/api/chat', { method: 'POST' })
    await flush()

    expect(response.bodyUsed).toBe(false)
    await expect(response.json()).resolves.toEqual(body)
  })

  it('a throwing resend listener fails neither the request nor the other listeners', async () => {
    const boots = ['boot-1', 'boot-2']
    const response = () => booted(boots.shift()!)
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    subscribeToModelKeyResend(() => {
      throw new Error('listener failed')
    })
    const resend = vi.fn()
    subscribeToModelKeyResend(resend)

    await authenticatedFetch('/api/model-config')
    await expect(authenticatedFetch('/api/model-config')).resolves.toBeInstanceOf(Response)

    expect(resend).toHaveBeenCalledOnce()
  })
})

