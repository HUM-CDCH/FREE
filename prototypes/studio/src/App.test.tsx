// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DocumentWorkspace, { type DocumentWorkspaceProps } from './App'
import parsedDocument from './assets/parsed_document.v2.json'

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
    createdAt: '2026-07-31T12:03:00.000Z',
    outcome: 'succeeded',
    result: { place: 'Ellekilde' },
    evidenceLinks: [],
    modelAttribution: { extraction: null, grounding: null },
    reviewDecisions: [],
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
    let extractCalls = 0
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
        if (url.endsWith('/api/extract')) {
          extractCalls += 1
          return Response.json({
            result:
              extractCalls === 1
                ? { number: '24-1' }
                : { links: { C1: 'E1' } },
            raw: '{}',
            reasoning: null,
            pages: 1,
            modelAttribution: { provider: 'ollama', modelId: 'test-model' },
          })
        }
        if (url.endsWith('/extraction-reviews'))
          return Response.json(
            { extractionId: '51000000-0000-4000-8006-000000000002' },
            { status: 201 },
          )
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
    expect(review.url).toContain(
      `/api/source-representations/${reopened.sourceRepresentationId}/extraction-reviews`,
    )
    expect(review.body).toEqual({
      schemaRevisionId: reopened.extractionSchema!.schemaRevisionId,
      result: { number: '24-1' },
      evidenceLinks: [
        {
          resultPath: ['number'],
          evidenceAnchorId: 'bundled-anchor',
        },
      ],
      modelAttribution: {
        extraction: { provider: 'ollama', modelId: 'test-model' },
        grounding: {
          strategy: 'retrieval_batched',
          batches: [
            {
              resultPath: null,
              candidateCount: 1,
              fallback: true,
              modelAttribution: {
                provider: 'ollama',
                modelId: 'test-model',
              },
            },
          ],
        },
      },
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
