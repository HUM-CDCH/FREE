// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
    extractionSchema,
    persistedExtraction,
    onInitialResourceLoadFailure,
  }: DocumentWorkspaceProps) => (
    <>
      <p>
        {/* DocumentWorkspace no longer reads annotationSet — the Annotation
            tab was retired in favor of SchemaPanel's own doc chat. Left in
            place, commented out, rather than deleted.
            {annotationSet?.annotations[0]?.text ?? 'no annotation'} ·{' '} */}
        Opened {filename} · {pdfUrl} · {String(markdownUrl)} ·{' '}
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
const detail = {
  projectContext: project,
  sourceDocuments: [{ ...beretning, pageCount: 6 }],
}

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
      name: 'Places',
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
      batchExtractionId: null,
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
  schemas: () => Response | Promise<Response> = () =>
    Response.json({ extractionSchemas: [] }),
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const reopened = /source-documents\/([^/]+)\/reopen$/.exec(url)
    if (reopened) return reopen(reopened[1])
    if (url.startsWith('/api/extraction-schemas?')) return schemas()
    if (url.startsWith('/api/batch-extractions?'))
      return Response.json({ batchExtractions: [] })
    if (url.startsWith('/api/batch-schema-suggestions?'))
      return Response.json({ batchSchemaSuggestions: [] })
    if (url.endsWith(projectContextId)) return Response.json(branch)
    return Response.json({ projectContexts: [project] })
  })
}

/** Browser Back: the URL changes and `popstate` is what the app hears. */
function back(pathname: string) {
  history.pushState(null, '', pathname)
  dispatchEvent(new PopStateEvent('popstate'))
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

/**
 * The rail lists Source Documents for navigation and the Project Context page
 * lists the same ones as cards, so every name-based query says which it means.
 */
const rail = () => within(screen.getByRole('navigation', { name: 'Project Contexts' }))
/**
 * A Project Context's rail row. The chevron and the name are one control that
 * only discloses Source Documents, so the row's accessible name is that
 * disclosure's, never the bare Project Context name.
 */
const railRow = (name = project.name) =>
  new RegExp(`Source Documents in ${name}$`)
/** The disclosure beside a project name; it never navigates. */
const disclosure = (name = project.name) =>
  screen.getByRole('button', { name: railRow(name) })
/**
 * Opens the routed Project Context page and waits for it. The rail row itself
 * only discloses Source Documents, so opening the page is the row menu's own
 * action.
 */
async function openProjectPage(name = project.name) {
  const actions = await screen.findByRole('button', {
    name: `Actions for ${name}`,
  })
  fireEvent.click(actions)
  // Every listed Project Context owns a menu, so the action must be taken from
  // this row's own one.
  const menu = actions.closest('details') as HTMLElement
  fireEvent.click(within(menu).getByRole('button', { name: 'Open project' }))
  const page = await screen.findByRole('region', { name: 'Project Context' })
  await within(page).findByRole('heading', { name })
  return page
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
      name: 'Project name',
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
      screen.getByRole('button', { name: railRow(secondProject.name) }),
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
      name: 'New Project',
    })
    const name = screen.getByRole('textbox', {
      name: 'Project name',
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
      screen.getByRole('textbox', { name: 'Project name' }),
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
    const page = await openProjectPage()
    fireEvent.click(within(page).getByRole('button', { name: 'Rename' }))
    const name = screen.getByRole('textbox', { name: 'Project Context name' })
    fireEvent.change(name, { target: { value: 'Ellekilde II' } })

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project Context storage is unavailable.',
    )
    expect(name).toHaveValue('Ellekilde II')
    expect(
      screen.queryByRole('button', { name: railRow('Ellekilde II') }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    expect(
      await screen.findByRole('button', { name: railRow('Ellekilde II') }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('textbox', { name: 'Project Context name' }),
    ).not.toBeInTheDocument()
  })

  it('deletes the open Project Context only once confirmed, and leaves /projects open', async () => {
    renderRoutes(lifecycleFetch())
    const page = await openProjectPage()
    await rail().findByText('Beretning.pdf')

    fireEvent.click(
      within(page).getByRole('button', { name: 'Delete Project Context' }),
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
      screen.getByRole('button', { name: railRow() }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    expect(
      await screen.findByRole('heading', { name: 'No project open' }),
    ).toBeInTheDocument()
    expect(location.pathname).toBe('/projects')
    expect(
      screen.queryByRole('button', { name: railRow() }),
    ).not.toBeInTheDocument()
  })

  it('keeps the confirmation and its retry while a deletion is in flight and fails', async () => {
    const pending = Promise.withResolvers<Response>()
    renderRoutes(lifecycleFetch({ remove: () => pending.promise as never }))
    const page = await openProjectPage()
    fireEvent.click(
      within(page).getByRole('button', { name: 'Delete Project Context' }),
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
      screen.getByRole('button', { name: railRow() }),
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
    // The route is already the Project Context page; renaming happens there.
    fireEvent.click(
      within(
        await screen.findByRole('region', { name: 'Project Context' }),
      ).getByRole('button', { name: 'Rename' }),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Project Context name' }),
      { target: { value: 'Ellekilde II' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await screen.findByRole('button', { name: railRow('Ellekilde II') })

    // This list read started before the rename and still carries the old name.
    list.resolve(Response.json({ projectContexts: [project] }))

    await waitFor(() =>
      expect(
        screen.queryByText('Loading Project Contexts…'),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole('button', { name: railRow('Ellekilde II') }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: railRow() }),
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
      screen.getByRole('textbox', { name: 'Project name' }),
      { target: { value: secondProject.name } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByRole('button', { name: railRow(secondProject.name) })

    initial.resolve(Response.json({ projectContexts: [project] }))

    expect(
      await screen.findByRole('button', { name: railRow() }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: railRow(secondProject.name) }),
    ).toBeInTheDocument()
    expect(reads).toBe(2)
  })

  it('never lets a branch read resurrect a deleted Project Context', async () => {
    const branch = Promise.withResolvers<Response>()
    renderRoutes(lifecycleFetch({ branch: () => branch.promise }))
    const page = await openProjectPage()
    await rail().findByText('Loading…')

    fireEvent.click(
      within(page).getByRole('button', { name: 'Delete Project Context' }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete permanently' }),
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: railRow() }),
      ).not.toBeInTheDocument(),
    )

    // The branch read started before the deletion; its Project Context is gone.
    branch.resolve(Response.json(detail))

    await waitFor(() =>
      expect(screen.getByText('No Project Contexts yet.')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('button', { name: railRow() }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Beretning.pdf')).not.toBeInTheDocument()
  })

  it('moves focus to the stable rail toggle after a successful delete', async () => {
    renderRoutes(lifecycleFetch())
    const page = await openProjectPage()
    fireEvent.click(
      within(page).getByRole('button', { name: 'Delete Project Context' }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete permanently' }),
    )

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: railRow() }),
      ).not.toBeInTheDocument(),
    )
    // The whole page is gone with its Project Context, so a stable rail
    // control takes focus instead of dropping it on <body>.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Collapse Project Contexts' }),
      ).toHaveFocus(),
    )
  })

  // Deletion is reachable only from the deleted Project Context's own page, so
  // the remaining ones must survive it untouched in the rail.
  it('leaves the other Project Contexts listed after deleting the open one', async () => {
    renderRoutes(lifecycleFetch({ projects: [project, secondProject] }))
    const page = await openProjectPage()
    await rail().findByText('Beretning.pdf')

    fireEvent.click(
      within(page).getByRole('button', { name: 'Delete Project Context' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: railRow() }),
      ).not.toBeInTheDocument(),
    )
    expect(location.pathname).toBe('/projects')
    expect(
      screen.getByRole('button', { name: railRow(secondProject.name) }),
    ).toBeInTheDocument()
    expect(rail().queryByText('Beretning.pdf')).not.toBeInTheDocument()
  })
})

describe('Project Context navigation', () => {
  it('keeps the persistent rail while navigating to a lazily loaded Project Context', async () => {
    const fetch = renderRoutes()

    expect(
      await screen.findByRole('heading', { name: 'No project open' }),
    ).toBeInTheDocument()
    const page = await openProjectPage()

    expect(await rail().findByText('Beretning.pdf')).toBeInTheDocument()
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
    // The rail owns ordinary selection; the shell only overrides it while a
    // document opening is in flight.
    expect(screen.getByRole('button', { name: railRow() })).toHaveAttribute(
      'aria-current',
      'page',
    )
    // Managing the Project Context — its name and its sources — is the page's
    // job, so the rail lists nothing but persisted Source Documents.
    expect(
      within(page).getByRole('heading', { name: project.name }),
    ).toBeInTheDocument()
    expect(screen.getByText('Drop PDFs here or browse')).toBeInTheDocument()
    expect(screen.getByLabelText('Drop PDFs here or browse')).toHaveAttribute(
      'multiple',
    )
    expect(screen.queryByLabelText('Open a PDF (dev)')).not.toBeInTheDocument()
    // Exactly five: the row's disclosure, its add-sources and actions
    // controls, the one action that menu holds, and its one Source Document.
    expect(rail().getAllByRole('button')).toHaveLength(5)
    expect(fetch).toHaveBeenCalledTimes(2)

    fireEvent.click(rail().getByRole('button', { name: 'Beretning.pdf' }))
    expect(await screen.findByText(/Opened Beretning.pdf/)).toBeInTheDocument()
    expect(location.pathname).toBe(documentPath())
  })

  it('filters, sorts, and switches the Project Context resource tabs', async () => {
    renderRoutes(
      studioFetch(undefined, {
        ...detail,
        sourceDocuments: [
          { ...beretning, pageCount: 6 },
          { ...historical, pageCount: 4 },
        ],
      }),
    )

    const page = await openProjectPage()
    const sourceNames = () =>
      within(within(page).getByRole('list'))
        .getAllByRole('button')
        .filter((button) => !button.closest('details'))
        .map((button) => button.textContent)

    expect(within(page).getByRole('tab', { name: 'Sources' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(sourceNames()[0]).toContain('Historical.pdf')
    expect(within(page).queryByText('Sort')).not.toBeInTheDocument()

    const dropInput = within(page).getByLabelText('Drop PDFs here or browse')
    const dropTarget = dropInput.closest('label')!
    expect(dropTarget).toHaveClass('focus-within:ring-2')
    fireEvent.dragEnter(within(page).getByRole('tabpanel', { name: 'Sources' }))
    expect(dropTarget).not.toHaveClass('border-accent')
    fireEvent.dragEnter(dropTarget)
    expect(dropTarget).toHaveClass('border-accent')
    fireEvent.dragLeave(dropTarget, { relatedTarget: null })
    expect(dropTarget).not.toHaveClass('border-accent')

    fireEvent.change(within(page).getByLabelText('Sort sources'), {
      target: { value: 'oldest' },
    })
    expect(sourceNames()[0]).toContain('Beretning.pdf')

    fireEvent.change(within(page).getByLabelText('Filter sources'), {
      target: { value: 'historical' },
    })
    expect(sourceNames()).toHaveLength(1)
    expect(sourceNames()[0]).toContain('Historical.pdf')

    fireEvent.keyDown(within(page).getByRole('tab', { name: 'Sources' }), {
      key: 'ArrowLeft',
    })
    expect(within(page).getByRole('tab', { name: 'Schemas' })).toHaveFocus()
    expect(await within(page).findByText('No schemas yet.')).toBeInTheDocument()
    expect(
      within(page).getByRole('tabpanel', { name: 'Schemas' }),
    ).toHaveAttribute('tabindex', '0')
    expect(within(page).queryByLabelText('Filter sources')).not.toBeInTheDocument()
    // Arrow keys move the route, not just the rendered panel.
    expect(location.pathname).toBe(`/projects/${projectContextId}/schemas`)
  })

  it('deep-links, refreshes, and walks back through the Project resource tabs', async () => {
    history.replaceState(null, '', `/projects/${projectContextId}/schemas`)
    renderRoutes()

    // A deep link is the page's first render: the tab it names is the one that
    // reads its resource.
    const page = await screen.findByRole('region', { name: 'Project Context' })
    expect(within(page).getByRole('tab', { name: 'Schemas' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(await within(page).findByText('No schemas yet.')).toBeInTheDocument()
    expect(
      within(page).queryByLabelText('Filter sources'),
    ).not.toBeInTheDocument()

    fireEvent.click(within(page).getByRole('tab', { name: 'Sources' }))
    // Sources is the page's entry, so it keeps the bare Project Context path.
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
    expect(location.search).toBe('')
    expect(within(page).getByLabelText('Filter sources')).toBeInTheDocument()

    fireEvent.click(within(page).getByRole('tab', { name: 'Extractions' }))
    expect(location.pathname).toBe(`/projects/${projectContextId}/extractions`)
    expect(
      await within(page).findByText('No Batch Extractions yet.'),
    ).toBeInTheDocument()

    // Reselecting the open tab must not push an entry Back would have to undo.
    const entries = history.length
    fireEvent.click(within(page).getByRole('tab', { name: 'Extractions' }))
    expect(location.pathname).toBe(`/projects/${projectContextId}/extractions`)
    expect(history.length).toBe(entries)

    back(`/projects/${projectContextId}`)
    await within(page).findByRole('tab', { name: 'Sources', selected: true })

    back(`/projects/${projectContextId}/schemas`)
    await within(page).findByRole('tab', { name: 'Schemas', selected: true })
    expect(await within(page).findByText('No schemas yet.')).toBeInTheDocument()
  })

  it('opens the Sources tab for a Source Document list path', async () => {
    history.replaceState(null, '', `/projects/${projectContextId}/documents`)
    renderRoutes()

    const page = await screen.findByRole('region', { name: 'Project Context' })
    expect(within(page).getByRole('tab', { name: 'Sources' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // The alias is left as it was typed; nothing rewrites the researcher's URL.
    expect(location.pathname).toBe(`/projects/${projectContextId}/documents`)
  })

  it('routes the open Batch Extraction so it survives a refresh', async () => {
    const batchExtractionId = '51000000-0000-4000-8007-000000000001'
    const batchExtraction = {
      batchExtractionId,
      projectContextId,
      schemaRevisionId: '51000000-0000-4000-8004-000000000001',
      extractionSchemaId: '51000000-0000-4000-8003-000000000001',
      extractionSchemaName: 'Places',
      schemaRevisionNumber: 1,
      strategy: 'ARTICLE',
      createdAt: '2026-08-14T10:42:00.000Z',
      executionStatus: 'COMPLETED',
      executionFailureMessage: null,
      startedAt: '2026-08-14T10:42:00.000Z',
      finishedAt: '2026-08-14T10:43:00.000Z',
      members: [
        {
          sourceDocumentId,
          sourceRepresentationRevisionId:
            '51000000-0000-4000-8002-000000000001',
          executionStatus: 'COMPLETED',
          executionFailureMessage: null,
          startedAt: '2026-08-14T10:42:00.000Z',
          finishedAt: '2026-08-14T10:43:00.000Z',
          latestExtraction: null,
        },
      ],
    }
    const batchFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return Response.json({ batchExtractions: [batchExtraction] })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return Response.json({ batchSchemaSuggestions: [] })
      if (url.startsWith('/api/schema-revisions/'))
        return Response.json({ revision: null })
      if (url.endsWith(projectContextId)) return Response.json(detail)
      return Response.json({ projectContexts: [project] })
    })
    history.replaceState(null, '', `/projects/${projectContextId}/extractions`)
    renderRoutes(batchFetch)

    const page = await screen.findByRole('region', { name: 'Project Context' })
    fireEvent.click(await within(page).findByText('Places · Schema Revision 1'))

    expect(location.pathname).toBe(
      `/projects/${projectContextId}/extractions/${batchExtractionId}`,
    )
    await within(page).findByRole('list', { name: 'Batch Extraction members' })

    // Back leaves the batch for the history that listed it.
    back(`/projects/${projectContextId}/extractions`)
    expect(
      await within(page).findByText('Places · Schema Revision 1'),
    ).toBeInTheDocument()
    expect(
      within(page).queryByRole('list', { name: 'Batch Extraction members' }),
    ).not.toBeInTheDocument()
  })

  it('loads project schemas and retries an error', async () => {
    const pending = Promise.withResolvers<Response>()
    const schemas = vi
      .fn<() => Response | Promise<Response>>()
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(
        Response.json({
          extractionSchemas: [
            {
              extractionSchemaId: '51000000-0000-4000-8003-000000000001',
              name: 'Places',
              createdAt: '2026-08-01T12:00:00.000Z',
              currentRevision: {
                schemaRevisionId: '51000000-0000-4000-8004-000000000001',
                revisionNumber: 2,
                origin: 'researcher-edit',
                createdAt: '2026-08-03T12:00:00.000Z',
              },
            },
          ],
        }),
      )
    renderRoutes(studioFetch(undefined, detail, schemas))

    const page = await openProjectPage()
    fireEvent.click(within(page).getByRole('tab', { name: 'Schemas' }))
    expect(await within(page).findByText('Loading schemas…')).toBeInTheDocument()

    pending.resolve(
      failureResponse('persistence_unavailable', 'Schema storage is unavailable.', 503),
    )
    expect(await within(page).findByRole('alert')).toHaveTextContent(
      'Could not load schemas. persistence_unavailable: Schema storage is unavailable.',
    )

    fireEvent.click(within(page).getByRole('button', { name: 'Retry' }))
    expect(await within(page).findByText('Places')).toBeInTheDocument()
    expect(within(page).getByText('Current Schema Revision 2')).toBeInTheDocument()
    expect(within(page).getByText(/^Updated /)).toHaveAttribute(
      'datetime',
      '2026-08-03T12:00:00.000Z',
    )
    expect(schemas).toHaveBeenCalledTimes(2)
  })

  it('renames a schema inline after the server acknowledges it', async () => {
    const fetcher = studioFetch(
      undefined,
      detail,
      () =>
        Response.json({
          extractionSchemas: [
            {
              extractionSchemaId: '51000000-0000-4000-8003-000000000001',
              name: 'Places',
              createdAt: '2026-08-01T12:00:00.000Z',
              currentRevision: null,
            },
          ],
        }),
    )
    fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PATCH' && url.includes('/api/extraction-schemas/'))
        return Response.json({
          extractionSchema: {
            extractionSchemaId: '51000000-0000-4000-8003-000000000001',
            name: 'Historic places',
            createdAt: '2026-08-01T12:00:00.000Z',
          },
        })
      if (url.startsWith('/api/extraction-schemas?'))
        return Response.json({
          extractionSchemas: [
            {
              extractionSchemaId: '51000000-0000-4000-8003-000000000001',
              name: 'Places',
              createdAt: '2026-08-01T12:00:00.000Z',
              currentRevision: null,
            },
          ],
        })
      if (url.endsWith(projectContextId)) return Response.json(detail)
      return Response.json({ projectContexts: [project] })
    })
    renderRoutes(fetcher)

    fireEvent.click(
      await screen.findByRole('button', { name: `Actions for ${project.name}` }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open project' }))
    const page = await screen.findByRole('region', { name: 'Project Context' })
    await within(page).findByRole('heading', { name: project.name })
    fireEvent.click(within(page).getByRole('tab', { name: 'Schemas' }))
    await within(page).findByText('Places')
    fireEvent.click(
      within(page).getByRole('button', { name: 'Rename schema Places' }),
    )
    const input = within(page).getByLabelText('Schema name for Places')
    fireEvent.change(input, { target: { value: '  Historic places  ' } })
    fireEvent.click(
      within(page).getByRole('button', { name: 'Save schema name' }),
    )

    expect(await within(page).findByText('Historic places')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledWith(
      '/api/extraction-schemas/51000000-0000-4000-8003-000000000001',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          projectContextId,
          name: 'Historic places',
        }),
      }),
    )
  })

  it('keeps project and source deletion controls and dialogs distinct', async () => {
    renderRoutes()
    const page = await openProjectPage()
    const actions = within(page).getByLabelText('Actions for Beretning.pdf')
    const menu = actions.closest('details')!

    fireEvent.click(actions)
    fireEvent.click(
      within(page).getByRole('button', {
        name: 'Delete Source Document Beretning.pdf',
      }),
    )
    const sourceDialog = await screen.findByRole('dialog', {
      name: 'Delete Source Document',
    })
    expect(menu).not.toHaveAttribute('open')

    fireEvent.click(
      within(page).getByRole('button', { name: 'Delete Project Context' }),
    )
    const projectDialog = await screen.findByRole('dialog', {
      name: 'Delete Project Context',
    })

    for (const attribute of ['aria-labelledby', 'aria-describedby'] as const) {
      const projectId = projectDialog.getAttribute(attribute)!
      const sourceId = sourceDialog.getAttribute(attribute)!
      expect(projectId).not.toBe(sourceId)
      expect(projectDialog).toContainElement(document.getElementById(projectId))
      expect(sourceDialog).toContainElement(document.getElementById(sourceId))
    }
  })

  it('downloads the pinned source and reports a later failure', async () => {
    const baseFetch = studioFetch()
    let pdfRequests = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/pdf')) {
        pdfRequests += 1
        return pdfRequests === 1
          ? new Response('pdf')
          : new Response(null, { status: 503 })
      }
      return baseFetch(input)
    })
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:source')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL')
    renderRoutes(fetcher)
    const page = await openProjectPage()
    const actions = within(page).getByLabelText('Actions for Beretning.pdf')
    const menu = actions.closest('details')!

    fireEvent.click(actions)
    fireEvent.click(
      within(page).getByRole('button', { name: 'Download Beretning.pdf' }),
    )
    await waitFor(() => expect(click).toHaveBeenCalledOnce())
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:source')
    expect(menu).not.toHaveAttribute('open')

    fireEvent.click(actions)
    fireEvent.click(
      within(page).getByRole('button', { name: 'Download Beretning.pdf' }),
    )
    expect(await within(page).findByRole('alert')).toHaveTextContent(
      'Could not download “Beretning.pdf”.',
    )
    expect(menu).not.toHaveAttribute('open')

    click.mockRestore()
    createObjectURL.mockRestore()
    revokeObjectURL.mockRestore()
  })

  it('discards a deferred download failure when changing Project Contexts', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (
        url.includes(
          `/projects/${projectContextId}/source-documents/${sourceDocumentId}/reopen`,
        )
      )
        return pending.promise
      if (url.startsWith('/api/extraction-schemas?'))
        return Response.json({ extractionSchemas: [] })
      if (url.endsWith(projectContextId)) return Response.json(detail)
      if (url.endsWith(secondProject.projectContextId))
        return Response.json({
          projectContext: secondProject,
          sourceDocuments: [{ ...secondDocument, pageCount: 2 }],
        })
      return Response.json({ projectContexts: [project, secondProject] })
    })
    renderRoutes(fetcher)
    const firstPage = await openProjectPage()
    fireEvent.click(within(firstPage).getByLabelText('Actions for Beretning.pdf'))
    fireEvent.click(
      within(firstPage).getByRole('button', { name: 'Download Beretning.pdf' }),
    )
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/reopen'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))

    const secondPage = await openProjectPage(secondProject.name)
    pending.resolve(
      Response.json(
        {
          error: {
            code: 'persistence_unavailable',
            message: 'late failure from Project A',
          },
        },
        { status: 503 },
      ),
    )
    await Promise.resolve()
    expect(within(secondPage).queryByRole('alert')).not.toBeInTheDocument()

    const reopenedFirstPage = await openProjectPage()
    expect(within(reopenedFirstPage).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('explains an empty Project Context on its page', async () => {
    renderRoutes(
      studioFetch(undefined, { ...detail, sourceDocuments: [] }),
    )

    const page = await openProjectPage()
    expect(
      await within(page).findByText(
        'No Source Documents yet. Drop PDFs above to get started.',
      ),
    ).toBeInTheDocument()
  })

  it('lets keyboard users resize the Project Context rail', async () => {
    renderRoutes()
    await screen.findByRole('heading', { name: 'No project open' })
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
      await screen.findByRole('button', { name: railRow() }),
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

    expect(await rail().findByText('Beretning.pdf')).toBeInTheDocument()
    expect(
      await screen.findByRole('region', { name: 'Project Context' }),
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
    await screen.findByRole('button', { name: railRow() })

    fireEvent.click(disclosure())
    await screen.findByText('Could not read Source Documents.')

    // Collapsing and re-expanding retries the failed read; only ready and
    // loading branches are cached.
    fireEvent.click(disclosure())
    fireEvent.click(disclosure())
    expect(await rail().findByText('Beretning.pdf')).toBeInTheDocument()
    expect(branchReads).toBe(2)
  })

  it('caches a loaded branch across collapse and re-expansion', async () => {
    const fetch = renderRoutes()
    await screen.findByRole('button', { name: railRow() })

    fireEvent.click(disclosure())
    await rail().findByText('Beretning.pdf')
    fireEvent.click(disclosure())
    expect(rail().queryByText('Beretning.pdf')).not.toBeInTheDocument()
    fireEvent.click(disclosure())
    expect(await rail().findByText('Beretning.pdf')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  // The row itself only discloses; opening the Project Context page is the
  // row menu's own action, so neither control can do the other's job.
  it('separates disclosure from navigation and keeps several branches open', async () => {
    renderRoutes(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (/reopen$/.test(url)) return Response.json(snapshot())
        if (url.endsWith(secondProject.projectContextId))
          return Response.json({
            projectContext: secondProject,
            sourceDocuments: [],
          })
        if (url.endsWith(projectContextId)) return Response.json(detail)
        return Response.json({ projectContexts: [project, secondProject] })
      }),
    )
    await screen.findByRole('button', { name: railRow() })

    fireEvent.click(disclosure())
    expect(await rail().findByText('Beretning.pdf')).toBeInTheDocument()
    // Disclosure alone never routes.
    expect(location.pathname).toBe('/')
    expect(
      screen.getByRole('button', { name: railRow() }),
    ).not.toHaveAttribute('aria-current')

    fireEvent.click(disclosure(secondProject.name))
    expect(await rail().findByText('Empty Project Context.')).toBeInTheDocument()
    // Both branches stay open; expansion is not an accordion.
    expect(rail().getByText('Beretning.pdf')).toBeInTheDocument()

    // The row menu navigates, and keeps navigating from an open Source Document
    // of that same Project Context.
    await openProjectPage()
    fireEvent.click(rail().getByRole('button', { name: 'Beretning.pdf' }))
    await screen.findByText(/Opened Beretning.pdf/)
    expect(location.pathname).toBe(documentPath())

    await openProjectPage()
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
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

    fireEvent.click(await screen.findByRole('button', { name: railRow() }))
    fireEvent.click(await rail().findByRole('button', { name: 'Retry' }))
    expect(await rail().findByText('Beretning.pdf')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps branch loading and empty states inside the expanded Project Context', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ projectContexts: [project] }))
      .mockReturnValueOnce(pending.promise)
    renderRoutes(fetch)

    fireEvent.click(await screen.findByRole('button', { name: railRow() }))
    expect(await rail().findByText('Loading…')).toBeInTheDocument()
    pending.resolve(Response.json({ ...detail, sourceDocuments: [] }))
    expect(
      await rail().findByText('Empty Project Context.'),
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
    await screen.findByRole('heading', { name: 'No project open' })

    history.pushState(null, '', `/projects/${projectContextId}`)
    dispatchEvent(new PopStateEvent('popstate'))

    expect(await rail().findByText('Beretning.pdf')).toBeInTheDocument()
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
  })
})

describe('multi-PDF ingestion on the Project Context page', () => {
  const uploadedA = {
    sourceDocumentId: '51000000-0000-4000-8001-000000000101',
    name: 'A.pdf',
    createdAt: '2026-08-12T10:01:00.000Z',
    pageCount: 1,
  }
  const uploadedB = {
    sourceDocumentId: '51000000-0000-4000-8001-000000000102',
    name: 'B.pdf',
    createdAt: '2026-08-12T10:02:00.000Z',
    pageCount: 2,
  }
  const uploadedC = {
    sourceDocumentId: '51000000-0000-4000-8001-000000000103',
    name: 'C.pdf',
    createdAt: '2026-08-12T10:03:00.000Z',
    pageCount: 3,
  }
  const uploadedD = {
    sourceDocumentId: '51000000-0000-4000-8001-000000000104',
    name: 'D.pdf',
    createdAt: '2026-08-12T10:04:00.000Z',
    pageCount: 4,
  }
  const ingestionKeys = {
    A: '51000000-0000-4000-9000-000000000101',
    B: '51000000-0000-4000-9000-000000000102',
    C: '51000000-0000-4000-9000-000000000103',
    D: '51000000-0000-4000-9000-000000000104',
  }

  function branch(sourceDocuments: typeof detail.sourceDocuments = []) {
    return Response.json({ projectContext: project, sourceDocuments })
  }

  function ingestionResult(sourceDocument: typeof beretning) {
    return Response.json({
      ...sourceDocument,
      sourceRepresentationId: representationId,
      revisionNumber: 1,
      pageCount: 1,
    })
  }

  it('writes selected PDFs in order, caches acknowledgements, and retries by the same key', async () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce(ingestionKeys.A)
      .mockReturnValueOnce(ingestionKeys.B)
      .mockReturnValueOnce(ingestionKeys.C)
      .mockReturnValueOnce(ingestionKeys.D)
    vi.stubGlobal('crypto', { randomUUID })

    let branchCalls = 0
    const attempts = new Map<string, number>()
    const writes: { name: string; ingestionKey: string }[] = []
    const pending: { response: Response; resolve: (response: Response) => void }[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        const form = init.body as FormData
        const file = form.get('file') as File
        const ingestionKey = String(form.get('ingestionKey'))
        writes.push({ name: file.name, ingestionKey })
        const attempt = (attempts.get(file.name) ?? 0) + 1
        attempts.set(file.name, attempt)
        const document =
          file.name === 'A.pdf'
            ? uploadedA
            : file.name === 'B.pdf'
              ? uploadedB
              : file.name === 'C.pdf'
                ? uploadedC
                : uploadedD
        const response =
          file.name === 'B.pdf' && attempt === 1
            ? failureResponse('source_ingestion_failed', 'B failed', 422)
            : ingestionResult(document)
        return new Promise<Response>((resolve) => pending.push({ response, resolve }))
      }
      const reopened = /source-documents\/([^/]+)\/reopen$/.exec(url)
      if (reopened) {
        const document = [uploadedA, uploadedB, uploadedC, uploadedD].find(
          (item) => item.sourceDocumentId === reopened[1],
        )
        return Response.json(snapshot(document ?? uploadedA))
      }
      if (url.endsWith(projectContextId)) {
        branchCalls += 1
        return branch(detail.sourceDocuments)
      }
      return Response.json({ projectContexts: [project] })
    })

    renderRoutes(fetcher)
    const page = await openProjectPage()
    await rail().findByText('Beretning.pdf')

    fireEvent.change(screen.getByLabelText('Drop PDFs here or browse'), {
      target: {
        files: [
          new File(['a'], 'A.pdf', { type: 'application/pdf' }),
          new File(['b'], 'B.pdf', { type: 'application/pdf' }),
          new File(['c'], 'C.pdf', { type: 'application/pdf' }),
        ],
      },
    })

    // Three selected PDFs are three cards, never more: the grid never claims
    // more Source Documents than there are.
    await waitFor(() => expect(within(page).getAllByText(/^[ABC]\.pdf$/)).toHaveLength(3))
    expect(within(page).getByRole('status')).toHaveTextContent(
      'A.pdf: parsing. B.pdf: queued. C.pdf: queued.',
    )
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ name: 'A.pdf', ingestionKey: ingestionKeys.A })
    expect(pending).toHaveLength(1)
    const firstRequest = pending.shift()!
    firstRequest.resolve(firstRequest.response)
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]).toMatchObject({ name: 'B.pdf', ingestionKey: ingestionKeys.B })
    expect(pending).toHaveLength(1)
    const secondRequest = pending.shift()!
    secondRequest.resolve(secondRequest.response)
    await waitFor(() => expect(writes).toHaveLength(3))
    expect(writes[2]).toMatchObject({ name: 'C.pdf', ingestionKey: ingestionKeys.C })
    expect(pending).toHaveLength(1)
    const thirdRequest = pending.shift()!
    thirdRequest.resolve(thirdRequest.response)

    expect(await screen.findByText('B failed')).toBeInTheDocument()
    // A saved card is replaced by the Source Document it became — never both.
    expect(await rail().findByRole('button', { name: 'C.pdf' })).toBeInTheDocument()
    await waitFor(() =>
      expect(within(page).getAllByText(/^[ABC]\.pdf$/)).toHaveLength(3),
    )
    expect(screen.queryByText(/Opened /)).not.toBeInTheDocument()
    expect(writes.map(({ name }) => name)).toEqual(['A.pdf', 'B.pdf', 'C.pdf'])
    expect(writes.map(({ ingestionKey }) => ingestionKey)).toEqual([
      ingestionKeys.A,
      ingestionKeys.B,
      ingestionKeys.C,
    ])
    // Acknowledged writes update the ready branch without a refresh.
    expect(branchCalls).toBe(1)
    expect(rail().getByRole('button', { name: 'A.pdf' })).toBeInTheDocument()
    expect(rail().getByRole('button', { name: 'C.pdf' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Drop PDFs here or browse'), {
      target: {
        files: [new File(['d'], 'D.pdf', { type: 'application/pdf' })],
      },
    })
    await waitFor(() => expect(writes).toHaveLength(4))
    expect(screen.getByText('B failed')).toBeInTheDocument()
    expect(writes[3]).toMatchObject({ name: 'D.pdf', ingestionKey: ingestionKeys.D })
    expect(pending).toHaveLength(1)
    const laterRequest = pending.shift()!
    laterRequest.resolve(laterRequest.response)
    expect(await rail().findByRole('button', { name: 'D.pdf' })).toBeInTheDocument()
    expect(within(page).getAllByText('D.pdf')).toHaveLength(1)
    expect(branchCalls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry B.pdf' }))
    await waitFor(() => expect(writes).toHaveLength(5))
    expect(writes[4]).toMatchObject({ name: 'B.pdf', ingestionKey: ingestionKeys.B })
    expect(pending).toHaveLength(1)
    const retryRequest = pending.shift()!
    retryRequest.resolve(retryRequest.response)
    expect(await rail().findByRole('button', { name: 'B.pdf' })).toBeInTheDocument()
    // The retried card became its Source Document in place: one B.pdf, always.
    await waitFor(() => expect(within(page).getAllByText('B.pdf')).toHaveLength(1))
    expect(writes.map(({ name }) => name)).toEqual([
      'A.pdf',
      'B.pdf',
      'C.pdf',
      'D.pdf',
      'B.pdf',
    ])
    expect(writes.at(-1)?.ingestionKey).toBe(ingestionKeys.B)
    expect(branchCalls).toBe(1)
    expect(
      rail()
        .getAllByRole('button')
        .filter((button) => ['A.pdf', 'B.pdf', 'C.pdf', 'D.pdf'].includes(button.textContent ?? ''))
        .map((button) => button.textContent),
    ).toEqual(['A.pdf', 'B.pdf', 'C.pdf', 'D.pdf'])
  })

  it('deduplicates acknowledged retries by Source Document id in the rail', async () => {
    vi.stubGlobal('crypto', {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce(ingestionKeys.A)
        .mockReturnValueOnce(ingestionKeys.B),
    })
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') return ingestionResult(uploadedA)
      if (url.includes('/reopen')) return Response.json(snapshot(uploadedA))
      if (url.endsWith(projectContextId)) return branch([])
      return Response.json({ projectContexts: [project] })
    })

    renderRoutes(fetcher)
    await openProjectPage()
    await rail().findByText('Empty Project Context.')
    fireEvent.change(screen.getByLabelText('Drop PDFs here or browse'), {
      target: {
        files: [
          new File(['a'], 'A.pdf', { type: 'application/pdf' }),
          new File(['a'], 'A retry.pdf', { type: 'application/pdf' }),
        ],
      },
    })

    // Both writes acknowledge the same Source Document; it is listed once.
    await waitFor(() =>
      expect(screen.queryByText('A retry.pdf')).not.toBeInTheDocument(),
    )
    expect(rail().getAllByRole('button', { name: 'A.pdf' })).toHaveLength(1)
  })

  it('stays on the Project Context route when every selected PDF fails', async () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce(ingestionKeys.A)
      .mockReturnValueOnce(ingestionKeys.B)
    vi.stubGlobal('crypto', { randomUUID })

    let branchReads = 0
    const writes: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        const form = init.body as FormData
        writes.push((form.get('file') as File).name)
        return failureResponse('source_ingestion_failed', 'No usable PDF', 422)
      }
      if (url.endsWith(projectContextId)) {
        branchReads += 1
        return branch([])
      }
      return Response.json({ projectContexts: [project] })
    })

    renderRoutes(fetcher)
    await openProjectPage()
    await rail().findByText('Empty Project Context.')
    fireEvent.change(screen.getByLabelText('Drop PDFs here or browse'), {
      target: {
        files: [
          new File(['a'], 'A.pdf', { type: 'application/pdf' }),
          new File(['b'], 'B.pdf', { type: 'application/pdf' }),
        ],
      },
    })

    await waitFor(() =>
      expect(screen.getAllByText('No usable PDF')).toHaveLength(2),
    )
    expect(screen.getByRole('button', { name: 'Retry A.pdf' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry B.pdf' })).toBeInTheDocument()
    expect(writes).toEqual(['A.pdf', 'B.pdf'])
    expect(branchReads).toBe(1)
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
    expect(screen.queryByText(/Opened /)).not.toBeInTheDocument()
  })

  // The queue outlives the page that started it: opening a Source Document
  // mid-queue must not drop the PDFs still waiting.
  it('finishes the queue after the researcher navigates away from the page', async () => {
    vi.stubGlobal('crypto', {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce(ingestionKeys.A)
        .mockReturnValueOnce(ingestionKeys.B),
    })
    const writes: string[] = []
    const pending: { response: Response; resolve: (response: Response) => void }[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        const file = (init.body as FormData).get('file') as File
        writes.push(file.name)
        const response = ingestionResult(file.name === 'A.pdf' ? uploadedA : uploadedB)
        return new Promise<Response>((resolve) => pending.push({ response, resolve }))
      }
      if (url.includes('/reopen')) return Response.json(snapshot(beretning))
      if (url.endsWith(projectContextId)) return branch(detail.sourceDocuments)
      return Response.json({ projectContexts: [project] })
    })

    renderRoutes(fetcher)
    await openProjectPage()
    await rail().findByText('Beretning.pdf')
    fireEvent.change(screen.getByLabelText('Drop PDFs here or browse'), {
      target: {
        files: [
          new File(['a'], 'A.pdf', { type: 'application/pdf' }),
          new File(['b'], 'B.pdf', { type: 'application/pdf' }),
        ],
      },
    })
    expect(await screen.findByText('Parsing…')).toBeInTheDocument()

    // Leaving the page unmounts it while A is in flight and B is queued.
    fireEvent.click(rail().getByRole('button', { name: 'Beretning.pdf' }))
    expect(await screen.findByText(/Opened Beretning\.pdf/)).toBeInTheDocument()
    const first = pending.shift()!
    first.resolve(first.response)

    await waitFor(() => expect(writes).toEqual(['A.pdf', 'B.pdf']))
    const second = pending.shift()!
    second.resolve(second.response)

    expect(await rail().findByRole('button', { name: 'B.pdf' })).toBeInTheDocument()
    expect(rail().getByRole('button', { name: 'A.pdf' })).toBeInTheDocument()
    // The chosen route is never hijacked by a completed ingestion.
    expect(screen.getByText(/Opened Beretning\.pdf/)).toBeInTheDocument()
    expect(location.pathname).toBe(documentPath())
  })

  it('does not mutate the rail or navigate after its Project Context is deleted mid-ingestion', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue(ingestionKeys.A) })
    let branchCalls = 0
    const pending: { response: Response; resolve: (response: Response) => void }[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        const response = ingestionResult(uploadedA)
        return new Promise<Response>((resolve) => pending.push({ response, resolve }))
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (url.endsWith(projectContextId)) {
        branchCalls += 1
        return branch(detail.sourceDocuments)
      }
      if (url.includes('/reopen')) throw new Error('stale navigation')
      return Response.json({ projectContexts: [project] })
    })

    renderRoutes(fetcher)
    const page = await openProjectPage()
    await rail().findByText('Beretning.pdf')
    fireEvent.change(screen.getByLabelText('Drop PDFs here or browse'), {
      target: { files: [new File(['a'], 'A.pdf', { type: 'application/pdf' })] },
    })
    await waitFor(() => expect(pending).toHaveLength(1))

    fireEvent.click(
      within(page).getByRole('button', { name: 'Delete Project Context' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently' }))
    expect(
      await screen.findByRole('heading', { name: 'No project open' }),
    ).toBeInTheDocument()
    expect(location.pathname).toBe('/projects')

    const request = pending.shift()!
    request.resolve(request.response)
    await waitFor(() => expect(branchCalls).toBe(1))
    expect(screen.queryByText(/Opened A\.pdf/)).not.toBeInTheDocument()
    expect(screen.queryByText('A.pdf')).not.toBeInTheDocument()
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
      await screen.findByText(/place.*SUCCEEDED/),
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
        {
          projectContext: project,
          sourceDocuments: [
            { ...beretning, pageCount: 6 },
            { ...historical, pageCount: 4 },
          ],
        },
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
          sourceDocuments: [{ ...secondDocument, pageCount: 2 }],
        })
      if (url.endsWith(projectContextId)) return Response.json(detail)
      return Response.json({ projectContexts: [project, secondProject] })
    })
    renderRoutes(fetch)

    await openProjectPage()
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
    expect(screen.getByRole('button', { name: railRow() })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      screen.getByRole('button', { name: railRow(secondProject.name) }),
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
