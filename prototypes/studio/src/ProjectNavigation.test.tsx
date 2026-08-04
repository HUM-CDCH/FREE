// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectNavigationProvider, ProjectRoutes } from './ProjectNavigation'

vi.mock('./App', () => ({
  default: ({ filename }: { filename: string }) => <p>Opened {filename}</p>,
}))

const projectContextId = '51000000-0000-4000-8000-000000000001'
const project = {
  projectContextId,
  name: 'Ellekilde, TAK 1355',
  createdAt: '2026-07-31T12:00:00.000Z',
}
const detail = {
  projectContext: project,
  sourceDocuments: [
    {
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      name: 'Beretning.pdf',
      createdAt: '2026-07-31T12:01:00.000Z',
    },
  ],
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

function renderRoutes(fetch = vi.fn(async (input: RequestInfo | URL) =>
  Response.json(String(input).endsWith(projectContextId) ? detail : { projectContexts: [project] }),
)) {
  vi.stubGlobal('fetch', fetch)
  render(
    <ProjectNavigationProvider>
      <ProjectRoutes />
    </ProjectNavigationProvider>,
  )
  return fetch
}

describe('Project Context navigation', () => {
  it('keeps the persistent rail while navigating to a lazily loaded Project Context', async () => {
    const fetch = renderRoutes()

    expect(
      await screen.findByRole('heading', { name: 'No Project Context open' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: project.name }))

    expect(await screen.findByText('Beretning.pdf')).toBeInTheDocument()
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
    expect(
      screen.getByRole('heading', { name: 'No Source Document open' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ New project' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '+ Add sources' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Row actions' })).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Beretning.pdf' }))
    expect(await screen.findByText('Opened Beretning.pdf')).toBeInTheDocument()
    expect(location.pathname).toBe(
      `/projects/${projectContextId}/documents/${detail.sourceDocuments[0].sourceDocumentId}`,
    )
  })

  it('lets keyboard users resize the Project Context rail', async () => {
    renderRoutes()
    await screen.findByRole('heading', { name: 'No Project Context open' })
    const separator = screen.getByRole('separator', {
      name: 'Resize Project Context rail',
    })

    expect(separator).toHaveAttribute('aria-valuenow', '212')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator).toHaveAttribute('aria-valuenow', '222')
  })

  it('ignores a Project Context list read abandoned by the StrictMode remount', async () => {
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

  it('caches a loaded branch across collapse and re-expansion', async () => {
    const fetch = renderRoutes()
    const row = await screen.findByRole('button', { name: project.name })

    fireEvent.click(row)
    await screen.findByText('Beretning.pdf')
    fireEvent.click(row)
    expect(screen.queryByText('Beretning.pdf')).not.toBeInTheDocument()
    fireEvent.click(row)
    expect(await screen.findByText('Beretning.pdf')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries only the failed branch', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ projectContexts: [project] }))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: 'persistence_unavailable',
              message: 'Project Context storage is unavailable.',
            },
          },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json(detail))
    renderRoutes(fetch)

    fireEvent.click(await screen.findByRole('button', { name: project.name }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Beretning.pdf')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps branch loading and empty states inside the expanded Project Context', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ projectContexts: [project] }))
      .mockReturnValueOnce(pending.promise)
    renderRoutes(fetch)

    fireEvent.click(await screen.findByRole('button', { name: project.name }))
    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    pending.resolve(
      Response.json({ ...detail, sourceDocuments: [] }),
    )
    expect(await screen.findByText('Empty Project Context.')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'No Source Document open' }),
    ).toBeInTheDocument()
  })

  it('renders a bad reference without requesting its malformed id', async () => {
    history.replaceState(null, '', '/projects/NOT-A-UUID')
    const fetch = renderRoutes()

    expect(
      await screen.findByRole('heading', {
        name: 'That Project Context reference is invalid',
      }),
    ).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      '/api/project-contexts',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('updates from the back/forward listener without pushing another history entry', async () => {
    renderRoutes()
    await screen.findByRole('heading', { name: 'No Project Context open' })

    history.pushState(null, '', `/projects/${projectContextId}`)
    dispatchEvent(new PopStateEvent('popstate'))

    expect(await screen.findByText('Beretning.pdf')).toBeInTheDocument()
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
  })
})
