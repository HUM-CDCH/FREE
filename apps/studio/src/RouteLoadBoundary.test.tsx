// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RouteLoadBoundary from './RouteLoadBoundary.tsx'
import { subscribeToAuthenticationRequired } from './auth/authenticatedFetch.ts'

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

function Failing(): never {
  throw new Error('Failed to fetch dynamically imported module')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RouteLoadBoundary', () => {
  it('renders its route while the module loads', () => {
    render(
      <RouteLoadBoundary
        resource="The Source Document workspace"
        readSession={async () => usableSession}
      >
        <p>Source Document workspace</p>
      </RouteLoadBoundary>,
    )

    expect(screen.getByText('Source Document workspace')).toBeInTheDocument()
  })

  it('offers a reload instead of unmounting the workspace', async () => {
    // React reports the failed import by rendering the error again in
    // development, so the thrown message reaches the console twice.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const reload = vi.fn()
    render(
      <RouteLoadBoundary
        resource="The Source Document workspace"
        readSession={async () => usableSession}
        reload={reload}
      >
        <Failing />
      </RouteLoadBoundary>,
    )

    expect(
      screen.getByText('The Source Document workspace could not be loaded'),
    ).toBeInTheDocument()
    screen.getByRole('button', { name: 'Reload' }).click()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('sends a Researcher whose session ended back to sign-in', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const authenticationRequired = vi.fn()
    const unsubscribe = subscribeToAuthenticationRequired(
      authenticationRequired,
    )

    render(
      <RouteLoadBoundary
        resource="The Project Context page"
        readSession={async () => anonymousSession}
        reload={vi.fn()}
      >
        <Failing />
      </RouteLoadBoundary>,
    )

    await waitFor(() => expect(authenticationRequired).toHaveBeenCalledOnce())
    unsubscribe()
  })

  it('keeps a signed-in Researcher on the failure surface', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const authenticationRequired = vi.fn()
    const unsubscribe = subscribeToAuthenticationRequired(
      authenticationRequired,
    )

    render(
      <RouteLoadBoundary
        resource="The Project Context page"
        readSession={async () => usableSession}
        reload={vi.fn()}
      >
        <Failing />
      </RouteLoadBoundary>,
    )

    await waitFor(() =>
      expect(
        screen.getByText('The Project Context page could not be loaded'),
      ).toBeInTheDocument(),
    )
    expect(authenticationRequired).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('does not retain a failed Source Document boundary after navigating to Project Context', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(
      <RouteLoadBoundary
        key="source-document-workspace"
        resource="The Source Document workspace"
        readSession={async () => usableSession}
      >
        <Failing />
      </RouteLoadBoundary>,
    )
    expect(
      screen.getByText('The Source Document workspace could not be loaded'),
    ).toBeInTheDocument()

    rerender(
      <RouteLoadBoundary
        key="project-context-page"
        resource="The Project Context page"
        readSession={async () => usableSession}
      >
        <p>Project Context content</p>
      </RouteLoadBoundary>,
    )

    expect(screen.getByText('Project Context content')).toBeInTheDocument()
    expect(
      screen.queryByText('The Source Document workspace could not be loaded'),
    ).not.toBeInTheDocument()
  })
})
