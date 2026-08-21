// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authenticatedFetch,
  subscribeToAuthenticationRequired,
} from './authenticatedFetch.ts'

afterEach(() => {
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
