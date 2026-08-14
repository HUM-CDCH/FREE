// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BatchExtractionsPanel from './BatchExtractionsPanel'

const projectContextId = '51000000-0000-4000-8000-000000000001'
const schemaRevisionId = '51000000-0000-4000-8004-000000000001'
const batchExtractionId = '51000000-0000-4000-8007-000000000001'
const failedDocumentId = '51000000-0000-4000-8001-000000000001'
const cancelledDocumentId = '51000000-0000-4000-8001-000000000002'
const extractionId = '51000000-0000-4000-8006-000000000001'

const documents = [
  { sourceDocumentId: failedDocumentId, name: 'Failed.pdf', pageCount: 2 },
  { sourceDocumentId: cancelledDocumentId, name: 'Cancelled.pdf', pageCount: 1 },
]

const batch = {
  batchExtractionId,
  projectContextId,
  schemaRevisionId,
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  extractionSchemaName: 'Places',
  schemaRevisionNumber: 1,
  strategy: 'ARTICLE' as const,
  createdAt: '2026-08-14T10:42:00.000Z',
  members: [
    {
      sourceDocumentId: failedDocumentId,
      sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
      latestExtraction: {
        extractionId,
        outcome: 'FAILED' as const,
        complete: null,
        reviewable: false,
        createdAt: '2026-08-14T10:43:00.000Z',
        reviewedAt: null,
        failureMessage: 'The provider rejected this document.',
      },
    },
    {
      sourceDocumentId: cancelledDocumentId,
      sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000002',
      latestExtraction: {
        extractionId: '51000000-0000-4000-8006-000000000002',
        outcome: 'CANCELLED' as const,
        complete: null,
        reviewable: false,
        createdAt: '2026-08-14T10:44:00.000Z',
        reviewedAt: null,
        failureMessage: null,
      },
    },
  ],
}

function response(body: unknown) {
  return Response.json(body)
}

function renderPanel(onNavigate = vi.fn()) {
  render(
    <BatchExtractionsPanel
      projectContextId={projectContextId}
      sourceDocuments={documents}
      onNavigate={onNavigate}
    />,
  )
  return onNavigate
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BatchExtractionsPanel', () => {
  it('keeps failures and cancellations distinct and opens the selected result in the document workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ batchExtractions: [batch] })),
    )
    const onNavigate = renderPanel()

    await screen.findByText('1 failed · 1 cancelled')
    fireEvent.click(screen.getByRole('button', { name: /Places/ }))

    expect(screen.getByText('The provider rejected this document.')).toBeVisible()
    expect(screen.getByText('The Extraction was cancelled before completion.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Failed.pdf/ }))
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'document',
      projectContextId,
      sourceDocumentId: failedDocumentId,
      extractionId,
    })
  })

  it('labels a reviewed empty Extraction as reviewed', async () => {
    const reviewedEmptyBatch = {
      ...batch,
      members: [
        {
          ...batch.members[0],
          latestExtraction: {
            ...batch.members[0].latestExtraction,
            outcome: 'SUCCEEDED' as const,
            complete: false,
            reviewable: false,
            reviewedAt: null,
            failureMessage: null,
          },
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ batchExtractions: [reviewedEmptyBatch] })),
    )
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: /Places/ }))

    expect(screen.getAllByText('Reviewed')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /Failed.pdf/ })).toHaveTextContent(
      'Reviewed',
    )
  })

  it('opens at most one batch while the first open is pending', async () => {
    let resolveOpen!: (value: Response) => void
    const openPending = new Promise<Response>((resolve) => {
      resolveOpen = resolve
    })
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({ batchExtractions: [] })
      if (url.startsWith('/api/extraction-schemas?'))
        return response({
          extractionSchemas: [
            {
              extractionSchemaId: batch.extractionSchemaId,
              name: 'Places',
              createdAt: '2026-08-14T10:00:00.000Z',
              currentRevision: {
                schemaRevisionId,
                revisionNumber: 1,
                origin: 'researcher-edit',
                createdAt: '2026-08-14T10:00:00.000Z',
              },
            },
          ],
        })
      if (url === '/api/batch-extractions' && init?.method === 'POST')
        return openPending
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    const run = screen.getByRole('button', { name: 'Run 1 Source Document' })
    fireEvent.click(run)
    fireEvent.click(run)

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/batch-extractions',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    expect(
      fetch.mock.calls.filter(
        ([url, init]) =>
          url === '/api/batch-extractions' && init?.method === 'POST',
      ),
    ).toHaveLength(1)
    resolveOpen(
      response({
        batchExtraction: { ...batch, members: [] },
        disposition: 'created',
      }),
    )
    const body = JSON.parse(
      String(
        fetch.mock.calls.find(
          ([url, init]) =>
            url === '/api/batch-extractions' && init?.method === 'POST',
        )?.[1]?.body,
      ),
    )
    expect(body).not.toHaveProperty('id')
  })

  it('shows the current member as in progress while its extraction is running', async () => {
    const pendingBatch = {
      ...batch,
      members: [{ ...batch.members[0], latestExtraction: null }],
    }
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({ batchExtractions: [] })
      if (url.startsWith('/api/extraction-schemas?'))
        return response({
          extractionSchemas: [
            {
              extractionSchemaId: batch.extractionSchemaId,
              name: 'Places',
              createdAt: '2026-08-14T10:00:00.000Z',
              currentRevision: {
                schemaRevisionId,
                revisionNumber: 1,
                origin: 'researcher-edit',
                createdAt: '2026-08-14T10:00:00.000Z',
              },
            },
          ],
        })
      if (url === '/api/batch-extractions' && init?.method === 'POST')
        return response({
          batchExtraction: pendingBatch,
          disposition: 'created',
        })
      if (url === '/api/extractions' && init?.method === 'POST')
        return new Promise<Response>(() => {})
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Run 1 Source Document' }))
    await screen.findByText('Running · 0 of 1')
    fireEvent.click(screen.getByRole('button', { name: /Places/ }))

    expect(screen.getByRole('button', { name: /Failed.pdf/ })).toHaveTextContent(
      'In progress',
    )
  })

  it('asks before forcing another matching running batch', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({ batchExtractions: [] })
      if (url.startsWith('/api/extraction-schemas?'))
        return response({
          extractionSchemas: [
            {
              extractionSchemaId: batch.extractionSchemaId,
              name: 'Places',
              createdAt: '2026-08-14T10:00:00.000Z',
              currentRevision: {
                schemaRevisionId,
                revisionNumber: 1,
                origin: 'researcher-edit',
                createdAt: '2026-08-14T10:00:00.000Z',
              },
            },
          ],
        })
      if (url === '/api/batch-extractions' && init?.method === 'POST')
        return response({
          batchExtraction: { ...batch, members: [] },
          disposition: 'running',
        })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Run 1 Source Document' }))

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(
      fetch.mock.calls.filter(
        ([url, init]) =>
          url === '/api/batch-extractions' && init?.method === 'POST',
      ),
    ).toHaveLength(1)
  })

  it('automatically retries only failed members of a matching failed batch', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({ batchExtractions: [] })
      if (url.startsWith('/api/extraction-schemas?'))
        return response({
          extractionSchemas: [
            {
              extractionSchemaId: batch.extractionSchemaId,
              name: 'Places',
              createdAt: '2026-08-14T10:00:00.000Z',
              currentRevision: {
                schemaRevisionId,
                revisionNumber: 1,
                origin: 'researcher-edit',
                createdAt: '2026-08-14T10:00:00.000Z',
              },
            },
          ],
        })
      if (url === '/api/batch-extractions' && init?.method === 'POST')
        return response({ batchExtraction: batch, disposition: 'retry' })
      if (url === '/api/extractions' && init?.method === 'POST')
        return Response.json(
          { error: { code: 'provider_failed', message: 'Provider failed.' } },
          { status: 500 },
        )
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Run 1 Source Document' }))

    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(
          ([url, init]) => url === '/api/extractions' && init?.method === 'POST',
        ),
      ).toHaveLength(1),
    )
    expect(
      JSON.parse(
        String(
          fetch.mock.calls.find(
            ([url, init]) =>
              url === '/api/extractions' && init?.method === 'POST',
          )?.[1]?.body,
        ),
      ),
    ).toMatchObject({
      batchExtractionId,
      sourceRepresentationRevisionId:
        batch.members[0].sourceRepresentationRevisionId,
    })
  })
})
