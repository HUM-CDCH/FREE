// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DocumentWorkspace, { type DocumentWorkspaceProps } from './App'

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
// Painting evidence needs a real canvas; hydrating the workspace does not.
vi.mock('./EvidenceHighlightLayer', () => ({ default: () => null }))

const reopened: DocumentWorkspaceProps = {
  pdfUrl: '/api/source-representations/rep/pdf',
  filename: 'Beretning.pdf',
  markdownUrl: '/api/source-representations/rep/markdown',
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
    revisionNumber: 1,
    template: { place: 'string' },
  },
  persistedExtraction: {
    extractionId: '51000000-0000-4000-8006-000000000001',
    createdAt: '2026-07-31T12:03:00.000Z',
    outcome: 'succeeded',
    result: { place: 'Ellekilde' },
    evidence: null,
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
    vi.fn(() => Promise.resolve(new Response('# Beretning'))),
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
