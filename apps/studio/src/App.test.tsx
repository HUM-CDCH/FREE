// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DocumentWorkspace, { type DocumentWorkspaceProps } from './App'
import { subscribeToAuthenticationRequired } from './auth/authenticatedFetch.ts'
import parsedDocument from './assets/parsed_document.v2.json'
import type { SchemaNode } from 'extraction/schema'
import type { ExtractionAttempt } from '../shared/extraction.contract'

HTMLElement.prototype.scrollIntoView = vi.fn()

const {
  destroyLoadingTask,
  getDocument,
  ResponseException,
  scrollPageIntoView,
} = vi.hoisted(() => {
  class ResponseException extends Error {
    readonly status: number

    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  const destroyLoadingTask = vi.fn()
  return {
    destroyLoadingTask,
    getDocument: vi.fn(() => ({
      promise: Promise.resolve({ numPages: 3 }),
      destroy: destroyLoadingTask,
    })),
    ResponseException,
    scrollPageIntoView: vi.fn(),
  }
})

// The account keeps every service default: each run submits `{ models: null, settings: <its slot>: null }`. A run
// re-reads it (`refresh`), which answers the ready state, or null when it is not ready.
const saved = vi.hoisted(() => ({
  state: {
    status: 'ready',
    config: {
      connections: [],
      routes: { schemaSuggestion: null, interaction: null },
      extractionModels: {},
      ingestionModels: {},
      extractionSettings: {},
    },
  } as import('./savedMethod').SavedMethodState,
  refresh: vi.fn(),
}))
const savedRefresh = async () => (saved.state.status === 'ready' ? saved.state : null)
saved.refresh.mockImplementation(savedRefresh)
vi.mock('./savedMethod', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./savedMethod')>()),
  useSavedMethod: () => saved,
}))
// Every toast the workspace asks for, in order: one completion must be asked for once (a toast replaced at once is still
// announced). The wrapper keeps showToast's identity, so the workspace's hooks see the same callback.
const shownToasts = vi.hoisted(() => [] as string[])
vi.mock('./useToast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useToast')>()
  const { useCallback } = await import('react')
  return {
    ...actual,
    useToast: () => {
      const host = actual.useToast()
      const { showToast } = host
      const recorded = useCallback<typeof showToast>((message, options) => {
        shownToasts.push(message)
        showToast(message, options)
      }, [showToast])
      return { ...host, showToast: recorded }
    },
  }
})
vi.mock('pdfjs-dist/build/pdf.worker.mjs?url', () => ({ default: 'pdf.worker.mjs' }))
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument,
  ResponseException,
  AnnotationEditorType: { HIGHLIGHT: 9 },
  AnnotationMode: { ENABLE: 2 },
}))
// Nothing emits `annotationeditoruimanager`, so the workspace holds no pdf.js
// editors — exactly the state a reopened Source Document's annotations start in.
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  EventBus: class {
    private listeners = new Map<string, Set<(event: unknown) => void>>()

    on(name: string, listener: (event: unknown) => void) {
      const listeners = this.listeners.get(name) ?? new Set()
      listeners.add(listener)
      this.listeners.set(name, listeners)
    }

    off(name: string, listener: (event: unknown) => void) {
      this.listeners.get(name)?.delete(listener)
    }

    dispatch(name: string, event: unknown) {
      this.listeners.get(name)?.forEach((listener) => listener(event))
    }
  },
  PDFViewer: class {
    private pagesReady = false
    private scaleValue: string | null = null
    private scale = 1
    private eventBus: {
      dispatch: (name: string, event: unknown) => void
    }

    firstPagePromise: Promise<void> | null = null

    constructor({
      eventBus,
    }: {
      eventBus: { dispatch: (name: string, event: unknown) => void }
    }) {
      this.eventBus = eventBus
    }

    // As pdf.js: moving to a page announces it.
    set currentPageNumber(pageNumber: number) {
      this.eventBus.dispatch('pagechanging', { pageNumber })
    }

    get currentScale() {
      return this.scale
    }

    set currentScale(value: number) {
      this.scale = Math.min(25, Math.max(0.1, value))
      this.scaleValue = String(this.scale)
      this.eventBus.dispatch('scalechanging', { scale: this.scale })
    }

    setDocument(pdfDocument: unknown) {
      if (!pdfDocument) return
      this.firstPagePromise = Promise.resolve().then(() => {
        this.pagesReady = true
      })
    }

    get currentScaleValue() {
      return this.scaleValue
    }

    set currentScaleValue(value: string | null) {
      if (!this.pagesReady) {
        console.error('scrollPageIntoView: "1" is not a valid pageNumber parameter.')
      }
      this.scaleValue = value
      const scale = Number(value)
      if (Number.isFinite(scale)) this.currentScale = scale
    }

    increaseScale() {
      this.currentScale = this.scale * 2
    }

    decreaseScale() {
      this.currentScale = this.scale / 2
    }

    updateScale({ scaleFactor }: { scaleFactor: number }) {
      this.currentScale = this.scale * scaleFactor
    }

    scrollPageIntoView = scrollPageIntoView
  },
}))
/** Answers `PATCH /api/extraction-schemas/<id>`: the rename a first generated schema gets (§5). */
function renamedSchema(url: string, init: RequestInit) {
  const { name } = JSON.parse(String(init.body)) as { name: string }
  return Response.json({
    extractionSchema: { extractionSchemaId: url.split('/').at(-1), name, createdAt: '2026-08-09T10:00:00.000Z' },
  })
}

const reopened: DocumentWorkspaceProps = {
  onOpenExtraction: vi.fn(),
  // The real tab-strip slot (DocumentTabBar.tsx) that the workspace's PDF
  // controls portal into; document.body stands in since these tests render
  // DocumentWorkspace without its AppFrame shell.
  tabBarSlot: document.body,
  projectContextId: '51000000-0000-4000-8000-000000000001',
  pdfUrl:
    '/api/project-contexts/51000000-0000-4000-8000-000000000001/source-representations/51000000-0000-4000-8002-000000000001/pdf',
  filename: 'Beretning.pdf',
  sourceRepresentationId: '51000000-0000-4000-8002-000000000001',
  sourceRepresentationCurrent: true,
  markdownUrl:
    '/api/project-contexts/51000000-0000-4000-8000-000000000001/source-representations/51000000-0000-4000-8002-000000000001/markdown',
  parsedDocumentUrl:
    '/api/project-contexts/51000000-0000-4000-8000-000000000001/source-representations/51000000-0000-4000-8002-000000000001/source',
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
  persistedExtraction: {
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
      revisionNumber: 1,
      resources: {
        sourcePdfUrl:
          '/api/project-contexts/51000000-0000-4000-8000-000000000001/source-representations/51000000-0000-4000-8002-000000000001/pdf',
        markdownUrl:
          '/api/project-contexts/51000000-0000-4000-8000-000000000001/source-representations/51000000-0000-4000-8002-000000000001/markdown',
        parsedDocumentUrl:
          '/api/project-contexts/51000000-0000-4000-8000-000000000001/source-representations/51000000-0000-4000-8002-000000000001/source',
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
}

afterEach(() => {
  cleanup()
  shownToasts.length = 0
  document.querySelector('base')?.remove()
  vi.unstubAllGlobals()
  getDocument.mockClear()
  destroyLoadingTask.mockClear()
  scrollPageIntoView.mockClear()
  saved.refresh.mockReset()
  saved.refresh.mockImplementation(savedRefresh)
})

type RevisionWrite = {
  expectedRevisionNumber: number
  recordDescription: string
  schemaNodes: SchemaNode[]
  recordScope?: 'document' | 'records'
}

/** The id the stubbed server gives revision `revisionNumber` of the reopened Extraction Schema. */
const appendedRevisionId = (revisionNumber: number) =>
  `51000000-0000-4000-8005-0000000001${String(revisionNumber).padStart(2, '0')}`

/**
 * Answers a Schema Revision append the way Studio does: the next revision, with the record scope the write names, else
 * its head's (`headScope`; the reopened schema is an Article). Each write body is kept.
 */
function appendRevision(
  init: RequestInit | undefined,
  writes: RevisionWrite[] = [],
  headScope = reopened.extractionSchema!.recordScope,
) {
  const request = JSON.parse(String(init?.body)) as RevisionWrite
  writes.push(request)
  const named = [...writes].reverse().find((write) => write.recordScope)?.recordScope
  return Response.json({
    revision: {
      schemaRevisionId: appendedRevisionId(request.expectedRevisionNumber + 1),
      extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
      revisionNumber: request.expectedRevisionNumber + 1,
      origin: 'researcher-edit',
      createdAt: '2026-08-12T00:00:00.000Z',
      recordDescription: request.recordDescription,
      recordScope: named ?? headScope,
      schemaNodes: request.schemaNodes,
    },
  }, { status: 201 })
}

/** Answers the durable results reader (`/api/extractions/{id}/durable…`) with one saved value at `cut`, in `status`. */
function durableRead(url: string, status: ExtractionAttempt['executionStatus'] = 'COMPLETED',
  cut: { snapshotVersion: number; feedbackVersion: number } = { snapshotVersion: 1, feedbackVersion: 0 }): Response | null {
  if (/^\/api\/extractions\/[^/?]+\/durable\/source$/.test(url)) return Response.json({ document: parsedDocument, markdown: '# Beretning' })
  const match = /^\/api\/extractions\/([^/?]+)\/durable(\/values)?(?:\?(.*))?$/.exec(url)
  if (!match) return null
  const [, extractionId, values, query] = match
  const asked = new URLSearchParams(query ?? '')
  const snapshotVersion = Number(asked.get('snapshotVersion') ?? cut.snapshotVersion)
  const feedbackVersion = Number(asked.get('feedbackVersion') ?? cut.feedbackVersion)
  const value = { id: 'place', recordId: 'record', fieldId: 'place', path: ['records', 0, 'place'],
    selectionId: '51000000-0000-4000-8009-000000000001', schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
    node: { id: 'place', name: 'place', type: 'string' }, modelValue: 'Elmbrooke', evidence: [], links: [],
    grounding: 'ungrounded', processing: 'saved', lineage: [], correction: null, historicalCorrection: null }
  if (values) return Response.json({ extractionId, snapshotVersion, feedbackVersion, status, finalization: null,
    reviewCounts: { required: 1, toCheck: 1, approved: 0, edited: 0, rejected: 0 }, values: [value], total: 1, next: null, coverage: {} })
  return Response.json({ protocol: 1, projectId: reopened.projectContextId, extractionId, status, controlVersion: 1, pendingResume: false,
    selection: { id: value.selectionId, ordinal: 1 }, pendingSelection: null, source: {}, sourceRevisionId: reopened.sourceRepresentationId,
    snapshotVersion: cut.snapshotVersion, feedbackVersion: cut.feedbackVersion, counts: { saved: 1, inFlight: 0, pending: 0 }, failure: null,
    records: null, reading: [] })
}

/** A RUNNING attempt the stubbed server acknowledges for the reopened document's current revision. */
function runningAttempt(extractionId: string) {
  return {
    extractionId,
    sourceDocumentId: '51000000-0000-4000-8001-000000000001',
    sourceRepresentationRevisionId: reopened.sourceRepresentationId,
    schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
    strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, requestedSettings: null, executionStatus: 'RUNNING',
    finalizedReview: null, batchExtractionId: null, createdAt: '2026-08-10T00:00:00.000Z',
  }
}

/** Renders the reopened workspace, with any props overridden, and waits for indexing to settle. */
async function renderReopened(overrides: Partial<DocumentWorkspaceProps> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) =>
      Promise.resolve(
        durableRead(String(input)) ?? (String(input).endsWith('/source')
          ? Response.json(parsedDocument)
          : new Response('# Beretning')),
      ),
    ),
  )
  const mounted = render(<DocumentWorkspace {...reopened} {...overrides} />)
  await waitFor(() =>
    expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
  )
  return mounted
}

describe('reopened Source Document workspace', () => {


  it.each(['ready', 'loading'] as const)('sends the current page only while the PDF is %s', async (pdfStatus) => {
    const posts: Array<Record<string, unknown>> = []
    if (pdfStatus === 'loading') getDocument.mockReturnValueOnce({ promise: new Promise<{ numPages: number }>(() => {}), destroy: destroyLoadingTask })
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const durable = durableRead(url)
      if (durable) return Promise.resolve(durable)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      if (url.endsWith('/api/extractions') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        posts.push(body)
        return Promise.resolve(Response.json({
          ...runningAttempt(String(body.id)),
          executionStatus: 'FAILED' }, { status: 201 }))
      }
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    if (pdfStatus === 'ready') {
      fireEvent.click(await screen.findByRole('button', { name: 'Next page' }))
      expect(screen.getByRole('textbox', { name: 'Current page' })).toHaveValue('2')
    }
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    if (pdfStatus === 'ready') expect(posts[0]).toMatchObject({ startPage: 2 })
    else expect(posts[0]).not.toHaveProperty('startPage')
  })

  it('a run re-reads the saved method before posting and hands the admitted Extraction to its controls', async () => {
    const extractionResponse = Promise.withResolvers<Response>()
    const order: string[] = []
    saved.refresh.mockImplementation(async () => { order.push('refresh'); return saved.state.status === 'ready' ? saved.state : null })
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input)
      const durable = durableRead(url)
      if (durable) return Promise.resolve(durable)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      if (url.endsWith('/api/extractions')) { order.push('post'); return extractionResponse.promise }
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    // Run is the screen's positive; Stop is red (decision 02).
    expect(screen.getByRole('button', { name: '▶ Run extraction' }).className).toMatch(/(^|\s)bg-green(\s|$)/)
    // While Run can start, Results' empty state points at it.
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(screen.getByText('Press ▶ Run extraction above.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    await waitFor(() => expect(order).toEqual(['refresh', 'post']))
    extractionResponse.resolve(Response.json({ ...runningAttempt('51000000-0000-4000-8006-000000000031') }, { status: 201 }))
    expect(await screen.findByRole('button', { name: '❚❚ Pause extraction' })).toBeEnabled()
    // An admitted Extraction is paused or stopped where it was run; Pause is not the screen's positive.
    expect(screen.getByRole('button', { name: '❚❚ Pause extraction' }).className).not.toMatch(/(^|\s)bg-green(\s|$)/)
    expect(screen.getByRole('button', { name: '■ Stop' })).toBeEnabled()
  })

  // Decision 04: a run started here that succeeds says so in one toast with "Review now"; a run this page only reopened
  // (restored while running) says it finished, with nothing offered.
  it.each(['started here', 'restored while running'] as const)('a run %s that completes while monitored ends in one completion toast', async (origin) => {
    // A run started here carries the identity the page made for it.
    let extractionId = '51000000-0000-4000-8006-000000000042'
    const completed = () => ({ ...runningAttempt(extractionId), executionStatus: 'COMPLETED' })
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const durable = durableRead(url)
      if (durable) return Promise.resolve(durable)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      if (url.endsWith('/api/extractions')) {
        extractionId = (JSON.parse(String(init?.body)) as { id: string }).id
        return Promise.resolve(Response.json(runningAttempt(extractionId), { status: 201 }))
      }
      if (url.endsWith(`/api/extractions/${extractionId}`)) return Promise.resolve(Response.json({ extraction: completed() }))
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened}
      persistedExtraction={origin === 'started here' ? null : { ...reopened.persistedExtraction!, ...runningAttempt(extractionId) } as DocumentWorkspaceProps['persistedExtraction']} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    if (origin === 'started here') {
      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      expect(await screen.findByRole('button', { name: '❚❚ Pause extraction' })).toBeEnabled()
    }
    expect(await screen.findByText(/complete — review it in the Results tab$/, undefined, { timeout: 4_000 })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Extraction finished' })).not.toBeInTheDocument()
    if (origin === 'restored while running') {
      expect(screen.queryByRole('button', { name: 'Review now' })).not.toBeInTheDocument()
      return
    }
    expect(screen.getByRole('tab', { name: /^Schema/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Review now' }))
    expect(screen.getByRole('tab', { name: /^Results/ })).toHaveAttribute('aria-selected', 'true')
  })

  // Review now opens the Results tab even when the researcher collapsed the rail during the run: it opens the rail too.
  it.each(['the rail collapses', 'Latest reviewed is inspected', 'latest Results stays open'] as const)('keeps monitoring after the Results reader reports running and %s', async (inspection) => {
    let extractionId = ''
    let status: ExtractionAttempt['executionStatus'] = 'RUNNING'
    const reads: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const durable = durableRead(url, status)
      if (durable) return Promise.resolve(durable)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.endsWith('/api/extractions') && init?.method === 'POST') {
        extractionId = (JSON.parse(String(init.body)) as { id: string }).id
        return Promise.resolve(Response.json(runningAttempt(extractionId), { status: 201 }))
      }
      if (url === `/api/extractions/${extractionId}`) {
        reads.push(extractionId)
        return Promise.resolve(Response.json({ extraction: { ...runningAttempt(extractionId), executionStatus: status } }))
      }
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} latestReviewedExtraction={{ ...reopened.persistedExtraction!,
      finalizedReview: { snapshotVersion: 1, feedbackVersion: 0, createdAt: '2026-10-05T00:00:00.000Z' } }} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    await screen.findByRole('button', { name: '❚❚ Pause extraction' })
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(await screen.findByText('Elmbrooke')).toBeVisible()
    if (inspection === 'the rail collapses') fireEvent.click(screen.getByTitle('Collapse panel'))
    else if (inspection === 'Latest reviewed is inspected') {
      fireEvent.change(screen.getByRole('combobox', { name: 'Extraction snapshot' }), { target: { value: reopened.persistedExtraction!.extractionId } })
      expect(await screen.findByText('Elmbrooke')).toBeVisible()
    }
    status = 'COMPLETED'
    if (inspection === 'latest Results stays open') {
      expect(await screen.findByText('Extraction complete — saved values are ready to review.', undefined, { timeout: 4_000 })).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Review now' })).not.toBeInTheDocument()
    } else {
      const reviewNow=await screen.findByRole('button', { name: 'Review now' }, { timeout: 4_000 })
      expect(reviewNow).toBeVisible()
      fireEvent.click(reviewNow)
      expect(await screen.findByRole('combobox', { name: 'Extraction snapshot' })).toHaveValue(extractionId)
      expect(reads).toEqual([extractionId])
    }
    expect(shownToasts.filter(message => message.includes('complete —'))).toHaveLength(1)
    expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled()
  }, 6_000)

  it.each(['PAUSED', 'FAILED', 'PAUSING', 'STOPPING'] as const)('disables Run while latest is %s and Latest reviewed is inspected', async (status) => {
    const latest = { ...reopened.persistedExtraction!, executionStatus: status }
    const reviewed = { ...reopened.persistedExtraction!, extractionId: '51000000-0000-4000-8006-000000000074',
      finalizedReview: { snapshotVersion: 1, feedbackVersion: 0, createdAt: '2026-10-05T00:00:00.000Z' } }
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/extractions' && init?.method === 'POST') posts.push(JSON.parse(String(init.body)))
      return Promise.resolve(durableRead(url, url.includes(latest.extractionId) ? status : 'COMPLETED') ??
        (url.endsWith('/source') ? Response.json(parsedDocument) : new Response('# Beretning')))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={latest} latestReviewedExtraction={reviewed} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    fireEvent.change(await screen.findByRole('combobox', { name: 'Extraction snapshot' }), { target: { value: reviewed.extractionId } })
    // The latest can still continue: the run button stays its control, whatever is inspected.
    expect(screen.queryByRole('button', { name: '▶ Run extraction' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: { PAUSED: '▶ Resume extraction', FAILED: '↻ Retry extraction', PAUSING: 'Pausing…', STOPPING: 'Stopping…' }[status] })).toBeInTheDocument()
    expect(posts).toEqual([])
  })

  it('pauses the latest Extraction from the run button and offers Resume once its calls are saved', async () => {
    const latest = { ...reopened.persistedExtraction!, executionStatus: 'RUNNING' as const }
    let status: ExtractionAttempt['executionStatus'] = 'RUNNING'
    const commands: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/durable/control') && init?.method === 'POST') {
        commands.push(JSON.parse(String(init.body)))
        status = 'PAUSING'
        return Promise.resolve(Response.json({ controlVersion: 2, status, pendingResume: false }))
      }
      if (url === `/api/extractions/${latest.extractionId}`) return Promise.resolve(Response.json({ extraction: { ...latest, executionStatus: status } }))
      return Promise.resolve(durableRead(url, status) ?? (url.endsWith('/source') ? Response.json(parsedDocument) : new Response('# Beretning')))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={latest} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '❚❚ Pause extraction' }))
    expect(await screen.findByRole('button', { name: 'Pausing…' })).toBeDisabled()
    expect(commands).toEqual([expect.objectContaining({ expectedVersion: 1, action: 'pause' })])
    status = 'PAUSED'
    expect(await screen.findByRole('button', { name: '▶ Resume extraction' }, { timeout: 4_000 })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '▶ Run extraction' })).not.toBeInTheDocument()
  }, 6_000)

  it('shows uncertain re-run admission beside prior results and reconnects the original identity after a page change', async () => {
    const posts: Array<{ id: string; startPage: number }> = []
    const reads: string[] = []
    let readable = false
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const durable = durableRead(url)
      if (durable) return Promise.resolve(durable)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url === '/api/extractions' && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(new Response('Bad gateway', { status: 502 }))
      }
      if (/^\/api\/extractions\/[^/]+$/.test(url)) {
        const id = url.split('/').at(-1)!
        reads.push(id)
        return Promise.resolve(readable ? Response.json({ extraction: { ...runningAttempt(id), executionStatus: 'PAUSED' } }) : new Response('Bad gateway', { status: 502 }))
      }
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to update status')
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeVisible()
    expect(shownToasts.some(message => message.includes('admission'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    readable = true
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument())
    expect(posts).toHaveLength(1)
    expect(reads).toEqual([posts[0]!.id, posts[0]!.id])
  })

  it('retries an uncertain request that never committed with its original identity and page', async () => {
    const posts: Array<{ id: string; startPage: number }> = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url=String(input)
      const durable=durableRead(url)
      if(durable)return Promise.resolve(durable)
      if(url.endsWith('/source'))return Promise.resolve(Response.json(parsedDocument))
      if(url.endsWith('/markdown'))return Promise.resolve(new Response('# Beretning'))
      if(url==='/api/extractions'&&init?.method==='POST') {
        const body=JSON.parse(String(init.body)) as (typeof posts)[number]
        posts.push(body)
        return Promise.resolve(posts.length===1 ? new Response('Bad gateway',{status:502})
          : Response.json({...runningAttempt(body.id),executionStatus:'COMPLETED'},{status:201}))
      }
      if(/^\/api\/extractions\/[^/]+$/.test(url))return Promise.resolve(Response.json({error:{code:'not_found',message:'Not admitted.'}},{status:404}))
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened}/>)
    await waitFor(()=>expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button',{name:'▶ Run extraction'}))
    const retry=await screen.findByRole('button',{name:'Retry original request'})
    fireEvent.click(screen.getByRole('button',{name:'Next page'}))
    expect(screen.getByRole('textbox',{name:'Current page'})).toHaveValue('2')
    expect(screen.getByRole('button',{name:'▶ Run extraction'})).toBeDisabled()
    fireEvent.click(retry)
    await waitFor(()=>expect(posts).toHaveLength(2))
    expect(posts[1]).toEqual(posts[0])
    expect(posts[1]!.startPage).toBe(1)
    await waitFor(()=>expect(screen.queryByRole('button',{name:'Retry original request'})).not.toBeInTheDocument())
  })

  it('Review now opens a rail collapsed during the run on its Results tab', async () => {
    let extractionId = '51000000-0000-4000-8006-000000000043'
    const completed = () => ({ ...runningAttempt(extractionId), executionStatus: 'COMPLETED' })
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const durable = durableRead(url)
      if (durable) return Promise.resolve(durable)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      if (url.endsWith('/api/extractions')) {
        extractionId = (JSON.parse(String(init?.body)) as { id: string }).id
        return Promise.resolve(Response.json(runningAttempt(extractionId), { status: 201 }))
      }
      if (url.endsWith(`/api/extractions/${extractionId}`)) return Promise.resolve(Response.json({ extraction: completed() }))
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    fireEvent.click(screen.getByTitle('Collapse panel'))
    expect(screen.queryByRole('tab', { name: /^Results/ })).not.toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: 'Review now' }, { timeout: 4_000 }))
    expect(screen.getByRole('tab', { name: /^Results/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTitle('Collapse panel')).toBeInTheDocument()
  })

  it('a method_changed refusal is retried once with a fresh read, a second one ends with a toast', async () => {
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const durable = durableRead(url)
      if (durable) return Promise.resolve(durable)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      if (url.endsWith('/api/extractions')) {
        posts.push(JSON.parse(String(init?.body)))
        return Promise.resolve(Response.json({ error: { code: 'method_changed', message: 'Stale.' } }, { status: 409 }))
      }
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(saved.refresh).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('Your saved settings changed. Run again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled()
  })

  it('a failed read of the saved method, read again once, starts nothing and says so (Review Focus 1)', async () => {
    saved.refresh.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    const posts: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input)
      const durable = durableRead(url)
      if (durable) return Promise.resolve(durable)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      if (url.endsWith('/api/extractions')) {
        posts.push(url)
        return Promise.resolve(new Response('unexpected', { status: 500 }))
      }
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    expect(await screen.findByText('Saved advanced settings could not be read. Nothing was started.')).toBeInTheDocument()
    expect(saved.refresh).toHaveBeenCalledTimes(2)
    expect(posts).toHaveLength(0)
    expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled()
  })

  it('a read of the saved method that an Apply interrupted is read again, and the run goes ahead', async () => {
    // An Apply aborts the read in flight, which resolves null although the settings are ready.
    saved.refresh.mockResolvedValueOnce(null)
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const durable = durableRead(url)
      if (durable) return Promise.resolve(durable)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      if (url.endsWith('/api/extractions')) {
        posts.push(JSON.parse(String(init?.body)))
        return Promise.resolve(Response.json(runningAttempt('51000000-0000-4000-8006-000000000032'), { status: 201 }))
      }
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(saved.refresh).toHaveBeenCalledTimes(2)
    expect(await screen.findByRole('button', { name: '❚❚ Pause extraction' })).toBeEnabled()
    expect(screen.queryByText('Saved advanced settings could not be read. Nothing was started.')).not.toBeInTheDocument()
  })

  it('without a saved record scope the run is disabled and points at the schema header', async () => {
    await renderReopened({ persistedExtraction: null, extractionSchema: { ...reopened.extractionSchema!, recordScope: null } })
    expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '▶ Run extraction' })).toHaveAttribute('title', 'Choose Article or Catalog in the schema header')
    expect(screen.queryByText(/Press Run extraction/)).not.toBeInTheDocument()
    // Results' empty state says why, in the same words, instead of pointing at a disabled Run.
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(screen.getByText('Choose Article or Catalog in the schema header')).toBeVisible()
    expect(screen.queryByText('Press ▶ Run extraction above.')).not.toBeInTheDocument()
  })

  it('the toolbar pager navigates on Enter and ignores an invalid page', async () => {
    await renderReopened()
    expect(screen.getByText('/ 3')).toBeInTheDocument()
    const input = screen.getByLabelText('Current page')
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Go to page 3' })).toHaveAttribute('aria-current', 'page')
    fireEvent.change(screen.getByLabelText('Current page'), { target: { value: '999' } })
    fireEvent.blur(screen.getByLabelText('Current page'))
    expect(screen.getByLabelText('Current page')).toHaveValue('3')
    const previous = screen.getByRole('button', { name: 'Previous page' })
    previous.focus()
    fireEvent.click(previous)
    expect(screen.getByRole('button', { name: 'Go to page 2' })).toHaveAttribute('aria-current', 'page')
    // The pager stays mounted, so the button keeps focus for the next press.
    expect(previous).toHaveFocus()
    expect(screen.getByLabelText('Current page')).toHaveValue('2')
  })

  it('clears a resize drag when the workspace unmounts', async () => {
    const mounted = await renderReopened()
    const separator = mounted.container.querySelector<HTMLElement>(
      '[title="Drag to resize"]',
    )
    expect(separator).not.toBeNull()
    fireEvent.mouseDown(separator!, { clientX: 100 })
    expect(document.body.style.cursor).toBe('col-resize')

    mounted.unmount()
    try {
      expect(document.body.style.cursor).toBe('')
    } finally {
      window.dispatchEvent(new MouseEvent('mouseup'))
      document.body.style.cursor = ''
    }
  })

  it('does not reload Source Document resources when only its name changes', async () => {
    let renamed = false
    const pending = new Promise<Response>(() => undefined)
    const fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (renamed) return pending
      return Promise.resolve(
        url.endsWith('/source')
          ? Response.json(parsedDocument)
          : new Response('# Beretning'),
      )
    })
    vi.stubGlobal('fetch', fetch)
    const mounted = render(<DocumentWorkspace {...reopened} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(getDocument).toHaveBeenCalledOnce())
    const callsEndingWith = (suffix: string) =>
      fetch.mock.calls.filter(([input]) => String(input).endsWith(suffix)).length
    expect(callsEndingWith('/pdf')).toBe(0)
    expect(callsEndingWith('/markdown')).toBe(1)
    expect(callsEndingWith('/source')).toBe(1)

    renamed = true
    mounted.rerender(
      <DocumentWorkspace {...reopened} filename="Renamed.pdf" />,
    )

    expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument()
    expect(callsEndingWith('/pdf')).toBe(0)
    expect(callsEndingWith('/markdown')).toBe(1)
    expect(callsEndingWith('/source')).toBe(1)
    expect(getDocument).toHaveBeenCalledOnce()
  })

  it('conceals the previous Source Document while switched resources load', async () => {
    const mounted = await renderReopened()
    await waitFor(() => expect(getDocument).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(screen.getByText('Elmbrooke')).toBeVisible()

    const nextSourceRepresentationId =
      '51000000-0000-4000-8002-000000000099'
    const pendingIndex = Promise.withResolvers<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = String(input)
        if (url.includes(nextSourceRepresentationId)) {
          return pendingIndex.promise
        }
        return Promise.resolve(
          url.endsWith('/source')
            ? Response.json(parsedDocument)
            : new Response('# Beretning'),
        )
      }),
    )
    const pendingPdf = Promise.withResolvers<{ numPages: number }>()
    getDocument.mockReturnValueOnce({
      promise: pendingPdf.promise,
      destroy: destroyLoadingTask,
    })

    mounted.rerender(
      <DocumentWorkspace
        {...reopened}
        sourceRepresentationId={nextSourceRepresentationId}
        pdfUrl={`/sources/${nextSourceRepresentationId}/pdf`}
        markdownUrl={`/sources/${nextSourceRepresentationId}/markdown`}
        parsedDocumentUrl={`/sources/${nextSourceRepresentationId}/source`}
        persistedExtraction={null}
      />,
    )

    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2))
    expect(destroyLoadingTask).toHaveBeenCalledOnce()
    expect(getDocument).toHaveBeenNthCalledWith(2, {
      url: `/sources/${nextSourceRepresentationId}/pdf`,
      wasmUrl: '/assets/pdfjs-wasm/',
    })
    expect(
      screen.getByRole('status', { name: 'Loading Source Document' }),
    ).toBeVisible()
    expect(screen.queryByText('Elmbrooke')).not.toBeInTheDocument()
  })

  it('keeps the collapsed right rail narrow at mobile widths', async () => {
    await renderReopened()
    const rail = screen.getByRole('complementary', {
      name: 'Evidence, schema and results',
    })
    const mobileDrawerWidth = 'max-[859px]:!w-[min(90vw,100%,32rem)]'

    expect(rail.className).toContain(mobileDrawerWidth)

    fireEvent.click(screen.getByTitle('Collapse panel'))

    expect(rail).toHaveStyle({ width: '46px' })
    expect(rail.className).not.toContain(mobileDrawerWidth)

    fireEvent.click(screen.getByTitle('Expand panel'))

    expect(rail.className).toContain(mobileDrawerWidth)
  })

  it('initializes PDF zoom only after the first page is available', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = document.createElement('base')
    base.href = '/free/'
    document.head.prepend(base)

    try {
      await renderReopened()
      await waitFor(() =>
        expect(getDocument).toHaveBeenCalledWith({
          url: `/free${reopened.pdfUrl}`,
          wasmUrl: '/free/assets/pdfjs-wasm/',
        }),
      )
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) => String(input).endsWith('/pdf')),
      ).toBe(false)
      expect(
        vi
          .mocked(fetch)
          .mock.calls.every(
            ([, init]) => init?.credentials === 'same-origin',
          ),
      ).toBe(true)

      expect(consoleError).not.toHaveBeenCalledWith(
        'scrollPageIntoView: "1" is not a valid pageNumber parameter.',
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('reports a PDF.js 401 to the application authentication state', async () => {
    const authenticationRequired = vi.fn()
    const unsubscribe = subscribeToAuthenticationRequired(authenticationRequired)
    getDocument.mockReturnValueOnce({
      promise: Promise.reject(
        new ResponseException('Unexpected server response (401).', 401),
      ),
      destroy: destroyLoadingTask,
    })

    try {
      await renderReopened()
      await waitFor(() => expect(authenticationRequired).toHaveBeenCalledOnce())
    } finally {
      unsubscribe()
    }
  })

  it('supports toolbar and keyboard zoom through the documented boundaries', async () => {
    await renderReopened()

    expect(await screen.findByText('/ 3')).toBeInTheDocument()
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' })
    const resetZoom = screen.getByRole('button', {
      name: 'Reset zoom to 100%',
    })
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })

    expect(resetZoom).toHaveTextContent('100%')
    fireEvent.keyDown(document, { key: '-', ctrlKey: true })
    expect(resetZoom).toHaveTextContent('50%')
    fireEvent.keyDown(document, { key: '+', ctrlKey: true })
    expect(resetZoom).toHaveTextContent('100%')

    for (let index = 0; index < 4; index += 1) fireEvent.click(zoomOut)
    expect(resetZoom).toHaveTextContent('10%')
    expect(zoomOut).toBeDisabled()

    fireEvent.keyDown(document, { key: '0', ctrlKey: true })
    expect(resetZoom).toHaveTextContent('100%')
    for (let index = 0; index < 5; index += 1) fireEvent.click(zoomIn)
    expect(resetZoom).toHaveTextContent('2500%')
    expect(zoomIn).toBeDisabled()

    fireEvent.click(resetZoom)
    expect(resetZoom).toHaveTextContent('100%')
  })

  it('renames the reopened schema from the schema/chat panel', async () => {
    const fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'PATCH')
          return Promise.resolve(
            Response.json({
              extractionSchema: {
                extractionSchemaId:
                  reopened.extractionSchema!.extractionSchemaId,
                name: 'Historic places',
                createdAt: '2026-08-01T12:00:00.000Z',
              },
            }),
          )
        return Promise.resolve(
          url.endsWith('/source')
            ? Response.json(parsedDocument)
            : new Response('# Beretning'),
        )
      },
    )
    vi.stubGlobal('fetch', fetch)
    render(<DocumentWorkspace {...reopened} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename schema Places' }))
    fireEvent.change(screen.getByLabelText('Schema name for Places'), {
      target: { value: ' Historic places ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save schema name' }))

    expect(
      await screen.findByRole('button', {
        name: 'Rename schema Historic places',
      }),
    ).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      `/api/extraction-schemas/${reopened.extractionSchema!.extractionSchemaId}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          projectContextId: reopened.projectContextId,
          name: 'Historic places',
        }),
      }),
    )
  })



  it.each([
    ['the parsed Markdown', '# Beretning'],
    ['that Markdown is unavailable', ''],
  ] as const)('switches the document pane to %s and back', async (_label, markdown) => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) =>
      Promise.resolve(String(input).endsWith('/source') ? Response.json(parsedDocument) : new Response(markdown))))
    render(<DocumentWorkspace {...reopened} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    const view = within(screen.getByRole('group', { name: 'Document view' }))
    expect(view.getByRole('button', { name: 'PDF' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByLabelText('Parsed Markdown')).not.toBeInTheDocument()

    fireEvent.click(view.getByRole('button', { name: 'Markdown' }))
    expect(view.getByRole('button', { name: 'Markdown' })).toHaveAttribute('aria-pressed', 'true')
    if (markdown) {
      expect(screen.getByLabelText('Parsed Markdown')).toHaveTextContent(markdown)
      expect(screen.queryByText('Markdown unavailable')).not.toBeInTheDocument()
    } else {
      expect(screen.getByText('Markdown unavailable')).toBeVisible()
      expect(screen.queryByLabelText('Parsed Markdown')).not.toBeInTheDocument()
    }
    // The PDF stays mounted under it.
    expect(document.querySelector('.pdfViewer')).toBeInTheDocument()

    fireEvent.click(view.getByRole('button', { name: 'PDF' }))
    expect(screen.queryByLabelText('Parsed Markdown')).not.toBeInTheDocument()
    expect(screen.queryByText('Markdown unavailable')).not.toBeInTheDocument()
  })

  it('persists a generated first schema and enables its history', async () => {
    const schemaRevisionId = '51000000-0000-4000-8005-000000000010'
    const extractionSchemaId = '51000000-0000-4000-8005-000000000011'
    let schemaNodes: unknown[] = []
    const renames: Array<{ projectContextId: string; name: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Response.json(parsedDocument)
        if (url.endsWith('/markdown')) return new Response('# Beretning')
        if (url.endsWith('/pdf')) return new Response(new Blob(['pdf']))
        if (url.endsWith('/api/generate_schema'))
          return Response.json({ template: { _description: 'One site record.', site: 'string' }, raw: '{}', pages: 1 })
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          schemaNodes = (JSON.parse(String(init.body)) as { schemaNodes: unknown[] }).schemaNodes
          return Response.json({
            revision: {
              schemaRevisionId,
              extractionSchemaId,
              revisionNumber: 1,
              origin: 'suggestion',
              createdAt: '2026-08-09T10:00:00.000Z',
              stabilisedAt: null,
              recordDescription: 'One site record.',
              recordScope: null,
              schemaNodes,
            },
          }, { status: 201 })
        }
        if (url.startsWith('/api/schema-revisions?'))
          return Response.json({
            revisions: [{
              schemaRevisionId,
              extractionSchemaId,
              revisionNumber: 1,
              origin: 'suggestion',
              createdAt: '2026-08-09T10:00:00.000Z',
              recordScope: null,
              stabilisedAt: null,
              summary: 'Initial schema',
            }],
          })
        if (url === `/api/extraction-schemas/${extractionSchemaId}` && init?.method === 'PATCH') {
          const rename = JSON.parse(String(init.body)) as { projectContextId: string; name: string }
          renames.push(rename)
          return Response.json({
            extractionSchema: { extractionSchemaId, name: rename.name, createdAt: '2026-08-09T10:00:00.000Z' },
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    render(<DocumentWorkspace {...reopened} extractionSchema={null} persistedExtraction={null} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate schema' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Schema actions' }))
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'History' })).toBeEnabled())
    expect(schemaNodes).toHaveLength(1)
    // A first schema is named after its Source Document.
    expect(await screen.findByRole('button', { name: 'Rename schema Beretning' })).toBeInTheDocument()
    // Fenced behind the name the server created the schema with (a later rename by anyone wins over it).
    expect(renames).toEqual([{ projectContextId: reopened.projectContextId, name: 'Beretning', expectedName: 'Extraction Schema' }])
  })

  // The first generation names the schema after its Source Document; a rename through the pencil meanwhile waits for
  // that save and is the name that stays, whatever the automatic save answers (Ruling: renames are serialized).
  it.each([
    ['succeeds', 'succeeds', 'Elmbrooke graves'],
    ['fails', 'succeeds', 'Elmbrooke graves'],
    ['fails', 'is refused', 'Extraction Schema'],
  ] as const)('the automatic first name %s late; a manual rename that %s meanwhile leaves "%s"', async (automatic, manual, expected) => {
    const schemaRevisionId = '51000000-0000-4000-8005-000000000040'
    const extractionSchemaId = '51000000-0000-4000-8005-000000000041'
    const patches: string[] = []
    let releaseAutomatic: (() => void) | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Response.json(parsedDocument)
        if (url.endsWith('/markdown')) return new Response('# Beretning')
        if (url.endsWith('/pdf')) return new Response(new Blob(['pdf']))
        if (url.endsWith('/api/generate_schema'))
          return Response.json({ template: { _description: 'One site record.', site: 'string' }, raw: '{}', pages: 1 })
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { schemaNodes: unknown[] }
          return Response.json({ revision: { schemaRevisionId, extractionSchemaId, revisionNumber: 1, origin: 'suggestion',
            createdAt: '2026-08-09T10:00:00.000Z', recordDescription: 'One site record.', recordScope: null, schemaNodes: body.schemaNodes } },
          { status: 201 })
        }
        if (url.startsWith('/api/schema-revisions?')) return Response.json({ revisions: [] })
        if (url.startsWith('/api/model-operations?')) return Response.json({ operations: [] })
        if (url === `/api/extraction-schemas/${extractionSchemaId}` && init?.method === 'PATCH') {
          const { name } = JSON.parse(String(init.body)) as { name: string }
          patches.push(name)
          if (name === 'Beretning') {
            await new Promise<void>((resolve) => { releaseAutomatic = resolve })
            if (automatic === 'fails') return Response.json({ error: { code: 'unavailable', message: 'Try again.' } }, { status: 503 })
          } else if (manual === 'is refused') {
            return Response.json({ error: { code: 'name_taken', message: 'That name is taken.' } }, { status: 409 })
          }
          return renamedSchema(url, init)
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    render(<DocumentWorkspace {...reopened} extractionSchema={null} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate schema' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Rename schema Beretning' }))
    await waitFor(() => expect(releaseAutomatic).not.toBeNull())
    fireEvent.change(screen.getByLabelText('Schema name for Beretning'), { target: { value: 'Elmbrooke graves' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save schema name' }))
    // The manual rename waits for the automatic one: the server applies them in the order they were asked for.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(patches).toEqual(['Beretning'])

    releaseAutomatic!()
    await waitFor(() => expect(patches).toEqual(['Beretning', 'Elmbrooke graves']))
    if (manual === 'is refused') {
      expect(await screen.findByRole('alert')).toHaveTextContent('That name is taken.')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel schema rename' }))
    }
    expect(await screen.findByRole('heading', { name: expected })).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.getByRole('heading', { name: expected })).toBeInTheDocument()
  })

  // A first name whose request never answers holds the renames behind it only until its time limit (20 s; shortened
  // here): the manual rename then goes out and its name shows. Meanwhile Escape closes the waiting editor.
  it.each(['kept open', 'closed with Escape'] as const)('a first name that never answers lets a manual rename go after its time limit (editor %s)', async (editor) => {
    const schemaRevisionId = '51000000-0000-4000-8005-000000000050'
    const extractionSchemaId = '51000000-0000-4000-8005-000000000051'
    const patches: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Response.json(parsedDocument)
        if (url.endsWith('/markdown')) return new Response('# Beretning')
        if (url.endsWith('/pdf')) return new Response(new Blob(['pdf']))
        if (url.endsWith('/api/generate_schema'))
          return Response.json({ template: { _description: 'One site record.', site: 'string' }, raw: '{}', pages: 1 })
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { schemaNodes: unknown[] }
          return Response.json({ revision: { schemaRevisionId, extractionSchemaId, revisionNumber: 1, origin: 'suggestion',
            createdAt: '2026-08-09T10:00:00.000Z', recordDescription: 'One site record.', recordScope: null, schemaNodes: body.schemaNodes } },
          { status: 201 })
        }
        if (url.startsWith('/api/schema-revisions?')) return Response.json({ revisions: [] })
        if (url.startsWith('/api/model-operations?')) return Response.json({ operations: [] })
        if (url === `/api/extraction-schemas/${extractionSchemaId}` && init?.method === 'PATCH') {
          const { name } = JSON.parse(String(init.body)) as { name: string }
          patches.push(name)
          // Never answers; like a real fetch, it gives up only when aborted.
          if (name === 'Beretning')
            return new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
            })
          return renamedSchema(url, init)
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    render(<DocumentWorkspace {...reopened} extractionSchema={null} persistedExtraction={null} automaticRenameTimeoutMs={1_000} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate schema' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Rename schema Beretning' }))
    await waitFor(() => expect(patches).toEqual(['Beretning']))
    fireEvent.change(screen.getByLabelText('Schema name for Beretning'), { target: { value: 'Elmbrooke graves' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save schema name' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(patches).toEqual(['Beretning'])
    if (editor === 'closed with Escape') {
      fireEvent.keyDown(screen.getByLabelText('Schema name for Beretning'), { key: 'Escape' })
      expect(screen.queryByLabelText('Schema name for Beretning')).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Beretning' })).toBeInTheDocument()
    }

    await waitFor(() => expect(patches).toEqual(['Beretning', 'Elmbrooke graves']), { timeout: 3_000 })
    expect(await screen.findByRole('heading', { name: 'Elmbrooke graves' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Schema name for/)).not.toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.getByRole('heading', { name: 'Elmbrooke graves' })).toBeInTheDocument()
  })

  // Giving up on the first name stops the browser's waiting, not the server's write: here its PATCH reaches the server's
  // write only after the manual rename was acknowledged. The automatic name is fenced behind the schema's creation name,
  // so the late write changes nothing and the manual name stays durable.
  it('a first name abandoned after its time limit cannot overwrite the manual name the server acknowledged meanwhile', async () => {
    const schemaRevisionId = '51000000-0000-4000-8005-000000000060'
    const extractionSchemaId = '51000000-0000-4000-8005-000000000061'
    let serverName = 'Extraction Schema'
    const bodies: Array<{ name: string; expectedName?: string }> = []
    let releaseWrite: (() => void) | null = null
    let heldWrite: Promise<void> | null = null
    /** The server's PATCH: an unfenced rename always applies; a fenced one only while the stored name is the expected. */
    const serverRename = (rename: { name: string; expectedName?: string }) => {
      if (rename.expectedName === undefined || rename.expectedName === serverName) serverName = rename.name
      return { extractionSchema: { extractionSchemaId, name: serverName, createdAt: '2026-08-09T10:00:00.000Z' } }
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Response.json(parsedDocument)
        if (url.endsWith('/markdown')) return new Response('# Beretning')
        if (url.endsWith('/pdf')) return new Response(new Blob(['pdf']))
        if (url.endsWith('/api/generate_schema'))
          return Response.json({ template: { _description: 'One site record.', site: 'string' }, raw: '{}', pages: 1 })
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { schemaNodes: unknown[] }
          return Response.json({ revision: { schemaRevisionId, extractionSchemaId, revisionNumber: 1, origin: 'suggestion',
            createdAt: '2026-08-09T10:00:00.000Z', recordDescription: 'One site record.', recordScope: null, schemaNodes: body.schemaNodes } },
          { status: 201 })
        }
        if (url.startsWith('/api/schema-revisions?')) return Response.json({ revisions: [] })
        if (url.startsWith('/api/model-operations?')) return Response.json({ operations: [] })
        if (url === `/api/extraction-schemas/${extractionSchemaId}` && init?.method === 'PATCH') {
          const rename = JSON.parse(String(init.body)) as { name: string; expectedName?: string }
          bodies.push(rename)
          if (rename.name === 'Beretning') {
            // The server's write waits; the browser gives up on it (an abort rejects only the client's promise).
            heldWrite = new Promise<void>((resolve) => { releaseWrite = resolve }).then(() => { serverRename(rename) })
            return new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
            })
          }
          return Response.json(serverRename(rename))
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    render(<DocumentWorkspace {...reopened} extractionSchema={null} persistedExtraction={null} automaticRenameTimeoutMs={1_000} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate schema' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Rename schema Beretning' }))
    await waitFor(() => expect(bodies.map(({ name }) => name)).toEqual(['Beretning']))
    fireEvent.change(screen.getByLabelText('Schema name for Beretning'), { target: { value: 'Custom' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save schema name' }))
    // After the time limit the manual rename goes out and the server applies it at once.
    await waitFor(() => expect(bodies.map(({ name }) => name)).toEqual(['Beretning', 'Custom']), { timeout: 3_000 })
    expect(await screen.findByRole('heading', { name: 'Custom' })).toBeInTheDocument()
    expect(serverName).toBe('Custom')

    // The abandoned write now reaches the server's database.
    releaseWrite!()
    await heldWrite
    expect(serverName).toBe('Custom')
    expect(bodies).toEqual([
      { projectContextId: reopened.projectContextId, name: 'Beretning', expectedName: 'Extraction Schema' },
      { projectContextId: reopened.projectContextId, name: 'Custom' },
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.getByRole('heading', { name: 'Custom' })).toBeInTheDocument()
  })

  it('saves a schema generated from excerpts with its declaration, and the reopened workspace shows it beside that source only', async () => {
    const excerpted = {
      complete: false, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }],
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
    }
    const notice = 'Suggested from excerpts: the middle of page 1 was not read (4,040 of 50,040 characters).'
    const written: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Response.json(parsedDocument)
        if (url.endsWith('/markdown')) return new Response('# Beretning')
        if (url.endsWith('/pdf')) return new Response(new Blob(['pdf']))
        if (url.endsWith('/api/generate_schema'))
          return Response.json({ template: { _description: 'One site record.', site: 'string' }, raw: '{}', pages: 1, sourceCoverage: excerpted })
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          written.push(body)
          return Response.json({
            revision: {
              schemaRevisionId: '51000000-0000-4000-8005-000000000030',
              extractionSchemaId: '51000000-0000-4000-8005-000000000031',
              revisionNumber: 1,
              origin: 'suggestion',
              createdAt: '2026-08-09T10:00:00.000Z',
              recordDescription: body.recordDescription,
              recordScope: (body as { recordScope?: string }).recordScope ?? null,
              schemaNodes: body.schemaNodes,
            },
          }, { status: 201 })
        }
        if (url.startsWith('/api/schema-revisions?')) return Response.json({ revisions: [] })
        if (url.startsWith('/api/model-operations?')) return Response.json({ operations: [] })
        if (url.startsWith('/api/extraction-schemas/') && init?.method === 'PATCH')
          return renamedSchema(url, init)
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    const generated = render(<DocumentWorkspace {...reopened} extractionSchema={null} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate schema' }))

    expect(await screen.findByText(notice)).toBeInTheDocument()
    expect(written.map((body) => body.sourceCoverage)).toEqual([excerpted])
    expect(await screen.findByRole('heading', { name: 'Beretning' })).toBeInTheDocument()
    generated.unmount()

    const saved = written[0] as { recordDescription: string; schemaNodes: SchemaNode[] }
    const workspace = (sourceRepresentationId: string) => (
      <DocumentWorkspace
        {...reopened}
        sourceRepresentationId={sourceRepresentationId}
        extractionSchema={{
          extractionSchemaId: '51000000-0000-4000-8005-000000000031',
          name: 'Extraction Schema',
          schemaRevisionId: '51000000-0000-4000-8005-000000000030',
          revisionNumber: 1,
          recordDescription: saved.recordDescription,
          recordScope: null,
          schemaNodes: saved.schemaNodes,
          sourceCoverage: excerpted as NonNullable<typeof reopened.extractionSchema>['sourceCoverage'],
        }}
        persistedExtraction={null}
      />
    )
    const view = render(workspace(reopened.sourceRepresentationId))
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    expect(await screen.findByText(notice)).toBeInTheDocument()

    // Another Source Document of the project shares the schema, not the declaration.
    view.rerender(workspace('51000000-0000-4000-8002-0000000000ff'))
    await waitFor(() => expect(screen.queryByText(notice)).not.toBeInTheDocument())
  })

  it('keeps cancelled fields and historical previews non-mutating until explicit creation', async () => {
    const currentRevisionId = '51000000-0000-4000-8005-000000000020'
    const historicalRevisionId = '51000000-0000-4000-8005-000000000019'
    const currentNodes: SchemaNode[] = [{ id: 'current-field', name: 'current_field', type: 'string' }]
    const historicalNodes: SchemaNode[] = [
      {
        id: 'stable-group',
        name: 'historical_group',
        type: 'object',
        children: [{ id: 'stable-leaf', name: 'historical_leaf', type: 'number' }],
      },
      { id: 'stable-title', name: 'historical_title', type: 'string' },
    ]
    const requests: Array<{ url: string; method?: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        requests.push({ url, method, body })
        if (url.endsWith('/source')) return Response.json(parsedDocument)
        if (url.endsWith('/markdown')) return new Response('# Beretning')
        if (url.endsWith('/pdf')) return new Response(new Blob(['pdf']))
        if (url.startsWith('/api/schema-revisions?')) {
          return Response.json({
            revisions: [
              {
                schemaRevisionId: currentRevisionId,
                extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
                revisionNumber: 2,
                origin: 'researcher-edit',
                createdAt: '2026-08-09T10:01:00.000Z',
                recordScope: 'document',
                stabilisedAt: null,
                summary: 'Current schema',
              },
              {
                schemaRevisionId: historicalRevisionId,
                extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
                revisionNumber: 1,
                origin: 'suggestion',
                createdAt: '2026-08-09T10:00:00.000Z',
                recordScope: 'document',
                stabilisedAt: null,
                summary: 'Initial schema',
              },
            ],
          })
        }
        if (url.startsWith(`/api/schema-revisions/${historicalRevisionId}?`)) {
          return Response.json({
            revision: {
              schemaRevisionId: historicalRevisionId,
              extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
              revisionNumber: 1,
              origin: 'suggestion',
              createdAt: '2026-08-09T10:00:00.000Z',
              stabilisedAt: null,
              recordDescription: 'One historical record.',
              recordScope: 'document',
              schemaNodes: historicalNodes,
            },
          })
        }
        if (url === '/api/schema-revisions' && method === 'POST') {
          const request = body as { expectedRevisionNumber: number; recordDescription: string; schemaNodes: unknown[] }
          return Response.json({
            revision: {
              schemaRevisionId: request.expectedRevisionNumber === 2
                ? '51000000-0000-4000-8005-000000000021'
                : '51000000-0000-4000-8005-000000000022',
              extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
              revisionNumber: request.expectedRevisionNumber + 1,
              origin: 'researcher-edit',
              createdAt: '2026-08-09T10:02:00.000Z',
              stabilisedAt: null,
              recordDescription: request.recordDescription,
              recordScope: (request as { recordScope?: string }).recordScope ?? 'document',
              schemaNodes: request.schemaNodes,
            },
          }, { status: 201 })
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    render(<DocumentWorkspace
      {...reopened}
      persistedExtraction={null}
      extractionSchema={{
        ...reopened.extractionSchema!,
        schemaRevisionId: currentRevisionId,
        revisionNumber: 2,
        schemaNodes: currentNodes,
      }}
    />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'History' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))

    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'unsaved field' } })
    fireEvent.keyDown(screen.getByPlaceholderText('field_name'), { key: 'Escape' })
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Schema history' })).getByRole('button', { name: /Revision 1/ }))

    expect(await screen.findByText('historical_group')).toBeInTheDocument()
    expect(screen.getByText('historical_title')).toBeInTheDocument()
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '+ Add field' })).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Create Current Schema Revision' }),
    )

    await waitFor(() => expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1))
    const getIndex = requests.findIndex((request) =>
      request.url.startsWith(`/api/schema-revisions/${historicalRevisionId}?`),
    )
    const postRequests = requests.filter((request) => request.method === 'POST')
    expect(getIndex).toBeGreaterThan(-1)
    expect(requests.indexOf(postRequests[0])).toBeGreaterThan(getIndex)
    expect((postRequests[0].body as { expectedRevisionNumber: number }).expectedRevisionNumber).toBe(2)
    expect(postRequests[0].body).toEqual({
      projectContextId: reopened.projectContextId,
      extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
      expectedRevisionNumber: 2,
      recordDescription: 'One historical record.',
      schemaNodes: historicalNodes,
      // Restored content is not the current suggestion's: the new revision records no source declaration.
      sourceCoverage: null,
    })
    expect(screen.getByText('historical_group')).toBeInTheDocument()
    expect(screen.getByText('historical_title')).toBeInTheDocument()
    expect(screen.queryByText('unsaved_field')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('field_name')).not.toBeInTheDocument()
  })

  it('flushes edits before clearing, then regenerates onto the existing schema', async () => {
    const savedRevisionId = '51000000-0000-4000-8005-000000000012'
    const regeneratedRevisionId = '51000000-0000-4000-8005-000000000013'
    const schemaPosts: Array<{
      extractionSchemaId: string
      expectedRevisionNumber: number
      recordDescription: string
      schemaNodes: SchemaNode[]
    }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Response.json(parsedDocument)
        if (url.endsWith('/markdown')) return new Response('# Beretning')
        if (url.endsWith('/pdf')) return new Response(new Blob(['pdf']))
        if (url.endsWith('/api/generate_schema')) {
          return Response.json({
            template: { _description: 'A regenerated place record.', locality: 'string' },
            raw: '{}',
            pages: 1,
          })
        }
        if (url.startsWith('/api/schema-revisions?')) return Response.json({ revisions: [] })
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          const request = JSON.parse(String(init.body)) as typeof schemaPosts[number]
          schemaPosts.push(request)
          return Response.json({
            revision: {
              schemaRevisionId: request.expectedRevisionNumber === 1
                ? savedRevisionId
                : regeneratedRevisionId,
              extractionSchemaId: request.extractionSchemaId,
              revisionNumber: request.expectedRevisionNumber + 1,
              origin: 'researcher-edit',
              createdAt: '2026-08-14T10:00:00.000Z',
              stabilisedAt: null,
              recordDescription: request.recordDescription,
              recordScope: (request as { recordScope?: string }).recordScope ?? 'document',
              schemaNodes: request.schemaNodes,
            },
          }, { status: 201 })
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'locality' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear schema' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Clear current schema' })).getByRole('button', { name: 'Clear schema' }))

    expect(await screen.findByText('No schema yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Generate schema' }))

    await waitFor(() => expect(schemaPosts).toHaveLength(2), { timeout: 2_000 })
    expect(schemaPosts[0]).toMatchObject({
      extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
      expectedRevisionNumber: 1,
    })
    expect(schemaPosts[1]).toMatchObject({
      extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
      expectedRevisionNumber: 2,
    })
  })

  it('hydrates the Extraction Schema and Extraction Result', async () => {
    await renderReopened()

    // The Schema tab's badge is the field count derived from the reopened template.
    expect(screen.getByRole('tab', { name: /^Schema\s*1$/ })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '▶ Run extraction' }),
    ).toBeInTheDocument()
  })

  it('uses the active Source Document for model edits after a workspace switch', async () => {
    const nextSourceRepresentationId =
      '51000000-0000-4000-8002-000000000099'
    let requestedSourceRepresentationId: FormDataEntryValue | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source'))
          return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown'))
          return Promise.resolve(new Response('# Beretning'))
        if (url.endsWith('/edit_schema')) {
          const form = init?.body as FormData
          requestedSourceRepresentationId = form.get(
            'source_representation_revision_id',
          )
          return Promise.resolve(
            Response.json({ status: 'refused', message: 'No edit.' }),
          )
        }
        if (url.startsWith('/api/schema-revisions?'))
          return Promise.resolve(Response.json({ revisions: [] }))
        return Promise.resolve(new Response('pdf'))
      }),
    )
    const { rerender } = render(
      <DocumentWorkspace {...reopened} persistedExtraction={null} />,
    )
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )

    rerender(
      <DocumentWorkspace
        {...reopened}
        sourceRepresentationId={nextSourceRepresentationId}
        pdfUrl={`/sources/${nextSourceRepresentationId}/pdf`}
        markdownUrl={`/sources/${nextSourceRepresentationId}/markdown`}
        parsedDocumentUrl={`/sources/${nextSourceRepresentationId}/source`}
        persistedExtraction={null}
      />,
    )
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    const input = screen.getByPlaceholderText(
      'Describe a change to the schema…',
    )
    fireEvent.change(input, { target: { value: 'Rename place' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Request refused: No edit.')).toBeVisible()
    expect(requestedSourceRepresentationId).toBe(
      nextSourceRepresentationId,
    )
  })

  // The tab strip's Run is the only run (decision 03); the Results tab no longer offers a second surface to test.
  it('waits for a dirty schema save before starting an Article rerun from the tab strip', async () => {
    const savedSchemaRevisionId = '51000000-0000-4000-8005-000000000099'
    let resolveExtraction!: (response: Response) => void
    const extractionResponse = new Promise<Response>((resolve) => {
      resolveExtraction = resolve
    })
    const extractionRequests: Array<{ strategy?: string; schemaRevisionId?: string }> = []
    const cancellationRequests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          const request = JSON.parse(String(init.body)) as {
            recordDescription: string
            schemaNodes: SchemaNode[]
          }
          return Promise.resolve(Response.json({
            revision: {
              schemaRevisionId: savedSchemaRevisionId,
              extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
              revisionNumber: 2,
              origin: 'researcher-edit',
              createdAt: '2026-08-12T00:00:00.000Z',
              stabilisedAt: null,
              recordDescription: request.recordDescription,
              recordScope: (request as { recordScope?: string }).recordScope ?? 'document',
              schemaNodes: request.schemaNodes,
            },
          }, { status: 201 }))
        }
        if (url.startsWith('/api/extractions/') && init?.method === 'DELETE') {
          cancellationRequests.push(url)
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        if (url.endsWith('/api/extractions')) {
          extractionRequests.push(JSON.parse(String(init?.body)) as { strategy?: string; schemaRevisionId?: string })
          return extractionResponse
        }
        return Promise.resolve(new Response('# Beretning'))
      }),
    )
    render(<DocumentWorkspace {...reopened} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit place' }))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'location' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const run = screen.getByRole('button', { name: '▶ Run extraction' })
    fireEvent.click(run)
    fireEvent.click(run)
    await waitFor(() => expect(run).toBeDisabled())

    await waitFor(() => expect(extractionRequests).toHaveLength(1))
    expect(extractionRequests[0]).toEqual(expect.objectContaining({
      strategy: 'ARTICLE',
      schemaRevisionId: savedSchemaRevisionId,
      startPage: 1,
    }))

    resolveExtraction(Response.json({
      extractionId: '51000000-0000-4000-8006-000000000011',
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      schemaRevisionId: savedSchemaRevisionId,
      strategy: 'ARTICLE', catalogRecipe: null, executionStatus: 'COMPLETED', finalizedReview: null, requestedSettings: null, requestedModels: null, batchExtractionId: null,
      createdAt: '2026-08-10T00:00:00.000Z' }))
    expect(
      await screen.findByText(
        '↻ Re-run complete — review it in the Results tab',
      ),
    ).toBeVisible()
    expect(extractionRequests).toHaveLength(1)
    expect(cancellationRequests).toEqual([])
  })


  it('navigates a long document with the keyboard and offers no sample controls', async () => {
    getDocument.mockReturnValueOnce({
      promise: Promise.resolve({ numPages: 120 }),
      destroy: destroyLoadingTask,
    })
    await renderReopened()
    const navigation = within(await screen.findByRole('navigation', { name: 'Page navigation' }))
    const firstPage = navigation.getByRole('button', { name: 'Go to page 1' })
    expect(navigation.getAllByRole('button', { name: /^Go to page/ })[0]!.querySelector('canvas')).toBeInTheDocument()
    // The mocked document has no getPage, so the thumbnail render fails and the card stays blank.
    await waitFor(() => expect(firstPage.querySelector('canvas')).toHaveAttribute('data-thumbnail', 'unavailable'))
    firstPage.focus()
    fireEvent.keyDown(firstPage, { key: 'End' })
    const lastPage = navigation.getByRole('button', { name: 'Go to page 120' })
    expect(lastPage).toHaveFocus()
    expect(lastPage).toHaveAttribute('aria-current', 'page')
    expect(firstPage).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(lastPage, { key: 'ArrowUp' })
    expect(navigation.getByRole('button', { name: 'Go to page 119' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(firstPage).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Select sample pages' })).not.toBeInTheDocument()
    expect(navigation.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryByText(/admitted samples/)).not.toBeInTheDocument()
    fireEvent.keyDown(firstPage, { key: 'Escape' })
    expect(screen.queryByRole('navigation', { name: 'Page navigation' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pages' })).toHaveFocus()
  })

  it.each([[null], ['numbered-catalogue-de@1']])('saves Catalog as the schema\'s record scope and runs it with record boundaries (%s); only the boundaries are one-shot', async (recipe) => {
    const extractionRequests: Array<{ strategy?: string; catalogRecipe?: string; schemaRevisionId?: string }> = []
    const writes: RevisionWrite[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?'))
          return Promise.resolve(Response.json({ revisions: [] }))
        if (url === '/api/schema-revisions' && init?.method === 'POST')
          return Promise.resolve(appendRevision(init, writes))
        if (url.endsWith('/api/extractions')) {
          const body = JSON.parse(String(init?.body)) as { strategy?: string; catalogRecipe?: string }
          extractionRequests.push(body)
          return Promise.resolve(Response.json({
            extractionId: '51000000-0000-4000-8006-000000000021',
            sourceDocumentId: '51000000-0000-4000-8001-000000000001',
            sourceRepresentationRevisionId: reopened.sourceRepresentationId,
            schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
            strategy: 'CATALOG', catalogRecipe: body.catalogRecipe ?? null,
            executionStatus: 'COMPLETED',
            finalizedReview: null,
            requestedSettings: null,
            requestedModels: null,
            batchExtractionId: null,
            createdAt: '2026-08-12T00:00:00.000Z' }, { status: 201 }))
        }
        return Promise.resolve(new Response('pdf'))
      }),
    )
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    const selector = screen.getByLabelText('Record scope')
    expect(selector).toHaveValue('document')
    // The Boundaries choice appears only for a Catalog; generic model discovery stays the default.
    expect(screen.queryByLabelText('Boundaries')).not.toBeInTheDocument()
    fireEvent.change(selector, { target: { value: 'records' } })
    const boundaries = screen.getByLabelText('Boundaries')
    expect(boundaries).toHaveValue('')
    if (recipe) fireEvent.change(boundaries, { target: { value: recipe } })
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))

    await waitFor(() => expect(extractionRequests).toHaveLength(1))
    // Catalog is a schema change: the run flushes it as a revision that names the scope, then runs that revision.
    expect(writes).toEqual([expect.objectContaining({ expectedRevisionNumber: 1, recordScope: 'records' })])
    expect(extractionRequests[0]).toEqual(
      expect.objectContaining({ strategy: 'CATALOG', schemaRevisionId: appendedRevisionId(2) }),
    )
    if (recipe) expect(extractionRequests[0].catalogRecipe).toBe(recipe)
    else expect(extractionRequests[0]).not.toHaveProperty('catalogRecipe')
    // The schema stays a Catalog; only the boundaries return to model discovery.
    await waitFor(() => expect(screen.getByLabelText('Boundaries')).toHaveValue(''))
    expect(screen.getByLabelText('Record scope')).toHaveValue('records')
  })

  it('with the unified Catalog enabled, a Catalog start offers no recipe and submits the unified method', async () => {
    const before = saved.state
    saved.state = { ...(before as Extract<typeof before, { status: 'ready' }>), unifiedCatalog: true }
    try {
      const extractionRequests: Array<Record<string, unknown>> = []
      vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
        if (url === '/api/schema-revisions' && init?.method === 'POST') return Promise.resolve(appendRevision(init))
        if (url.endsWith('/api/extractions')) {
          extractionRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return Promise.resolve(Response.json({ error: { code: 'method_changed', message: 'Stale.' } }, { status: 409 }))
        }
        return Promise.resolve(new Response('pdf'))
      }))
      render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
      await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
      fireEvent.change(screen.getByLabelText('Record scope'), { target: { value: 'records' } })
      expect(screen.queryByLabelText('Boundaries')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      // The stub refuses every run as method_changed: the click re-reads the saved method and retries once.
      await waitFor(() => expect(extractionRequests).toHaveLength(2))
      for (const request of extractionRequests) {
        expect(request).toMatchObject({ strategy: 'CATALOG', method: { models: null, settings: { unified: { defaults: 2 } } } })
        expect(request).not.toHaveProperty('catalogRecipe')
      }
      expect(await screen.findByText('Your saved settings changed. Run again.')).toBeInTheDocument()
    } finally {
      saved.state = before
    }
  })

  describe('Results-tab run action after a Catalog attempt', () => {
    // Every Results-tab run action posts the schema's saved Article/Catalog
    // scope with the toolbar's one-shot boundaries: after a Catalog run the
    // schema stays a Catalog and boundaries return to Model discovery — unless
    // the run failed, which repeats that attempt's recipe.
    const catalogAttempts: Record<'FAILED' | 'SUCCEEDED', ExtractionAttempt> = {
      FAILED: {
        extractionId: '51000000-0000-4000-8006-000000000041',
        sourceDocumentId: '51000000-0000-4000-8001-000000000001',
        sourceRepresentationRevisionId: reopened.sourceRepresentationId,
        schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
        strategy: 'CATALOG', catalogRecipe: null, executionStatus: 'FAILED', finalizedReview: null, requestedSettings: null, requestedModels: null, batchExtractionId: null,
        createdAt: '2026-08-12T00:00:00.000Z' },
      SUCCEEDED: {
        extractionId: '51000000-0000-4000-8006-000000000042',
        sourceDocumentId: '51000000-0000-4000-8001-000000000001',
        sourceRepresentationRevisionId: reopened.sourceRepresentationId,
        schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
        strategy: 'CATALOG', catalogRecipe: null, executionStatus: 'COMPLETED', finalizedReview: null, requestedSettings: null, requestedModels: null, batchExtractionId: null,
        createdAt: '2026-08-12T00:00:00.000Z' },
    }

    /** The exact body a run from this workspace posts for a toolbar selection. Choosing Catalog on the reopened Article
     *  schema saved revision 2, and every Catalog run here runs it. */
    const posted = (strategy: 'ARTICLE' | 'CATALOG', catalogRecipe?: string) => ({
      id: expect.any(String),
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      startPage: 1,
      schemaRevisionId: strategy === 'CATALOG' ? appendedRevisionId(2) : reopened.extractionSchema!.schemaRevisionId,
      strategy,
      ...(catalogRecipe ? { catalogRecipe } : {}),
      // The saved method of the run's own settings slot: the account keeps every service default.
      method: {
        models: null,
        settings: strategy === 'ARTICLE' ? { article: null } : catalogRecipe ? { recipe: null } : { generic: null },
      },
    })

    /** Answers every run with a terminal attempt of the posted strategy and keeps each request body. */
    function stubRuns(outcome: 'FAILED' | 'SUCCEEDED') {
      const bodies: Array<{ id: string; strategy: 'ARTICLE' | 'CATALOG'; schemaRevisionId: string }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const durable = durableRead(url)
          if (durable) return Promise.resolve(durable)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?'))
            return Promise.resolve(Response.json({ revisions: [] }))
          if (url === '/api/schema-revisions' && init?.method === 'POST')
            return Promise.resolve(appendRevision(init))
          if (url.endsWith('/api/extractions') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { id: string; strategy: 'ARTICLE' | 'CATALOG'; schemaRevisionId: string }
            bodies.push(body)
            return Promise.resolve(Response.json(
              { ...catalogAttempts[outcome], extractionId: body.id, strategy: body.strategy, schemaRevisionId: body.schemaRevisionId },
              { status: 201 },
            ))
          }
          return Promise.resolve(new Response('pdf'))
        }),
      )
      return bodies
    }

    async function renderWorkspace(persistedExtraction: DocumentWorkspaceProps['persistedExtraction']) {
      render(<DocumentWorkspace {...reopened} persistedExtraction={persistedExtraction} />)
      await waitFor(() =>
        expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
      )
    }

    /** Saves Catalog and starts a run from the toolbar; acknowledging it resets the one-shot boundaries, unless it
     *  failed. The schema stays a Catalog. */
    async function runCatalogFromToolbar(bodies: unknown[], recipe?: string, nextRecipe = '') {
      fireEvent.change(screen.getByLabelText('Record scope'), { target: { value: 'records' } })
      if (recipe)
        fireEvent.change(screen.getByLabelText('Boundaries'), { target: { value: recipe } })
      expect(screen.getByRole('button', { name: '▶ Run extraction' }))
        .toHaveAttribute('title', 'Find the catalogue entries and extract one record per entry')
      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]).toEqual(posted('CATALOG', recipe))
      await waitFor(() =>
        expect(screen.getByLabelText('Boundaries')).toHaveValue(nextRecipe),
      )
      expect(screen.getByLabelText('Record scope')).toHaveValue('records')
    }

    /** The one run (decision 03): the tab strip's, titled for the schema's strategy (decision 05). Results, opened,
     *  offers no run of its own. */
    function tabStripRun(strategy: 'ARTICLE' | 'CATALOG') {
      fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
      expect(screen.queryByRole('button', { name: /^Run (Article |Catalog )?extraction/ })).not.toBeInTheDocument()
      const run = screen.getByRole('button', { name: '▶ Run extraction' })
      expect(run).toHaveAttribute('title', strategy === 'CATALOG'
        ? 'Find the catalogue entries and extract one record per entry'
        : 'Extract one record from the whole document')
      return run
    }

    it('titles and posts the schema\'s Catalog after a Catalog run that succeeds', async () => {
      const bodies = stubRuns('SUCCEEDED')
      await renderWorkspace(null)
      await runCatalogFromToolbar(bodies)
      // Its completion is a toast with Review now, not a dialog to dismiss (decision 04).
      expect(await screen.findByRole('button', { name: 'Review now' })).toBeInTheDocument()
      expect(screen.queryByRole('dialog', { name: 'Extraction finished' })).not.toBeInTheDocument()

      expect(screen.getByLabelText('Boundaries')).toHaveDisplayValue('Model discovery')
      fireEvent.click(tabStripRun('CATALOG'))
      await waitFor(() => expect(bodies).toHaveLength(2))
      expect(bodies[1]).toEqual(posted('CATALOG'))
    })


    it('titles and posts the schema\'s Article after reopening a completed Catalog attempt', async () => {
      const bodies = stubRuns('SUCCEEDED')
      await renderWorkspace({
        ...catalogAttempts.SUCCEEDED,
        sourceRepresentation: reopened.persistedExtraction!.sourceRepresentation,
        extractionSchema: reopened.persistedExtraction!.extractionSchema,
      })
      expect(screen.getByLabelText('Record scope')).toHaveValue('document')

      const run = tabStripRun('ARTICLE')
      // Results shows the reopened Catalog attempt's saved values, not an empty workspace.
      expect(await screen.findByText('Elmbrooke')).toBeVisible()
      fireEvent.click(run)
      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]).toEqual(posted('ARTICLE'))
    })

    it.each([
      ['selects the recipe again', 'numbered-catalogue-de@1', 'Numbered catalogue (German)'],
      ['keeps Model discovery', undefined, 'Model discovery'],
    ] as const)('after a recipe run, titles and posts Catalog as the researcher %s', async (_label, recipe, boundaries) => {
      const bodies = stubRuns('SUCCEEDED')
      await renderWorkspace(null)
      await runCatalogFromToolbar(bodies, 'numbered-catalogue-de@1')
      // The recipe is one-shot: the schema stays a Catalog, and its next run starts at Model discovery.
      expect(screen.getByLabelText('Boundaries')).toHaveValue('')
      expect(screen.getByLabelText('Boundaries')).toHaveDisplayValue('Model discovery')
      if (recipe)
        fireEvent.change(screen.getByLabelText('Boundaries'), { target: { value: recipe } })

      // The schema header names the boundaries the run posts; the Results tab no longer repeats them.
      expect(screen.getByLabelText('Boundaries')).toHaveDisplayValue(boundaries)
      expect(screen.queryByText(/^Boundaries: /)).not.toBeInTheDocument()
      fireEvent.click(tabStripRun('CATALOG'))
      await waitFor(() => expect(bodies).toHaveLength(2))
      expect(bodies[1]).toEqual(posted('CATALOG', recipe))
    })
  })

  describe('the strategy is the schema\'s saved record scope', () => {
    /** A workspace whose fetches answer revision writes (kept) and runs (kept, each refused or queued as given). */
    function stubWorkspace(run: (body: Record<string, unknown>) => Response = (body) => Response.json({
      extractionId: body.id,
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      schemaRevisionId: body.schemaRevisionId,
      strategy: body.strategy, catalogRecipe: null,
      executionStatus: 'COMPLETED',
      finalizedReview: null,
      requestedSettings: null,
      requestedModels: null,
      batchExtractionId: null, createdAt: '2026-08-12T00:00:00.000Z' }, { status: 201 }), headScope = reopened.extractionSchema!.recordScope) {
      const writes: RevisionWrite[] = []
      const runs: Array<Record<string, unknown>> = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const durable = durableRead(url)
          if (durable) return Promise.resolve(durable)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?'))
            return Promise.resolve(Response.json({ revisions: [] }))
          if (url === '/api/schema-revisions' && init?.method === 'POST')
            return Promise.resolve(appendRevision(init, writes, headScope))
          if (url.endsWith('/api/extractions') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>
            runs.push(body)
            return Promise.resolve(run(body))
          }
          return Promise.resolve(new Response('pdf'))
        }),
      )
      return { writes, runs }
    }

    async function renderWith(extractionSchema: DocumentWorkspaceProps['extractionSchema']) {
      render(<DocumentWorkspace {...reopened} extractionSchema={extractionSchema} persistedExtraction={null} />)
      await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    }

    it('shows the revision\'s scope, and a legacy revision with none waits for a choice that is saved before Run', async () => {
      const { writes, runs } = stubWorkspace()
      await renderWith({ ...reopened.extractionSchema!, recordScope: null })

      const selector = screen.getByLabelText('Record scope')
      expect(selector).toHaveValue('')
      // The schema header's own choice explains the two scopes; Run points at it.
      expect(screen.getByRole('option', { name: 'Choose Article or Catalog' })).toBeDisabled()
      expect(screen.getByRole('option', { name: 'Article · one object for the document' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Catalog · a collection of records' })).toBeInTheDocument()
      const run = screen.getByRole('button', { name: '▶ Run extraction' })
      expect(run).toBeDisabled()
      expect(run).toHaveAttribute('title', 'Choose Article or Catalog in the schema header')
      fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
      // The Results tab offers no run of its own (decision 03).
      expect(screen.queryByRole('button', { name: /^Run (Article |Catalog )?extraction/ })).not.toBeInTheDocument()

      fireEvent.change(selector, { target: { value: 'records' } })
      expect(selector).toHaveValue('records')
      await waitFor(() => expect(run).toBeEnabled())
      fireEvent.click(run)

      await waitFor(() => expect(runs).toHaveLength(1))
      expect(writes).toEqual([expect.objectContaining({ expectedRevisionNumber: 1, recordScope: 'records' })])
      expect(runs[0]).toMatchObject({ strategy: 'CATALOG', schemaRevisionId: appendedRevisionId(2) })
      expect(selector).toHaveValue('records')
    })

    it('keeps the scope through a schema edit: the append names none and the server keeps the head\'s', async () => {
      const { writes, runs } = stubWorkspace(undefined, 'records')
      await renderWith({ ...reopened.extractionSchema!, recordScope: 'records' })
      expect(screen.getByLabelText('Record scope')).toHaveValue('records')

      fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Edit place' }))
      fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'location' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))

      await waitFor(() => expect(runs).toHaveLength(1))
      expect(writes).toHaveLength(1)
      expect(writes[0]).not.toHaveProperty('recordScope')
      expect(runs[0]).toMatchObject({ strategy: 'CATALOG', schemaRevisionId: appendedRevisionId(2) })
      expect(screen.getByLabelText('Record scope')).toHaveValue('records')
    })

    /** Renames the `place` field in the Schema tab: a field edit the 1500 ms debounce holds. */
    function renamePlaceField() {
      fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Edit place' }))
      fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'location' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    }

    it('saves a scope change at once, with the pending field edit in the same revision, and shows the save state', async () => {
      const { writes } = stubWorkspace()
      await renderWith(reopened.extractionSchema)
      renamePlaceField()
      // The toolbar and the Schema panel's footer both show the save state.
      expect(screen.getAllByText('Unsaved changes')).toHaveLength(2)
      expect(writes).toHaveLength(0)

      fireEvent.change(screen.getByLabelText('Record scope'), { target: { value: 'records' } })

      // Well inside the debounce: the scope does not wait for it, and it carries the edit.
      await waitFor(() => expect(writes).toHaveLength(1))
      expect(writes[0]).toMatchObject({
        expectedRevisionNumber: 1,
        recordScope: 'records',
        schemaNodes: [expect.objectContaining({ name: 'location' })],
      })
      await waitFor(() => expect(screen.queryAllByText('Unsaved changes')).toHaveLength(0))
      expect(screen.queryAllByText('Saving…')).toHaveLength(0)
      expect(screen.getByLabelText('Record scope')).toHaveValue('records')
    })

    it('shows a failed scope save, refuses Run until Retry saves it, then runs the saved revision', async () => {
      const { writes, runs } = stubWorkspace()
      const answer = vi.mocked(fetch).getMockImplementation()!
      let failNextWrite = true
      vi.mocked(fetch).mockImplementation((input, init) => {
        if (String(input) === '/api/schema-revisions' && init?.method === 'POST' && failNextWrite) {
          failNextWrite = false
          return Promise.resolve(Response.json(
            { error: { code: 'unavailable', message: 'The database is unavailable.' } },
            { status: 503 },
          ))
        }
        return answer(input, init)
      })
      await renderWith(reopened.extractionSchema)
      const run = screen.getByRole('button', { name: '▶ Run extraction' })

      fireEvent.change(screen.getByLabelText('Record scope'), { target: { value: 'records' } })
      // One alert and one Retry, the toolbar's (reachable with the Schema tab hidden); the Schema panel's footer says it
      // as status text.
      const schemaPanel = screen.getByRole('tabpanel', { name: /^Schema/ })
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(/^Not saved: .*The database is unavailable\.$/)
      expect(schemaPanel).not.toContainElement(alert)
      expect(schemaPanel).not.toContainElement(screen.getByRole('button', { name: 'Retry save' }))
      expect(
        within(schemaPanel).getAllByRole('status')
          .some((status) => /^Not saved: .*The database is unavailable\.$/.test(status.textContent ?? '')),
      ).toBe(true)
      expect(run).toBeDisabled()
      expect(run).toHaveAttribute('title', 'The schema is not saved. Retry the save first.')
      expect(screen.getByLabelText('Record scope')).toHaveValue('records')

      fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
      await waitFor(() => expect(writes).toHaveLength(1))
      expect(writes[0]).toMatchObject({ expectedRevisionNumber: 1, recordScope: 'records' })
      await waitFor(() => expect(run).toBeEnabled())
      expect(screen.queryAllByRole('alert')).toHaveLength(0)

      fireEvent.click(run)
      await waitFor(() => expect(runs).toHaveLength(1))
      expect(runs[0]).toMatchObject({ strategy: 'CATALOG', schemaRevisionId: appendedRevisionId(2) })
    })

    it('starts the pending save when the workspace closes instead of dropping the edit', async () => {
      const { writes } = stubWorkspace()
      render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
      await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
      renamePlaceField()
      expect(writes).toHaveLength(0)

      cleanup()

      await waitFor(() => expect(writes).toHaveLength(1))
      expect(writes[0]).toMatchObject({ expectedRevisionNumber: 1, schemaNodes: [expect.objectContaining({ name: 'location' })] })
      expect(writes[0]).not.toHaveProperty('recordScope')
    })

    it.each([
      ['record_scope_mismatch', 'The schema is saved as a Catalog; refresh to run it.'],
      ['record_scope_required', 'Choose Article or Catalog for this schema before it can run.'],
    ])('shows a %s refusal with the server\'s message as a notice, and starts nothing', async (code, message) => {
      const { runs } = stubWorkspace(() => Response.json({ error: { code, message } }, { status: 409 }))
      await renderWith(reopened.extractionSchema)

      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      // The workspace's toast over the PDF says it in the server's own words, without the code.
      const notice = await within(screen.getByRole('region', { name: 'PDF document' })).findByText(message)
      expect(notice.closest('[role="status"]')?.textContent).toBe(message)
      // Only a changed method is retried.
      expect(runs).toHaveLength(1)
      expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled()
      expect(screen.queryByText(/Extraction failed/)).not.toBeInTheDocument()
    })

    it('a schema a suggestion initializes without a scope waits for the header\'s choice, saved before Run', async () => {
      const written: Array<Record<string, unknown>> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const durable = durableRead(url)
          if (durable) return Promise.resolve(durable)
          if (url.endsWith('/source')) return Response.json(parsedDocument)
          if (url.endsWith('/markdown')) return new Response('# Beretning')
          if (url.endsWith('/pdf')) return new Response(new Blob(['pdf']))
          if (url.endsWith('/api/generate_schema'))
            return Response.json({ template: { _description: 'One site record.', site: 'string' }, raw: '{}', pages: 1 })
          if (url === '/api/schema-revisions' && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>
            written.push(body)
            return Response.json({
              revision: {
                schemaRevisionId: `51000000-0000-4000-8005-0000000000${40 + written.length * 2}`,
                extractionSchemaId: '51000000-0000-4000-8005-000000000041',
                revisionNumber: written.length,
                origin: written.length === 1 ? 'suggestion' : 'researcher-edit',
                createdAt: '2026-08-09T10:00:00.000Z',
                recordDescription: body.recordDescription,
                recordScope: body.recordScope ?? null,
                schemaNodes: body.schemaNodes,
              },
            }, { status: 201 })
          }
          if (url.startsWith('/api/schema-revisions?')) return Response.json({ revisions: [] })
          if (url.startsWith('/api/extraction-schemas/') && init?.method === 'PATCH')
            return renamedSchema(url, init)
          throw new Error(`Unexpected request: ${url}`)
        }),
      )
      await renderWith(null)
      // The scope is chosen in the schema header, which exists once there is a schema.
      expect(screen.queryByLabelText('Record scope')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Generate schema' }))
      await waitFor(() => expect(written).toHaveLength(1))
      expect(written[0]).not.toHaveProperty('recordScope')
      expect(await screen.findByRole('heading', { name: 'Beretning' })).toBeInTheDocument()
      const selector = screen.getByLabelText('Record scope')
      expect(selector).toHaveValue('')
      expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeDisabled()

      fireEvent.change(selector, { target: { value: 'document' } })
      await waitFor(() => expect(written).toHaveLength(2))
      expect(written[1]).toMatchObject({ expectedRevisionNumber: 1, recordScope: 'document' })
      await waitFor(() => expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled())
      expect(selector).toHaveValue('document')
    })
  })

  describe('the next run after a refused or failed one', () => {

    it('a refused admission keeps the saved revision and re-runs under a new ID; an uncertain one reserves its identity for Reconnect', async () => {
      const writes: RevisionWrite[] = []
      const runs: Array<{ id: string; schemaRevisionId: string }> = []
      const reads: string[] = []
      let readable = false
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const durable = durableRead(url)
          if (durable) return Promise.resolve(durable)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?'))
            return Promise.resolve(Response.json({ revisions: [] }))
          if (url === '/api/schema-revisions' && init?.method === 'POST')
            return Promise.resolve(appendRevision(init, writes))
          if (url.endsWith('/api/extractions') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as (typeof runs)[number]
            runs.push(body)
            return Promise.resolve(runs.length === 1
              ? Response.json({ error: { code: 'invalid_request', message: 'The run was refused.' } }, { status: 422 })
              : runs.length === 2
                ? new Response('Bad gateway', { status: 502 })
                : Response.json({ ...reopened.persistedExtraction, extractionId: body.id, schemaRevisionId: body.schemaRevisionId }, { status: 201 }))
          }
          if (/^\/api\/extractions\/[^/]+$/.test(url)) {
            const id = url.split('/').at(-1)!
            reads.push(id)
            return Promise.resolve(readable
              ? Response.json({ extraction: { ...runningAttempt(id), executionStatus: 'PAUSED' } })
              : new Response('Bad gateway', { status: 502 }))
          }
          // Reading the uncertain run fails too, so its admission stays unresolved.
          return Promise.resolve(new Response('pdf'))
        }),
      )
      render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
      await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())

      fireEvent.click(screen.getByRole('button', { name: 'Edit place' }))
      fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'location' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      await waitFor(() => expect(runs).toHaveLength(1))
      expect(writes).toHaveLength(1)
      expect(runs[0]).toMatchObject({ schemaRevisionId: appendedRevisionId(2) })

      // Refused: the revision stays saved, so running again only admits, under a new identity.
      await waitFor(() => expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled())
      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      await waitFor(() => expect(runs).toHaveLength(2))
      expect(writes).toHaveLength(1)
      expect(runs[1]).toEqual({ ...runs[0], id: expect.not.stringMatching(runs[0]!.id) })

      // Uncertain (the gateway failed, and so does reading it): Reconnect reads the reserved identity.
      fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
      expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      readable = true
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
      await waitFor(() => expect(reads).toHaveLength(2))
      expect(writes).toHaveLength(1)
      expect(runs).toHaveLength(2)
      expect(reads).toEqual([runs[1]!.id, runs[1]!.id])
    })


    it('a superseded refusal refreshes the document and disables Run without hiding the earlier results', async () => {
      const message =
        "This document has been reprocessed. No new Extraction was started. Open the document from the project's Sources list to run on its current source revision. You can continue reviewing this earlier Extraction."
      const posts: unknown[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const durable = durableRead(url)
          if (durable) return Promise.resolve(durable)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?'))
            return Promise.resolve(Response.json({ revisions: [] }))
          if (url.endsWith('/api/extractions') && init?.method === 'POST') {
            posts.push(JSON.parse(String(init.body)))
            return Promise.resolve(Response.json(
              { error: { code: 'source_representation_superseded', message } },
              { status: 409 },
            ))
          }
          return Promise.resolve(new Response('pdf'))
        }),
      )
      // What AppFrame swaps in once the second reopen read answers: the same document, no longer current.
      const onSourceSuperseded = vi.fn(() =>
        rerender(<DocumentWorkspace {...reopened} sourceRepresentationCurrent={false} onSourceSuperseded={onSourceSuperseded} />),
      )
      const { rerender } = render(<DocumentWorkspace {...reopened} onSourceSuperseded={onSourceSuperseded} />)
      await waitFor(() =>
        expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
      )
      fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
      expect(screen.getByText('Elmbrooke')).toBeVisible()

      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      await waitFor(() => expect(onSourceSuperseded).toHaveBeenCalledOnce())
      expect(posts).toHaveLength(1)
      expect(screen.getByText('This document has been reprocessed — no new Extraction was started')).toBeVisible()
      expect(screen.getByText('Elmbrooke')).toBeVisible()
      expect(screen.queryByText(/Extraction failed/)).not.toBeInTheDocument()
      const run = screen.getByRole('button', { name: '▶ Run extraction' })
      expect(run).toBeDisabled()
      expect(run).toHaveAttribute(
        'title',
        'This view shows an Extraction on an earlier Source Representation. Go back to the current one to run a new Extraction.',
      )
      expect(screen.queryByRole('button', { name: /^Run (Article|Catalog) extraction/ })).not.toBeInTheDocument()
    })

    it.each([
      [{ status: 'loading' } as const],
      [{ status: 'error', message: 'Unavailable.' } as const],
    ])('starts nothing when the saved settings read at the click is not ready (%o)', async (state) => {
      const ready = saved.state
      saved.state = state
      try {
        const posts: string[] = []
        vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
          const url = String(input)
          const durable = durableRead(url)
          if (durable) return Promise.resolve(durable)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
          if (url.endsWith('/api/extractions')) posts.push(url)
          return Promise.resolve(new Response('pdf'))
        }))
        render(<DocumentWorkspace {...reopened} />)
        await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
        // The click reads the saved method itself, so Run does not wait on the mount-time read.
        fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
        expect(await screen.findByText('Saved advanced settings could not be read. Nothing was started.')).toBeInTheDocument()
        expect(posts).toHaveLength(0)
        expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled()
      } finally {
        saved.state = ready
      }
    })

    it('a method_changed refusal re-reads the saved settings and retries once, then says so without a failure', async () => {
      const message = 'Your saved advanced settings changed after this summary was shown. Nothing was started; review the updated summary and start again.'
      const posts: unknown[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const durable = durableRead(url)
          if (durable) return Promise.resolve(durable)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?'))
            return Promise.resolve(Response.json({ revisions: [] }))
          if (url.endsWith('/api/extractions') && init?.method === 'POST') {
            posts.push(JSON.parse(String(init.body)))
            return Promise.resolve(Response.json({ error: { code: 'method_changed', message } }, { status: 409 }))
          }
          return Promise.resolve(new Response('pdf'))
        }),
      )
      render(<DocumentWorkspace {...reopened} />)
      await waitFor(() =>
        expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
      )

      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      expect(await screen.findByText('Your saved settings changed. Run again.')).toBeInTheDocument()
      expect(posts).toHaveLength(2)
      expect(saved.refresh).toHaveBeenCalledTimes(2)
      expect(screen.queryByText(message)).not.toBeInTheDocument()
      expect(screen.queryByText(/Extraction failed/)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled()
    })

    it('keeps the superseded notice when the refresh moves a plain route to the reprocessed Source Representation', async () => {
      const posts: unknown[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const durable = durableRead(url)
          if (durable) return Promise.resolve(durable)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?'))
            return Promise.resolve(Response.json({ revisions: [] }))
          if (url.endsWith('/api/extractions') && init?.method === 'POST') {
            posts.push(JSON.parse(String(init.body)))
            return Promise.resolve(Response.json(
              { error: { code: 'source_representation_superseded', message: 'This document has been reprocessed.' } },
              { status: 409 },
            ))
          }
          return Promise.resolve(new Response('pdf'))
        }),
      )
      // A plain route reopens the head: after a reprocess, that is the new Source Representation, current and
      // with no attempt yet.
      const reprocessedId = '51000000-0000-4000-8002-000000000077'
      const resource = (artifact: 'pdf' | 'markdown' | 'source') =>
        `/api/project-contexts/${reopened.projectContextId}/source-representations/${reprocessedId}/${artifact}`
      const onSourceSuperseded = vi.fn(() =>
        rerender(
          <DocumentWorkspace
            {...reopened}
            sourceRepresentationId={reprocessedId}
            sourceRepresentationCurrent
            pdfUrl={resource('pdf')}
            markdownUrl={resource('markdown')}
            parsedDocumentUrl={resource('source')}
            persistedExtraction={null}
            latestReviewedExtraction={null}
            onSourceSuperseded={onSourceSuperseded}
          />,
        ),
      )
      const { rerender } = render(<DocumentWorkspace {...reopened} onSourceSuperseded={onSourceSuperseded} />)
      await waitFor(() =>
        expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
      )

      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      await waitFor(() => expect(onSourceSuperseded).toHaveBeenCalledOnce())
      await waitFor(() =>
        expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
      )

      expect(posts).toHaveLength(1)
      expect(screen.getByText('This document has been reprocessed — no new Extraction was started')).toBeVisible()
      // The workspace now shows the reprocessed Source Representation, which can be run.
      expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled()
    })

    it('a notice that outlives the switch stays above the switched document\'s loading cover', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const durable = durableRead(url)
          if (durable) return Promise.resolve(durable)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
          if (url.endsWith('/api/extractions') && init?.method === 'POST')
            return Promise.resolve(Response.json(
              { error: { code: 'source_representation_superseded', message: 'This document has been reprocessed.' } },
              { status: 409 },
            ))
          return Promise.resolve(new Response('pdf'))
        }),
      )
      const reprocessedId = '51000000-0000-4000-8002-000000000078'
      const resource = (artifact: 'pdf' | 'markdown' | 'source') =>
        `/api/project-contexts/${reopened.projectContextId}/source-representations/${reprocessedId}/${artifact}`
      const onSourceSuperseded = vi.fn(() =>
        rerender(
          <DocumentWorkspace {...reopened} sourceRepresentationId={reprocessedId} sourceRepresentationCurrent
            pdfUrl={resource('pdf')} markdownUrl={resource('markdown')} parsedDocumentUrl={resource('source')}
            persistedExtraction={null} latestReviewedExtraction={null} onSourceSuperseded={onSourceSuperseded} />,
        ),
      )
      const { rerender } = render(<DocumentWorkspace {...reopened} onSourceSuperseded={onSourceSuperseded} />)
      await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
      // The reprocessed document's PDF is still loading when the notice shows.
      getDocument.mockReturnValueOnce({ promise: new Promise<{ numPages: number }>(() => {}), destroy: destroyLoadingTask })

      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      await waitFor(() => expect(onSourceSuperseded).toHaveBeenCalledOnce())
      const cover = await screen.findByRole('status', { name: 'Loading Source Document' })
      const notice = screen.getByText('This document has been reprocessed — no new Extraction was started').closest('[role="status"]')!
      const host = notice.parentElement!
      // Same stacking context (the document section); the notice's host stacks above the loading cover.
      const z = (element: Element) => Number(/(?:^|\s)z-(\d+)(?:\s|$)/.exec(element.className)?.[1] ?? 0)
      expect(cover.className).toMatch(/(^|\s)absolute(\s|$)/)
      expect(z(host)).toBeGreaterThan(z(cover))
      expect(host.closest('section')).toBe(cover.closest('section'))
    })
  })

  describe('Extraction Model Choice', () => {
    const listing = {
      defaults: { fields: 'nuextract', reasoning: 'instruct' },
      models: [
        { key: 'instruct', repo: 'Qwen/Qwen3.8-27B-FP8', roles: ['fields', 'reasoning'], reachable: true, serving: true },
        { key: 'nuextract', repo: 'numind/NuExtract3-FP8', roles: ['fields'], reachable: true, serving: false },
      ],
    }
    const attemptFor = (body: { models?: object }, executionStatus: 'RUNNING' | 'FAILED') => ({
      extractionId: '51000000-0000-4000-8006-000000000031',
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
      strategy: 'ARTICLE', catalogRecipe: null, requestedModels: body.models ?? null, requestedSettings: null, executionStatus,
      finalizedReview: null, batchExtractionId: null, createdAt: '2026-08-12T00:00:00.000Z',
    })
    function stubFetch(models: () => Response, executionStatus: 'RUNNING' | 'FAILED') {
      const extractionRequests: Array<{ models?: object }> = []
      const modelReads: string[] = []
      let acknowledged: ReturnType<typeof attemptFor> | null = null
      vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
        if (url.endsWith('/api/extraction-models')) {
          modelReads.push(url)
          return Promise.resolve(models())
        }
        if (url.endsWith('/api/extractions') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { models?: object }
          extractionRequests.push(body)
          acknowledged = attemptFor(body, executionStatus)
          return Promise.resolve(Response.json(acknowledged, { status: 201 }))
        }
        if (url.startsWith('/api/extractions/') && acknowledged)
          return Promise.resolve(Response.json({ extraction: acknowledged, pendingReviewDecisions: null }))
        return Promise.resolve(new Response('pdf'))
      }))
      return { extractionRequests, modelReads }
    }

    it('offers no per-run model choice: the run carries none and the header lists no models', async () => {
      const { extractionRequests, modelReads } = stubFetch(() => Response.json(listing), 'FAILED')
      render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
      await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
      expect(screen.queryByLabelText('Field model')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Reasoning model')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))

      await waitFor(() => expect(extractionRequests).toHaveLength(1))
      expect(extractionRequests[0]).not.toHaveProperty('models')
      expect(modelReads).toHaveLength(0)
    })
  })

  it('abandons a pending run when the active Source Document changes', async () => {
    const nextSourceRepresentationId =
      '51000000-0000-4000-8002-000000000099'
    const save = Promise.withResolvers<Response>()
    const extractionRequests: unknown[] = []
    let savedDefinition:
      | { recordDescription: string; schemaNodes: SchemaNode[] }
      | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source'))
          return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown'))
          return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?'))
          return Promise.resolve(Response.json({ revisions: [] }))
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          savedDefinition = JSON.parse(String(init.body)) as {
            recordDescription: string
            schemaNodes: SchemaNode[]
          }
          return save.promise
        }
        if (url.endsWith('/api/extractions')) {
          extractionRequests.push(JSON.parse(String(init?.body)))
          return Promise.resolve(new Response(null, { status: 202 }))
        }
        return Promise.resolve(new Response('pdf'))
      }),
    )
    const mounted = render(
      <DocumentWorkspace {...reopened} persistedExtraction={null} />,
    )
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit place' }))
    fireEvent.change(screen.getByPlaceholderText('field_name'), {
      target: { value: 'location' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(
      screen.getByRole('button', { name: '▶ Run extraction' }),
    )
    await waitFor(() => expect(savedDefinition).not.toBeNull())

    mounted.rerender(
      <DocumentWorkspace
        {...reopened}
        sourceRepresentationId={nextSourceRepresentationId}
        pdfUrl={`/sources/${nextSourceRepresentationId}/pdf`}
        markdownUrl={`/sources/${nextSourceRepresentationId}/markdown`}
        parsedDocumentUrl={`/sources/${nextSourceRepresentationId}/source`}
        persistedExtraction={null}
      />,
    )
    save.resolve(
      Response.json(
        {
          revision: {
            schemaRevisionId: '51000000-0000-4000-8005-000000000099',
            extractionSchemaId:
              reopened.extractionSchema!.extractionSchemaId,
            revisionNumber: 2,
            origin: 'researcher-edit',
            createdAt: '2026-08-12T00:00:00.000Z',
            stabilisedAt: null,
            recordDescription: savedDefinition!.recordDescription,
            recordScope: 'document',
            schemaNodes: savedDefinition!.schemaNodes,
          },
        },
        { status: 201 },
      ),
    )

    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    await Promise.resolve()
    expect(extractionRequests).toEqual([])
  })

  it('does not restore an old running Extraction after switching Source Documents', async () => {
    const nextSourceDocumentId =
      '51000000-0000-4000-8001-000000000099'
    const nextSourceRepresentationId =
      '51000000-0000-4000-8002-000000000099'
    const runningAttempt = {
      extractionId: '51000000-0000-4000-8006-000000000099',
      sourceDocumentId: nextSourceDocumentId,
      sourceRepresentationRevisionId: nextSourceRepresentationId,
      schemaRevisionId: reopened.persistedExtraction!.schemaRevisionId,
      strategy: 'CATALOG' as const,
      catalogRecipe: null,
      executionStatus: 'RUNNING' as const,
      finalizedReview: null,
      requestedSettings: null,
      requestedModels: null,
      batchExtractionId: null,
      createdAt: reopened.persistedExtraction!.createdAt }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        // Only the other document's run is running; this document's own Extraction stays completed.
        const durable = durableRead(url, url.includes(runningAttempt.extractionId) ? 'RUNNING' : 'COMPLETED')
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source'))
          return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown'))
          return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?'))
          return Promise.resolve(Response.json({ revisions: [] }))
        if (url.endsWith('/api/extractions')) {
          runningAttempt.extractionId = (JSON.parse(String(init?.body)) as { id: string }).id
          return Promise.resolve(Response.json(runningAttempt, { status: 201 }))
        }
        if (url.includes(`/api/extractions/${runningAttempt.extractionId}`))
          return Promise.resolve(Response.json({ extraction: runningAttempt }))
        return Promise.resolve(new Response('pdf'))
      }),
    )
    const mounted = render(
      <StrictMode>
        <DocumentWorkspace
          {...reopened}
          latestReviewedExtraction={reopened.persistedExtraction}
        />
      </StrictMode>,
    )
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    mounted.rerender(
      <StrictMode>
        <DocumentWorkspace
          {...reopened}
          filename="Next.pdf"
          sourceRepresentationId={nextSourceRepresentationId}
          pdfUrl={`/sources/${nextSourceRepresentationId}/pdf`}
          markdownUrl={`/sources/${nextSourceRepresentationId}/markdown`}
          parsedDocumentUrl={`/sources/${nextSourceRepresentationId}/source`}
          persistedExtraction={null}
          latestReviewedExtraction={null}
        />
      </StrictMode>,
    )
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    fireEvent.click(
      screen.getByRole('button', { name: '▶ Run extraction' }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '❚❚ Pause extraction' }),
      ).toBeInTheDocument(),
    )
    // The record scope is the schema's own, and is locked while the run is active.
    expect(screen.getByLabelText('Record scope')).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    // The durable reader owns the running Extraction's status in Results.
    expect(await screen.findByText('Elmbrooke')).toBeVisible()
    expect(screen.getByRole('button', { name: '❚❚ Pause extraction' })).toHaveTextContent(/^❚❚ Pause extraction$/)

    mounted.rerender(
      <StrictMode>
        <DocumentWorkspace
          {...reopened}
          latestReviewedExtraction={reopened.persistedExtraction}
        />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '▶ Run extraction' }),
      ).toBeInTheDocument(),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 2_100))
    expect(
      screen.queryByRole('button', { name: '❚❚ Pause extraction' }),
    ).not.toBeInTheDocument()
  }, 8_000)


  it.each([
    ['failed', 'FAILED', 'Extraction failed — its saved values remain in Results, where Retry continues it'],
    ['stopped', 'STOPPED', 'Extraction stopped — its saved values and decisions remain in Results'],
  ] as const)('reports a %s Extraction without a success toast', async (_label, executionStatus, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const durable = durableRead(url)
        if (durable) return Promise.resolve(durable)
        if (url.endsWith('/source')) return Response.json(parsedDocument)
        if (url.endsWith('/api/extractions')) {
          const request = JSON.parse(String(init?.body)) as { id: string }
          return Response.json({
            extractionId: request.id,
            sourceDocumentId: '51000000-0000-4000-8001-000000000001',
            sourceRepresentationRevisionId: reopened.sourceRepresentationId,
            schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
            strategy: 'ARTICLE',
            catalogRecipe: null,
            executionStatus,
            finalizedReview: null,
            requestedSettings: null,
            requestedModels: null,
            batchExtractionId: null,
            createdAt: '2026-08-10T00:00:00.000Z' }, { status: 201 })
        }
        return new Response('# Beretning')
      }),
    )
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByText(/Extraction complete/)).not.toBeInTheDocument()
  })

})


describe('an Extraction reopened on a superseded Source Representation', () => {
  // Reprocessing published `reopened`'s Source Representation after this one,
  // and a Schema Revision after the one `reopened`'s attempts ran with.
  const earlierRepresentationId = '51000000-0000-4000-8002-000000000002'
  const earlierResource = (artifact: 'pdf' | 'markdown' | 'source') =>
    `/api/project-contexts/${reopened.projectContextId}/source-representations/${earlierRepresentationId}/${artifact}`
  const currentSchema = {
    ...reopened.extractionSchema!,
    schemaRevisionId: '51000000-0000-4000-8005-000000000003',
    revisionNumber: 2,
  }
  const earlierSourceRunTitle =
    'This view shows an Extraction on an earlier Source Representation. Go back to the current one to run a new Extraction.'
  /** One Extraction as the attempt contract carries it. */
  const attemptOn = (
    sourceRepresentationRevisionId: string,
    overrides: Partial<ExtractionAttempt> = {},
  ): ExtractionAttempt => ({
    extractionId: '51000000-0000-4000-8006-000000000051',
    sourceDocumentId: '51000000-0000-4000-8001-000000000001',
    sourceRepresentationRevisionId,
    schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
    strategy: 'ARTICLE', catalogRecipe: null, executionStatus: 'COMPLETED', finalizedReview: null, requestedSettings: null, requestedModels: null, batchExtractionId: null,
    createdAt: '2026-07-31T12:03:00.000Z',
    ...overrides })

  /** The attempt as a reopen pins it to the earlier source and its own Schema Revision. */
  const reopenedOnEarlierSource = (attempt: ExtractionAttempt) => ({
    ...attempt,
    sourceRepresentation: {
      revisionNumber: 1,
      resources: {
        sourcePdfUrl: earlierResource('pdf'),
        markdownUrl: earlierResource('markdown'),
        parsedDocumentUrl: earlierResource('source'),
      },
    },
    extractionSchema: {
      ...reopened.persistedExtraction!.extractionSchema,
      revisionNumber: attempt.schemaRevisionId === currentSchema.schemaRevisionId ? 2 : 1,
    },
  })

  /** What AppFrame opens for `?extractionId=` of an Extraction on the earlier source. */
  function pinnedView(attempt: ExtractionAttempt): DocumentWorkspaceProps {
    const pinned = reopenedOnEarlierSource(attempt)
    return {
      ...reopened,
      sourceRepresentationId: earlierRepresentationId,
      sourceRepresentationCurrent: false,
      pdfUrl: earlierResource('pdf'),
      markdownUrl: earlierResource('markdown'),
      parsedDocumentUrl: earlierResource('source'),
      extractionSchema: currentSchema,
      persistedExtraction: pinned,
      latestReviewedExtraction: attempt.finalizedReview ? pinned : null,
    }
  }

  /** Serves the workspace's reads (`reads`, by URL) and keeps every posted run and cancellation. */
  function stubWorkspace(reads: Record<string, unknown> = {}, durableStatus: ExtractionAttempt['executionStatus'] = 'COMPLETED') {
    const runs: Array<{ id: string; sourceRepresentationRevisionId: string; schemaRevisionId: string }> = []
    const cancellations: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/source') && !url.includes('/durable/')) return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?'))
          return Promise.resolve(Response.json({ revisions: [] }))
        if (url.endsWith('/api/extractions') && init?.method === 'POST') {
          const run = JSON.parse(String(init.body)) as (typeof runs)[number]
          runs.push(run)
          // A terminal answer, so no monitor outlives the test.
          return Promise.resolve(Response.json(attemptOn(run.sourceRepresentationRevisionId, {
            extractionId: run.id,
            schemaRevisionId: run.schemaRevisionId,
            executionStatus: 'FAILED',
            finalizedReview: null,
            requestedSettings: null,
            requestedModels: null }), { status: 201 }))
        }
        if (url.startsWith('/api/extractions/') && init?.method === 'DELETE') {
          cancellations.push(url)
          return Promise.resolve(Response.json({ extractionId: url.split('/').at(-1) }, { status: 202 }))
        }
        if (url in reads) return Promise.resolve(Response.json(reads[url]))
        const durable = durableRead(url, durableStatus)
        if (durable) return Promise.resolve(durable)
        return Promise.resolve(new Response('pdf'))
      }),
    )
    return { runs, cancellations }
  }

  async function renderView(view: DocumentWorkspaceProps) {
    const mounted = render(<DocumentWorkspace {...view} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    return mounted
  }

  /** The Results tab's own run actions: none since decision 03 (the tab strip's Run is the only one). */
  const resultsRunActions = () =>
    screen.queryAllByRole('button', { name: /^Run (Article |Catalog )?extraction/ })

  it.each([
    ['a finalized result on a previous Schema Revision',
      attemptOn(earlierRepresentationId, { finalizedReview: { snapshotVersion: 1, feedbackVersion: 1, createdAt: '2026-08-01T00:00:00.000Z' } }), 'Completed'],
    ['a result on the Current Schema Revision', attemptOn(earlierRepresentationId, { schemaRevisionId: currentSchema.schemaRevisionId }), 'Completed'],
    ['a stopped Extraction', attemptOn(earlierRepresentationId, { executionStatus: 'STOPPED' }), 'Stopped'],
  ] as const)('offers no new run from %s', async (_label, attempt, shown) => {
    stubWorkspace({}, attempt.executionStatus)
    await renderView(pinnedView(attempt))

    const run = screen.getByRole('button', { name: '▶ Run extraction' })
    expect(run).toBeDisabled()
    expect(run).toHaveAttribute('title', earlierSourceRunTitle)
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    // Results keeps the Extraction's saved values beside its lifecycle.
    expect(await screen.findByText(shown, { exact: true })).toBeVisible()
    expect(resultsRunActions()).toEqual([])
  })

  it('hands a failed Extraction to Retry rather than a new run', async () => {
    const attempt = attemptOn(earlierRepresentationId, { executionStatus: 'FAILED' })
    stubWorkspace({}, 'FAILED')
    await renderView(pinnedView(attempt))
    expect(screen.queryByRole('button', { name: '▶ Run extraction' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '↻ Retry extraction' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '■ Stop' })).toBeEnabled()
  })

  it.each([
    ['the plain view of the current Source Representation', reopened],
    [
      'an Extraction pinned on the current Source Representation',
      {
        ...reopened,
        persistedExtraction: {
          ...reopened.persistedExtraction!,
          extractionId: '51000000-0000-4000-8006-000000000061',
          batchExtractionId: '51000000-0000-4000-8007-000000000001',
        },
      },
    ],
  ] as const)('keeps the run of %s', async (_label, view) => {
    const { runs } = stubWorkspace()
    await renderView(view)

    const run = screen.getByRole('button', { name: '▶ Run extraction' })
    expect(run).toBeEnabled()
    expect(run).toHaveAttribute('title', 'Extract one record from the whole document')
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    // The tab strip's Run is the only run (decision 03).
    expect(resultsRunActions()).toEqual([])
    fireEvent.click(run)
    await waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]).toMatchObject({ sourceRepresentationRevisionId: reopened.sourceRepresentationId })
  })

  it('offers the run again once Back reopens the current Source Representation, and posts that one', async () => {
    const reviewed = attemptOn(earlierRepresentationId, { finalizedReview: { snapshotVersion: 1, feedbackVersion: 1, createdAt: '2026-08-01T00:00:00.000Z' } })
    const { runs } = stubWorkspace()
    const { rerender } = await renderView(pinnedView(reviewed))
    expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeDisabled()

    // The plain route: the current Source Representation, its newer unreviewed
    // attempt, and the reviewed one still on the earlier source.
    rerender(
      <DocumentWorkspace
        {...reopened}
        extractionSchema={currentSchema}
        persistedExtraction={{
          ...reopened.persistedExtraction!,
          extractionId: '51000000-0000-4000-8006-000000000052',
          schemaRevisionId: currentSchema.schemaRevisionId,
          extractionSchema: { ...reopened.persistedExtraction!.extractionSchema, revisionNumber: 2 },
        }}
        latestReviewedExtraction={reopenedOnEarlierSource(reviewed)}
      />,
    )
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    const run = screen.getByRole('button', { name: '▶ Run extraction' })
    expect(run).toBeEnabled()
    // "Open latest reviewed" sits in the Results header.
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(screen.getByRole('button', { name: 'Open latest reviewed' })).toBeInTheDocument()
    expect(resultsRunActions()).toEqual([])

    fireEvent.click(run)
    await waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]).toMatchObject({
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      schemaRevisionId: currentSchema.schemaRevisionId,
    })
  })
})

describe('updated latest reviewed extraction', () => {
  /** Every request the workspace made, with durable reads answered at the live cut `results 3 · decisions 4`. */
  function stubLatestReviewed() {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input)
      requests.push(url)
      return Promise.resolve(durableRead(url, 'PAUSED', { snapshotVersion: 3, feedbackVersion: 4 }) ??
        (url.endsWith('/source') ? Response.json(parsedDocument) : new Response('# Source')))
    }))
    return requests
  }
  const finalizedA = { ...reopened.persistedExtraction!, extractionId: '51000000-0000-4000-8006-000000000008', executionStatus: 'PAUSED' as const,
    finalizedReview: { snapshotVersion: 1, feedbackVersion: 2, createdAt: '2026-08-08T00:00:00.000Z' } }
  const finalizedCut = (id: string) => `/api/extractions/${id}/durable/values?limit=500&snapshotVersion=1&feedbackVersion=2`

  it('refreshes the historical choice after rerender', async () => {
    stubLatestReviewed()
    const first = finalizedA
    const second = { ...first, extractionId: '51000000-0000-4000-8006-000000000009', finalizedReview: { snapshotVersion: 2, feedbackVersion: 3, createdAt: '2026-08-09T00:00:00.000Z' } }
    const { rerender } = render(<DocumentWorkspace {...reopened} latestReviewedExtraction={first} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    rerender(<DocumentWorkspace {...reopened} latestReviewedExtraction={second} />)
    // The snapshot choice sits in the Results header.
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect((await screen.findByRole<HTMLOptionElement>('option', { name: 'Latest reviewed' })).value).toBe(second.extractionId)
  })

  it('opens the same-source latest reviewed Extraction on its finalized result and decision pair, not its later live cut', async () => {
    const requests = stubLatestReviewed()
    render(<DocumentWorkspace {...reopened} latestReviewedExtraction={finalizedA} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    // Ordinary inspection of the latest attempt follows its live cut.
    expect(await screen.findByText('Elmbrooke')).toBeVisible()
    expect(screen.queryByText(/Showing saved results/)).not.toBeInTheDocument()
    fireEvent.change(await screen.findByRole('combobox', { name: 'Extraction snapshot' }), { target: { value: finalizedA.extractionId } })
    expect(await screen.findByText(/Showing saved results 1/)).toBeVisible()
    expect(requests).toContain(finalizedCut(finalizedA.extractionId))
    // The later unfinalized work in the same visible Extraction is one click away.
    expect(screen.getByRole('button', { name: 'Show the latest results' })).toBeVisible()
    expect(requests.some((url) => url.includes(`/api/extractions/${reopened.persistedExtraction!.extractionId}/durable/values?`) && url.includes('feedbackVersion'))).toBe(false)
  })

  it('keeps the live cut when the latest attempt is itself the latest reviewed', async () => {
    const requests = stubLatestReviewed()
    const latest = { ...reopened.persistedExtraction!, finalizedReview: finalizedA.finalizedReview }
    render(<DocumentWorkspace {...reopened} persistedExtraction={latest} latestReviewedExtraction={latest} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(await screen.findByText('Elmbrooke')).toBeVisible()
    expect(screen.queryByText(/Showing saved results/)).not.toBeInTheDocument()
    expect(requests.some((url) => url.includes('feedbackVersion='))).toBe(false)
  })

  it('opens a latest reviewed Extraction on another source with its finalized pair', async () => {
    stubLatestReviewed()
    const onOpenExtraction = vi.fn()
    const elsewhere = { ...finalizedA, sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000077' }
    render(<DocumentWorkspace {...reopened} latestReviewedExtraction={elsewhere} onOpenExtraction={onOpenExtraction} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open latest reviewed' }))
    expect(onOpenExtraction).toHaveBeenCalledWith(elsewhere.extractionId, { snapshotVersion: 1, feedbackVersion: 2 })
  })

  it('reads the routed Extraction at the cut its route names', async () => {
    const requests = stubLatestReviewed()
    render(<DocumentWorkspace {...reopened} persistedExtraction={finalizedA} persistedReviewCut={{ snapshotVersion: 1, feedbackVersion: 2 }} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(await screen.findByText(/Showing saved results 1/)).toBeVisible()
    expect(requests).toContain(finalizedCut(finalizedA.extractionId))
  })
})
