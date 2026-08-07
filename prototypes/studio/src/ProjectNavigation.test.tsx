// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentWorkspaceProps } from './App'
// The explicit extension is required: `./ProjectNavigation` resolves to
// `projectNavigation.ts` on a case-insensitive filesystem.
import { ProjectNavigationProvider, ProjectRoutes } from './ProjectNavigation.tsx'

vi.mock('./App', () => ({
  default: ({
    pdfUrl,
    filename,
    markdownUrl,
    annotationSet,
    extractionSchema,
    persistedExtraction,
    onInitialResourceLoadFailure,
  }: DocumentWorkspaceProps) => (
    <>
      <p>
        Opened {filename} · {pdfUrl} · {String(markdownUrl)} ·{' '}
        {annotationSet?.annotations[0]?.text ?? 'no annotation'} ·{' '}
        {JSON.stringify(extractionSchema?.template ?? 'no schema')} ·{' '}
        {persistedExtraction?.outcome ?? 'no extraction'}
      </p>
      <button type="button" onClick={onInitialResourceLoadFailure}>
        Fail retained artifact
      </button>
    </>
  ),
}))

const projectContextId = '51000000-0000-4000-8000-000000000001'
const sourceDocumentId = '51000000-0000-4000-8001-000000000001'
const otherSourceDocumentId = '51000000-0000-4000-8001-000000000002'
const representationId = '51000000-0000-4000-8002-000000000001'
const project = {
  projectContextId,
  name: 'Ellekilde, TAK 1355',
  createdAt: '2026-07-31T12:00:00.000Z',
}
const beretning = {
  sourceDocumentId,
  name: 'Beretning.pdf',
  createdAt: '2026-07-31T12:01:00.000Z',
}
const historical = {
  sourceDocumentId: otherSourceDocumentId,
  name: 'Historical.pdf',
  createdAt: '2026-07-31T12:02:00.000Z',
}
const detail = { projectContext: project, sourceDocuments: [beretning] }

const documentPath = (documentId = sourceDocumentId) =>
  `/projects/${projectContextId}/documents/${documentId}`

function snapshot(sourceDocument = beretning) {
  return {
    projectContext: project,
    sourceDocument,
    sourceRepresentation: {
      sourceRepresentationId: representationId,
      revisionNumber: 2,
      resources: {
        sourcePdfUrl: `/api/source-representations/${representationId}/pdf`,
        markdownUrl: `/api/source-representations/${representationId}/markdown`,
        parsedDocumentUrl: `/api/source-representations/${representationId}/source`,
      },
    },
    annotationSet: null,
    extractionSchema: null,
    extraction: null,
  }
}

function hydratedSnapshot() {
  return {
    ...snapshot(),
    annotationSet: {
      annotationSetId: '51000000-0000-4000-8003-000000000001',
      revisionNumber: 1,
      annotations: [
        {
          annotationId: '51000000-0000-4000-8004-000000000001',
          evidenceAnchorId: 'anchor-1',
          text: 'The restored annotation',
          pageNumber: 1,
        },
      ],
    },
    extractionSchema: {
      extractionSchemaId: '51000000-0000-4000-8005-000000000001',
      schemaRevisionId: '51000000-0000-4000-8005-000000000002',
      revisionNumber: 1,
      template: { place: 'string' },
    },
    extraction: {
      extractionId: '51000000-0000-4000-8006-000000000001',
      createdAt: '2026-07-31T12:03:00.000Z',
      outcome: 'succeeded',
      result: { place: 'Ellekilde' },
      reviewDecisions: [],
    },
  }
}

const failureResponse = (
  code: string,
  message: string,
  status: number,
): Response => Response.json({ error: { code, message } }, { status })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

/** Serves the rail list, the routed branch, and the reopen read. */
function studioFetch(
  reopen: (documentId: string) => Response | Promise<Response> = (documentId) =>
    Response.json(
      snapshot(documentId === sourceDocumentId ? beretning : historical),
    ),
  branch: unknown = detail,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const reopened = /source-documents\/([^/]+)\/reopen$/.exec(url)
    if (reopened) return reopen(reopened[1])
    if (url.endsWith(projectContextId)) return Response.json(branch)
    return Response.json({ projectContexts: [project] })
  })
}

function renderRoutes(fetch: ReturnType<typeof vi.fn> = studioFetch()) {
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
    expect(await screen.findByText(/Opened Beretning.pdf/)).toBeInTheDocument()
    expect(location.pathname).toBe(documentPath())
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
        failureResponse(
          'persistence_unavailable',
          'Project Context storage is unavailable.',
          503,
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

describe('routed Source Document reopening', () => {
  it('reopens the routed Source Document from its durable snapshot on refresh', async () => {
    history.replaceState(null, '', documentPath())
    renderRoutes()

    expect(
      await screen.findByText(/Opened Beretning.pdf.*\/pdf.*\/markdown/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Beretning.pdf' }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('threads durable research state into the workspace', async () => {
    history.replaceState(null, '', documentPath())
    renderRoutes(studioFetch(() => Response.json(hydratedSnapshot())))

    expect(
      await screen.findByText(/The restored annotation.*place.*succeeded/),
    ).toBeInTheDocument()
  })

  it('retries after the workspace reports a retained artifact failure', async () => {
    history.replaceState(null, '', documentPath())
    renderRoutes()

    await screen.findByText(/Opened Beretning.pdf/)
    fireEvent.click(screen.getByRole('button', { name: 'Fail retained artifact' }))

    expect(
      await screen.findByRole('heading', {
        name: 'That Source Document could not be opened',
      }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/Opened Beretning.pdf/)).toBeInTheDocument()
  })

  it('keeps the open Source Document beneath a dimmed overlay while the next one opens', async () => {
    history.replaceState(null, '', documentPath())
    const pending = Promise.withResolvers<Response>()
    let reads = 0
    renderRoutes(
      studioFetch(
        (documentId) => {
          reads += 1
          return documentId === sourceDocumentId
            ? Response.json(snapshot(beretning))
            : pending.promise
        },
        { projectContext: project, sourceDocuments: [beretning, historical] },
      ),
    )
    await screen.findByText(/Opened Beretning.pdf/)
    expect(document.title).toBe('FREE Studio — Beretning.pdf')

    fireEvent.click(screen.getByRole('button', { name: 'Historical.pdf' }))

    const overlay = await screen.findByText('Opening Source Document…')
    expect(overlay).toBeInTheDocument()
    expect(screen.getByText(/Opened Beretning.pdf/)).toBeInTheDocument()
    expect(overlay.closest('[aria-busy="true"]')).toHaveClass('absolute')
    // Selection belongs to the Source Document that is open, not the requested one.
    expect(
      screen.getByRole('button', { name: 'Beretning.pdf' }),
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('button', { name: 'Historical.pdf' }),
    ).not.toHaveAttribute('aria-current')

    pending.resolve(Response.json(snapshot(historical)))
    expect(await screen.findByText(/Opened Historical.pdf/)).toBeInTheDocument()
    expect(document.title).toBe('FREE Studio — Historical.pdf')
    expect(screen.queryByText('Opening Source Document…')).not.toBeInTheDocument()
    expect(reads).toBe(2)
  })

  it('explains a Source Document the routed Project Context does not contain', async () => {
    history.replaceState(null, '', documentPath(otherSourceDocumentId))
    const fetch = renderRoutes(
      studioFetch(() => {
        throw new Error('A Source Document outside the branch must not be read.')
      }),
    )

    expect(
      await screen.findByRole('heading', {
        name: 'That Source Document is not in this Project Context',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Opened /)).not.toBeInTheDocument()
    expect(document.title).toBe('FREE Studio')
    // The rail list and the one branch read; containment costs no reopen read.
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('waits for a failed rail branch to succeed before reopening', async () => {
    history.replaceState(null, '', documentPath())
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ projectContexts: [project] }))
      .mockResolvedValueOnce(
        failureResponse(
          'persistence_unavailable',
          'Project Context storage is unavailable.',
          503,
        ),
      )
      .mockResolvedValueOnce(Response.json(detail))
      .mockResolvedValueOnce(Response.json(snapshot()))
    renderRoutes(fetch)

    expect(
      await screen.findByRole('heading', {
        name: 'Could not load this Project Context',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Opened /)).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText(/Opened Beretning.pdf/)).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('explains a missing durable snapshot for a contained Source Document', async () => {
    history.replaceState(null, '', documentPath())
    renderRoutes(
      studioFetch(() =>
        failureResponse(
          'not_found',
          'That Source Document has no durable snapshot in this Project Context.',
          404,
        ),
      ),
    )

    expect(
      await screen.findByRole('heading', {
        name: 'That Source Document cannot be reopened',
      }),
    ).toBeInTheDocument()
  })

  it('offers a retry when the retained artifact is unavailable', async () => {
    history.replaceState(null, '', documentPath())
    const responses = [
      failureResponse(
        'source_artifact_unavailable',
        'The retained Source Document artifact is unavailable.',
        503,
      ),
      Response.json(snapshot(beretning)),
    ]
    renderRoutes(studioFetch(() => responses.shift()!))

    expect(
      await screen.findByRole('heading', {
        name: 'That Source Document could not be opened',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('The retained Source Document artifact is unavailable.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText(/Opened Beretning.pdf/)).toBeInTheDocument()
  })

  it('never reads a malformed Source Document reference', async () => {
    history.replaceState(null, '', documentPath('NOT-A-UUID'))
    const fetch = renderRoutes()

    expect(
      await screen.findByRole('heading', {
        name: 'That Project Context reference is invalid',
      }),
    ).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
