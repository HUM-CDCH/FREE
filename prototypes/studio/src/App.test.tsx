// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DocumentWorkspace, { type DocumentWorkspaceProps } from './App'
import parsedDocument from './assets/parsed_document.v2.json'
import type { SchemaNode } from 'extraction/schema'

const { getDocument, scrollPageIntoView } = vi.hoisted(() => ({
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({ numPages: 3 }),
    destroy: () => {},
  })),
  scrollPageIntoView: vi.fn(),
}))

vi.mock('pdfjs-dist/build/pdf.worker.mjs?url', () => ({ default: 'pdf.worker.mjs' }))
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument,
  AnnotationEditorType: { HIGHLIGHT: 9 },
  AnnotationMode: { ENABLE: 2 },
}))
// Nothing emits `annotationeditoruimanager`, so the workspace holds no pdf.js
// editors — exactly the state a reopened Source Document's annotations start in.
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  EventBus: class {
    on() {}
    off() {}
  },
  PDFViewer: class {
    private pagesReady = false
    private scaleValue: string | null = null

    currentScale = 1
    firstPagePromise: Promise<void> | null = null

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
  pdfUrl: '/api/source-representations/rep/pdf',
  filename: 'Beretning.pdf',
  sourceRepresentationId: '51000000-0000-4000-8002-000000000001',
  markdownUrl: '/api/source-representations/rep/markdown',
  parsedDocumentUrl: '/api/source-representations/rep/source',
  // DocumentWorkspace no longer reads annotationSet — the Annotation tab was
  // retired in favor of SchemaPanel's own doc chat. Left in place, commented
  // out, rather than deleted.
  // annotationSet: {
  //   annotationSetId: '51000000-0000-4000-8003-000000000001',
  //   revisionNumber: 1,
  //   annotations: [
  //     {
  //       annotationId: '51000000-0000-4000-8004-000000000001',
  //       evidenceAnchorId: 'anchor-1',
  //       text: 'The restored annotation',
  //       pageNumber: 2,
  //     },
  //   ],
  // },
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
    outcome: 'SUCCEEDED',
    complete: true,
    diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, grounding: null },
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
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  getDocument.mockClear()
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
  render(<DocumentWorkspace {...reopened} />)
  await waitFor(() =>
    expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
  )
}

describe('reopened Source Document workspace', () => {
  it('initializes PDF zoom only after the first page is available', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await renderReopened()

      expect(consoleError).not.toHaveBeenCalledWith(
        'scrollPageIntoView: "1" is not a valid pageNumber parameter.',
      )
    } finally {
      consoleError.mockRestore()
    }
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

    fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }))
    await waitFor(() =>
      expect(page.querySelectorAll('[data-evidence-anchor-id]')).toHaveLength(0),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
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

  it('loads an older revision before appending the pending draft and restored tree', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))

    await waitFor(() => expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2))
    const getIndex = requests.findIndex((request) =>
      request.url.startsWith(`/api/schema-revisions/${historicalRevisionId}?`),
    )
    const postRequests = requests.filter((request) => request.method === 'POST')
    expect(getIndex).toBeGreaterThan(-1)
    expect(requests.indexOf(postRequests[0])).toBeGreaterThan(getIndex)
    expect((postRequests[0].body as { expectedRevisionNumber: number }).expectedRevisionNumber).toBe(2)
    expect((postRequests[0].body as { schemaNodes: Array<{ name: string }> }).schemaNodes.map((node) => node.name)).toEqual(['current_field', 'nyt_felt'])
    expect(postRequests[1].body).toEqual({
      projectContextId: reopened.projectContextId,
      extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
      expectedRevisionNumber: 3,
      recordDescription: 'One historical record.',
      schemaNodes: historicalNodes,
    })
    expect(await screen.findByText('historical_group')).toBeInTheDocument()
    expect(screen.getByText('historical_title')).toBeInTheDocument()
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

    // Annotation-set hydration was covered here too before the Annotation tab
    // was retired (see the commented-out test below). Left in place, rather
    // than deleted.
    // expect(
    //   screen.getByRole('button', {
    //     name: 'Remove highlight: The restored annotation',
    //   }),
    // ).toBeInTheDocument()
    // The Schema tab's badge is the field count derived from the reopened template.
    expect(screen.getByRole('tab', { name: /^Schema\s*1$/ })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '↻ Re-run extraction' }),
    ).toBeInTheDocument()
  })

  it('waits for a dirty schema save before starting an Article run', async () => {
    const savedSchemaRevisionId = '51000000-0000-4000-8005-000000000099'
    let resolveExtraction!: (response: Response) => void
    const extractionResponse = new Promise<Response>((resolve) => {
      resolveExtraction = resolve
    })
    const extractionRequests: Array<{ strategy?: string; schemaRevisionId?: string }> = []
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
        if (url.endsWith('/api/extractions')) {
          extractionRequests.push(JSON.parse(String(init?.body)) as { strategy?: string; schemaRevisionId?: string })
          return extractionResponse
        }
        return Promise.resolve(new Response('# Beretning'))
      }),
    )
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() =>
      expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Schema/ }))
    fireEvent.click(screen.getByTitle('Edit place'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'location' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const run = screen.getByRole('button', { name: '▶ Run extraction' })
    fireEvent.click(run)
    await waitFor(() => expect(run).toBeDisabled())
    fireEvent.click(run)

    await waitFor(() => expect(extractionRequests).toHaveLength(1))
    expect(extractionRequests[0]).toEqual(expect.objectContaining({
      strategy: 'ARTICLE',
      schemaRevisionId: savedSchemaRevisionId,
    }))

    resolveExtraction(Response.json({
      extractionId: '51000000-0000-4000-8006-000000000011',
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      sourceRepresentationRevisionId: reopened.sourceRepresentationId,
      schemaRevisionId: '51000000-0000-4000-8005-000000000010',
      strategy: 'ARTICLE', outcome: 'SUCCEEDED', complete: true,
      modelAttribution: { provider: 'ollama', modelId: 'test-model' },
      diagnostics: {
        phase: 'grounding', durationMs: 1, modelCalls: 1,
        finishReason: 'stop', inputTokens: 1, outputTokens: 1,
        grounding: null,
      },
      failure: null, resultPayload: { records: [{ place: 'Article' }] },
      evidenceLinks: [], reviewable: true, retryOfId: null, batchExtractionId: null,
      createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
    }))
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
            outcome: 'SUCCEEDED',
            complete: true,
            modelAttribution: { provider: 'ollama', modelId: 'test-model' },
            diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null },
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
              strategy: 'ARTICLE', outcome: 'SUCCEEDED', complete: true,
              modelAttribution: { provider: 'ollama', modelId: 'test-model' },
              diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null },
              failure: null, resultPayload: { records: [{ number: '24-1' }] },
              evidenceLinks: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor' }],
              reviewable: true, retryOfId: null, batchExtractionId: null,
              createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: null,
              reviewDecisions: [],
            },
            pendingReviewDecisions: [{
              evidenceAnchorId: 'bundled-anchor',
              reviewedOccurrenceIds: ['bundled-occurrence'],
            }],
          })
        }
        if (url.endsWith('/review')) {
          const extractionId = url.split('/').at(-2)!
          return Response.json({
            extractionId,
            sourceDocumentId: '51000000-0000-4000-8001-000000000001',
            sourceRepresentationRevisionId: reopened.sourceRepresentationId,
            schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
            strategy: 'ARTICLE', outcome: 'SUCCEEDED', complete: true,
            modelAttribution: { provider: 'ollama', modelId: 'test-model' },
            diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null },
            failure: null, resultPayload: { records: [{ number: '24-1' }] },
            evidenceLinks: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor' }],
            reviewable: true, retryOfId: null, batchExtractionId: null, createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: '2026-08-10T00:01:00.000Z',
            reviewDecisions: [{ evidenceAnchorId: 'bundled-anchor', reviewedOccurrenceIds: ['bundled-occurrence'] }],
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
    const accept = await screen.findByRole('button', { name: 'Save Review' })
    fireEvent.click(accept)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Review saved' })).toBeDisabled(),
    )
    const review = calls.at(-1)!
    expect(review.url).toMatch(/\/api\/extractions\/[0-9a-f-]+\/review$/)
    expect(review.body).toEqual({
      reviewDecisions: [
        {
          evidenceAnchorId: 'bundled-anchor',
          reviewedOccurrenceIds: ['bundled-occurrence'],
        },
      ],
    })
  })

  it.each([
    ['FAILED', 'Extraction failed — see details in Results'],
    ['CANCELLED', 'Extraction cancelled — no result was saved'],
  ] as const)('reports a persisted %s attempt without a success toast', async (outcome, message) => {
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
            outcome,
            complete: null,
            modelAttribution: null,
            diagnostics: { phase: 'extracting', durationMs: 1, modelCalls: 1, finishReason: null, inputTokens: null, outputTokens: null, grounding: null },
            failure: outcome === 'FAILED' ? { code: 'extraction_failed', message: 'Extraction failed.' } : null,
            resultPayload: null,
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

  // Retired along with the Annotation tab (no more highlight-set list to
  // select/remove from). Left in place, commented out, rather than deleted.
  //
  // it('keeps a restored annotation usable without a pdf.js editor', async () => {
  //   await renderReopened()
  //
  //   fireEvent.click(
  //     screen.getByTitle('Go to highlight on page 2: The restored annotation'),
  //   )
  //   expect(scrollPageIntoView).toHaveBeenCalledWith({ pageNumber: 2 })
  //
  //   fireEvent.click(
  //     screen.getByRole('button', {
  //       name: 'Remove highlight: The restored annotation',
  //     }),
  //   )
  //   expect(
  //     screen.queryByRole('button', {
  //       name: 'Remove highlight: The restored annotation',
  //     }),
  //   ).not.toBeInTheDocument()
  // })
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
