// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DocumentWorkspace, { type DocumentWorkspaceProps } from './App'
import parsedDocument from './assets/parsed_document.v2.json'
import type { SchemaNode } from '../shared/schemaNode'

const { scrollPageIntoView } = vi.hoisted(() => ({ scrollPageIntoView: vi.fn() }))

vi.mock('pdfjs-dist/build/pdf.worker.mjs?url', () => ({ default: 'pdf.worker.mjs' }))
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 3 }),
    destroy: () => {},
  }),
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
    setDocument() {}
    scrollPageIntoView = scrollPageIntoView
  },
}))
const reopened: DocumentWorkspaceProps = {
  projectContextId: '51000000-0000-4000-8000-000000000001',
  pdfUrl: '/api/source-representations/rep/pdf',
  filename: 'Beretning.pdf',
  sourceRepresentationId: '51000000-0000-4000-8002-000000000001',
  markdownUrl: '/api/source-representations/rep/markdown',
  parsedDocumentUrl: '/api/source-representations/rep/source',
  annotationSet: {
    annotationSetId: '51000000-0000-4000-8003-000000000001',
    revisionNumber: 1,
    annotations: [
      {
        annotationId: '51000000-0000-4000-8004-000000000001',
        evidenceAnchorId: 'anchor-1',
        text: 'The restored annotation',
        pageNumber: 2,
      },
    ],
  },
  extractionSchema: {
    extractionSchemaId: '51000000-0000-4000-8005-000000000001',
    schemaRevisionId: '51000000-0000-4000-8005-000000000002',
    revisionNumber: 1,
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
    diagnostics: { phase: 'persisting', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, grounding: null },
    failure: null,
    resultPayload: { place: 'Ellekilde' },
    evidenceLinks: [],
    modelAttribution: { provider: 'ollama', modelId: 'fixture' },
    reviewable: true,
    retryOfId: null,
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
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    },
  },
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
          return Response.json({ template: { site: 'string' }, raw: '{}', pages: 1 })
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          schemaNodes = (JSON.parse(String(init.body)) as { schemaNodes: unknown[] }).schemaNodes
          return Response.json({
            revision: {
              schemaRevisionId,
              extractionSchemaId,
              revisionNumber: 1,
              origin: 'suggestion',
              createdAt: '2026-08-09T10:00:00.000Z',
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
              schemaNodes: historicalNodes,
            },
          })
        }
        if (url === '/api/schema-revisions' && method === 'POST') {
          const request = body as { expectedRevisionNumber: number; schemaNodes: unknown[] }
          return Response.json({
            revision: {
              schemaRevisionId: request.expectedRevisionNumber === 2
                ? '51000000-0000-4000-8005-000000000021'
                : '51000000-0000-4000-8005-000000000022',
              extractionSchemaId: reopened.extractionSchema!.extractionSchemaId,
              revisionNumber: request.expectedRevisionNumber + 1,
              origin: 'researcher-edit',
              createdAt: '2026-08-09T10:02:00.000Z',
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
      schemaNodes: historicalNodes,
    })
    expect(await screen.findByText('historical_group')).toBeInTheDocument()
    expect(screen.getByText('historical_title')).toBeInTheDocument()
  })

  it('hydrates the annotation set, Extraction Schema, and Extraction Result', async () => {
    await renderReopened()

    expect(
      screen.getByRole('button', {
        name: 'Remove highlight: The restored annotation',
      }),
    ).toBeInTheDocument()
    // The Schema tab's badge is the field count derived from the reopened template.
    expect(screen.getByRole('tab', { name: /^Schema\s*1$/ })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '↻ Re-run extraction' }),
    ).toBeInTheDocument()
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
            diagnostics: { phase: 'persisting', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null },
            failure: null,
            resultPayload: { records: [{ number: '24-1' }] },
            evidenceLinks: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor' }],
            reviewable: true,
            retryOfId: null,
            createdAt: '2026-08-10T00:00:00.000Z',
            reviewedAt: null,
            reviewDecisions: [],
          }, { status: 201 })
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
            diagnostics: { phase: 'persisting', durationMs: 1, modelCalls: 2, finishReason: 'stop', inputTokens: 10, outputTokens: 4, grounding: null },
            failure: null, resultPayload: { records: [{ number: '24-1' }] },
            evidenceLinks: [{ resultPath: ['records', 0, 'number'], evidenceAnchorId: 'bundled-anchor' }],
            reviewable: true, retryOfId: null, createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: '2026-08-10T00:01:00.000Z',
            reviewDecisions: [{ reviewDecisionId: '51000000-0000-4000-8007-000000000001', evidenceAnchorId: 'bundled-anchor', reviewedOccurrenceIds: ['bundled-occurrence'] }],
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
    const accept = await screen.findByRole('button', { name: 'Accept result' })
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

  it('keeps a restored annotation usable without a pdf.js editor', async () => {
    await renderReopened()

    fireEvent.click(
      screen.getByTitle('Go to highlight on page 2: The restored annotation'),
    )
    expect(scrollPageIntoView).toHaveBeenCalledWith({ pageNumber: 2 })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove highlight: The restored annotation',
      }),
    )
    expect(
      screen.queryByRole('button', {
        name: 'Remove highlight: The restored annotation',
      }),
    ).not.toBeInTheDocument()
  })
})
