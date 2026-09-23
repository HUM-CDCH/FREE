// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DocumentWorkspace, { type DocumentWorkspaceProps } from './App'
import { subscribeToAuthenticationRequired } from './auth/authenticatedFetch.ts'
import parsedDocument from './assets/parsed_document.v2.json'
import type { SchemaNode } from 'extraction/schema'

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
      dispatch: (name: string, event: { scale: number }) => void
    }

    firstPagePromise: Promise<void> | null = null

    constructor({
      eventBus,
    }: {
      eventBus: { dispatch: (name: string, event: { scale: number }) => void }
    }) {
      this.eventBus = eventBus
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
  // The real tab-strip slot (DocumentTabBar.tsx) that the workspace's PDF
  // controls portal into; document.body stands in since these tests render
  // DocumentWorkspace without its AppFrame shell.
  tabBarSlot: document.body,
  projectContextId: '51000000-0000-4000-8000-000000000001',
  pdfUrl:
    '/api/project-contexts/51000000-0000-4000-8000-000000000001/source-representations/51000000-0000-4000-8002-000000000001/pdf',
  filename: 'Beretning.pdf',
  sourceRepresentationId: '51000000-0000-4000-8002-000000000001',
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
  },
  persistedExtraction: {
    extractionId: '51000000-0000-4000-8006-000000000001',
    sourceDocumentId: '51000000-0000-4000-8001-000000000001',
    sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
    schemaRevisionId: '51000000-0000-4000-8005-000000000002',
    createdAt: '2026-07-31T12:03:00.000Z',
    reviewedAt: null,
    strategy: 'ARTICLE',
    executionStatus: 'COMPLETED',
    outcome: 'SUCCEEDED',
    complete: true,
    diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, grounding: null, catalog: null, retry: null },
    failure: null,
    resultPayload: { place: 'Ellekilde' },
    evidenceLinks: [],
    modelAttribution: { provider: 'ollama', modelId: 'fixture' },
    reviewable: true,
    retryOfId: null,
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
      name: runSurface === 'toolbar' ? '↻ Re-run extraction' : 'Rerun',
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
      strategy: 'ARTICLE', executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
      modelAttribution: { provider: 'ollama', modelId: 'test-model' },
      diagnostics: {
        phase: 'grounding', durationMs: 1, modelCalls: 1,
        finishReason: 'stop', inputTokens: 1, outputTokens: 1,
        grounding: null,
        catalog: null,
        retry: null,
      },
      failure: null, resultPayload: { records: [{ place: 'Article' }] },
      evidenceLinks: [], reviewable: true, retryOfId: null, batchExtractionId: null,
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
    expect(screen.queryByRole('button', { name: 'Rerun' })).not.toBeInTheDocument()
    expect(screen.getByText('Ellekilde')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Run with current schema' }))
    await waitFor(() => expect(extractionRequests).toHaveLength(1))
    expect(extractionRequests[0]!.schemaRevisionId).toBe(savedSchemaRevisionId)
    extractionResponse.resolve(Response.json({
      extractionId: extractionRequests[0]!.id,
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      schemaRevisionId: savedSchemaRevisionId,
      strategy: 'ARTICLE', executionStatus: 'RUNNING', outcome: null, complete: null,
      modelAttribution: null, diagnostics: null, failure: null, resultPayload: null,
      evidenceLinks: null, reviewable: false, retryOfId: null, batchExtractionId: null,
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
          const body = JSON.parse(String(init?.body)) as { strategy?: string }
          extractionRequests.push(body)
          return Promise.resolve(Response.json({
            extractionId: '51000000-0000-4000-8006-000000000021',
            sourceDocumentId: '51000000-0000-4000-8001-000000000001',
            sourceRepresentationRevisionId: reopened.sourceRepresentationId,
            schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
            strategy: 'CATALOG', executionStatus: 'FAILED', outcome: null, complete: null,
            modelAttribution: null,
            diagnostics: null,
            failure: { code: 'catalog_discovery_failed', message: 'Discovery failed.' },
            resultPayload: null, evidenceLinks: null, reviewable: false,
            retryOfId: null, batchExtractionId: null,
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
      strategy: 'ARTICLE', requestedModels: body.models ?? null, executionStatus, outcome: null, complete: null,
      modelAttribution: null, diagnostics: null,
      failure: executionStatus === 'FAILED' ? { code: 'extraction_failed', message: 'kei-exp returned HTTP 422.' } : null,
      resultPayload: null, evidenceLinks: null, reviewable: false, retryOfId: null, batchExtractionId: null,
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
      executionStatus: 'RUNNING' as const,
      outcome: null,
      complete: null,
      modelAttribution: null,
      diagnostics: null,
      failure: null,
      resultPayload: null,
      evidenceLinks: null,
      reviewable: false,
      retryOfId: null,
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
            executionStatus: 'COMPLETED',
            outcome: 'SUCCEEDED',
            complete: true,
            modelAttribution: { provider: 'ollama', modelId: 'test-model' },
            diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null, catalog: null, retry: null },
            failure: null,
            resultPayload: { records: [{ number: '24-1' }] },
            evidenceLinks: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor' }],
            reviewable: true,
            retryOfId: null, batchExtractionId: null,
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
              strategy: 'ARTICLE', executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
              modelAttribution: { provider: 'ollama', modelId: 'test-model' },
              diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null, catalog: null, retry: null },
              failure: null, resultPayload: { records: [{ number: '24-1' }] },
              evidenceLinks: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor' }],
              reviewable: true, retryOfId: null, batchExtractionId: null,
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
            strategy: 'ARTICLE', executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
            modelAttribution: { provider: 'ollama', modelId: 'test-model' },
            diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null, catalog: null, retry: null },
            failure: null, resultPayload: { records: [{ number: '24-1' }] },
            evidenceLinks: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor' }],
            reviewable: true, retryOfId: null, batchExtractionId: null, createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: '2026-08-10T00:01:00.000Z',
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
    expect(screen.getByRole('heading', { name: 'Extraction finished' })).toBeInTheDocument()
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
    ['failed job', 'FAILED', null, 'Extraction failed — see details in Results'],
    ['cancellation', 'COMPLETED', 'CANCELLED', 'Extraction cancelled — no result was saved'],
  ] as const)('reports a persisted %s without a success toast', async (_label, executionStatus, outcome, message) => {
    const failedJob = executionStatus === 'FAILED'
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
            executionStatus,
            outcome,
            complete: failedJob ? true : null,
            modelAttribution: failedJob ? { provider: 'ollama', modelId: 'test-model' } : null,
            diagnostics: { phase: 'extracting', durationMs: 1, modelCalls: 1, finishReason: null, inputTokens: null, outputTokens: null, grounding: null, catalog: null, retry: null },
            failure: failedJob ? { code: 'extraction_failed', message: 'Extraction failed.' } : null,
            resultPayload: failedJob ? { records: [{ place: 'Checkpointed' }] } : null,
            evidenceLinks: null,
            reviewable: false,
            retryOfId: null, batchExtractionId: null,
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
