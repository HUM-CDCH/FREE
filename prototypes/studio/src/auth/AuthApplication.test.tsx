// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AuthApplication from './AuthApplication.tsx'
import type { ProjectNavigationLoader } from './AuthApplication.tsx'
import { SessionControls } from './AuthForms.tsx'
import { authenticatedFetch } from './authenticatedFetch.ts'
import {
  clearSessionRecovery,
  markSessionSignedOut,
} from './sessionRecovery.ts'

const account = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Researcher Example',
}
const anonymousSession = { authenticated: false as const }
const usableSession = {
  authenticated: true as const,
  account,
  expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
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
    ProjectRoutes: () => (
      <>
        <p>Project application</p>
        <SessionControls />
      </>
    ),
  }))
}

afterEach(() => {
  cleanup()
  clearSessionRecovery()
  document.querySelector('base')?.remove()
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  history.replaceState(null, '', '/')
})

describe('AuthApplication', () => {
  it('keeps project navigation unloaded while session resolution is pending', () => {
    mockFetch(() => new Promise<Response>(() => {}))
    const loadNavigation = projectLoader()

    render(<AuthApplication loadNavigation={loadNavigation} />)

    expect(screen.getByRole('status')).toHaveTextContent('Resolving session…')
    expect(loadNavigation).not.toHaveBeenCalled()
  })

  it('loads protected UI from the bounded Entra session view', async () => {
    mockFetch(() => jsonResponse(usableSession))
    render(<AuthApplication loadNavigation={projectLoader()} />)

    expect(await screen.findByText('Project application')).toBeInTheDocument()
    expect(screen.getByText(account.displayName)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Researcher Account' }))
    const form = screen.getByRole('button', { name: 'Sign out' }).closest('form')
    expect(form).toHaveAttribute('action', '/auth/logout')
    expect(form).toHaveAttribute('method', 'post')
  })

  it('navigates anonymous protected pages to Entra with the exact local deep link', async () => {
    history.replaceState(
      null,
      '',
      '/projects/22222222-2222-4222-8222-222222222222?view=review#value',
    )
    mockFetch(() => jsonResponse(anonymousSession))
    const navigate = vi.fn()
    render(
      <AuthApplication loadNavigation={projectLoader()} navigate={navigate} />,
    )

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        '/auth/login?returnTo=%2Fprojects%2F22222222-2222-4222-8222-222222222222%3Fview%3Dreview%23value&fragmentCaptured=1',
      ),
    )
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Project application')).not.toBeInTheDocument()
  })

  it('keeps Back on the signed-out landing after explicit logout', async () => {
    history.replaceState(null, '', '/projects')
    markSessionSignedOut()
    mockFetch(() => jsonResponse(anonymousSession))
    const navigate = vi.fn()
    const replace = vi.fn()
    render(
      <AuthApplication
        loadNavigation={projectLoader()}
        navigate={navigate}
        replace={replace}
      />,
    )

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/auth/signed-out'),
    )
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.queryByText('Project application')).not.toBeInTheDocument()
  })

  it('deduplicates concurrent protected-request 401 redirects', async () => {
    history.replaceState(
      null,
      '',
      '/projects/22222222-2222-4222-8222-222222222222?view=review#value',
    )
    mockFetch((url) =>
      url === '/api/auth/session'
        ? jsonResponse(usableSession)
        : jsonResponse({ error: { code: 'authentication_required' } }, 401),
    )
    const navigate = vi.fn()
    render(
      <AuthApplication loadNavigation={projectLoader()} navigate={navigate} />,
    )
    expect(await screen.findByText('Project application')).toBeInTheDocument()

    await act(async () => {
      await Promise.all([
        authenticatedFetch('/api/first'),
        authenticatedFetch('/api/second'),
      ])
    })

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith(
      '/auth/login?returnTo=%2Fprojects%2F22222222-2222-4222-8222-222222222222%3Fview%3Dreview%23value&fragmentCaptured=1',
    )
    expect(screen.queryByText('Project application')).not.toBeInTheDocument()
  })

  it('renders the public signed-out landing without starting a new sign-in', async () => {
    history.replaceState(null, '', '/auth/signed-out')
    sessionStorage.setItem('free.auth.recovery.v1', 'stale')
    mockFetch(() => jsonResponse(anonymousSession))
    const navigate = vi.fn()
    render(
      <AuthApplication loadNavigation={projectLoader()} navigate={navigate} />,
    )

    expect(
      await screen.findByRole('heading', { name: 'You have signed out' }),
    ).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  })

  it('warns five minutes before expiry and continues through Entra', async () => {
    history.replaceState(null, '', '/projects')
    mockFetch(() =>
      jsonResponse({
        ...usableSession,
        expiresAt: new Date(Date.now() + 4 * 60 * 1_000).toISOString(),
      }),
    )
    const navigate = vi.fn()
    render(
      <AuthApplication loadNavigation={projectLoader()} navigate={navigate} />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your session expires soon.',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue session' }),
    )
    expect(navigate).toHaveBeenCalledWith(
      '/auth/login?returnTo=%2Fprojects&fragmentCaptured=1',
    )
  })

  it('reauthenticates when the session expires', async () => {
    vi.useFakeTimers()
    history.replaceState(null, '', '/projects')
    mockFetch(() =>
      jsonResponse({
        ...usableSession,
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    )
    const navigate = vi.fn()
    render(
      <AuthApplication loadNavigation={projectLoader()} navigate={navigate} />,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => vi.advanceTimersByTime(1_000))

    expect(navigate).toHaveBeenCalledWith(
      '/auth/login?returnTo=%2Fprojects&fragmentCaptured=1',
    )
    expect(screen.queryByText('Project application')).not.toBeInTheDocument()
  })

  it('revalidates a page restored from cache before showing protected UI', async () => {
    let requests = 0
    mockFetch(() => jsonResponse(requests++ === 0 ? usableSession : anonymousSession))
    const navigate = vi.fn()
    const replace = vi.fn()
    render(
      <AuthApplication
        loadNavigation={projectLoader()}
        navigate={navigate}
        replace={replace}
      />,
    )
    expect(await screen.findByText('Project application')).toBeInTheDocument()

    const restored = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(restored, 'persisted', { value: true })
    act(() => dispatchEvent(restored))

    expect(screen.queryByText('Project application')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/auth/signed-out'),
    )
    expect(navigate).not.toHaveBeenCalled()
  })

  it('retries session resolution and lazy workspace loading independently', async () => {
    let sessionAttempt = 0
    mockFetch(() => {
      sessionAttempt += 1
      if (sessionAttempt === 1) throw new Error('unavailable')
      return jsonResponse(usableSession)
    })
    let loadAttempt = 0
    const loadNavigation: ProjectNavigationLoader = vi.fn(async () => {
      loadAttempt += 1
      if (loadAttempt === 1) throw new Error('chunk unavailable')
      return {
        ProjectNavigationProvider: ({ children }: { children: ReactNode }) => (
          <>{children}</>
        ),
        ProjectRoutes: () => <p>Project application</p>,
      }
    })
    render(<AuthApplication loadNavigation={loadNavigation} navigate={vi.fn()} />)

    expect(
      await screen.findByRole('heading', { name: 'Session unavailable' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(
      await screen.findByRole('heading', { name: 'Workspace unavailable' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Project application')).toBeInTheDocument()
  })
})
