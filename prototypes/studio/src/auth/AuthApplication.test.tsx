// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AuthApplication from './AuthApplication.tsx'
import type { ProjectNavigationLoader } from './AuthApplication.tsx'
import { authenticatedFetch } from './authenticatedFetch.ts'

const account = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'researcher@example.org',
}
const anonymousSession = { authenticated: false as const }
const usableSession = {
  authenticated: true as const,
  account: { ...account, mustChangePassword: false },
}
const temporarySession = {
  authenticated: true as const,
  account: { ...account, mustChangePassword: true },
}

type FetchHandler = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch(handler: FetchHandler) {
  const request = vi.fn(
    (input: string | URL | Request, init: RequestInit = {}) =>
      Promise.resolve(handler(String(input), init)),
  )
  vi.stubGlobal('fetch', request)
  return request
}

function projectLoader(): ProjectNavigationLoader {
  return vi.fn(async () => ({
    ProjectNavigationProvider: ({ children }: { children: ReactNode }) => (
      <section data-testid="project-navigation-provider">{children}</section>
    ),
    ProjectRoutes: () => <p>Project application</p>,
  }))
}

async function submitLogin(
  email = 'researcher@example.org',
  password = 'temporary-password',
) {
  await screen.findByRole('heading', { name: 'Sign in to FREE Studio' })
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: email },
  })
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: password },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

afterEach(() => {
  cleanup()
  document.querySelector('base')?.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  history.replaceState(null, '', '/')
})

describe('AuthApplication', () => {
  it('keeps project navigation unloaded while session resolution is pending', () => {
    mockFetch(() => new Promise<Response>(() => {}))
    const loadNavigation = projectLoader()

    render(<AuthApplication loadNavigation={loadNavigation} />)

    expect(screen.getByRole('status')).toHaveTextContent('Resolving session…')
    expect(loadNavigation).not.toHaveBeenCalled()
    expect(
      screen.queryByTestId('project-navigation-provider'),
    ).not.toBeInTheDocument()
  })

  it('returns a successful normal login to a validated local deep link', async () => {
    const returnTo =
      '/projects/22222222-2222-4222-8222-222222222222/schemas?revision=latest'
    history.replaceState(
      null,
      '',
      `/login?${new URLSearchParams({ returnTo })}`,
    )
    const request = mockFetch((url, init) => {
      if (url === '/api/auth/session') return jsonResponse(anonymousSession)
      if (url === '/api/auth/login') {
        expect(init.method).toBe('POST')
        expect(init.credentials).toBe('same-origin')
        expect(JSON.parse(String(init.body))).toEqual({
          email: 'researcher@example.org',
          password: 'temporary-password',
        })
        return jsonResponse(usableSession)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const loadNavigation = projectLoader()
    render(<AuthApplication loadNavigation={loadNavigation} />)

    await submitLogin()

    expect(await screen.findByText('Project application')).toBeInTheDocument()
    expect(`${location.pathname}${location.search}`).toBe(returnTo)
    expect(loadNavigation).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps authentication and return navigation beneath the Studio base path', async () => {
    const base = document.createElement('base')
    base.href = '/free/'
    document.head.prepend(base)
    const returnTo =
      '/projects/22222222-2222-4222-8222-222222222222/schemas?revision=latest'
    history.replaceState(
      null,
      '',
      `/free/login?${new URLSearchParams({ returnTo })}`,
    )
    const request = mockFetch((url) => {
      if (url === '/free/api/auth/session') return jsonResponse(anonymousSession)
      if (url === '/free/api/auth/login') return jsonResponse(usableSession)
      throw new Error(`Unexpected request: ${url}`)
    })

    render(<AuthApplication loadNavigation={projectLoader()} />)
    await submitLogin()

    expect(await screen.findByText('Project application')).toBeInTheDocument()
    expect(`${location.pathname}${location.search}`).toBe(`/free${returnTo}`)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['absolute external URL', 'https://attacker.example/projects/stolen'],
    ['scheme-relative external URL', '//attacker.example/projects/stolen'],
  ])('rejects an %s return target', async (_label, returnTo) => {
    history.replaceState(
      null,
      '',
      `/login?${new URLSearchParams({ returnTo })}`,
    )
    mockFetch((url) => {
      if (url === '/api/auth/session') return jsonResponse(anonymousSession)
      if (url === '/api/auth/login') return jsonResponse(usableSession)
      throw new Error(`Unexpected request: ${url}`)
    })
    const loadNavigation = projectLoader()
    render(<AuthApplication loadNavigation={loadNavigation} />)

    await submitLogin()

    expect(await screen.findByText('Project application')).toBeInTheDocument()
    expect(location.pathname).toBe('/projects')
    expect(location.origin).not.toBe('https://attacker.example')
  })

  it('renders the generic login failure without loading project navigation', async () => {
    mockFetch((url) => {
      if (url === '/api/auth/session') return jsonResponse(anonymousSession)
      if (url === '/api/auth/login')
        return jsonResponse(
          {
            error: {
              code: 'invalid_credentials',
              message: 'Email or password is incorrect.',
            },
          },
          401,
        )
      throw new Error(`Unexpected request: ${url}`)
    })
    const loadNavigation = projectLoader()
    render(<AuthApplication loadNavigation={loadNavigation} />)

    await submitLogin('unknown@example.org', 'incorrect-password')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Email or password is incorrect.',
    )
    expect(loadNavigation).not.toHaveBeenCalled()
  })

  it('renders a retryable unavailable login failure without loading project navigation', async () => {
    mockFetch((url) => {
      if (url === '/api/auth/session') return jsonResponse(anonymousSession)
      if (url === '/api/auth/login')
        return jsonResponse(
          {
            error: {
              code: 'authentication_unavailable',
              message: 'connection refused: pg://secret@database.internal/free',
            },
          },
          503,
        )
      throw new Error(`Unexpected request: ${url}`)
    })
    const loadNavigation = projectLoader()
    render(<AuthApplication loadNavigation={loadNavigation} />)

    await submitLogin()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Sign in is unavailable. Try again.')
    expect(alert).not.toHaveTextContent('database.internal')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
    expect(loadNavigation).not.toHaveBeenCalled()
  })

  it('gates a temporary account to password change and logout only', async () => {
    const request = mockFetch((url) => {
      if (url === '/api/auth/session') return jsonResponse(anonymousSession)
      if (url === '/api/auth/login') return jsonResponse(temporarySession)
      throw new Error(`Unexpected request: ${url}`)
    })
    const loadNavigation = projectLoader()
    render(<AuthApplication loadNavigation={loadNavigation} />)

    await submitLogin()

    expect(
      await screen.findByRole('heading', {
        name: 'Choose a permanent password',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('researcher@example.org')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Current temporary password'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Sign in to FREE Studio' }),
    ).not.toBeInTheDocument()
    expect(loadNavigation).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps mismatched passwords repairable without sending a request', async () => {
    const request = mockFetch((url) => {
      if (url === '/api/auth/session') return jsonResponse(anonymousSession)
      if (url === '/api/auth/login') return jsonResponse(temporarySession)
      throw new Error(`Unexpected request: ${url}`)
    })
    render(<AuthApplication loadNavigation={projectLoader()} />)

    await submitLogin()
    await screen.findByRole('heading', { name: 'Choose a permanent password' })
    const password = screen.getByLabelText('New password')
    const confirmation = screen.getByLabelText('Confirm new password')
    fireEvent.change(password, {
      target: { value: 'a permanent password 🔐' },
    })
    fireEvent.change(confirmation, {
      target: { value: 'a different password 🔐' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    const error = screen.getByRole('alert')
    expect(error).toHaveTextContent(
      'The new password confirmation does not match.',
    )
    expect(password).toHaveValue('a permanent password 🔐')
    expect(confirmation).toHaveValue('a different password 🔐')
    expect(confirmation).toHaveFocus()
    expect(confirmation).toHaveAttribute('aria-invalid', 'true')
    expect(confirmation).toHaveAccessibleDescription(error.textContent ?? '')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('enforces the same 6-to-128 Unicode-scalar password boundary as the server', async () => {
    const request = mockFetch((url, init) => {
      if (url === '/api/auth/session') return jsonResponse(anonymousSession)
      if (url === '/api/auth/login') return jsonResponse(temporarySession)
      if (url === '/api/auth/password') {
        expect(JSON.parse(String(init.body))).toEqual({
          currentPassword: 'temporary-password',
          newPassword: '🔐abcde',
        })
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    render(<AuthApplication loadNavigation={projectLoader()} />)

    await submitLogin()
    await screen.findByRole('heading', { name: 'Choose a permanent password' })
    const password = screen.getByLabelText('New password')
    const confirmation = screen.getByLabelText('Confirm new password')
    const tooLong = '🔐'.repeat(129)
    fireEvent.change(password, { target: { value: tooLong } })
    fireEvent.change(confirmation, { target: { value: tooLong } })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Password must contain between 6 and 128 Unicode characters.',
    )
    expect(password).toHaveFocus()
    expect(request).toHaveBeenCalledTimes(2)

    fireEvent.change(password, { target: { value: '🔐abcde' } })
    fireEvent.change(confirmation, { target: { value: '🔐abcde' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(
      await screen.findByRole('heading', { name: 'Sign in to FREE Studio' }),
    ).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it.each([
    {
      label: 'server validation',
      status: 400,
      code: 'invalid_password',
      message: 'Password must contain between 6 and 128 Unicode characters.',
      field: 'New password',
    },
    {
      label: 'wrong temporary authority',
      status: 401,
      code: 'invalid_credentials',
      message: 'Password change failed. Sign out and sign in again.',
      field: null,
    },
    {
      label: 'service outage',
      status: 503,
      code: 'authentication_unavailable',
      message: 'Password change is unavailable. Try again.',
      field: null,
    },
  ])(
    'keeps password values and recovery controls after $label failure',
    async ({ status, code, message, field }) => {
      const request = mockFetch((url) => {
        if (url === '/api/auth/session') return jsonResponse(anonymousSession)
        if (url === '/api/auth/login') return jsonResponse(temporarySession)
        if (url === '/api/auth/password')
          return jsonResponse(
            { error: { code, message: 'unsafe internal authentication detail' } },
            status,
          )
        throw new Error(`Unexpected request: ${url}`)
      })
      render(<AuthApplication loadNavigation={projectLoader()} />)

      await submitLogin()
      await screen.findByRole('heading', { name: 'Choose a permanent password' })
      const password = screen.getByLabelText('New password')
      const confirmation = screen.getByLabelText('Confirm new password')
      fireEvent.change(password, { target: { value: 'a permanent password 🔐' } })
      fireEvent.change(confirmation, {
        target: { value: 'a permanent password 🔐' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(message)
      expect(alert).not.toHaveTextContent('unsafe internal')
      expect(password).toHaveValue('a permanent password 🔐')
      expect(confirmation).toHaveValue('a permanent password 🔐')
      expect(screen.getByRole('button', { name: 'Change password' })).toBeEnabled()
      if (field) expect(screen.getByLabelText(field)).toHaveAttribute('aria-invalid', 'true')
      expect(request).toHaveBeenCalledTimes(3)
    },
  )

  it('sends a temporary session resolved without a typed password back to login', async () => {
    const request = mockFetch((url) => {
      if (url === '/api/auth/session') return jsonResponse(temporarySession)
      throw new Error(`Unexpected request: ${url}`)
    })
    const loadNavigation = projectLoader()
    render(<AuthApplication loadNavigation={loadNavigation} />)

    expect(
      await screen.findByRole('heading', { name: 'Sign in to FREE Studio' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sign in again to choose a permanent password.',
    )
    expect(loadNavigation).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('changes a temporary password and requires a new normal login', async () => {
    history.replaceState(null, '', '/change-password')
    const request = mockFetch((url, init) => {
      if (url === '/api/auth/session') return jsonResponse(anonymousSession)
      if (url === '/api/auth/login') return jsonResponse(temporarySession)
      if (url === '/api/auth/password') {
        expect(init.method).toBe('POST')
        expect(init.credentials).toBe('same-origin')
        expect(JSON.parse(String(init.body))).toEqual({
          currentPassword: 'temporary-password',
          newPassword: 'a permanent password 🔐',
        })
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const loadNavigation = projectLoader()
    render(<AuthApplication loadNavigation={loadNavigation} />)

    await submitLogin()

    await screen.findByRole('heading', { name: 'Choose a permanent password' })
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'a permanent password 🔐' },
    })
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'a permanent password 🔐' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(
      await screen.findByRole('heading', { name: 'Sign in to FREE Studio' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Password changed. Sign in with your new password.',
    )
    expect(location.pathname).toBe('/login')
    expect(loadNavigation).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('returns to login when password change discovers revoked authority', async () => {
    mockFetch((url) => {
      if (url === '/api/auth/session') return jsonResponse(anonymousSession)
      if (url === '/api/auth/login') return jsonResponse(temporarySession)
      if (url === '/api/auth/password')
        return jsonResponse(
          {
            error: {
              code: 'authentication_required',
              message: 'Authentication is required.',
            },
          },
          401,
        )
      throw new Error(`Unexpected request: ${url}`)
    })
    render(<AuthApplication loadNavigation={projectLoader()} />)

    await submitLogin()

    await screen.findByRole('heading', { name: 'Choose a permanent password' })
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'a permanent password 🔐' },
    })
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'a permanent password 🔐' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(
      await screen.findByRole('heading', { name: 'Sign in to FREE Studio' }),
    ).toBeInTheDocument()
  })

  it('unmounts all project state once when later protected requests return 401', async () => {
    const deepLink =
      '/projects/44444444-4444-4444-8444-444444444444/documents/55555555-5555-4555-8555-555555555555'
    history.replaceState(null, '', deepLink)
    const nextSession = {
      authenticated: true as const,
      account: {
        id: '66666666-6666-4666-8666-666666666666',
        email: 'next-researcher@example.org',
        mustChangePassword: false,
      },
    }
    const request = mockFetch((url, init) => {
      if (url === '/api/auth/session') return jsonResponse(usableSession)
      if (url === '/api/auth/login') return jsonResponse(nextSession)
      if (
        url === '/api/project-contexts/stale' ||
        url === '/api/batch-extractions/stale'
      ) {
        expect(init.credentials).toBe('same-origin')
        return jsonResponse(
          {
            error: {
              code: 'authentication_required',
              message: 'Authentication is required.',
            },
          },
          401,
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const loadNavigation = projectLoader()
    render(<AuthApplication loadNavigation={loadNavigation} />)
    expect(await screen.findByText('Project application')).toBeInTheDocument()

    await act(async () => {
      await Promise.all([
        authenticatedFetch('/api/project-contexts/stale'),
        authenticatedFetch('/api/batch-extractions/stale'),
      ])
    })

    expect(
      await screen.findByRole('heading', { name: 'Sign in to FREE Studio' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your session expired. Sign in again.',
    )
    expect(screen.queryByText('Project application')).not.toBeInTheDocument()
    expect(`${location.pathname}${location.search}`).toBe(deepLink)

    await submitLogin()

    expect(await screen.findByText('Project application')).toBeInTheDocument()
    expect(screen.getByText('next-researcher@example.org')).toBeInTheDocument()
    expect(loadNavigation).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('unmounts project navigation and returns to login after logout', async () => {
    const deepLink =
      '/projects/33333333-3333-4333-8333-333333333333/extractions'
    history.replaceState(null, '', deepLink)
    const request = mockFetch((url, init) => {
      if (url === '/api/auth/session') return jsonResponse(usableSession)
      if (url === '/api/auth/logout') {
        expect(init.method).toBe('POST')
        expect(init.credentials).toBe('same-origin')
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const loadNavigation = projectLoader()
    render(<AuthApplication loadNavigation={loadNavigation} />)

    expect(await screen.findByText('Project application')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(
      await screen.findByRole('heading', { name: 'Sign in to FREE Studio' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Project application')).not.toBeInTheDocument()
    expect(`${location.pathname}${location.search}`).toBe(deepLink)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('unmounts protected UI when logout discovers an expired session', async () => {
    mockFetch((url) => {
      if (url === '/api/auth/session') return jsonResponse(usableSession)
      if (url === '/api/auth/logout')
        return jsonResponse(
          {
            error: {
              code: 'authentication_required',
              message: 'Authentication is required.',
            },
          },
          401,
        )
      throw new Error(`Unexpected request: ${url}`)
    })
    render(<AuthApplication loadNavigation={projectLoader()} />)

    expect(await screen.findByText('Project application')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(
      await screen.findByRole('heading', { name: 'Sign in to FREE Studio' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Project application')).not.toBeInTheDocument()
  })

  it('keeps protected UI mounted and logout retryable after a non-401 failure', async () => {
    let logoutAttempts = 0
    const request = mockFetch((url) => {
      if (url === '/api/auth/session') return jsonResponse(usableSession)
      if (url === '/api/auth/logout') {
        logoutAttempts += 1
        return logoutAttempts === 1
          ? jsonResponse(
              {
                error: {
                  code: 'authentication_unavailable',
                  message: 'unsafe database connection detail',
                },
              },
              503,
            )
          : new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    render(<AuthApplication loadNavigation={projectLoader()} />)

    expect(await screen.findByText('Project application')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not sign out. Try again.')
    expect(alert).not.toHaveTextContent('database connection')
    expect(screen.getByText('Project application')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Sign out' })
    expect(retry).toBeEnabled()

    fireEvent.click(retry)
    expect(
      await screen.findByRole('heading', { name: 'Sign in to FREE Studio' }),
    ).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('separately retries a failed lazy project-module load', async () => {
    mockFetch((url) => {
      if (url === '/api/auth/session') return jsonResponse(usableSession)
      throw new Error(`Unexpected request: ${url}`)
    })
    const module = await projectLoader()()
    const loadNavigation = vi
      .fn<ProjectNavigationLoader>()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce(module)
    render(<AuthApplication loadNavigation={loadNavigation} />)

    expect(
      await screen.findByRole('heading', { name: 'Workspace unavailable' }),
    ).toBeInTheDocument()
    expect(screen.getByText('researcher@example.org')).toBeInTheDocument()
    expect(loadNavigation).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Project application')).toBeInTheDocument()
    expect(loadNavigation).toHaveBeenCalledTimes(2)
  })
})
