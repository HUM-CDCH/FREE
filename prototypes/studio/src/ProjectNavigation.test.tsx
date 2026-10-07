// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentWorkspaceProps } from './App'
// The explicit extension is required: `./ProjectNavigation` resolves to
// `projectNavigation.ts` on a case-insensitive filesystem.
import {
  ProjectNavigationProvider,
  ProjectRoutes,
} from './ProjectNavigation.tsx'

// The Extractions tab reads the signed-in account's saved method, which no project scopes; routing keeps every
// service default.
const saved = vi.hoisted(() => ({
  state: {
    status: 'ready' as const,
    config: {
      connections: [],
      routes: { schemaSuggestion: null, interaction: null },
      extractionModels: {},
      ingestionModels: {},
      extractionSettings: {},
    },
  },
  refresh: vi.fn(),
}))
vi.mock('./savedMethod', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./savedMethod')>()),
  useSavedMethod: () => saved,
}))
// The developer evaluation panel is off unless FREE_DEVELOPER_EVAL is set; its read stays out of these fetch counts.
vi.mock('./projectContexts/evaluationRounds', () => ({ readEvaluationRounds: async () => null }))

vi.mock('./App', () => ({
  default: ({
    pdfUrl,
    filename,
    markdownUrl,
    parsedDocumentUrl,
    sourceRepresentationId,
    sourceRepresentationCurrent,
    extractionSchema,
    persistedExtraction,
    onInitialResourceLoadFailure,
    onSourceSuperseded,
  }: DocumentWorkspaceProps) => (
    <>
      <p>
        {/* DocumentWorkspace no longer reads annotationSet — the Annotation
            tab was retired in favor of SchemaPanel's own doc chat. Left in
            place, commented out, rather than deleted.
            {annotationSet?.annotations[0]?.text ?? 'no annotation'} ·{' '} */}
        Opened {filename} · {pdfUrl} · {String(markdownUrl)} ·{' '}
        {JSON.stringify(extractionSchema?.schemaNodes ?? 'no schema')} ·{' '}
        {persistedExtraction?.executionStatus ?? 'no extraction'}
      </p>
      <p data-testid="workspace-resources">
        {sourceRepresentationId} · {pdfUrl} · {markdownUrl} ·{' '}
        {parsedDocumentUrl}
      </p>
      <p data-testid="workspace-source-current">
        {sourceRepresentationCurrent ? 'current' : 'superseded'}
      </p>
      <p data-testid="workspace-schema">
        {JSON.stringify(extractionSchema?.schemaNodes ?? null)}
      </p>
      <p data-testid="workspace-result">
        {JSON.stringify(persistedExtraction?.extractionId ?? null)}
      </p>
      <button type="button" onClick={onInitialResourceLoadFailure}>
        Fail retained artifact
      </button>
      <button type="button" onClick={onSourceSuperseded}>
        Refuse a run as superseded
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
  name: 'Elmbrooke, TAK 9355',
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

function snapshot(sourceDocument = beretning, projectContext = project) {
  return {
    projectContext,
    sourceDocument,
    sourceRepresentation: {
      sourceRepresentationId: representationId,
      revisionNumber: 2,
      current: true,
      resources: {
        sourcePdfUrl: `/api/project-contexts/${projectContext.projectContextId}/source-representations/${representationId}/pdf`,
        markdownUrl: `/api/project-contexts/${projectContext.projectContextId}/source-representations/${representationId}/markdown`,
        parsedDocumentUrl: `/api/project-contexts/${projectContext.projectContextId}/source-representations/${representationId}/source`,
      },
    },
    annotationSet: null,
    extractionSchema: null,
    latestAttempt: null,
    latestReviewed: null,
  }
}

function secondSnapshot() {
  return snapshot(secondDocument, secondProject)
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
      recordScope: 'document',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
      sourceCoverage: null,
    },
    latestAttempt: {
      extractionId: '51000000-0000-4000-8006-000000000001',
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
      schemaRevisionId: '51000000-0000-4000-8005-000000000002',
      createdAt: '2026-07-31T12:03:00.000Z',
      strategy: 'ARTICLE',
      catalogRecipe: null,
      requestedModels: null,
      requestedSettings: null,
      executionStatus: 'COMPLETED',
      finalizedReview: null,
      batchExtractionId: null,
      sourceRepresentation: {
        revisionNumber: 2,
        resources: {
          sourcePdfUrl: `/api/project-contexts/${projectContextId}/source-representations/${representationId}/pdf`,
          markdownUrl: `/api/project-contexts/${projectContextId}/source-representations/${representationId}/markdown`,
          parsedDocumentUrl: `/api/project-contexts/${projectContextId}/source-representations/${representationId}/source`,
        },
      },
      extractionSchema: {
        extractionSchemaId: '51000000-0000-4000-8005-000000000001',
        revisionNumber: 1,
        recordDescription: 'One place record.',
        recordScope: 'document',
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

/** The persisted per-project summary as the list contract ships it. */
function projectSummary(
  overrides: Partial<{
    phase: 'ingest' | 'chat' | 'approve' | 'extract' | 'validate'
    extractionCount: number
    extractedSourceDocumentCount: number
    reviewedSourceDocumentCount: number
    staleSourceDocumentCount: number
    schemaDraftCount: number
    schemaStabilised: boolean
    lastActivityAt: string
    runningBatch: { completedMemberCount: number; memberCount: number } | null
  }> = {},
) {
  return {
    phase: 'chat' as const,
    extractionCount: 0,
    extractedSourceDocumentCount: 0,
    reviewedSourceDocumentCount: 0,
    staleSourceDocumentCount: 0,
    schemaDraftCount: 0,
    schemaStabilised: false,
    lastActivityAt: project.createdAt,
    runningBatch: null,
    ...overrides,
  }
}

function projectListResponse(
  projects: readonly (typeof project)[],
  summary: ReturnType<typeof projectSummary> = projectSummary(),
) {
  const body = {
    projectContexts: projects.map((item) => ({
      ...item,
      sourceDocumentCount:
        item.projectContextId === projectContextId
          ? detail.sourceDocuments.length
          : 0,
      summary,
    })),
  }
  return Response.json(body)
}

afterEach(() => {
  cleanup()
  document.querySelector('base')?.remove()
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
    if (url.startsWith('/api/project-spreadsheets?'))
      return Response.json({ projectSpreadsheetVersion: null })
    if (url.endsWith(projectContextId)) return Response.json(branch)
    return projectListResponse([project])
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
const rail = () => within(screen.getByRole('navigation', { name: 'Projects' }))
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
  const page = await screen.findByRole('region', { name: 'Project' })
  await within(page).findByRole('heading', { name })
  return page
}

const secondProject = {
  projectContextId: '51000000-0000-4000-8000-000000000002',
  name: 'Fernhollow, TAK 9400',
  createdAt: '2026-08-11T09:00:00.000Z',
}

/**
 * The rail list, the routed branches, and the three Project Context writes —
 * every write answers the shipped contract so the rail applies only what the
 * server acknowledged.
 */
function lifecycleFetch(
  options: {
    projects?: (typeof project)[]
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
            projectContext: { ...project, name: 'Elmbrooke II' },
          })
        )
      case 'DELETE':
        return options.remove?.() ?? new Response(null, { status: 204 })
    }
    if (url.endsWith('/source-ingestions'))
      return Response.json({ ingestions: [] })
    if (url.endsWith(secondProject.projectContextId))
      return Response.json({
        projectContext: secondProject,
        sourceDocuments: [],
      })
    if (url.endsWith(projectContextId))
      return options.branch?.() ?? Response.json(detail)
    return (
      options.list?.() ??
      projectListResponse(options.projects ?? [project])
    )
  })
}

/** The home page's own region; project names also appear in the rail. */
const home = () => within(screen.getByRole('region', { name: 'Projects' }))

describe('Studio home', () => {
  it('opens a Project Context from its card', async () => {
    renderRoutes()

    fireEvent.click(await home().findByRole('button', { name: project.name }))

    expect(
      await screen.findByRole('region', { name: 'Project' }),
    ).toBeInTheDocument()
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
    expect(screen.queryByRole('region', { name: 'Projects' })).toBeNull()
  })

  it('returns to Studio home through the logo', async () => {
    history.replaceState(null, '', `/projects/${projectContextId}`)
    renderRoutes()
    await screen.findByRole('region', { name: 'Project' })

    const logo = screen.getByRole('link', { name: 'Studio home' })
    expect(logo).toHaveAttribute('href', '/projects')
    fireEvent.click(logo)

    expect(await home().findByRole('heading', { name: 'Projects' })).toBeVisible()
    expect(location.pathname).toBe('/projects')
  })

  it('creates a Project Context from the home page and routes into it', async () => {
    renderRoutes(lifecycleFetch())

    // The home page's one filled primary (decision 01).
    expect((await home().findByRole('button', { name: 'New Project' })).className).toMatch(/(^|\s)bg-green(\s|$)/)
    fireEvent.click(
      await home().findByRole('button', { name: 'New Project' }),
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: secondProject.name },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(
      await screen.findByText('Empty project.'),
    ).toBeInTheDocument()
    expect(location.pathname).toBe(
      `/projects/${secondProject.projectContextId}`,
    )
    expect(
      screen.getByRole('button', { name: railRow(secondProject.name) }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('renders the first-run walkthrough when no Project Context exists', async () => {
    renderRoutes(lifecycleFetch({ projects: [] }))

    expect(
      await home().findByRole('heading', {
        name: 'From source to structured data, with the evidence to prove it',
      }),
    ).toBeVisible()
    // The five workflow phases, named per the design.
    for (const phase of ['Ingest', 'Chat', 'Approve', 'Extract', 'Validate'])
      expect(home().getByText(phase)).toBeInTheDocument()
    expect(home().queryByRole('heading', { name: 'Projects' })).toBeNull()

    // The create action opens the existing modal and routes into the created
    // Project Context.
    expect(home().getByRole('button', { name: 'Create your first project' }).className).toMatch(/(^|\s)bg-green(\s|$)/)
    fireEvent.click(
      home().getByRole('button', { name: 'Create your first project' }),
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: secondProject.name },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(
      await screen.findByText('Empty project.'),
    ).toBeInTheDocument()
    expect(location.pathname).toBe(
      `/projects/${secondProject.projectContextId}`,
    )
  })

  it('renders the card grid, not the first-run state, once a Project Context exists', async () => {
    renderRoutes()

    expect(
      await home().findByRole('button', { name: project.name }),
    ).toBeInTheDocument()
    expect(
      home().queryByRole('heading', {
        name: 'From source to structured data, with the evidence to prove it',
      }),
    ).toBeNull()
  })

  it('shows the Source Document count from the initial list read', async () => {
    const fetch = renderRoutes()

    expect(
      await home().findByRole('button', { name: project.name }),
    ).toHaveTextContent('1 Source Document')
    // The list contract carries the count; home never fans out branch reads.
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('renders the card meta line from the persisted summary', async () => {
    renderRoutes(
      lifecycleFetch({
        list: () =>
          projectListResponse(
            [project],
            projectSummary({
              phase: 'validate',
              extractionCount: 3,
              extractedSourceDocumentCount: 3,
              reviewedSourceDocumentCount: 2,
            }),
          ),
      }),
    )

    expect(
      await home().findByRole('button', { name: project.name }),
    ).toHaveTextContent('1 Source Document · 2 of 3 reviewed')
  })

  it('shows the phase bar and state line for each summary state', async () => {
    const states = [
      { name: 'Chatting', summary: projectSummary({ phase: 'chat' }) },
      {
        name: 'Running',
        summary: projectSummary({
          phase: 'extract',
          runningBatch: { completedMemberCount: 31, memberCount: 42 },
        }),
      },
      {
        name: 'Reviewed',
        summary: projectSummary({
          phase: 'validate',
          extractionCount: 2,
          extractedSourceDocumentCount: 2,
          reviewedSourceDocumentCount: 2,
        }),
      },
      {
        name: 'Drifted',
        summary: projectSummary({
          phase: 'extract',
          extractionCount: 1,
          extractedSourceDocumentCount: 1,
          staleSourceDocumentCount: 1,
        }),
      },
    ]
    renderRoutes(
      lifecycleFetch({
        list: () =>
          Response.json({
            projectContexts: states.map((state, index) => ({
              projectContextId: `51000000-0000-4000-8000-00000000010${index}`,
              name: state.name,
              createdAt: project.createdAt,
              sourceDocumentCount: 2,
              summary: state.summary,
            })),
          }),
      }),
    )

    const chatting = within(
      await home().findByRole('button', { name: 'Chatting' }),
    )
    expect(chatting.getByText('Create schema')).toBeInTheDocument()

    const running = within(home().getByRole('button', { name: 'Running' }))
    expect(running.getByText('Extraction running')).toBeInTheDocument()
    expect(running.getByText('31 / 42')).toBeInTheDocument()

    const reviewed = within(home().getByRole('button', { name: 'Reviewed' }))
    expect(reviewed.getByText('Validated')).toBeInTheDocument()

    const drifted = within(home().getByRole('button', { name: 'Drifted' }))
    expect(drifted.getByText('Re-run needed')).toBeInTheDocument()
    // Every card carries the five-segment bar from the shared primitive.
    expect(drifted.getAllByTestId('phase-segment')).toHaveLength(5)
  })

  it('lists persisted recent activity beside the cards, and nothing when empty', async () => {
    const recentActivity = [
      {
        kind: 'batch_extraction_opened',
        projectContextId,
        projectContextName: project.name,
        occurredAt: '2026-08-12T10:00:00.000Z',
      },
      {
        kind: 'review_decisions_stored',
        projectContextId,
        projectContextName: project.name,
        occurredAt: '2026-08-11T10:00:00.000Z',
      },
      {
        kind: 'schema_revision_appended',
        projectContextId,
        projectContextName: project.name,
        occurredAt: '2026-08-10T10:00:00.000Z',
      },
      {
        kind: 'extraction_appended',
        projectContextId,
        projectContextName: project.name,
        occurredAt: '2026-08-09T10:00:00.000Z',
      },
    ]
    renderRoutes(
      lifecycleFetch({
        list: async () => {
          const body = await projectListResponse([project]).json()
          return Response.json({ ...body, recentActivity })
        },
      }),
    )

    const aside = within(
      await screen.findByRole('complementary', { name: 'Recent activity' }),
    )
    const entries = aside.getAllByRole('listitem')
    // Newest first, each entry two lines: what happened, then project and date.
    expect(entries.map((entry) => entry.textContent)).toEqual([
      `Batch Extraction opened${project.name} · 12 Aug 2026`,
      `Review Decisions stored${project.name} · 11 Aug 2026`,
      `Schema Revision appended${project.name} · 10 Aug 2026`,
      `Extraction appended${project.name} · 9 Aug 2026`,
    ])
  })

  it('renders no activity column at all when there is no persisted activity', async () => {
    renderRoutes()

    await home().findByRole('button', { name: project.name })
    expect(
      screen.queryByRole('complementary', { name: 'Recent activity' }),
    ).toBeNull()
    expect(screen.queryByText('Recent')).toBeNull()
  })

  it('surfaces staleness ahead of review progress in the card meta line', async () => {
    renderRoutes(
      lifecycleFetch({
        list: () =>
          projectListResponse(
            [project],
            projectSummary({
              phase: 'validate',
              extractedSourceDocumentCount: 3,
              reviewedSourceDocumentCount: 3,
              staleSourceDocumentCount: 2,
            }),
          ),
      }),
    )

    expect(
      await home().findByRole('button', { name: project.name }),
    ).toHaveTextContent('1 Source Document · 2 changed since extraction')
  })
})

describe('Project Context lifecycle in the rail', () => {
  it('renders markup-like Project Context and Source Document names as inert text', async () => {
    const projectName = '<img src=x onerror="project-secret"> Project'
    const sourceName = '<script>source-secret</script>.pdf'
    const markedProject = { ...project, name: projectName }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/extraction-schemas?'))
        return Response.json({ extractionSchemas: [] })
      if (url.startsWith('/api/batch-extractions?'))
        return Response.json({ batchExtractions: [] })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return Response.json({ batchSchemaSuggestions: [] })
      if (url.endsWith(projectContextId))
        return Response.json({
          projectContext: markedProject,
          sourceDocuments: [{ ...beretning, name: sourceName, pageCount: 6 }],
        })
      return projectListResponse([markedProject])
    })
    renderRoutes(fetcher)

    const homeRow = await screen.findByRole('button', { name: projectName })
    expect(within(homeRow).getByText(projectName)).not.toHaveClass('truncate')
    const projectRow = await screen.findByRole('button', {
      name: `Expand Source Documents in ${projectName}`,
    })
    expect(projectRow).toHaveTextContent(projectName)
    expect(projectRow.querySelector('.truncate')).toBeNull()
    fireEvent.click(projectRow)
    const sourceRow = await screen.findByRole('button', { name: sourceName })
    expect(sourceRow).toHaveTextContent(sourceName)
    expect(sourceRow).not.toHaveClass('truncate')
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })

  it('navigates to and expands an acknowledged new Project Context', async () => {
    renderRoutes(lifecycleFetch())
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create project' }),
    )

    const name = screen.getByRole('textbox', {
      name: 'Project name',
    })
    // The field never narrows the contract: padding around a limit-length name
    // still submits, because the name is trimmed before it is judged.
    fireEvent.change(name, { target: { value: `  ${'x'.repeat(512)}  ` } })
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
    fireEvent.change(name, { target: { value: `  ${'x'.repeat(513)}  ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Use no more than 512 characters.',
    )

    fireEvent.change(name, { target: { value: '  Fernhollow, TAK 9400  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(
      await screen.findByText('Empty project.'),
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

    const trigger = await screen.findByRole('button', { name: 'Create project' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', {
      name: 'New Project',
    })
    const name = screen.getByRole('textbox', {
      name: 'Project name',
    })
    expect(name).toHaveFocus()
    expect(name).not.toHaveAttribute('aria-invalid')
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a project name.')

    fireEvent.change(name, { target: { value: secondProject.name } })
    expect(name).not.toHaveAttribute('aria-invalid')
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

    fireEvent.change(name, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a project name.')

    fireEvent.change(name, { target: { value: secondProject.name } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(
      await screen.findByText('Empty project.'),
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
                projectContext: { ...project, name: 'Elmbrooke II' },
              })
        },
      }),
    )
    const page = await openProjectPage()
    fireEvent.click(within(page).getByRole('button', { name: 'Rename' }))
    const name = screen.getByRole('textbox', { name: 'Project name' })
    fireEvent.change(name, { target: { value: 'Elmbrooke II' } })

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project Context storage is unavailable.',
    )
    expect(name).toHaveValue('Elmbrooke II')
    expect(
      screen.queryByRole('button', { name: railRow('Elmbrooke II') }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    expect(
      await screen.findByRole('button', { name: railRow('Elmbrooke II') }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('textbox', { name: 'Project name' }),
    ).not.toBeInTheDocument()
  })

  it('deletes the open Project Context only once confirmed, and leaves /projects open', async () => {
    renderRoutes(lifecycleFetch())
    const page = await openProjectPage()
    await rail().findByText('Beretning.pdf')

    fireEvent.click(
      within(page).getByRole('button', { name: 'Delete project' }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete project',
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

    // Deleting the last Project Context lands on the first-run home state.
    expect(
      await screen.findByRole('heading', {
        name: 'From source to structured data, with the evidence to prove it',
      }),
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
      within(page).getByRole('button', { name: 'Delete project' }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete permanently' }),
    )

    // Escape dispatches `cancel`; a write already sent must survive it.
    const dialog = screen.getByRole('dialog', {
      name: 'Delete project',
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
        await screen.findByRole('region', { name: 'Project' }),
      ).getByRole('button', { name: 'Rename' }),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Project name' }),
      { target: { value: 'Elmbrooke II' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await screen.findByRole('button', { name: railRow('Elmbrooke II') })

    // This list read started before the rename and still carries the old name.
    list.resolve(projectListResponse([project]))

    await waitFor(() =>
      expect(
        screen.queryByText('Loading projects…'),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole('button', { name: railRow('Elmbrooke II') }),
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
            : projectListResponse([secondProject, project])
        },
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create project' }),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Project name' }),
      { target: { value: secondProject.name } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByRole('button', { name: railRow(secondProject.name) })

    initial.resolve(projectListResponse([project]))

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
      within(page).getByRole('button', { name: 'Delete project' }),
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
      expect(screen.getByText('No projects yet.')).toBeInTheDocument(),
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
      within(page).getByRole('button', { name: 'Delete project' }),
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
        screen.getByRole('button', { name: 'Collapse projects' }),
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
      within(page).getByRole('button', { name: 'Delete project' }),
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
  it('keeps routing and reads beneath the configured Studio base path', async () => {
    const base = document.createElement('base')
    base.href = '/free/'
    document.head.prepend(base)
    history.replaceState(null, '', '/free/projects')
    const fetch = renderRoutes()

    await home().findByRole('heading', { name: 'Projects' })
    await openProjectPage()

    expect(location.pathname).toBe(`/free/projects/${projectContextId}`)
    expect(
      fetch.mock.calls.every(([input]) =>
        String(input).startsWith('/free/api/'),
      ),
    ).toBe(true)
  })

  it('keeps the persistent rail while navigating to a lazily loaded Project Context', async () => {
    const fetch = renderRoutes()

    expect(
      await home().findByRole('heading', { name: 'Projects' }),
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
    // Exactly seven: the row's disclosure, add-sources and actions controls,
    // the menu's open/delete actions, and the Source Document's open/delete actions.
    expect(rail().getAllByRole('button')).toHaveLength(6)
    // The list, the branch, and the uploads the server is still ingesting.
    expect(fetch).toHaveBeenCalledTimes(3)

    fireEvent.click(rail().getByRole('button', { name: 'Beretning.pdf' }))
    expect(await screen.findByText(/Opened Beretning.pdf/)).toBeInTheDocument()
    expect(location.pathname).toBe(documentPath())
  })

  it('opens the rail Source Document picker once for each add action', async () => {
    renderRoutes()
    await openProjectPage()
    const openPicker = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined)

    fireEvent.click(
      rail().getByRole('button', {
        name: `Add Source Documents to ${project.name}`,
      }),
    )

    expect(openPicker).toHaveBeenCalledTimes(1)
    openPicker.mockRestore()
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

    // Sources is first in tab order (docs -> schema -> extraction), so the
    // next tab over is Schemas.
    fireEvent.keyDown(within(page).getByRole('tab', { name: 'Sources' }), {
      key: 'ArrowRight',
    })
    expect(within(page).getByRole('tab', { name: 'Schemas' })).toHaveFocus()
    expect(
      await within(page).findByText('Build your schema from a document'),
    ).toBeInTheDocument()
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
    const page = await screen.findByRole('region', { name: 'Project' })
    expect(within(page).getByRole('tab', { name: 'Schemas' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      await within(page).findByText('Build your schema from a document'),
    ).toBeInTheDocument()
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
      await within(page).findByText(/No Batch Extractions yet\./),
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
    expect(
      await within(page).findByText('Build your schema from a document'),
    ).toBeInTheDocument()
  })

  it('opens the Sources tab for a Source Document list path', async () => {
    history.replaceState(null, '', `/projects/${projectContextId}/documents`)
    renderRoutes()

    const page = await screen.findByRole('region', { name: 'Project' })
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
      members: [
        {
          extractionId: '51000000-0000-4000-8006-000000000031',
          sourceDocumentId,
          sourceRepresentationRevisionId:
            '51000000-0000-4000-8002-000000000001',
          executionStatus: 'COMPLETED',
          completed: true,
          reviewable: false,
          currentReview: null,
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
      return projectListResponse([project])
    })
    history.replaceState(null, '', `/projects/${projectContextId}/extractions`)
    renderRoutes(batchFetch)

    const page = await screen.findByRole('region', { name: 'Project' })
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

    pending.resolve(
      failureResponse('persistence_unavailable', 'Schema storage is unavailable.', 503),
    )
    fireEvent.click(
      await within(page).findByRole('button', { name: 'Schema history' }),
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
      return projectListResponse([project])
    })
    renderRoutes(fetcher)

    fireEvent.click(
      await screen.findByRole('button', { name: `Actions for ${project.name}` }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open project' }))
    const page = await screen.findByRole('region', { name: 'Project' })
    await within(page).findByRole('heading', { name: project.name })
    fireEvent.click(within(page).getByRole('tab', { name: 'Schemas' }))
    fireEvent.click(
      await within(page).findByRole('button', { name: 'Schema history' }),
    )
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
      within(page).getByRole('button', { name: 'Delete project' }),
    )
    const projectDialog = await screen.findByRole('dialog', {
      name: 'Delete project',
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
      return projectListResponse([project, secondProject])
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
    await home().findByRole('heading', { name: 'Projects' })
    const separator = screen.getByRole('separator', {
      name: 'Resize project navigation',
    })

    expect(separator).toHaveAttribute('aria-valuenow', '212')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator).toHaveAttribute('aria-valuenow', '222')
  })

  it('clears a Project Context rail drag when AppFrame unmounts', async () => {
    renderRoutes()
    await home().findByRole('heading', { name: 'Projects' })
    fireEvent.mouseDown(
      screen.getByRole('separator', {
        name: 'Resize project navigation',
      }),
      { clientX: 100 },
    )
    expect(document.body.style.cursor).toBe('col-resize')

    cleanup()
    try {
      expect(document.body.style.cursor).toBe('')
    } finally {
      window.dispatchEvent(new MouseEvent('mouseup'))
      document.body.style.cursor = ''
    }
  })

  it('hides per-project marks when the Project Context rail is collapsed', async () => {
    renderRoutes(lifecycleFetch({ projects: [project, secondProject] }))
    await screen.findByRole('button', { name: railRow() })

    fireEvent.click(
      screen.getByRole('button', { name: 'Collapse projects' }),
    )

    const projectNavigation = screen.getByRole('complementary', {
      name: 'Project navigation',
    })
    expect(
      within(projectNavigation).getByRole('button', {
        name: 'Expand projects',
      }),
    ).toBeInTheDocument()
    expect(projectNavigation.querySelector('ul')).toBeNull()
    expect(projectNavigation.querySelectorAll('li')).toHaveLength(0)
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
              () => resolve(projectListResponse([project])),
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
      await screen.findByRole('region', { name: 'Project' }),
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
      return projectListResponse([project])
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
        return projectListResponse([project, secondProject])
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
    expect(await rail().findByText('Empty project.')).toBeInTheDocument()
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
      .mockResolvedValueOnce(projectListResponse([project]))
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
      .mockResolvedValueOnce(projectListResponse([project]))
      .mockReturnValueOnce(pending.promise)
    renderRoutes(fetch)

    fireEvent.click(await screen.findByRole('button', { name: railRow() }))
    expect(await rail().findByText('Loading…')).toBeInTheDocument()
    pending.resolve(Response.json({ ...detail, sourceDocuments: [] }))
    expect(
      await rail().findByText('Empty project.'),
    ).toBeInTheDocument()
  })

  it('renders a bad reference without requesting its malformed id', async () => {
    history.replaceState(null, '', '/projects/NOT-A-UUID')
    const fetch = renderRoutes()

    expect(
      await screen.findByRole('heading', {
        name: 'That project reference is invalid',
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
    await home().findByRole('heading', { name: 'Projects' })

    history.pushState(null, '', `/projects/${projectContextId}`)
    dispatchEvent(new PopStateEvent('popstate'))

    expect(await rail().findByText('Beretning.pdf')).toBeInTheDocument()
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
  })
})

describe('Source Ingestions on the Project Context page', () => {
  type Row = {
    workflowId: string
    name: string
    status: 'queued' | 'parsing' | 'succeeded' | 'failed'
    createdAt: string
    completedAt?: string
    sourceDocumentId?: string
    failure?: { code: string; message: string }
    /** false: only answered when the tab names it (outside every window). */
    windowed: boolean
  }
  const documentOf = (n: number, name: string) => ({
    sourceDocumentId: `51000000-0000-4000-8001-0000000003${String(n).padStart(2, '0')}`,
    name,
    createdAt: `2026-08-12T10:${String(n).padStart(2, '0')}:00.000Z`,
    pageCount: n,
  })
  const workflowOf = (name: string) => `ingest:${projectContextId}:${name}`

  /**
   * A fake Studio for uploads: every POST is admitted (202) as one workflow per file name, which the test then moves
   * through the listing; a success adds its Source Document to the branch.
   */
  function ingestionStudio(options: {
    documents?: (typeof detail.sourceDocuments)[number][]
    rows?: Row[]
    post?: (file: File, layout: FormDataEntryValue | null) => Response | Promise<Response> | undefined
    /** The workflow a file's bytes join (content deduplication); its own name's by default. */
    workflowFor?: (file: File) => string
  } = {}) {
    const rows = new Map((options.rows ?? []).map((row) => [row.workflowId, row]))
    const documents = [...(options.documents ?? detail.sourceDocuments)]
    const posts: { name: string; layout: FormDataEntryValue | null; ingestionKey: FormDataEntryValue | null }[] = []
    const listings: string[][] = []
    const dismissed: string[] = []
    const reads = { branch: 0, list: 0 }
    const control = {
      listing: (): Response | Promise<Response> | undefined => undefined,
      branch: (): Response | Promise<Response> | undefined => undefined,
      dismiss: (): Response | undefined => undefined,
    }
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/source-documents')) {
        const form = init.body as FormData
        const file = form.get('file') as File
        posts.push({ name: file.name, layout: form.get('layout'), ingestionKey: form.get('ingestionKey') })
        const custom = await options.post?.(file, form.get('layout'))
        if (custom) return custom
        const workflowId = options.workflowFor?.(file) ?? workflowOf(file.name)
        if (!rows.has(workflowId))
          rows.set(workflowId, { workflowId, name: file.name, status: 'queued', createdAt: '2026-08-12T10:00:00.000Z', windowed: true })
        return Response.json({ workflowId }, { status: 202 })
      }
      if (init?.method === 'DELETE' && url.includes('/source-ingestions/')) {
        const workflowId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
        const refused = control.dismiss()
        if (refused) return refused
        dismissed.push(workflowId)
        rows.delete(workflowId)
        return new Response(null, { status: 204 })
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (url.includes('/source-ingestions')) {
        const named = new URL(url, 'http://local').searchParams.getAll('workflowId')
        listings.push(named)
        const custom = await control.listing()
        if (custom) return custom
        const ingestions = [...rows.values()]
          .filter((row) => row.windowed || named.includes(row.workflowId))
          .map((row) => { const listed: Partial<Row> = { ...row }; delete listed.windowed; return listed })
        return Response.json({ ingestions, absent: named.filter((id) => !rows.has(id)) })
      }
      if (url.endsWith(projectContextId)) {
        reads.branch += 1
        const custom = await control.branch()
        if (custom) return custom
        return Response.json({ projectContext: project, sourceDocuments: [...documents] })
      }
      if (url === '/api/project-contexts') reads.list += 1
      return studioFetch()(input)
    })
    const set = (name: string, change: Partial<Row>) => {
      const workflowId = workflowOf(name)
      const row = rows.get(workflowId) ?? { workflowId, name, status: 'queued' as const, createdAt: '2026-08-12T10:00:00.000Z', windowed: true }
      rows.set(workflowId, { ...row, ...change })
    }
    return {
      fetch, posts, listings, dismissed, reads, control,
      parse: (name: string) => set(name, { status: 'parsing' }),
      succeed: (name: string, n: number, change: Partial<Row> = {}) => {
        const document = documentOf(n, name)
        documents.push(document)
        set(name, { status: 'succeeded', completedAt: '2026-08-12T11:00:00.000Z', sourceDocumentId: document.sourceDocumentId, ...change })
      },
      fail: (name: string, message: string) =>
        set(name, { status: 'failed', completedAt: '2026-08-12T11:00:00.000Z', failure: { code: 'source_ingestion_failed', message } }),
      row: (name: string, status: Row['status'] = 'queued'): Row =>
        ({ workflowId: workflowOf(name), name, status, createdAt: '2026-08-12T10:00:00.000Z', windowed: true }),
    }
  }
  const select = (...names: string[]) =>
    fireEvent.change(screen.getByLabelText('Drop PDFs here or browse'), {
      target: { files: names.map((name) => new File([name], name, { type: 'application/pdf' })) },
    })
  /** Runs the provider's polling (3 s while busy) past its next read. */
  const poll = async (ms = 3000) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a fresh provider mounting in the same commit as a warm Project page still observes its Source Ingestions', async () => {
    const studio = ingestionStudio({ rows: [ingestionStudio().row('Parsing.pdf', 'parsing')] })
    // Load the lazy page once, so the next mount renders it in the provider's own first commit (a bfcache restore).
    renderRoutes(studio.fetch)
    await openProjectPage()
    cleanup()
    history.replaceState(null, '', `/projects/${projectContextId}`)
    const reads = studio.listings.length
    render(
      <ProjectNavigationProvider>
        <ProjectRoutes />
      </ProjectNavigationProvider>,
    )
    const page = await screen.findByRole('region', { name: 'Project' })
    expect(await within(page).findByText('Parsing.pdf')).toBeInTheDocument()
    expect(studio.listings.length).toBeGreaterThan(reads)
  })

  it('sends selected PDFs in order without a key and shows each as Queued once Studio admits it', async () => {
    const studio = ingestionStudio()
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await rail().findByText('Beretning.pdf')

    select('A.pdf', 'B.pdf', 'C.pdf')

    await waitFor(() => expect(studio.posts.map(({ name }) => name)).toEqual(['A.pdf', 'B.pdf', 'C.pdf']))
    expect(studio.posts.map(({ ingestionKey }) => ingestionKey)).toEqual([null, null, null])
    // Three selected PDFs are three cards, never more.
    await waitFor(() => expect(within(page).getAllByText(/^[ABC]\.pdf$/)).toHaveLength(3))
    await waitFor(() => expect(within(page).getByRole('status')).toHaveTextContent('A.pdf: queued. B.pdf: queued. C.pdf: queued.'))

    studio.parse('A.pdf')
    studio.fail('B.pdf', 'B failed')
    studio.succeed('C.pdf', 3)
    await poll()

    expect(await within(page).findByText('Parsing…')).toBeInTheDocument()
    expect(within(page).getByText('B failed')).toBeInTheDocument()
    expect(within(page).getByRole('button', { name: 'Dismiss B.pdf' })).toBeInTheDocument()
    expect(within(page).getByRole('button', { name: 'Upload B.pdf again' })).toBeInTheDocument()
    expect(await rail().findByRole('button', { name: 'C.pdf' })).toBeInTheDocument()
    // The succeeded card is replaced by the Source Document it became: one C.pdf.
    await waitFor(() => expect(within(page).getAllByText('C.pdf')).toHaveLength(1))
    expect(within(page).getByRole('status')).toHaveTextContent('A.pdf: parsing. B.pdf: failed. B failed')
  })

  it('uploads with the page layout chosen beside the drop zone', async () => {
    const studio = ingestionStudio({ documents: [] })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await rail().findByText('Empty project.')
    const layout = within(page).getByLabelText('Page layout')
    expect(layout).toHaveValue('pages')
    fireEvent.change(layout, { target: { value: 'spreads' } })
    select('A.pdf')
    await waitFor(() => expect(studio.posts.map(({ layout: sent }) => sent)).toEqual(['spreads']))
  })

  it('two admissions of one workflow render one card, before and after the listing shows it', async () => {
    const held = Promise.withResolvers<Response>()
    const studio = ingestionStudio({ workflowFor: () => workflowOf('A.pdf') })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await rail().findByText('Beretning.pdf')
    studio.control.listing = () => held.promise

    select('A.pdf', 'A copy.pdf')

    await waitFor(() => expect(studio.posts).toHaveLength(2))
    await waitFor(() => expect(within(page).getAllByText(/^A( copy)?\.pdf$/)).toHaveLength(1))
    studio.control.listing = () => undefined
    held.resolve(Response.json({ ingestions: [{ ...studio.row('A.pdf'), windowed: undefined }], absent: [] }))
    await poll()
    expect(within(page).getAllByText(/^A( copy)?\.pdf$/)).toHaveLength(1)
  })

  it('sends a 180-scalar filename and holds a 181-scalar filename as an item error', async () => {
    const acceptedName = `${'😀'.repeat(176)}.pdf`
    const rejectedName = `${'😀'.repeat(177)}.pdf`
    const studio = ingestionStudio()
    renderRoutes(studio.fetch)
    await openProjectPage()
    select(acceptedName, rejectedName)

    expect(await screen.findByText('The Source Document filename must contain at most 180 Unicode characters.')).toBeInTheDocument()
    await waitFor(() => expect(studio.posts.map(({ name }) => name)).toEqual([acceptedName]))
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    expect(Array.from(acceptedName)).toHaveLength(180)
    expect(Array.from(rejectedName)).toHaveLength(181)
  })

  it('an upload Studio could not acknowledge stays item-scoped, on the route, with Retry', async () => {
    let refuse = true
    const studio = ingestionStudio({
      post: () => (refuse ? failureResponse('persistence_unavailable', 'Studio is unavailable.', 503) : undefined),
    })
    renderRoutes(studio.fetch)
    await openProjectPage()
    await rail().findByText('Beretning.pdf')
    select('A.pdf', 'B.pdf')

    await waitFor(() => expect(screen.getAllByText('Studio is unavailable.')).toHaveLength(2))
    expect(studio.posts.map(({ name }) => name)).toEqual(['A.pdf', 'B.pdf'])
    expect(location.pathname).toBe(`/projects/${projectContextId}`)
    refuse = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry A.pdf' }))
    await waitFor(() => expect(studio.posts.map(({ name }) => name)).toEqual(['A.pdf', 'B.pdf', 'A.pdf']))
    await waitFor(() => expect(screen.getAllByText('Studio is unavailable.')).toHaveLength(1))
  })

  it('keeps a parse on the page after a reload, then shows the Source Document it became', async () => {
    const studio = ingestionStudio({ rows: [ingestionStudio().row('Parsing.pdf', 'parsing'), ingestionStudio().row('Waiting.pdf')] })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()

    // A reload emptied the browser's queue, but Studio still holds both uploads.
    expect(await within(page).findByText('Parsing.pdf')).toBeInTheDocument()
    expect(within(page).getByText('Waiting.pdf')).toBeInTheDocument()
    expect(within(page).getByRole('status')).toHaveTextContent('Parsing.pdf: parsing. Waiting.pdf: queued.')
    const branchReads = studio.reads.branch

    studio.succeed('Parsing.pdf', 12)
    studio.parse('Waiting.pdf')
    await poll()
    await waitFor(() => expect(studio.reads.branch).toBe(branchReads + 1))
    expect(await rail().findByRole('button', { name: 'Parsing.pdf' })).toBeInTheDocument()
    await waitFor(() => expect(within(page).getAllByText('Parsing.pdf')).toHaveLength(1))
    expect(within(page).getByText('12 pages', { exact: false })).toBeInTheDocument()
    expect(within(page).getByRole('status')).toHaveTextContent('Waiting.pdf: parsing.')
  })

  it('a failure survives a reload; Dismiss removes it, and a refused Dismiss keeps it', async () => {
    const failed = { ...ingestionStudio().row('Broken.pdf', 'failed'), completedAt: '2026-08-12T11:00:00.000Z', failure: { code: 'source_ingestion_failed', message: 'kei refused the PDF.' } }
    const studio = ingestionStudio({ rows: [failed] })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    expect(await within(page).findByText('kei refused the PDF.')).toBeInTheDocument()

    studio.control.dismiss = () => failureResponse('persistence_unavailable', 'Try again later.', 503)
    fireEvent.click(within(page).getByRole('button', { name: 'Dismiss Broken.pdf' }))
    expect(await within(page).findByText('Try again later.')).toBeInTheDocument()
    expect(within(page).getByText('kei refused the PDF.')).toBeInTheDocument()

    studio.control.dismiss = () => undefined
    fireEvent.click(within(page).getByRole('button', { name: 'Dismiss Broken.pdf' }))
    await waitFor(() => expect(within(page).queryByText('kei refused the PDF.')).not.toBeInTheDocument())
    expect(studio.dismissed).toEqual([workflowOf('Broken.pdf')])
  })

  it('Upload again opens the file chooser', async () => {
    const failed = { ...ingestionStudio().row('Broken.pdf', 'failed'), completedAt: '2026-08-12T11:00:00.000Z', failure: { code: 'source_ingestion_failed', message: 'No.' } }
    const studio = ingestionStudio({ rows: [failed] })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    const chooser = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(await within(page).findByRole('button', { name: 'Upload Broken.pdf again' }))
    expect(chooser).toHaveBeenCalledOnce()
    expect(chooser.mock.contexts[0]).toBe(screen.getByLabelText('Drop PDFs here or browse'))
    chooser.mockRestore()
  })

  it('an unavailable listing keeps the cards and says status is unavailable', async () => {
    const studio = ingestionStudio({ rows: [ingestionStudio().row('Parsing.pdf', 'parsing')] })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    expect(await within(page).findByText('Parsing.pdf')).toBeInTheDocument()

    studio.control.listing = () => failureResponse('persistence_unavailable', 'Down.', 503)
    await poll()
    expect(await within(page).findByText('Ingestion status is unavailable; retrying.')).toBeInTheDocument()
    expect(within(page).getByText('Parsing.pdf')).toBeInTheDocument()

    studio.control.listing = () => undefined
    await poll()
    await waitFor(() => expect(within(page).queryByText('Ingestion status is unavailable; retrying.')).not.toBeInTheDocument())
  })

  it('keeps observing after the researcher navigates away, and never hijacks the route', async () => {
    const studio = ingestionStudio()
    renderRoutes(studio.fetch)
    await openProjectPage()
    await rail().findByText('Beretning.pdf')
    select('A.pdf', 'B.pdf')
    await waitFor(() => expect(studio.posts).toHaveLength(2))

    fireEvent.click(rail().getByRole('button', { name: 'Beretning.pdf' }))
    expect(await screen.findByText(/Opened Beretning\.pdf/)).toBeInTheDocument()
    studio.succeed('A.pdf', 1)
    studio.succeed('B.pdf', 2)
    await poll()

    expect(await rail().findByRole('button', { name: 'B.pdf' })).toBeInTheDocument()
    expect(rail().getByRole('button', { name: 'A.pdf' })).toBeInTheDocument()
    expect(screen.getByText(/Opened Beretning\.pdf/)).toBeInTheDocument()
    expect(location.pathname).toBe(documentPath())
  })

  it('each read names the admitted uploads and the attempts live in the previous listing', async () => {
    const studio = ingestionStudio({ rows: [ingestionStudio().row('Other.pdf', 'parsing')] })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await within(page).findByText('Other.pdf')
    select('A.pdf')
    await waitFor(() => expect(studio.posts).toHaveLength(1))
    await poll()
    expect(studio.listings.at(-1)!.sort()).toEqual([workflowOf('A.pdf'), workflowOf('Other.pdf')].sort())
  })

  it('a completion missing from the windows is still found through its named ID', async () => {
    const studio = ingestionStudio({ rows: [ingestionStudio().row('Long.pdf', 'parsing')] })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await within(page).findByText('Long.pdf')
    // It finished long enough ago to fall out of the success window: only its named ID answers it.
    studio.succeed('Long.pdf', 4, { windowed: false })
    await poll()
    expect(await rail().findByRole('button', { name: 'Long.pdf' })).toBeInTheDocument()
    await waitFor(() => expect(within(page).getAllByText('Long.pdf')).toHaveLength(1))
  })

  it('completion re-reads the branch once, and the project list once, however many attempts succeed', async () => {
    const studio = ingestionStudio({ rows: [ingestionStudio().row('A.pdf', 'parsing'), ingestionStudio().row('B.pdf', 'parsing')] })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await within(page).findByText('B.pdf')
    const before = { ...studio.reads }
    studio.succeed('A.pdf', 1)
    studio.succeed('B.pdf', 2)
    await poll()
    expect(await rail().findByRole('button', { name: 'B.pdf' })).toBeInTheDocument()
    await poll()
    expect(studio.reads.branch).toBe(before.branch + 1)
    expect(studio.reads.list).toBe(before.list + 1)
  })

  it('a refresh that fails or reads a stale branch is retried by the next listing', async () => {
    const studio = ingestionStudio({ rows: [ingestionStudio().row('A.pdf', 'parsing')] })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await within(page).findByText('A.pdf')
    studio.succeed('A.pdf', 1)
    let failures = 1
    studio.control.branch = () => (failures-- > 0 ? failureResponse('persistence_unavailable', 'Down.', 503) : undefined)
    await poll()
    await poll()
    expect(await rail().findByRole('button', { name: 'A.pdf' })).toBeInTheDocument()
    const settled = studio.reads.branch
    await poll(30_000)
    expect(studio.reads.branch).toBe(settled)
  })

  it('a success whose document is gone from a read branch is not re-read again and again', async () => {
    const studio = ingestionStudio({ rows: [ingestionStudio().row('A.pdf', 'parsing')] })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await within(page).findByText('A.pdf')
    // Published, then deleted (another tab) before this tab's refresh: the branch is right not to hold it.
    studio.succeed('A.pdf', 1)
    const deleted = documentOf(1, 'A.pdf').sourceDocumentId
    studio.control.branch = () => Response.json({ projectContext: project, sourceDocuments: detail.sourceDocuments.filter((document) => document.sourceDocumentId !== deleted) })
    await poll()
    await waitFor(() => expect(within(page).queryByText('A.pdf')).not.toBeInTheDocument())
    const reads = studio.reads.branch
    await poll(3000)
    await poll(3000)
    await poll(30_000)
    expect(studio.reads.branch).toBe(reads)
  })

  it('a replayed document acknowledged during a background re-read is not erased by that older read', async () => {
    const replayed = documentOf(9, 'Replayed.pdf')
    const studio = ingestionStudio({
      rows: [ingestionStudio().row('A.pdf', 'parsing')],
      post: () => Response.json({ ...replayed, sourceRepresentationId: representationId, revisionNumber: 1 }, { status: 201 }),
    })
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await within(page).findByText('A.pdf')
    // A completion starts a background re-read of the branch; hold it with the branch as it was before the replay.
    const held = Promise.withResolvers<Response>()
    studio.control.branch = () => held.promise
    studio.succeed('A.pdf', 1)
    await poll()
    await waitFor(() => expect(studio.reads.branch).toBeGreaterThan(1))
    select('Replayed.pdf')
    expect(await rail().findByRole('button', { name: 'Replayed.pdf' })).toBeInTheDocument()

    // Studio holds the replayed document; only the held read predates it.
    studio.control.branch = () =>
      Response.json({ projectContext: project, sourceDocuments: [...detail.sourceDocuments, documentOf(1, 'A.pdf'), replayed] })
    held.resolve(Response.json({ projectContext: project, sourceDocuments: [...detail.sourceDocuments, documentOf(1, 'A.pdf')] }))
    await poll()
    await poll()
    expect(rail().getByRole('button', { name: 'Replayed.pdf' })).toBeInTheDocument()
  })

  it('opening a cached project re-reads its branch once', async () => {
    const studio = ingestionStudio()
    renderRoutes(studio.fetch)
    await openProjectPage()
    await rail().findByText('Beretning.pdf')
    fireEvent.click(screen.getByRole('link', { name: 'Studio home' }))
    await home().findByRole('heading', { name: 'Projects' })
    const before = studio.reads.branch
    await openProjectPage()
    await waitFor(() => expect(studio.reads.branch).toBe(before + 1))
    await poll(30_000)
    expect(studio.reads.branch).toBe(before + 1)
  })

  it('a project deleted in another tab drops its cards and stops reading', async () => {
    const studio = ingestionStudio()
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await rail().findByText('Beretning.pdf')
    select('A.pdf')
    await waitFor(() => expect(within(page).getByText('A.pdf')).toBeInTheDocument())
    studio.control.listing = () => failureResponse('not_found', 'Project Context was not found.', 404)
    await poll()
    await waitFor(() => expect(within(page).queryByText('A.pdf')).not.toBeInTheDocument())
    const reads = studio.listings.length
    await poll(60_000)
    expect(studio.listings).toHaveLength(reads)
  })

  it('deleting the project stops its reads and never mutates the rail afterwards', async () => {
    const studio = ingestionStudio()
    renderRoutes(studio.fetch)
    const page = await openProjectPage()
    await rail().findByText('Beretning.pdf')
    select('A.pdf')
    await waitFor(() => expect(studio.posts).toHaveLength(1))

    fireEvent.click(within(page).getByRole('button', { name: 'Delete project' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently' }))
    expect(await screen.findByRole('heading', { name: 'From source to structured data, with the evidence to prove it' })).toBeInTheDocument()
    const reads = studio.listings.length
    studio.succeed('A.pdf', 1)
    await poll(60_000)
    expect(studio.listings).toHaveLength(reads)
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
      await screen.findByText(/place.*COMPLETED/),
    ).toBeInTheDocument()
  })

  it('tells the workspace whether its Source Representation is current, per reopen', async () => {
    const extractionId = '51000000-0000-4000-8006-000000000001'
    const reopens: string[] = []
    const rest = studioFetch()
    history.replaceState(null, '', `${documentPath()}?extractionId=${extractionId}`)
    renderRoutes(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (!url.includes('/reopen')) return rest(input)
        reopens.push(url)
        const reopened = hydratedSnapshot()
        // Only the pinned reopen names a superseded Source Representation.
        return Response.json(
          url.endsWith(`/reopen?extractionId=${extractionId}`)
            ? {
                ...reopened,
                sourceRepresentation: { ...reopened.sourceRepresentation, current: false },
              }
            : reopened,
        )
      }),
    )

    expect(
      await screen.findByTestId('workspace-source-current'),
    ).toHaveTextContent(/^superseded$/)
    back(documentPath())
    await waitFor(() =>
      expect(screen.getByTestId('workspace-source-current')).toHaveTextContent(/^current$/),
    )
    expect(reopens).toEqual([
      expect.stringMatching(new RegExp(`/reopen\\?extractionId=${extractionId}$`)),
      expect.stringMatching(/\/reopen$/),
    ])
  })

  it('re-reads the open Source Document after a superseded refusal, and keeps it when that read fails', async () => {
    const extractionId = '51000000-0000-4000-8006-000000000001'
    const answers: Array<() => Response> = [
      () => Response.json(hydratedSnapshot()),
      () => {
        const reopened = hydratedSnapshot()
        return Response.json({
          ...reopened,
          sourceRepresentation: { ...reopened.sourceRepresentation, current: false },
        })
      },
      () => Response.json(
        { error: { code: 'persistence_unavailable', message: 'Persistence is unavailable.' } },
        { status: 503 },
      ),
    ]
    const reopens: string[] = []
    const rest = studioFetch()
    history.replaceState(null, '', `${documentPath()}?extractionId=${extractionId}`)
    renderRoutes(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (!url.includes('/reopen')) return rest(input)
        reopens.push(url)
        return answers[reopens.length - 1]()
      }),
    )
    expect(await screen.findByTestId('workspace-source-current')).toHaveTextContent(/^current$/)

    fireEvent.click(screen.getByRole('button', { name: 'Refuse a run as superseded' }))
    await waitFor(() =>
      expect(screen.getByTestId('workspace-source-current')).toHaveTextContent(/^superseded$/),
    )
    // The same reopen read that opened it, for the same route.
    expect(reopens).toEqual([reopens[0], reopens[0]])
    expect(reopens[0]).toMatch(new RegExp(`/reopen\\?extractionId=${extractionId}$`))

    fireEvent.click(screen.getByRole('button', { name: 'Refuse a run as superseded' }))
    await waitFor(() => expect(reopens).toHaveLength(3))
    await Promise.resolve()
    expect(screen.getByTestId('workspace-source-current')).toHaveTextContent(/^superseded$/)
    expect(screen.getByTestId('workspace-result')).toHaveTextContent('51000000-0000-4000-8006-000000000001')
    expect(screen.queryByRole('heading', { name: /could not be opened|cannot be reopened/ })).not.toBeInTheDocument()
  })

  it('moves a plain route to the reprocessed head when a superseded refusal re-reads it', async () => {
    const reprocessedId = '51000000-0000-4000-8002-000000000077'
    const reopens: string[] = []
    const rest = studioFetch()
    history.replaceState(null, '', documentPath())
    renderRoutes(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (!url.includes('/reopen')) return rest(input)
        reopens.push(url)
        const reopened = hydratedSnapshot()
        if (reopens.length === 1) return Response.json(reopened)
        // The plain read answers the head: the reprocessed Source Representation, current, with no attempt yet.
        return Response.json({
          ...reopened,
          sourceRepresentation: {
            ...reopened.sourceRepresentation,
            sourceRepresentationId: reprocessedId,
            revisionNumber: 3,
          },
          latestAttempt: null,
          latestReviewed: null,
        })
      }),
    )
    expect(await screen.findByTestId('workspace-resources')).toHaveTextContent(representationId)

    fireEvent.click(screen.getByRole('button', { name: 'Refuse a run as superseded' }))

    await waitFor(() =>
      expect(screen.getByTestId('workspace-resources')).toHaveTextContent(reprocessedId),
    )
    expect(screen.getByTestId('workspace-source-current')).toHaveTextContent(/^current$/)
    expect(screen.getByTestId('workspace-result')).toHaveTextContent('null')
    expect(reopens).toEqual([
      expect.stringMatching(/\/reopen$/),
      expect.stringMatching(/\/reopen$/),
    ])
  })

  it('keeps the workspace on the current head while displaying a historical latest attempt', async () => {
    const reopened = hydratedSnapshot()
    const historicalRepresentationId = '51000000-0000-4000-8002-000000000009'
    reopened.latestAttempt = {
      ...reopened.latestAttempt,
      sourceRepresentationRevisionId: historicalRepresentationId,
      schemaRevisionId: '51000000-0000-4000-8005-000000000009',
      extractionId: '51000000-0000-4000-8006-000000000019',
      sourceRepresentation: {
        revisionNumber: 1,
        resources: {
          sourcePdfUrl: `/api/project-contexts/${projectContextId}/source-representations/${historicalRepresentationId}/pdf`,
          markdownUrl: `/api/project-contexts/${projectContextId}/source-representations/${historicalRepresentationId}/markdown`,
          parsedDocumentUrl: `/api/project-contexts/${projectContextId}/source-representations/${historicalRepresentationId}/source`,
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
      '51000000-0000-4000-8006-000000000019',
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

    const overlay = await screen.findByRole('status', {
      name: 'Opening Source Document',
    })
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
      screen.queryByRole('status', { name: 'Opening Source Document' }),
    ).not.toBeInTheDocument()
    expect(reads).toBe(2)
  })

  it('places the narrow navigation toggle beside the Source Document tabs', async () => {
    vi.stubGlobal('innerWidth', 774)
    history.replaceState(null, '', documentPath())
    renderRoutes(
      studioFetch(
        () => Response.json(snapshot(beretning)),
        {
          projectContext: project,
          sourceDocuments: [{ ...beretning, pageCount: 6 }],
        },
      ),
    )
    await screen.findByText(/Opened Beretning.pdf/)

    // The tab strip can commit after the announcement; wait for it.
    const tablist = await screen.findByRole('tablist', {
      name: 'Open Source Documents',
    })
    const toggle = screen.getByRole('button', {
      name: 'Open project navigation',
    })

    expect(toggle).not.toHaveClass('fixed')
    // The toggle leads the tab-strip row, then the project chip, then the tabs.
    const chip = tablist.previousElementSibling as HTMLElement
    expect(toggle.nextElementSibling).toBe(chip)
    expect(within(chip).getByRole('button', { name: `Open project ${project.name}` })).toBeInTheDocument()
  })

  it('closes inactive, active, and final Source Document tabs without losing route intent', async () => {
    history.replaceState(null, '', documentPath())
    renderRoutes(
      studioFetch(
        (documentId) =>
          Response.json(
            snapshot(
              documentId === sourceDocumentId ? beretning : historical,
            ),
          ),
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

    fireEvent.click(screen.getByRole('button', { name: historical.name }))
    await screen.findByText(/Opened Historical.pdf/)
    expect(location.pathname).toBe(documentPath(otherSourceDocumentId))
    expect(
      screen.getByRole('tab', { name: new RegExp(`^${historical.name}`) }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('tab', { name: new RegExp(`^${beretning.name}`) }),
    ).toHaveAttribute('aria-selected', 'false')

    fireEvent.click(screen.getByRole('button', { name: `Close ${beretning.name}` }))
    expect(location.pathname).toBe(documentPath(otherSourceDocumentId))
    expect(screen.getByText(/Opened Historical.pdf/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: beretning.name }))
    await screen.findByText(/Opened Beretning.pdf/)
    fireEvent.click(screen.getByRole('button', { name: `Close ${beretning.name}` }))
    await waitFor(() =>
      expect(location.pathname).toBe(documentPath(otherSourceDocumentId)),
    )
    expect(await screen.findByText(/Opened Historical.pdf/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: `Close ${historical.name}` }))
    await waitFor(() =>
      expect(location.pathname).toBe(`/projects/${projectContextId}`),
    )
    expect(
      await screen.findByRole('region', { name: 'Project' }),
    ).toBeInTheDocument()
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
      return projectListResponse([project, secondProject])
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
      await screen.findByRole('status', { name: 'Opening Source Document' }),
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
        name: 'That Source Document is not in this project',
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
      return projectListResponse([project])
    })
    renderRoutes(fetch)

    expect(
      await screen.findByRole('heading', {
        name: 'Could not load this project',
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

  it.each([
    [
      'Project Context',
      `/projects/${projectContextId}`,
      2,
      'That project no longer exists',
    ],
    ['Source Document', documentPath(), 2, 'That project no longer exists'],
    [
      'Batch Extraction',
      `/projects/${projectContextId}/extractions/51000000-0000-4000-8007-000000000099`,
      4,
      'That project no longer exists',
    ],
  ] as const)(
    'renders a scoped not-found state for a stale cross-account %s route',
    async (_kind, path, expectedCalls, expectedTitle) => {
      history.replaceState(null, '', path)
      const fetch = vi.fn(
        async (
          input: RequestInfo | URL,
          init: RequestInit = {},
        ): Promise<Response> => {
          expect(init.credentials).toBe('same-origin')
          const url = String(input)
          if (url === '/api/project-contexts')
            return projectListResponse([])
          if (url === `/api/project-contexts/${projectContextId}`)
            return failureResponse(
              'not_found',
              'That Project Context is unavailable.',
              404,
            )
          // The page observes its Source Ingestions from mount; Studio refuses a foreign project the same way.
          if (url.startsWith(`/api/project-contexts/${projectContextId}/source-ingestions`))
            return failureResponse('not_found', 'That Project Context is unavailable.', 404)
          if (url.startsWith('/api/batch-extractions?'))
            return Response.json({ batchExtractions: [] })
          if (url.startsWith('/api/batch-schema-suggestions?'))
            return Response.json({ batchSchemaSuggestions: [] })
          throw new Error(`A stale scoped route must not read ${url}.`)
        },
      )
      renderRoutes(fetch)

      expect(
        await screen.findByRole('heading', {
          name: expectedTitle,
        }),
      ).toBeInTheDocument()
      expect(
        screen.getByText('That Project Context is unavailable.'),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Opened /)).not.toBeInTheDocument()
      expect(
        fetch.mock.calls.filter(([input]) => !String(input).includes('/source-ingestions')),
      ).toHaveLength(expectedCalls)
    },
  )

  it('never reads a malformed Source Document reference', async () => {
    history.replaceState(null, '', documentPath('NOT-A-UUID'))
    const fetch = renderRoutes()

    expect(
      await screen.findByRole('heading', {
        name: 'That project reference is invalid',
      }),
    ).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
