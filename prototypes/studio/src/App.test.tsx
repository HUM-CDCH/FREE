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

// The account keeps every service default: each run submits `{ models: null, settings: <its slot>: null }`.
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
vi.mock('./savedMethod', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./savedMethod')>()),
  useSavedMethod: () => saved,
}))
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
    schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    sourceCoverage: null,
  },
  persistedExtraction: {
    extractionId: '51000000-0000-4000-8006-000000000001',
    sourceDocumentId: '51000000-0000-4000-8001-000000000001',
    sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
    schemaRevisionId: '51000000-0000-4000-8005-000000000002',
    createdAt: '2026-07-31T12:03:00.000Z',
    reviewedAt: null,
    strategy: 'ARTICLE',
    catalogRecipe: null,
    executionStatus: 'COMPLETED',
    outcome: 'SUCCEEDED',
    complete: true,
    diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, grounding: null, catalog: null },
    failure: null,
    resultPayload: { place: 'Ellekilde' },
    evidenceLinks: [],
    modelAttribution: { provider: 'ollama', modelId: 'fixture' },
    reviewable: true,
    batchExtractionId: null,
    reviewDecisions: [],
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
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    },
  },
}

afterEach(() => {
  cleanup()
  document.querySelector('base')?.remove()
  vi.unstubAllGlobals()
  getDocument.mockClear()
  destroyLoadingTask.mockClear()
  scrollPageIntoView.mockClear()
})

/** Renders the reopened workspace and waits for indexing to settle. */
async function renderReopened() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith('/source')
          ? Response.json(parsedDocument)
          : new Response('# Beretning'),
      ),
    ),
  )
  const mounted = render(<DocumentWorkspace {...reopened} />)
  await waitFor(() =>
    expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
  )
  return mounted
}

describe('reopened Source Document workspace', () => {
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
    expect(screen.getByText('Ellekilde')).toBeVisible()

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
    expect(screen.queryByText('Ellekilde')).not.toBeInTheDocument()
  })

  it('keeps the collapsed right rail narrow at mobile widths', async () => {
    await renderReopened()
    const rail = screen.getByRole('complementary', {
      name: 'Evidence, schema and results',
    })
    const mobileDrawerWidth = 'max-[859px]:!w-[min(90vw,32rem)]'

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

    expect(await screen.findByText('3 pages')).toBeInTheDocument()
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

  it('paints only canonical Evidence at the visible Results depth', async () => {
    const persistedExtraction = reopened.persistedExtraction
    if (!persistedExtraction || persistedExtraction.outcome !== 'SUCCEEDED')
      throw new Error('Expected a successful reopened Extraction fixture')
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) =>
        Promise.resolve(
          String(input).endsWith('/source')
            ? Response.json(parsedDocument)
            : new Response('# Beretning'),
        ),
      ),
    )
    const { container } = render(
      <DocumentWorkspace
        {...reopened}
        persistedExtraction={{
          ...persistedExtraction,
          resultPayload: { title: 'Beretning', record: { place: 'Ellekilde' } },
          evidenceLinks: [
            { resultPath: ['title'], evidenceAnchorId: 'bundled-anchor' },
            { resultPath: ['record', 'place'], evidenceAnchorId: 'bundled-anchor' },
          ],
        }}
      />,
    )
    const page = document.createElement('div')
    page.className = 'page'
    page.dataset.pageNumber = '1'
    page.style.position = 'relative'
    container.querySelector('.pdfViewer')!.append(page)

    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    expect(page.querySelectorAll('[data-evidence-anchor-id]')).toHaveLength(0)

    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    await waitFor(() =>
      expect(page.querySelectorAll('[data-evidence-anchor-id]')).toHaveLength(1),
    )
    fireEvent.click(screen.getByText('record', { exact: true }))
    await waitFor(() =>
      expect(page.querySelectorAll('[data-evidence-anchor-id]')).toHaveLength(1),
    )
    const highlight = page.querySelector<HTMLElement>('[data-evidence-anchor-id]')!
    expect(highlight.dataset.resultPath).toBe('["record","place"]')
    expect(highlight.style.background).toContain('0.28')

    fireEvent.click(screen.getByRole('tab', { name: 'Raw JSON' }))
    await waitFor(() =>
      expect(page.querySelectorAll('[data-evidence-anchor-id]')).toHaveLength(0),
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    await waitFor(() =>
      expect(page.querySelectorAll('[data-evidence-anchor-id]')).toHaveLength(1),
    )
    fireEvent.click(screen.getByTitle('Back'))
    await waitFor(() =>
      expect(page.querySelector<HTMLElement>('[data-evidence-anchor-id]')?.dataset.resultPath).toBe('["title"]'),
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    await waitFor(() =>
      expect(page.querySelectorAll('[data-evidence-anchor-id]')).toHaveLength(0),
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    await waitFor(() =>
      expect(page.querySelectorAll('[data-evidence-anchor-id]')).toHaveLength(1),
    )
    fireEvent.click(screen.getByTitle('Collapse panel'))
    await waitFor(() =>
      expect(page.querySelectorAll('[data-evidence-anchor-id]')).toHaveLength(0),
    )
    fireEvent.click(screen.getByTitle('Expand panel'))
    await waitFor(() =>
      expect(page.querySelector<HTMLElement>('[data-evidence-anchor-id]')?.dataset.resultPath).toBe('["title"]'),
    )
  })

  it('reveals the PDF page before painting nested table Evidence', async () => {
    const tableDocument = {
      ...parsedDocument,
      pages: parsedDocument.pages.map((page) =>
        page.page_number === 4
          ? { ...page, unplaced_content: ['table-1'] }
          : page,
      ),
      tables: [{
        table_id: 'table-1',
        rows: 1,
        cols: 1,
        cells: [{
          cell_id: 'cell-1', row: 0, column: 0, text: '26-1', role: 'data',
          rowspan: 1, colspan: 1,
          bbox: { x0: 80, y0: 606, x1: 100, y1: 615 },
          evidence_anchor_id: 'table-anchor',
        }],
        spans: [{
          page_number: 4, producer_table_ref: '#/tables/6',
          page_local_row_start: 0, page_local_row_end: 0,
          page_local_col_count: 1,
        }],
        parser_attribution: {
          content_parser: { parser: 'docling', version: null },
          structure_parser: { parser: 'docling', version: null },
          geometry_parser: { parser: 'docling', version: null },
        },
        continuation: 'page_local',
      }],
      evidence_index: {
        anchors: [...parsedDocument.evidence_index.anchors, {
          kind: 'table_cell',
          anchor_id: 'table-anchor',
          content_sha256: 'a'.repeat(64),
          preprocess_id: 'bundled-fixture',
          logical_table_id: 'table-1',
          cell_id: 'cell-1',
          canonical_row: 0,
          canonical_column: 0,
          producer_observations: [{
            occurrence_id: 'table-occurrence',
            page_number: 4,
            producer_ref: '#/tables/6',
            row_offset: 0,
            column_offset: 0,
            row_span: 1,
            column_span: 1,
            bbox: { x0: 80, y0: 606, x1: 100, y1: 615 },
          }],
        }],
      },
    }
    const persistedExtraction = reopened.persistedExtraction
    if (!persistedExtraction || persistedExtraction.outcome !== 'SUCCEEDED')
      throw new Error('Expected a successful reopened Extraction fixture')
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) =>
        Promise.resolve(
          String(input).endsWith('/source')
            ? Response.json(tableDocument)
            : new Response('# Beretning'),
        ),
      ),
    )
    const { container } = render(
      <DocumentWorkspace
        {...reopened}
        persistedExtraction={{
          ...persistedExtraction,
          strategy: 'ARTICLE',
          resultPayload: { records: [
            { finds: [] },
            { finds: [] },
            { finds: [] },
            { finds: [{ find_number: '26-1' }] },
          ] },
          evidenceLinks: [{
            resultPath: ['records', 3, 'finds', 0, 'find_number'],
            evidenceAnchorId: 'table-anchor',
          }],
        }}
      />,
    )
    const page = document.createElement('div')
    page.className = 'page'
    page.dataset.pageNumber = '4'
    page.style.position = 'relative'
    container.querySelector('.pdfViewer')!.append(page)

    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    fireEvent.click(screen.getByText('Item 4'))

    await waitFor(() =>
      expect(page.querySelectorAll('[data-evidence-anchor-id="table-anchor"]')).toHaveLength(1),
    )
    expect(scrollPageIntoView).toHaveBeenLastCalledWith({ pageNumber: 4 })
  })

  it('persists a generated first schema and enables its history', async () => {
    const schemaRevisionId = '51000000-0000-4000-8005-000000000010'
    const extractionSchemaId = '51000000-0000-4000-8005-000000000011'
    let schemaNodes: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
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
              recordDescription: 'One site record.',
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
              summary: 'Initial schema',
            }],
          })
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    render(<DocumentWorkspace {...reopened} extractionSchema={null} persistedExtraction={null} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate schema' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Schema history' })).toBeEnabled())
    expect(schemaNodes).toHaveLength(1)
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
              schemaNodes: body.schemaNodes,
            },
          }, { status: 201 })
        }
        if (url.startsWith('/api/schema-revisions?')) return Response.json({ revisions: [] })
        if (url.startsWith('/api/model-operations?')) return Response.json({ operations: [] })
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    const generated = render(<DocumentWorkspace {...reopened} extractionSchema={null} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate schema' }))

    expect(await screen.findByText(notice)).toBeInTheDocument()
    expect(written.map((body) => body.sourceCoverage)).toEqual([excerpted])
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
                summary: 'Current schema',
              },
              {
                schemaRevisionId: historicalRevisionId,
                extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
                revisionNumber: 1,
                origin: 'suggestion',
                createdAt: '2026-08-09T10:00:00.000Z',
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
              recordDescription: 'One historical record.',
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
              recordDescription: request.recordDescription,
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schema history' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
    fireEvent.keyDown(screen.getByDisplayValue('nyt_felt'), { key: 'Escape' })
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))

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
    expect(screen.queryByText('nyt_felt')).not.toBeInTheDocument()
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
              recordDescription: request.recordDescription,
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
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear current schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear schema' }))

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
      screen.getByRole('button', { name: '↻ Re-run extraction' }),
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

  it.each(['toolbar', 'results'] as const)(
    'waits for a dirty schema save before starting an Article rerun from the %s',
    async (runSurface) => {
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
              recordDescription: request.recordDescription,
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
    fireEvent.click(screen.getByTitle('Edit place'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'location' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    if (runSurface === 'results')
      fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    const run = screen.getByRole('button', {
      name: runSurface === 'toolbar' ? '↻ Re-run extraction' : 'Run Article extraction',
    })
    fireEvent.click(run)
    if (runSurface === 'toolbar') {
      fireEvent.click(run)
      await waitFor(() => expect(run).toBeDisabled())
    }

    await waitFor(() => expect(extractionRequests).toHaveLength(1))
    expect(extractionRequests[0]).toEqual(expect.objectContaining({
      strategy: 'ARTICLE',
      schemaRevisionId: savedSchemaRevisionId,
    }))

    resolveExtraction(Response.json({
      extractionId: '51000000-0000-4000-8006-000000000011',
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      schemaRevisionId: savedSchemaRevisionId,
      strategy: 'ARTICLE', catalogRecipe: null, executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
      modelAttribution: { provider: 'ollama', modelId: 'test-model' },
      diagnostics: {
        phase: 'grounding', durationMs: 1, modelCalls: 1,
        finishReason: 'stop', inputTokens: 1, outputTokens: 1,
        grounding: null,
        catalog: null,
      },
      failure: null, resultPayload: { records: [{ place: 'Article' }] },
      evidenceLinks: [], reviewable: true, batchExtractionId: null,
      createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
    }))
    expect(
      await screen.findByText(
        '↻ Re-run complete — view the JSON in the Results tab',
      ),
    ).toBeVisible()
    expect(extractionRequests).toHaveLength(1)
    expect(cancellationRequests).toEqual([])
    },
  )

  it('marks the result as previous only once a new Schema Revision is saved, then runs and cancels with the current one', async () => {
    const savedSchemaRevisionId = '51000000-0000-4000-8005-000000000099'
    const extractionResponse = Promise.withResolvers<Response>()
    const extractionRequests: Array<{ id: string; schemaRevisionId?: string }> = []
    const cancellationRequests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?'))
          return Promise.resolve(Response.json({ revisions: [] }))
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          const request = JSON.parse(String(init.body)) as { recordDescription: string; schemaNodes: SchemaNode[] }
          return Promise.resolve(Response.json({
            revision: {
              schemaRevisionId: savedSchemaRevisionId,
              extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
              revisionNumber: 2,
              origin: 'researcher-edit',
              createdAt: '2026-08-12T00:00:00.000Z',
              recordDescription: request.recordDescription,
              schemaNodes: request.schemaNodes,
            },
          }, { status: 201 }))
        }
        if (url.startsWith('/api/extractions/') && init?.method === 'DELETE') {
          cancellationRequests.push(url)
          return Promise.resolve(Response.json({ extractionId: url.split('/').at(-1) }, { status: 202 }))
        }
        if (url.endsWith('/api/extractions')) {
          extractionRequests.push(JSON.parse(String(init?.body)) as { id: string; schemaRevisionId?: string })
          return extractionResponse.promise
        }
        return Promise.resolve(new Response('# Beretning'))
      }),
    )
    render(<DocumentWorkspace {...reopened} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(screen.getByText('Using Schema Revision 1 · Current revision: 1')).toBeInTheDocument()
    expect(screen.queryByText('Previous schema')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByTitle('Edit place'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'location' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    // Unsaved edits are not a new revision: no false "previous schema" yet.
    expect(screen.queryByText('Previous schema')).not.toBeInTheDocument()
    expect(screen.getByText('Using Schema Revision 1 · Current revision: 1')).toBeInTheDocument()

    // The debounced durable save acknowledges Revision 2.
    await waitFor(
      () => expect(screen.getByText('Using Schema Revision 1 · Current revision: 2')).toBeInTheDocument(),
      { timeout: 4_000 },
    )
    expect(screen.getByText('Previous schema')).toBeInTheDocument()
    expect(screen.getByText('Review applies to Schema Revision 1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Run (Article|Catalog) extraction$/ })).not.toBeInTheDocument()
    expect(screen.getByText('Ellekilde')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Run Article extraction with current schema' }))
    await waitFor(() => expect(extractionRequests).toHaveLength(1))
    expect(extractionRequests[0]!.schemaRevisionId).toBe(savedSchemaRevisionId)
    extractionResponse.resolve(Response.json({
      extractionId: extractionRequests[0]!.id,
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      schemaRevisionId: savedSchemaRevisionId,
      strategy: 'ARTICLE', catalogRecipe: null, executionStatus: 'RUNNING', outcome: null, complete: null,
      modelAttribution: null, diagnostics: null, failure: null, resultPayload: null,
      evidenceLinks: null, reviewable: false, batchExtractionId: null,
      createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
    }, { status: 201 }))
    expect(await screen.findByText('Using Schema Revision 2 · Current revision: 2', undefined, { timeout: 4_000 })).toBeInTheDocument()
    expect(screen.queryByText('Previous schema')).not.toBeInTheDocument()
    expect(screen.getByText('You can continue working on other documents.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Cancel extraction' })).toHaveLength(2)
    fireEvent.click(screen.getByTitle('Cancel the active Extraction'))
    await waitFor(() => expect(cancellationRequests).toHaveLength(1))
    expect(screen.getAllByRole('button', { name: 'Cancellation requested…' })).toHaveLength(2)
    for (const control of screen.getAllByRole('button', { name: 'Cancellation requested…' }))
      expect(control).toBeDisabled()
  })

  it('navigates a long document with the keyboard and enforces the sample page limit', async () => {
    getDocument.mockReturnValueOnce({
      promise: Promise.resolve({ numPages: 120 }),
      destroy: destroyLoadingTask,
    })
    await renderReopened()
    const navigation = within(await screen.findByRole('navigation', { name: 'Page navigation' }))
    const firstPage = navigation.getByRole('button', { name: 'Go to page 1' })
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

    fireEvent.click(screen.getByRole('button', { name: 'Select sample pages' }))
    for (let page = 1; page <= 30; page += 1)
      fireEvent.click(navigation.getByRole('checkbox', { name: `Add page ${page} to the sample` }))
    expect(navigation.getByRole('checkbox', { name: 'Add page 31 to the sample' })).toBeDisabled()
    fireEvent.click(navigation.getByRole('checkbox', { name: 'Remove page 1 from the sample' }))
    expect(navigation.getByRole('checkbox', { name: 'Add page 31 to the sample' })).toBeEnabled()
    fireEvent.keyDown(firstPage, { key: 'Escape' })
    expect(screen.queryByRole('navigation', { name: 'Page navigation' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pages' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Run sample on pp. 2–30' })).toBeEnabled()
  })

  it('keeps page navigation visible and sampling optional, preserves a hidden selection, and admits with the saved schema', async () => {
    const savedSchemaRevisionId = '51000000-0000-4000-8005-000000000099'
    const schemaSaves: unknown[] = []
    const runs: Array<{ id: string; schemaRevisionId: string; pages?: number[] }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?'))
          return Promise.resolve(Response.json({ revisions: [] }))
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          const request = JSON.parse(String(init.body)) as { recordDescription: string; schemaNodes: SchemaNode[] }
          schemaSaves.push(request)
          return Promise.resolve(Response.json({
            revision: {
              schemaRevisionId: savedSchemaRevisionId,
              extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
              revisionNumber: 2, origin: 'researcher-edit', createdAt: '2026-08-12T00:00:00.000Z',
              recordDescription: request.recordDescription, schemaNodes: request.schemaNodes,
            },
          }, { status: 201 }))
        }
        if (url.endsWith('/api/extractions') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as (typeof runs)[number]
          runs.push(body)
          return Promise.resolve(runs.length === 1
            ? Response.json({ error: { code: 'invalid_request', message: 'The sample was refused.' } }, { status: 422 })
            : runs.length === 2
              ? new Response('Bad gateway', { status: 502 })
              : Response.json({ ...reopened.persistedExtraction, extractionId: body.id, schemaRevisionId: savedSchemaRevisionId,
                requestedPages: body.pages }, { status: 201 }))
        }
        return Promise.resolve(new Response('pdf'))
      }),
    )
    render(<DocumentWorkspace {...reopened} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())

    fireEvent.click(await screen.findByRole('button', { name: 'Go to page 2' }))
    expect(screen.getByRole('navigation', { name: 'Page navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /page \d+.*sample/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'This page' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select sample pages' }))
    expect(screen.getByText('Around page 2:')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '± 1 page' }))
    expect(screen.getByText('pp. 1–3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remove page 3 from the sample' }))
    expect(screen.getByRole('checkbox', { name: 'Add page 3 to the sample' })).not.toBeChecked()
    expect(screen.getByText('2 pages')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done selecting' }))
    expect(screen.queryByRole('checkbox', { name: /page \d+.*sample/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'This page' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to page 1' })).toHaveAccessibleDescription('Sample')
    fireEvent.click(screen.getByRole('button', { name: 'Pages' }))
    expect(screen.queryByRole('navigation', { name: 'Page navigation' })).not.toBeInTheDocument()
    expect(screen.getByText('2 pages')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('Edit place'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'location' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run sample on pp. 1–2' }))
    await waitFor(() => expect(runs).toHaveLength(1))
    expect(schemaSaves).toHaveLength(1)
    expect(runs[0]).toMatchObject({ schemaRevisionId: savedSchemaRevisionId, pages: [1, 2] })

    // Refused: the revision stays saved, so running the sample again only admits, under a new identity.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run sample on pp. 1–2' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Run sample on pp. 1–2' }))
    await waitFor(() => expect(runs).toHaveLength(2))
    expect(schemaSaves).toHaveLength(1)
    expect(runs[1]).toEqual({ ...runs[0], id: expect.not.stringMatching(runs[0]!.id) })
    // Uncertain (the gateway failed, and so does reading it): the sample bar offers Reconnect, and running again
    // posts the same identity, which admission replays if it did commit (design §4).
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run sample on pp. 1–2' }))
    await waitFor(() => expect(runs).toHaveLength(3))
    expect(runs[2]).toEqual(runs[1])
    // The sample is its own attempt: the whole-document result stays what Results shows.
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(await screen.findByText('Ellekilde')).toBeInTheDocument()
  })

  it.each(['QUEUED', 'RUNNING'] as const)('offers status and cancellation for a reopened %s sample without cancelling the whole-document result', async (executionStatus) => {
    const { sourceRepresentation, extractionSchema, ...previousAttempt } = reopened.persistedExtraction!
    const activeSample: ExtractionAttempt = {
      ...previousAttempt,
      extractionId: '51000000-0000-4000-8006-000000000002',
      requestedPages: [2], executionStatus, outcome: null, complete: null,
      resultPayload: null, evidenceLinks: null, diagnostics: null,
      modelAttribution: null, reviewable: false,
    }
    const cancellations: string[] = []
    let monitoredSample = activeSample
    let rejectCancellation = true
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE') {
        cancellations.push(url)
        if (rejectCancellation) {
          rejectCancellation = false
          return Promise.resolve(Response.json({ error: { code: 'cancel_failed', message: 'Try cancelling again' } }, { status: 503 }))
        }
        return Promise.resolve(Response.json({ extractionId: activeSample.extractionId }, { status: 202 }))
      }
      if (url.endsWith(`/extractions/${activeSample.extractionId}`))
        return Promise.resolve(Response.json({ extraction: monitoredSample, pendingReviewDecisions: null }))
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} latestSample={{ ...activeSample, sourceRepresentation, extractionSchema }} />)
    const cancel = await screen.findByRole('button', { name: 'Cancel sample' })
    expect(cancel).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Select sample pages' }))
    fireEvent.click(screen.getByRole('button', { name: 'This page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done selecting' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pages' }))
    expect(screen.queryByRole('navigation', { name: 'Page navigation' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel sample' })).toBeEnabled()
    expect(screen.getByText(executionStatus === 'QUEUED' ? 'Sample queued on pp. 2' : 'Sample running on pp. 2')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: '↻ Re-run extraction' })).toBeDisabled()

    fireEvent.click(cancel)
    expect(await screen.findByText('cancel_failed: Try cancelling again')).toHaveAttribute('role', 'alert')
    expect(screen.getByRole('button', { name: 'Cancel sample' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sample' }))
    await waitFor(() => expect(cancellations).toHaveLength(2))
    expect(cancellations).toEqual(Array(2).fill(`/api/extractions/${activeSample.extractionId}`))
    expect(screen.getByRole('button', { name: 'Cancellation requested…' })).toBeDisabled()
    expect(screen.getByText('Sample cancellation requested; a running model call may need to finish first.')).toHaveAttribute('role', 'status')

    // Cancellation is cooperative: no new run is offered until a terminal status is observed.
    monitoredSample = { ...activeSample, executionStatus: 'FAILED', failure: { code: 'cancelled', message: 'Extraction cancelled' } }
    expect(await screen.findByRole('button', { name: 'Run sample on pp. 1' }, { timeout: 4_000 })).toBeEnabled()
    expect(await screen.findByText('Sample cancelled — no result was saved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(await screen.findByText('Ellekilde')).toBeInTheDocument()
  })

  it('shows the newest sample only on the Source Representation it ran on', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      return Promise.resolve(new Response('pdf'))
    }))
    const sampleOn = (sourceRepresentationRevisionId: string) => ({
      ...reopened.persistedExtraction!, extractionId: '51000000-0000-4000-8006-000000000002', requestedPages: [1],
      resultPayload: { records: [{ place: 'Ellekilde' }] }, sourceRepresentationRevisionId,
    })
    const { unmount } = render(<DocumentWorkspace {...reopened} latestSample={sampleOn(reopened.sourceRepresentationId)} />)
    expect(await screen.findByText(/^Sample · rev 1 · pp\. 1/)).toBeInTheDocument()
    unmount()
    render(<DocumentWorkspace {...reopened} latestSample={sampleOn('51000000-0000-4000-8002-000000000009')} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    expect(screen.queryByText(/^Sample · rev/)).not.toBeInTheDocument()
  })

  it.each([[null], ['numbered-catalogue-de@1']])('submits the selected Catalog strategy and record boundaries (%s) once, then defaults back to Article', async (recipe) => {
    const extractionRequests: Array<{ strategy?: string; catalogRecipe?: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?'))
          return Promise.resolve(Response.json({ revisions: [] }))
        if (url.endsWith('/api/extractions')) {
          const body = JSON.parse(String(init?.body)) as { strategy?: string; catalogRecipe?: string }
          extractionRequests.push(body)
          return Promise.resolve(Response.json({
            extractionId: '51000000-0000-4000-8006-000000000021',
            sourceDocumentId: '51000000-0000-4000-8001-000000000001',
            sourceRepresentationRevisionId: reopened.sourceRepresentationId,
            schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
            strategy: 'CATALOG', catalogRecipe: body.catalogRecipe ?? null,
            executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
            modelAttribution: { provider: 'ollama', modelId: 'test-model' },
            diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 1, finishReason: 'stop', inputTokens: 1, outputTokens: 1, grounding: null, catalog: null },
            failure: null,
            resultPayload: { records: [] }, evidenceLinks: [], reviewable: true,
            batchExtractionId: null,
            createdAt: '2026-08-12T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
          }, { status: 201 }))
        }
        return Promise.resolve(new Response('pdf'))
      }),
    )
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    const selector = screen.getByLabelText('Extraction strategy')
    expect(selector).toHaveValue('ARTICLE')
    // Record boundaries only apply to Catalog; generic model discovery stays the default.
    expect(screen.queryByLabelText('Record boundaries')).not.toBeInTheDocument()
    fireEvent.change(selector, { target: { value: 'CATALOG' } })
    const boundaries = screen.getByLabelText('Record boundaries')
    expect(boundaries).toHaveValue('')
    if (recipe) fireEvent.change(boundaries, { target: { value: recipe } })
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))

    await waitFor(() => expect(extractionRequests).toHaveLength(1))
    expect(extractionRequests[0]).toEqual(
      expect.objectContaining({ strategy: 'CATALOG' }),
    )
    if (recipe) expect(extractionRequests[0].catalogRecipe).toBe(recipe)
    else expect(extractionRequests[0]).not.toHaveProperty('catalogRecipe')
    // The selection is one-shot: the next run defaults back to Article.
    await waitFor(() =>
      expect(screen.getByLabelText('Extraction strategy')).toHaveValue('ARTICLE'),
    )
    expect(screen.queryByLabelText('Record boundaries')).not.toBeInTheDocument()
  })

  describe('Results-tab run action after a Catalog attempt', () => {
    // Every Results-tab run action posts the toolbar's one-shot selection, so
    // after a Catalog attempt it names and posts the Article default until the
    // researcher selects Catalog again — unless the run it started failed,
    // which repeats that attempt's strategy and recipe.
    const catalogAttempts: Record<'FAILED' | 'SUCCEEDED', ExtractionAttempt> = {
      FAILED: {
        extractionId: '51000000-0000-4000-8006-000000000041',
        sourceDocumentId: '51000000-0000-4000-8001-000000000001',
        sourceRepresentationRevisionId: reopened.sourceRepresentationId,
        schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
        strategy: 'CATALOG', catalogRecipe: null, executionStatus: 'FAILED', outcome: null, complete: null,
        modelAttribution: null, diagnostics: null,
        failure: { code: 'catalog_discovery_failed', message: 'Discovery failed.' },
        resultPayload: null, evidenceLinks: null, reviewable: false, batchExtractionId: null,
        createdAt: '2026-08-12T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
      },
      SUCCEEDED: {
        extractionId: '51000000-0000-4000-8006-000000000042',
        sourceDocumentId: '51000000-0000-4000-8001-000000000001',
        sourceRepresentationRevisionId: reopened.sourceRepresentationId,
        schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
        strategy: 'CATALOG', catalogRecipe: null, executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
        modelAttribution: { provider: 'ollama', modelId: 'test-model' },
        diagnostics: {
          phase: 'grounding', durationMs: 1, modelCalls: 1,
          finishReason: 'stop', inputTokens: 1, outputTokens: 1,
          grounding: null, catalog: null,
        },
        failure: null, resultPayload: { records: [{ place: 'Catalogued' }] }, evidenceLinks: [],
        reviewable: true, batchExtractionId: null,
        createdAt: '2026-08-12T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
      },
    }

    /** The exact body a run from this workspace posts for a toolbar selection. */
    const posted = (strategy: 'ARTICLE' | 'CATALOG', catalogRecipe?: string) => ({
      id: expect.any(String),
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
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
      const bodies: Array<{ id: string; strategy: 'ARTICLE' | 'CATALOG' }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?'))
            return Promise.resolve(Response.json({ revisions: [] }))
          if (url.endsWith('/api/extractions') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { id: string; strategy: 'ARTICLE' | 'CATALOG' }
            bodies.push(body)
            return Promise.resolve(Response.json(
              { ...catalogAttempts[outcome], extractionId: body.id, strategy: body.strategy },
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

    /** Starts a Catalog run from the toolbar; acknowledging it resets the one-shot selection, unless it failed. */
    async function runCatalogFromToolbar(bodies: unknown[], recipe?: string, next: 'ARTICLE' | 'CATALOG' = 'ARTICLE') {
      fireEvent.change(screen.getByLabelText('Extraction strategy'), { target: { value: 'CATALOG' } })
      if (recipe)
        fireEvent.change(screen.getByLabelText('Record boundaries'), { target: { value: recipe } })
      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]).toEqual(posted('CATALOG', recipe))
      await waitFor(() =>
        expect(screen.getByLabelText('Extraction strategy')).toHaveValue(next),
      )
    }

    /** Opens Results and finds its run action by the exact name it must carry. */
    function resultsRunAction(name: string) {
      fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
      return screen.getByRole('button', { name })
    }

    it('names and posts Article after a Catalog run that succeeds', async () => {
      const bodies = stubRuns('SUCCEEDED')
      await renderWorkspace(null)
      await runCatalogFromToolbar(bodies)
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

      const action = resultsRunAction('Run Article extraction')
      expect(action).not.toHaveAccessibleDescription()
      fireEvent.click(action)
      await waitFor(() => expect(bodies).toHaveLength(2))
      expect(bodies[1]).toEqual(posted('ARTICLE'))
    })

    it('names and posts the same Catalog run after one that fails', async () => {
      const bodies = stubRuns('FAILED')
      await renderWorkspace(null)
      await runCatalogFromToolbar(bodies, undefined, 'CATALOG')

      const action = resultsRunAction('Run Catalog extraction')
      expect(action).toHaveAccessibleDescription('Boundaries: Model discovery')
      fireEvent.click(action)
      await waitFor(() => expect(bodies).toHaveLength(2))
      expect(bodies[1]).toEqual(posted('CATALOG'))
    })

    it.each([
      ['failed', 'FAILED', 'Extraction failed'],
      ['completed', 'SUCCEEDED', 'Catalogued'],
    ] as const)('names and posts Article after reopening a %s Catalog attempt', async (_label, outcome, shown) => {
      const bodies = stubRuns(outcome)
      await renderWorkspace({
        ...catalogAttempts[outcome],
        sourceRepresentation: reopened.persistedExtraction!.sourceRepresentation,
        extractionSchema: reopened.persistedExtraction!.extractionSchema,
      })
      expect(screen.getByLabelText('Extraction strategy')).toHaveValue('ARTICLE')

      const action = resultsRunAction('Run Article extraction')
      // Results shows the reopened Catalog attempt, not an empty workspace's run action.
      expect(screen.getByText(shown)).toBeVisible()
      expect(action).not.toHaveAccessibleDescription()
      fireEvent.click(action)
      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]).toEqual(posted('ARTICLE'))
    })

    it.each([
      ['selects the recipe again', 'numbered-catalogue-de@1', 'Numbered catalogue (German)'],
      ['keeps Model discovery', undefined, 'Model discovery'],
    ] as const)('after a recipe run, names and posts Catalog as the researcher %s', async (_label, recipe, boundaries) => {
      const bodies = stubRuns('SUCCEEDED')
      await renderWorkspace(null)
      await runCatalogFromToolbar(bodies, 'numbered-catalogue-de@1')
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      // The recipe is one-shot like the strategy: selecting Catalog again starts at Model discovery.
      fireEvent.change(screen.getByLabelText('Extraction strategy'), { target: { value: 'CATALOG' } })
      expect(screen.getByLabelText('Record boundaries')).toHaveValue('')
      expect(resultsRunAction('Run Catalog extraction')).toHaveAccessibleDescription('Boundaries: Model discovery')
      if (recipe)
        fireEvent.change(screen.getByLabelText('Record boundaries'), { target: { value: recipe } })

      const action = screen.getByRole('button', { name: 'Run Catalog extraction' })
      expect(action).toHaveAccessibleDescription(`Boundaries: ${boundaries}`)
      expect(screen.getByText(`Boundaries: ${boundaries}`)).toBeVisible()
      fireEvent.click(action)
      await waitFor(() => expect(bodies).toHaveLength(2))
      expect(bodies[1]).toEqual(posted('CATALOG', recipe))
    })
  })

  describe('the next run after a refused or failed one', () => {
    const recipe = 'numbered-catalogue-de@1'

    it('after a failed Catalog attempt, the next run posts that attempt\'s recipe', async () => {
      const bodies: Array<{ id: string; strategy: 'ARTICLE' | 'CATALOG'; catalogRecipe?: string }> = []
      const admitted = new Map<string, ExtractionAttempt>()
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?'))
            return Promise.resolve(Response.json({ revisions: [] }))
          if (url.endsWith('/api/extractions') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as (typeof bodies)[number]
            bodies.push(body)
            const queued: ExtractionAttempt = {
              extractionId: body.id,
              sourceDocumentId: '51000000-0000-4000-8001-000000000001',
              sourceRepresentationRevisionId: reopened.sourceRepresentationId,
              schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
              strategy: body.strategy, catalogRecipe: body.catalogRecipe ?? null,
              executionStatus: 'QUEUED', outcome: null, complete: null,
              modelAttribution: null, diagnostics: null, failure: null,
              resultPayload: null, evidenceLinks: null, reviewable: false, batchExtractionId: null,
              createdAt: '2026-08-12T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
            }
            admitted.set(body.id, queued)
            return Promise.resolve(Response.json(queued, { status: 201 }))
          }
          const monitored = admitted.get(url.split('/').at(-1)!)
          if (monitored)
            return Promise.resolve(Response.json({
              extraction: {
                ...monitored,
                executionStatus: 'FAILED',
                failure: { code: 'extraction_failed', message: 'Discovery failed.' },
              },
              pendingReviewDecisions: null,
            }))
          return Promise.resolve(new Response('pdf'))
        }),
      )
      render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
      await waitFor(() =>
        expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
      )
      fireEvent.change(screen.getByLabelText('Extraction strategy'), { target: { value: 'CATALOG' } })
      fireEvent.change(screen.getByLabelText('Record boundaries'), { target: { value: recipe } })
      fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]).toMatchObject({ strategy: 'CATALOG', catalogRecipe: recipe })

      fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
      expect(await screen.findByText('Discovery failed.', undefined, { timeout: 4_000 })).toBeVisible()
      // The failed attempt's strategy and recipe are the next run's selection.
      expect(screen.getByLabelText('Extraction strategy')).toHaveValue('CATALOG')
      expect(screen.getByLabelText('Record boundaries')).toHaveDisplayValue('Numbered catalogue (German)')
      const action = screen.getByRole('button', { name: 'Run Catalog extraction' })
      expect(action).toHaveAccessibleDescription('Boundaries: Numbered catalogue (German)')
      fireEvent.click(action)
      await waitFor(() => expect(bodies).toHaveLength(2))
      expect(bodies[1]).toEqual({
        id: expect.any(String),
        sourceRepresentationRevisionId: reopened.sourceRepresentationId,
        schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
        strategy: 'CATALOG',
        catalogRecipe: recipe,
        method: { models: null, settings: { recipe: null } },
      })
    })

    it('a superseded refusal refreshes the document and disables Run without hiding the earlier results', async () => {
      const message =
        "This document has been reprocessed. No new Extraction was started. Open the document from the project's Sources list to run on its current source revision. You can continue reviewing this earlier Extraction."
      const posts: unknown[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
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
      expect(screen.getByText('Ellekilde')).toBeVisible()

      fireEvent.click(screen.getByRole('button', { name: '↻ Re-run extraction' }))
      await waitFor(() => expect(onSourceSuperseded).toHaveBeenCalledOnce())
      expect(posts).toHaveLength(1)
      expect(screen.getByText('This document has been reprocessed — no new Extraction was started')).toBeVisible()
      expect(screen.getByText('Ellekilde')).toBeVisible()
      expect(screen.queryByText(/Extraction failed/)).not.toBeInTheDocument()
      const run = screen.getByRole('button', { name: '↻ Re-run extraction' })
      expect(run).toBeDisabled()
      expect(run).toHaveAttribute(
        'title',
        'This view shows an Extraction on an earlier Source Representation. Go back to the current one to run a new Extraction.',
      )
      expect(screen.queryByRole('button', { name: /^Run (Article|Catalog) extraction/ })).not.toBeInTheDocument()
    })

    it.each([
      [{ status: 'loading' } as const, 'Loading saved advanced settings…'],
      [{ status: 'error', message: 'Unavailable.' } as const, 'Nothing can start until they load.'],
    ])('starts nothing while the saved settings are %o', async (state, shown) => {
      const ready = saved.state
      saved.state = state
      try {
        vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
          const url = String(input)
          if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
          if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
          if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
          return Promise.resolve(new Response('pdf'))
        }))
        render(<DocumentWorkspace {...reopened} />)
        await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
        expect(screen.getByText(shown, { exact: false })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '↻ Re-run extraction' })).toBeDisabled()
      } finally {
        saved.state = ready
      }
    })

    it('shows the saved advanced settings it submits; a method_changed refusal opens them with a refresh and no failure', async () => {
      const message = 'Your saved advanced settings changed after this summary was shown. Nothing was started; review the updated summary and start again.'
      const posts: unknown[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
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
      saved.refresh.mockClear()
      render(<DocumentWorkspace {...reopened} />)
      await waitFor(() =>
        expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
      )
      expect(screen.getByText('Saved advanced settings')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: '↻ Re-run extraction' }))
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Nothing was started'))
      expect(posts).toHaveLength(1)
      expect(screen.queryByText(/Extraction failed/)).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Refresh summary' }))
      expect(saved.refresh).toHaveBeenCalledOnce()
      expect(screen.queryByRole('button', { name: 'Refresh summary' })).not.toBeInTheDocument()
    })

    it('keeps the superseded notice when the refresh moves a plain route to the reprocessed Source Representation', async () => {
      const posts: unknown[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
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

      fireEvent.click(screen.getByRole('button', { name: '↻ Re-run extraction' }))
      await waitFor(() => expect(onSourceSuperseded).toHaveBeenCalledOnce())
      await waitFor(() =>
        expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
      )

      expect(posts).toHaveLength(1)
      expect(screen.getByText('This document has been reprocessed — no new Extraction was started')).toBeVisible()
      // The workspace now shows the reprocessed Source Representation, which can be run.
      expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled()
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
      strategy: 'ARTICLE', catalogRecipe: null, requestedModels: body.models ?? null, executionStatus, outcome: null, complete: null,
      modelAttribution: null, diagnostics: null,
      failure: executionStatus === 'FAILED' ? { code: 'extraction_failed', message: 'kei-exp returned HTTP 422.' } : null,
      resultPayload: null, evidenceLinks: null, reviewable: false, batchExtractionId: null,
      createdAt: '2026-08-12T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
    })
    function stubFetch(models: () => Response, executionStatus: 'RUNNING' | 'FAILED') {
      const extractionRequests: Array<{ models?: object }> = []
      const modelReads: string[] = []
      let acknowledged: ReturnType<typeof attemptFor> | null = null
      vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
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
    fireEvent.click(screen.getByTitle('Edit place'))
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
            recordDescription: savedDefinition!.recordDescription,
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
      outcome: null,
      complete: null,
      modelAttribution: null,
      diagnostics: null,
      failure: null,
      resultPayload: null,
      evidenceLinks: null,
      reviewable: false,
      batchExtractionId: null,
      createdAt: reopened.persistedExtraction!.createdAt,
      reviewedAt: null,
      reviewDecisions: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/source'))
          return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown'))
          return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?'))
          return Promise.resolve(Response.json({ revisions: [] }))
        if (url.endsWith('/api/extractions'))
          return Promise.resolve(Response.json(runningAttempt, { status: 201 }))
        if (url.includes(`/api/extractions/${runningAttempt.extractionId}`))
          return Promise.resolve(Response.json({
            extraction: runningAttempt,
            pendingReviewDecisions: null,
          }))
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
        screen.getByRole('button', { name: 'Cancel extraction' }),
      ).toBeInTheDocument(),
    )
    expect(
      screen.getByRole('button', { name: 'Cancel extraction' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Extraction strategy')).toHaveValue('CATALOG')

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
        screen.getByRole('button', { name: '↻ Re-run extraction' }),
      ).toBeInTheDocument(),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 2_100))
    expect(
      screen.queryByRole('button', { name: 'Cancel extraction' }),
    ).not.toBeInTheDocument()
  })

  it('posts the accepted result with its pinned Schema Revision and canonical Review Decisions', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (init?.body !== undefined)
          calls.push({
            url,
            body:
              typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
          })
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
            executionStatus: 'COMPLETED',
            outcome: 'SUCCEEDED',
            complete: true,
            modelAttribution: { provider: 'ollama', modelId: 'test-model' },
            diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null, catalog: null },
            failure: null,
            resultPayload: { records: [{ number: '24-1' }] },
            evidenceLinks: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor' }],
            reviewable: true,
            batchExtractionId: null,
            createdAt: '2026-08-10T00:00:00.000Z',
            reviewedAt: null,
            reviewDecisions: [],
          }, { status: 201 })
        }
        if (/\/api\/extractions\/[0-9a-f-]+$/.test(url)) {
          const extractionId = url.split('/').at(-1)!
          return Response.json({
            extraction: {
              extractionId,
              sourceDocumentId: '51000000-0000-4000-8001-000000000001',
              sourceRepresentationRevisionId: reopened.sourceRepresentationId,
              schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
              strategy: 'ARTICLE', catalogRecipe: null, executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
              modelAttribution: { provider: 'ollama', modelId: 'test-model' },
              diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null, catalog: null },
              failure: null, resultPayload: { records: [{ number: '24-1' }] },
              evidenceLinks: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor' }],
              reviewable: true, batchExtractionId: null,
              createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: null,
              reviewDecisions: [],
            },
            pendingReviewDecisions: [{
              resultPath: ['records', 0, 'number'],
              evidenceAnchorId: 'bundled-anchor',
              reviewedOccurrenceIds: ['bundled-occurrence'],
              action: 'APPROVED',
              reviewedValue: null,
            }],
          })
        }
        if (url.endsWith('/review/draft')) {
          const draft = JSON.parse(String(init?.body))
          return Response.json({ ...draft, version: draft.version + 1 })
        }
        if (url.endsWith('/review')) {
          const extractionId = url.split('/').at(-2)!
          return Response.json({
            extractionId,
            sourceDocumentId: '51000000-0000-4000-8001-000000000001',
            sourceRepresentationRevisionId: reopened.sourceRepresentationId,
            schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
            strategy: 'ARTICLE', catalogRecipe: null, executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
            modelAttribution: { provider: 'ollama', modelId: 'test-model' },
            diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null, catalog: null },
            failure: null, resultPayload: { records: [{ number: '24-1' }] },
            evidenceLinks: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor' }],
            reviewable: true, batchExtractionId: null, createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: '2026-08-10T00:01:00.000Z',
            reviewDecisions: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor', reviewedOccurrenceIds: ['bundled-occurrence'], action: 'APPROVED', reviewedValue: null, createdAt: '2026-08-10T00:01:00.000Z' }],
          })
        }
        return new Response('# Beretning')
      }),
    )
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    // Completion never switches the rail tab; it reports through the finished
    // dialog and the researcher opens Results themselves.
    expect(await screen.findByText('✓ Extraction complete — view the JSON in the Results tab')).toBeVisible()
    // A terminal admission can show the toast before its awaiting caller opens the dialog.
    expect(await screen.findByRole('heading', { name: 'Extraction finished' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByRole('tab', { name: /^Schema/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    const approve = await screen.findByRole('button', { name: /Approve remaining/ })
    await waitFor(() => expect(approve).toBeEnabled())
    fireEvent.click(approve)
    expect(screen.getByText('Using Schema Revision 1 · Current revision: 1')).toBeInTheDocument()
    expect(screen.queryByText('Previous schema')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View used schema' }))
    expect(screen.getByText(reopened.extractionSchema!.schemaRevisionId)).toBeInTheDocument()
    expect(screen.getByText(/"place": "string"/)).toBeInTheDocument()
    expect(screen.queryByText(/"number": "string"/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    expect(await screen.findByText('Review saved')).toBeVisible()
    const review = calls.at(-1)!
    expect(review.url).toMatch(/\/api\/extractions\/[0-9a-f-]+\/review$/)
    expect(review.body).toEqual({
      expectedDraftVersion: 1,
      reviewDecisions: [
        {
          resultPath: ['records', 0, 'number'],
          evidenceAnchorId: 'bundled-anchor',
          reviewedOccurrenceIds: ['bundled-occurrence'],
          action: 'APPROVED',
          reviewedValue: null,
        },
      ],
    })
  })

  it.each([
    ['failure', { code: 'extraction_failed', message: 'Extraction failed.' }, 'Extraction failed — see details in Results'],
    ['cancellation', { code: 'cancelled', message: 'Extraction cancelled.' }, 'Extraction cancelled — no result was saved'],
  ] as const)('reports a persisted %s without a success toast', async (_label, failure, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
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
            executionStatus: 'FAILED',
            outcome: null,
            complete: null,
            modelAttribution: null,
            diagnostics: null,
            failure,
            resultPayload: null,
            evidenceLinks: null,
            reviewable: false,
            batchExtractionId: null,
            createdAt: '2026-08-10T00:00:00.000Z',
            reviewedAt: null,
            reviewDecisions: [],
          }, { status: 201 })
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
  const unfinished = {
    complete: null, modelAttribution: null, diagnostics: null,
    resultPayload: null, evidenceLinks: null, reviewable: false,
  } as const

  /** One Extraction as the attempt contract carries it. */
  const attemptOn = (
    sourceRepresentationRevisionId: string,
    overrides: Partial<ExtractionAttempt> = {},
  ): ExtractionAttempt => ({
    extractionId: '51000000-0000-4000-8006-000000000051',
    sourceDocumentId: '51000000-0000-4000-8001-000000000001',
    sourceRepresentationRevisionId,
    schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
    strategy: 'ARTICLE', catalogRecipe: null, executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
    modelAttribution: { provider: 'ollama', modelId: 'fixture' },
    diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, grounding: null, catalog: null },
    failure: null, resultPayload: { place: 'Ellekilde' }, evidenceLinks: [],
    reviewable: true, batchExtractionId: null,
    createdAt: '2026-07-31T12:03:00.000Z', reviewedAt: null, reviewDecisions: [],
    ...overrides,
  })

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
      latestReviewedExtraction: attempt.reviewedAt ? pinned : null,
    }
  }

  /** Serves the workspace's reads (`reads`, by URL) and keeps every posted run and cancellation. */
  function stubWorkspace(reads: Record<string, unknown> = {}) {
    const runs: Array<{ id: string; sourceRepresentationRevisionId: string; schemaRevisionId: string }> = []
    const cancellations: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
        if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
        if (url.startsWith('/api/schema-revisions?'))
          return Promise.resolve(Response.json({ revisions: [] }))
        if (url.endsWith('/api/extractions') && init?.method === 'POST') {
          const run = JSON.parse(String(init.body)) as (typeof runs)[number]
          runs.push(run)
          // A terminal answer, so no monitor outlives the test.
          return Promise.resolve(Response.json(attemptOn(run.sourceRepresentationRevisionId, {
            ...unfinished,
            extractionId: run.id,
            schemaRevisionId: run.schemaRevisionId,
            executionStatus: 'FAILED',
            outcome: null,
            failure: { code: 'extraction_failed', message: 'Extraction failed.' },
          }), { status: 201 }))
        }
        if (url.startsWith('/api/extractions/') && init?.method === 'DELETE') {
          cancellations.push(url)
          return Promise.resolve(Response.json({ extractionId: url.split('/').at(-1) }, { status: 202 }))
        }
        if (url in reads) return Promise.resolve(Response.json(reads[url]))
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

  const resultsRunActions = () =>
    screen.queryAllByRole('button', { name: /^Run (Article|Catalog) extraction/ })

  it.each([
    [
      'a reviewed result on a previous Schema Revision',
      attemptOn(earlierRepresentationId, { reviewedAt: '2026-08-01T00:00:00.000Z' }),
      'Review applies to Schema Revision 1',
    ],
    [
      'a result on the Current Schema Revision',
      attemptOn(earlierRepresentationId, { schemaRevisionId: currentSchema.schemaRevisionId }),
      'Using Schema Revision 2 · Current revision: 2',
    ],
    [
      'a failed attempt',
      attemptOn(earlierRepresentationId, {
        ...unfinished,
        executionStatus: 'FAILED',
        outcome: null,
        failure: { code: 'extraction_failed', message: 'The model was unreachable.' },
      }),
      'Extraction failed',
    ],
    [
      'a cancelled attempt',
      attemptOn(earlierRepresentationId, {
        ...unfinished,
        executionStatus: 'FAILED',
        outcome: null,
        failure: { code: 'cancelled', message: 'Extraction cancelled.' },
      }),
      'Extraction cancelled',
    ],
  ] as const)('offers no new run from %s', async (_label, attempt, shown) => {
    stubWorkspace()
    await renderView(pinnedView(attempt))

    const run = screen.getByRole('button', { name: /^(↻ Re-run|▶ Run) extraction$/ })
    expect(run).toBeDisabled()
    expect(run).toHaveAttribute('title', earlierSourceRunTitle)
    expect(screen.queryByText(/^Press Run extraction/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(screen.getByText(shown, { exact: true })).toBeVisible()
    expect(resultsRunActions()).toEqual([])
  })

  it('keeps Review of an unreviewed result open', async () => {
    const attempt = attemptOn(earlierRepresentationId, {
      schemaRevisionId: currentSchema.schemaRevisionId,
      resultPayload: { records: [{ place: 'Ellekilde' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'bundled-anchor' }],
    })
    stubWorkspace({
      [`/api/extractions/${attempt.extractionId}`]: {
        extraction: attempt,
        pendingReviewDecisions: [{
          resultPath: ['records', 0, 'place'],
          evidenceAnchorId: 'bundled-anchor',
          reviewedOccurrenceIds: ['bundled-occurrence'],
          action: 'APPROVED',
          reviewedValue: null,
        }],
      },
    })
    await renderView(pinnedView(attempt))

    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve remaining (1)' })).toBeEnabled(),
    )
    expect(screen.getByRole('button', { name: 'Reject place' })).toBeEnabled()
    expect(resultsRunActions()).toEqual([])
    expect(screen.getByRole('button', { name: '↻ Re-run extraction' })).toBeDisabled()
  })

  it('still cancels a running Extraction', async () => {
    const attempt = attemptOn(earlierRepresentationId, {
      ...unfinished,
      executionStatus: 'RUNNING',
      outcome: null,
    })
    const { cancellations } = stubWorkspace()
    await renderView(pinnedView(attempt))

    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(screen.getAllByRole('button', { name: 'Cancel extraction' })).toHaveLength(2)
    const cancel = screen.getByTitle('Cancel the active Extraction')
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    await waitFor(() =>
      expect(cancellations).toEqual([`/api/extractions/${attempt.extractionId}`]),
    )
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
  ] as const)('keeps the run actions of %s', async (_label, view) => {
    const { runs } = stubWorkspace()
    await renderView(view)

    const run = screen.getByRole('button', { name: '↻ Re-run extraction' })
    expect(run).toBeEnabled()
    expect(run).toHaveAttribute('title', 'Run one values extraction across the whole Source Document')
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Run Article extraction' }))
    await waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]).toMatchObject({ sourceRepresentationRevisionId: reopened.sourceRepresentationId })
  })

  it('offers the run again once Back reopens the current Source Representation, and posts that one', async () => {
    const reviewed = attemptOn(earlierRepresentationId, { reviewedAt: '2026-08-01T00:00:00.000Z' })
    const { runs } = stubWorkspace()
    const { rerender } = await renderView(pinnedView(reviewed))
    expect(screen.getByRole('button', { name: '↻ Re-run extraction' })).toBeDisabled()

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
    expect(screen.getByRole('button', { name: 'Open latest reviewed' })).toBeInTheDocument()
    const run = screen.getByRole('button', { name: '↻ Re-run extraction' })
    expect(run).toBeEnabled()
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }))
    expect(screen.getByRole('button', { name: 'Run Article extraction' })).toBeEnabled()

    fireEvent.click(run)
    await waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]).toMatchObject({
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      schemaRevisionId: currentSchema.schemaRevisionId,
    })
  })
})

describe('updated latest reviewed extraction', () => {
  it('refreshes the historical choice after rerender', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) =>
      Promise.resolve(String(input).endsWith('/source') ? Response.json(parsedDocument) : new Response('# Source')),
    ))
    const latest = reopened.persistedExtraction!
    const first = { ...latest, extractionId: '51000000-0000-4000-8006-000000000008', reviewedAt: '2026-08-08T00:00:00.000Z' }
    const second = { ...first, extractionId: '51000000-0000-4000-8006-000000000009', reviewedAt: '2026-08-09T00:00:00.000Z' }
    const { rerender } = render(<DocumentWorkspace {...reopened} latestReviewedExtraction={first} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    rerender(<DocumentWorkspace {...reopened} latestReviewedExtraction={second} />)
    expect(screen.getByRole<HTMLOptionElement>('option', { name: 'Latest reviewed' }).value).toBe(second.extractionId)
  })

})
