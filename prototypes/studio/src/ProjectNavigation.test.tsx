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
import type { DocumentWorkspaceProps } from './App'
// The explicit extension is required: `./ProjectNavigation` resolves to
// `projectNavigation.ts` on a case-insensitive filesystem.
import {
  ProjectNavigationProvider,
  ProjectRoutes,
} from './ProjectNavigation.tsx'

vi.mock('./App', () => ({
  default: ({
    pdfUrl,
    filename,
    markdownUrl,
    parsedDocumentUrl,
    sourceRepresentationId,
    annotationSet,
    extractionSchema,
    persistedExtraction,
    onInitialResourceLoadFailure,
  }: DocumentWorkspaceProps) => (
    <>
      <p>
        Opened {filename} · {pdfUrl} · {String(markdownUrl)} ·{' '}
        {annotationSet?.annotations[0]?.text ?? 'no annotation'} ·{' '}
        {JSON.stringify(extractionSchema?.schemaNodes ?? 'no schema')} ·{' '}
        {persistedExtraction?.outcome ?? 'no extraction'}
      </p>
      <p data-testid="workspace-resources">
        {sourceRepresentationId} · {pdfUrl} · {markdownUrl} ·{' '}
        {parsedDocumentUrl}
      </p>
      <p data-testid="workspace-schema">
        {JSON.stringify(extractionSchema?.schemaNodes ?? null)}
      </p>
      <p data-testid="workspace-result">
        {JSON.stringify(persistedExtraction?.resultPayload ?? null)}
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
const secondSourceDocumentId = '51000000-0000-4000-8001-000000000003'
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
const secondDocument = {
  sourceDocumentId: secondSourceDocumentId,
  name: 'Second Context.pdf',
  createdAt: '2026-07-31T12:03:00.000Z',
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
    latestAttempt: null,
    latestReviewed: null,
  }
}

function secondSnapshot() {
  return {
    ...snapshot(secondDocument),
    projectContext: secondProject,
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
      recordDescription: 'One place record.',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    },
    latestAttempt: {
      extractionId: '51000000-0000-4000-8006-000000000001',
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
      schemaRevisionId: '51000000-0000-4000-8005-000000000002',
      createdAt: '2026-07-31T12:03:00.000Z',
      reviewedAt: null,
      strategy: 'ARTICLE',
      outcome: 'SUCCEEDED',
      complete: true,
      diagnostics: {
        phase: 'grounding',
        durationMs: 1,
        modelCalls: 0,
        finishReason: null,
        inputTokens: null,
        outputTokens: null,
        values: null,
        grounding: null,
      },
      failure: null,
      resultPayload: { place: 'Ellekilde' },
      evidenceLinks: [],
      modelAttribution: { provider: 'ollama', modelId: 'fixture' },
      reviewable: true,
      retryOfId: null,
      reviewDecisions: [],
      sourceRepresentation: {
        revisionNumber: 2,
        resources: {
          sourcePdfUrl: '/api/source-representations/rep/pdf',
          markdownUrl: '/api/source-representations/rep/markdown',
          parsedDocumentUrl: '/api/source-representations/rep/source',
        },
      },
      extractionSchema: {
        extractionSchemaId: '51000000-0000-4000-8005-000000000001',
        revisionNumber: 1,
        recordDescription: 'One place record.',
        schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
      },
    },
    latestReviewed: null,
  }
}

// This jsdom build implements `<dialog>` and its `open` state but neither
// modality method. The shim only opens and closes; React's own `autoFocus`
// still moves focus, and real modality is the browser's.
const dialogs = HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal: () => void
  close: () => void
}
dialogs.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true
}
dialogs.close ??= function close(this: HTMLDialogElement) {
  this.open = false
  this.dispatchEvent(new Event('close'))
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

const secondProject = {
  projectContextId: '51000000-0000-4000-8000-000000000002',
  name: 'Fæstningen, TAK 1400',
  createdAt: '2026-08-11T09:00:00.000Z',
}

/**
 * The rail list, the routed branches, and the three Project Context writes —
 * every write answers the shipped contract so the rail applies only what the
 * server acknowledged.
 */
function lifecycleFetch(
  options: {
    projects?: unknown[]
    list?: () => Response | Promise<Response>
    branch?: () => Response | Promise<Response>
    post?: () => Response | Promise<Response>
    patch?: () => Response | Promise<Response>
    remove?: () => Response | Promise<Response>
  } = {},
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    switch (init?.method) {
      case 'POST':
        return (
          options.post?.() ??
          Response.json({ projectContext: secondProject }, { status: 201 })
        )
      case 'PATCH':
        return (
          options.patch?.() ??
          Response.json({
            projectContext: { ...project, name: 'Ellekilde II' },
          })
        )
      case 'DELETE':
        return options.remove?.() ?? new Response(null, { status: 204 })
    }
    if (url.endsWith(secondProject.projectContextId))
      return Response.json({
        projectContext: secondProject,
        sourceDocuments: [],
      })
    if (url.endsWith(projectContextId))
      return options.branch?.() ?? Response.json(detail)
    return (
      options.list?.() ??
      Response.json({ projectContexts: options.projects ?? [project] })
    )
  })
}

describe('Project Context lifecycle in the rail', () => {
  it('navigates to and expands an acknowledged new Project Context', async () => {
    renderRoutes(lifecycleFetch())
    fireEvent.click(
      await screen.findByRole('button', { name: '+ New project' }),
    )

    const name = screen.getByRole('textbox', {
      name: 'New Project Context name',
    })
    // The field never narrows the contract: padding around a limit-length name
    // still submits, because the name is trimmed before it is judged.
    fireEvent.change(name, { target: { value: `  ${'x'.repeat(512)}  ` } })
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
    fireEvent.change(name, { target: { value: `  ${'x'.repeat(513)}  ` } })
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()

    fireEvent.change(name, { target: { value: '  Fæstningen, TAK 1400  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(
      await screen.findByText('Empty Project Context.'),
    ).toBeInTheDocument()
    expect(location.pathname).toBe(
      `/projects/${secondProject.projectContextId}`,
    )
    expect(
      screen.getByRole('button', { name: secondProject.name }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('keeps the native creation dialog pending on failure and restores focus after acknowledgement', async () => {
    const pending = Promise.withResolvers<Response>()
    let attempts = 0
    const renderFetch = lifecycleFetch({
      post: () => {
        attempts += 1
        return attempts === 1
          ? pending.promise
          : Response.json({ projectContext: secondProject }, { status: 201 })
      },
    })
    renderRoutes(renderFetch)

    const trigger = await screen.findByRole('button', { name: '+ New project' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', {
      name: 'New Project Context',
    })
    const name = screen.getByRole('textbox', {
      name: 'New Project Context name',
    })
    expect(name).toHaveFocus()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()

    fireEvent.change(name, { target: { value: secondProject.name } })
    expect(name).toHaveAttribute('aria-invalid', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(dialog).toBeInTheDocument()

    pending.resolve(
      failureResponse(
        'persistence_unavailable',
        'Project Context storage is unavailable.',
        503,
      ),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project Context storage is unavailable.',
    )
    expect(
      screen.getByRole('textbox', { name: 'New Project Context name' }),
    ).toHaveValue(secondProject.name)
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(
      await screen.findByText('Empty Project Context.'),
    ).toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(location.pathname).toBe(
      `/projects/${secondProject.projectContextId}`,
    )
  })

  it('retains the rename form on a failed write and applies the acknowledged one', async () => {
    let attempts = 0
    renderRoutes(
      lifecycleFetch({
        patch: () => {
          attempts += 1
          return attempts === 1
            ? failureResponse(
                'persistence_unavailable',
                'Project Context storage is unavailable.',
                503,
              )
            : Response.json({
                projectContext: { ...project, name: 'Ellekilde II' },
              })
        },
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: `Rename ${project.name}` }),
    )
    const name = screen.getByRole('textbox', { name: 'Project Context name' })
    fireEvent.change(name, { target: { value: 'Ellekilde II' } })

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project Context storage is unavailable.',
    )
    expect(name).toHaveValue('Ellekilde II')
    expect(
      screen.queryByRole('button', { name: 'Ellekilde II' }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    expect(
      await screen.findByRole('button', { name: 'Ellekilde II' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('textbox', { name: 'Project Context name' }),
    ).not.toBeInTheDocument()
  })

  it('deletes the open Project Context only once confirmed, and leaves /projects open', async () => {
    renderRoutes(lifecycleFetch())
    fireEvent.click(await screen.findByRole('button', { name: project.name }))
    await screen.findByText('Beretning.pdf')

    fireEvent.click(
      screen.getByRole('button', { name: `Delete ${project.name}` }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete Project Context',
    })
    // Native modality: focus moves into the dialog, so the rail behind it is
    // out of reach until the researcher answers.
    expect(dialog).toContainElement(
      document.activeElement as HTMLElement | null,
    )
    // Confirmation is required: the rail is untouched until it is given.
    expect(
      screen.getByRole('button', { name: project.name }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    expect(
      await screen.findByRole('heading', { name: 'No Project Context open' }),
    ).toBeInTheDocument()
    expect(location.pathname).toBe('/projects')
    expect(
      screen.queryByRole('button', { name: project.name }),
    ).not.toBeInTheDocument()
  })

  it('keeps the confirmation and its retry while a deletion is in flight and fails', async () => {
    const pending = Promise.withResolvers<Response>()
    renderRoutes(lifecycleFetch({ remove: () => pending.promise as never }))
    fireEvent.click(
      await screen.findByRole('button', { name: `Delete ${project.name}` }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete permanently' }),
    )

    // Escape dispatches `cancel`; a write already sent must survive it.
    const dialog = screen.getByRole('dialog', {
      name: 'Delete Project Context',
    })
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(dialog).toBeInTheDocument()

    pending.resolve(
      failureResponse(
        'persistence_unavailable',
        'Project Context storage is unavailable.',
        503,
      ),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project Context storage is unavailable.',
    )
    expect(
      screen.getByRole('button', { name: project.name }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Delete permanently' }),
    ).toBeEnabled()

    // Once nothing is in flight, the same dismissal is honoured.
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
  })

  it('never lets a read that a write superseded revert the rail', async () => {
    const list = Promise.withResolvers<Response>()
    const branch = Promise.withResolvers<Response>()
    history.replaceState(null, '', `/projects/${projectContextId}`)
    renderRoutes(
      lifecycleFetch({
        list: () => list.promise,
        branch: () => branch.promise,
      }),
    )
    // The routed branch resolves first, so the rail knows this Project Context
    // before its list read finishes.
    branch.resolve(Response.json(detail))
    fireEvent.click(
      await screen.findByRole('button', { name: `Rename ${project.name}` }),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Project Context name' }),
      { target: { value: 'Ellekilde II' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await screen.findByRole('button', { name: 'Ellekilde II' })

    // This list read started before the rename and still carries the old name.
    list.resolve(Response.json({ projectContexts: [project] }))

    await waitFor(() =>
      expect(
        screen.queryByText('Loading Project Contexts…'),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole('button', { name: 'Ellekilde II' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: project.name }),
    ).not.toBeInTheDocument()
  })

  it('re-reads a superseded initial list without hiding existing Project Contexts', async () => {
    const initial = Promise.withResolvers<Response>()
    let reads = 0
    renderRoutes(
      lifecycleFetch({
        list: () => {
          reads += 1
          return reads === 1
            ? initial.promise
            : Response.json({ projectContexts: [secondProject, project] })
        },
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: '+ New project' }),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: 'New Project Context name' }),
      { target: { value: secondProject.name } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByRole('button', { name: secondProject.name })

    initial.resolve(Response.json({ projectContexts: [project] }))

    expect(
      await screen.findByRole('button', { name: project.name }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: secondProject.name }),
    ).toBeInTheDocument()
    expect(reads).toBe(2)
  })

  it('never lets a branch read resurrect a deleted Project Context', async () => {
    const branch = Promise.withResolvers<Response>()
    renderRoutes(lifecycleFetch({ branch: () => branch.promise }))
    fireEvent.click(await screen.findByRole('button', { name: project.name }))
    await screen.findByText('Loading…')

    fireEvent.click(
      screen.getByRole('button', { name: `Delete ${project.name}` }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete permanently' }),
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: project.name }),
      ).not.toBeInTheDocument(),
    )

    // The branch read started before the deletion; its Project Context is gone.
    branch.resolve(Response.json(detail))

    await waitFor(() =>
      expect(screen.getByText('No Project Contexts yet.')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('button', { name: project.name }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Beretning.pdf')).not.toBeInTheDocument()
  })

  it('moves focus to the stable rail toggle after a successful delete', async () => {
    renderRoutes(lifecycleFetch())
    fireEvent.click(
      await screen.findByRole('button', { name: `Delete ${project.name}` }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete permanently' }),
    )

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: project.name }),
      ).not.toBeInTheDocument(),
    )
    // The deleted row's controls are gone, so a stable rail control takes
    // focus instead of dropping it on <body>.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Collapse Project Contexts' }),
      ).toHaveFocus(),
    )
  })

  it('keeps the open route when another Project Context is deleted', async () => {
    renderRoutes(lifecycleFetch({ projects: [project, secondProject] }))
    fireEvent.click(await screen.findByRole('button', { name: project.name }))
    await screen.findByText('Beretning.pdf')

    fireEvent.click(
      screen.getByRole('button', { name: `Delete ${secondProject.name}` }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: secondProject.name }),
      ).not.toBeInTheDocument(),
    )
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
    expect(screen.getByText('Beretning.pdf')).toBeInTheDocument()
  })
})

describe('Project Context navigation', () => {
  it('keeps the persistent rail while navigating to a lazily loaded Project Context', async () => {
    const fetch = renderRoutes()

    expect(
      await screen.findByRole('heading', { name: 'No Project Context open' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: project.name }))

    expect(await screen.findByText('Beretning.pdf')).toBeInTheDocument()
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
    // The rail owns ordinary selection; the shell only supplies overrides for
    // dev documents and in-flight document openings.
    expect(screen.getByRole('button', { name: project.name })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      screen.getByRole('heading', { name: 'No Source Document open' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add sources' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Row actions' })).toHaveLength(
      1,
    )
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

  it('resolves a routed branch under a StrictMode remount', async () => {
    // The dev build (and Playwright's server) double-mounts; the routed branch
    // read must survive it and settle into the workspace, never hang loading.
    history.replaceState(null, '', `/projects/${projectContextId}`)
    vi.stubGlobal('fetch', studioFetch())
    render(
      <StrictMode>
        <ProjectNavigationProvider>
          <ProjectRoutes />
        </ProjectNavigationProvider>
      </StrictMode>,
    )

    expect(await screen.findByText('Beretning.pdf')).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'No Source Document open' }),
    ).toBeInTheDocument()
  })

  it('re-reads an errored branch on re-expansion', async () => {
    let branchReads = 0
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith(projectContextId)) {
        branchReads += 1
        return branchReads === 1
          ? failureResponse(
              'persistence_unavailable',
              'Project Context storage is unavailable.',
              503,
            )
          : Response.json(detail)
      }
      return Response.json({ projectContexts: [project] })
    })
    renderRoutes(fetch)
    const row = await screen.findByRole('button', { name: project.name })

    fireEvent.click(row)
    await screen.findByText('Could not read Source Documents.')

    // Collapsing and re-expanding retries the failed read; only ready and
    // loading branches are cached.
    fireEvent.click(row)
    fireEvent.click(row)
    expect(await screen.findByText('Beretning.pdf')).toBeInTheDocument()
    expect(branchReads).toBe(2)
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
    pending.resolve(Response.json({ ...detail, sourceDocuments: [] }))
    expect(
      await screen.findByText('Empty Project Context.'),
    ).toBeInTheDocument()
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
      await screen.findByText(/The restored annotation.*place.*SUCCEEDED/),
    ).toBeInTheDocument()
  })

  it('keeps the workspace on the current head while displaying a historical latest attempt', async () => {
    const reopened = hydratedSnapshot()
    const historicalRepresentationId = '51000000-0000-4000-8002-000000000009'
    reopened.latestAttempt = {
      ...reopened.latestAttempt,
      sourceRepresentationRevisionId: historicalRepresentationId,
      schemaRevisionId: '51000000-0000-4000-8005-000000000009',
      resultPayload: { place: 'Historical persisted result' },
      sourceRepresentation: {
        revisionNumber: 1,
        resources: {
          sourcePdfUrl: `/api/source-representations/${historicalRepresentationId}/pdf`,
          markdownUrl: `/api/source-representations/${historicalRepresentationId}/markdown`,
          parsedDocumentUrl: `/api/source-representations/${historicalRepresentationId}/source`,
        },
      },
      extractionSchema: {
        ...reopened.latestAttempt.extractionSchema,
        revisionNumber: 1,
        schemaNodes: [
          { id: 'historical', name: 'historical_place', type: 'string' },
        ],
      },
    }
    history.replaceState(null, '', documentPath())
    renderRoutes(studioFetch(() => Response.json(reopened)))

    const resources = await screen.findByTestId('workspace-resources')
    expect(resources).toHaveTextContent(representationId)
    expect(resources).not.toHaveTextContent(historicalRepresentationId)
    expect(screen.getByTestId('workspace-schema')).toHaveTextContent('place')
    expect(screen.getByTestId('workspace-schema')).not.toHaveTextContent(
      'historical_place',
    )
    expect(screen.getByTestId('workspace-result')).toHaveTextContent(
      'Historical persisted result',
    )
  })

  it('retries after the workspace reports a retained artifact failure', async () => {
    history.replaceState(null, '', documentPath())
    renderRoutes()

    await screen.findByText(/Opened Beretning.pdf/)
    fireEvent.click(
      screen.getByRole('button', { name: 'Fail retained artifact' }),
    )

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
    expect(
      screen.queryByText('Opening Source Document…'),
    ).not.toBeInTheDocument()
    expect(reads).toBe(2)
  })

  it('keeps the open selection paired to its Project Context during a cross-context opening', async () => {
    history.replaceState(null, '', '/projects')
    const pending = Promise.withResolvers<Response>()
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const reopened = /source-documents\/([^/]+)\/reopen$/.exec(url)
      if (reopened) {
        return reopened[1] === secondSourceDocumentId
          ? pending.promise
          : Response.json(snapshot(beretning))
      }
      if (url.endsWith(secondProject.projectContextId))
        return Response.json({
          projectContext: secondProject,
          sourceDocuments: [secondDocument],
        })
      if (url.endsWith(projectContextId)) return Response.json(detail)
      return Response.json({ projectContexts: [project, secondProject] })
    })
    renderRoutes(fetch)

    fireEvent.click(await screen.findByRole('button', { name: project.name }))
    fireEvent.click(await screen.findByRole('button', { name: beretning.name }))
    await screen.findByText(/Opened Beretning.pdf/)
    history.pushState(
      null,
      '',
      `/projects/${secondProject.projectContextId}/documents/${secondSourceDocumentId}`,
    )
    dispatchEvent(new PopStateEvent('popstate'))
    await screen.findByRole('button', { name: secondDocument.name })

    expect(
      await screen.findByText('Opening Source Document…'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: project.name })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      screen.getByRole('button', { name: secondProject.name }),
    ).not.toHaveAttribute('aria-current')
    expect(
      screen.getByRole('button', { name: beretning.name }),
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('button', { name: secondDocument.name }),
    ).not.toHaveAttribute('aria-current')

    pending.resolve(Response.json(secondSnapshot()))
    expect(
      await screen.findByText(/Opened Second Context.pdf/),
    ).toBeInTheDocument()
  })

  it('explains a Source Document the routed Project Context does not contain', async () => {
    history.replaceState(null, '', documentPath(otherSourceDocumentId))
    const fetch = renderRoutes(
      studioFetch(() => {
        throw new Error(
          'A Source Document outside the branch must not be read.',
        )
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
    let branchReads = 0
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (/reopen$/.test(url)) return Response.json(snapshot())
      if (url.endsWith(projectContextId)) {
        branchReads += 1
        return branchReads === 1
          ? failureResponse(
              'persistence_unavailable',
              'Project Context storage is unavailable.',
              503,
            )
          : Response.json(detail)
      }
      return Response.json({ projectContexts: [project] })
    })
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
