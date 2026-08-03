// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectNavigationProvider, ProjectRoutes } from './ProjectNavigation'

const projectContextId = '00000000-0000-4000-8000-000000000044'
const project = {
  projectContextId,
  name: 'Ellekilde, TAK 1355',
  createdAt: '2026-07-31T12:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

describe('Project Context navigation', () => {
  it('lists projects, pushes the selected route, and renders its chooser', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        return Response.json(
          url.endsWith(projectContextId)
            ? {
                projectContext: project,
                sourceDocuments: [
                  {
                    sourceDocumentId: '00000000-0000-4000-8000-000000000045',
                    name: 'Beretning.pdf',
                    createdAt: '2026-07-31T12:01:00.000Z',
                  },
                ],
              }
            : { projectContexts: [project] },
        )
      }),
    )

    render(
      <ProjectNavigationProvider>
        <ProjectRoutes />
      </ProjectNavigationProvider>,
    )
    expect(
      await screen.findByRole('link', { name: 'Open Studio workspace' }),
    ).toHaveAttribute('href', '/studio')
    fireEvent.click(await screen.findByRole('button', { name: project.name }))
    await screen.findByText('Beretning.pdf')
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
  })

  it('ignores the read abandoned by the StrictMode remount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
            setTimeout(
              () => resolve(Response.json({ projectContexts: [project] })),
              0,
            )
          }),
      ),
    )

    render(
      <StrictMode>
        <ProjectNavigationProvider>
          <ProjectRoutes />
        </ProjectNavigationProvider>
      </StrictMode>,
    )
    expect(
      await screen.findByRole('button', { name: project.name }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Project Context storage is unavailable.'),
    ).not.toBeInTheDocument()
  })

  it('keeps recent projects available beside a recoverable route failure', async () => {
    history.replaceState(null, '', `/projects/${projectContextId}`)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        return url.endsWith(projectContextId)
          ? Response.json(
              {
                error: {
                  code: 'not_found',
                  message: 'Project Context was not found.',
                },
              },
              { status: 404 },
            )
          : Response.json({ projectContexts: [project] })
      }),
    )

    render(
      <ProjectNavigationProvider>
        <ProjectRoutes />
      </ProjectNavigationProvider>,
    )
    await screen.findByText('Project Context was not found.')
    expect(
      screen.getByRole('button', { name: project.name }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: project.name }))
    await waitFor(() =>
      expect(location.pathname).toBe(`/projects/${projectContextId}`),
    )
  })
})
