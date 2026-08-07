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
    template: { place: 'string' },
  },
  persistedExtraction: {
    extractionId: '51000000-0000-4000-8006-000000000001',
    createdAt: '2026-07-31T12:03:00.000Z',
    outcome: 'succeeded',
    result: { place: 'Ellekilde' },
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
        if (url.endsWith('/api/extract'))
          return Response.json({
            // The model cites the label it was shown; the browser resolves it.
            result: { number: { value: '24-1', anchor_id: 'E1' } },
            raw: '{}',
            reasoning: null,
            pages: 1,
            modelAttribution: { provider: 'ollama', modelId: 'test-model' },
          })
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
      result: { number: { value: '24-1', anchor_id: 'bundled-anchor' } },
      modelAttribution: { provider: 'ollama', modelId: 'test-model' },
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
