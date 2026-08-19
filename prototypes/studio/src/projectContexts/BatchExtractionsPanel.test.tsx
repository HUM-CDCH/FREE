// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
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
  {
    sourceDocumentId: cancelledDocumentId,
    name: 'Cancelled.pdf',
    pageCount: 1,
  },
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

    expect(
      screen.getByText('The provider rejected this document.'),
    ).toBeVisible()
    expect(
      screen.getByText('The Extraction was cancelled before completion.'),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Failed.pdf/ }))
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'document',
      projectContextId,
      sourceDocumentId: failedDocumentId,
      extractionId,
    })
  })

  it('never labels an unreviewed Extraction with no reviewable result as reviewed', async () => {
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

    expect(screen.queryByText('Reviewed')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Failed.pdf/ }),
    ).toHaveTextContent('No reviewable result')
  })

  it('opens at most one server-owned batch and does not cancel it on unmount', async () => {
    let resolveOpen!: (value: Response) => void
    const openPending = new Promise<Response>((resolve) => {
      resolveOpen = resolve
    })
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
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
    const batchRequest = fetch.mock.calls.find(
      ([url, init]) =>
        url === '/api/batch-extractions' && init?.method === 'POST',
    )
    expect(batchRequest?.[1]?.signal).toBeUndefined()
    expect(
      fetch.mock.calls.some(
        ([url, init]) => url === '/api/extractions' && init?.method === 'POST',
      ),
    ).toBe(false)
    cleanup()
    resolveOpen(
      response({
        batchExtraction: { ...batch, members: [] },
        disposition: 'created',
        memberFailures: [],
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

  it('keeps an opened batch when the initial history read resolves later', async () => {
    let resolveHistory!: (value: Response) => void
    const history = new Promise<Response>((resolve) => {
      resolveHistory = resolve
    })
    const openedBatch = { ...batch, members: [batch.members[0]] }
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?')) return history
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
            batchExtraction: openedBatch,
            disposition: 'created',
            memberFailures: [],
          })
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(
      screen.getByRole('button', { name: 'Run 1 Source Document' }),
    )

    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            url === '/api/batch-extractions' && init?.method === 'POST',
        ),
      ).toBe(true),
    )
    await screen.findByRole('button', { name: /Places/ })

    resolveHistory(response({ batchExtractions: [] }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Places/ }),
      ).toBeInTheDocument(),
    )
    expect(
      screen.queryByText('No Batch Extractions yet.'),
    ).not.toBeInTheDocument()
  })

  it('keeps member execution behind the batch request and renders its terminal response', async () => {
    const completedBatch = {
      ...batch,
      members: [
        {
          ...batch.members[0],
          latestExtraction: {
            ...batch.members[0].latestExtraction,
            outcome: 'SUCCEEDED' as const,
            complete: true,
            reviewable: false,
            failureMessage: null,
          },
        },
      ],
    }
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
            batchExtraction: completedBatch,
            disposition: 'created',
            memberFailures: [],
          })
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(
      screen.getByRole('button', { name: 'Run 1 Source Document' }),
    )
    await screen.findByText('1 with no reviewable result')
    fireEvent.click(screen.getByRole('button', { name: /Places/ }))

    expect(
      screen.getByRole('button', { name: /Failed.pdf/ }),
    ).toHaveTextContent('No reviewable result')
    expect(
      fetch.mock.calls.some(
        ([url, init]) => url === '/api/extractions' && init?.method === 'POST',
      ),
    ).toBe(false)
  })

  it('resumes a matching running batch without forcing a duplicate', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
            memberFailures: [],
          })
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(
      screen.getByRole('button', { name: 'Run 1 Source Document' }),
    )

    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(
          ([url, init]) =>
            url === '/api/batch-extractions' && init?.method === 'POST',
        ),
      ).toHaveLength(1),
    )
    expect(confirm).not.toHaveBeenCalled()
    const body = JSON.parse(
      String(
        fetch.mock.calls.find(
          ([url, init]) =>
            url === '/api/batch-extractions' && init?.method === 'POST',
        )?.[1]?.body,
      ),
    )
    expect(body).not.toHaveProperty('force')
  })

  it('leaves failed-member retry to the server-owned batch request', async () => {
    const retried = {
      ...batch,
      members: [
        {
          ...batch.members[0],
          latestExtraction: {
            ...batch.members[0].latestExtraction,
            extractionId: '51000000-0000-4000-8006-000000000003',
            outcome: 'SUCCEEDED' as const,
            complete: true,
            reviewable: false,
            failureMessage: null,
          },
        },
        batch.members[1],
      ],
    }
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
            batchExtraction: retried,
            disposition: 'complete',
            memberFailures: [],
          })
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(
      screen.getByRole('button', { name: 'Run 1 Source Document' }),
    )

    await screen.findByText('1 with no reviewable result · 1 cancelled')
    expect(
      fetch.mock.calls.some(
        ([url, init]) => url === '/api/extractions' && init?.method === 'POST',
      ),
    ).toBe(false)
  })

  it('names a member that never reached a terminal write instead of calling it not run', async () => {
    const openedBatch = {
      ...batch,
      members: [
        { ...batch.members[0], latestExtraction: null },
        batch.members[1],
      ],
    }
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
            batchExtraction: openedBatch,
            disposition: 'running',
            memberFailures: [
              {
                sourceDocumentId: failedDocumentId,
                message: 'Extraction storage is unavailable.',
              },
            ],
          })
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(
      screen.getByRole('button', { name: 'Run 1 Source Document' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 Source Document did not run: Failed.pdf. Open the Batch Extraction to see why.',
    )

    fireEvent.click(await screen.findByText('Places · Schema Revision 1'))
    const members = await screen.findByRole('list', {
      name: 'Batch Extraction members',
    })
    expect(members).toHaveTextContent('Did not run')
    expect(members).toHaveTextContent('Extraction storage is unavailable.')
    expect(members).not.toHaveTextContent('Not run')
  })

  it('identifies the Source Document and safe reason when field suggestion fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [] })
        if (url.startsWith('/api/extraction-schemas?'))
          return response({ extractionSchemas: [] })
        if (url === '/api/batch-schema-suggestions' && init?.method === 'POST')
          return Response.json(
            {
              error: {
                code: 'source_suggestion_failed',
                message:
                  'Fields could not be suggested for every selected Source Document. Try again.',
                details: {
                  failures: [
                    {
                      sourceDocumentId: failedDocumentId,
                      code: 'invalid_model_output',
                    },
                  ],
                },
              },
            },
            { status: 502 },
          )
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(
      screen.getByRole('button', { name: 'Suggest common fields' }),
    )

    expect(
      await screen.findByText(
        'Failed.pdf: The model returned an invalid Schema Suggestion.',
      ),
    ).toBeVisible()
  })

  it('keeps one confirmed suggested revision across a failed batch-open retry', async () => {
    let batchOpenAttempts = 0
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [] })
        if (url.startsWith('/api/extraction-schemas?'))
          return response({ extractionSchemas: [] })
        if (
          url === '/api/batch-schema-suggestions' &&
          init?.method === 'POST'
        ) {
          const body = JSON.parse(String(init.body))
          if (body.action === 'merge')
            return response({
              status: 'ready',
              selectionKey: 'a'.repeat(64),
              recordDescription: 'One record.',
              schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
              coverage: [{ nodeId: 'place', present: 1, total: 1 }],
            })
          return response({
            revision: {
              schemaRevisionId,
              extractionSchemaId: batch.extractionSchemaId,
              revisionNumber: 1,
              origin: 'suggestion',
              createdAt: '2026-08-15T10:00:00.000Z',
              recordDescription: 'One record.',
              schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
            },
          })
        }
        if (url === '/api/batch-extractions' && init?.method === 'POST') {
          batchOpenAttempts++
          return batchOpenAttempts === 1
            ? Response.json(
                {
                  error: {
                    code: 'persistence_unavailable',
                    message: 'Try again.',
                  },
                },
                { status: 503 },
              )
            : response({
                batchExtraction: { ...batch, members: [] },
                disposition: 'created',
                memberFailures: [],
              })
        }
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(
      screen.getByRole('button', { name: 'Suggest common fields' }),
    )
    await screen.findByDisplayValue('place')
    expect(screen.getByLabelText('Merged schema preview')).toHaveTextContent(
      '"type": "string"',
    )

    const run = screen.getByRole('button', { name: 'Run 1 Source Document' })
    fireEvent.click(run)
    await screen.findByText(/Try again/)
    fireEvent.click(run)

    await waitFor(() => expect(batchOpenAttempts).toBe(2))
    expect(
      fetch.mock.calls.filter(
        ([url, init]) =>
          url === '/api/batch-schema-suggestions' &&
          init?.method === 'POST' &&
          JSON.parse(String(init.body)).action === 'confirm',
      ),
    ).toHaveLength(1)
  })

  it('does not detach from a server-owned open while it is running', async () => {
    const pendingOpen = Promise.withResolvers<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [] })
        if (url.startsWith('/api/extraction-schemas?'))
          return response({ extractionSchemas: [] })
        if (
          url === '/api/batch-schema-suggestions' &&
          init?.method === 'POST'
        ) {
          const body = JSON.parse(String(init.body))
          if (body.action === 'merge')
            return response({
              status: 'ready',
              selectionKey: 'a'.repeat(64),
              recordDescription: 'One record.',
              schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
              coverage: [{ nodeId: 'place', present: 1, total: 1 }],
            })
          return response({
            revision: {
              schemaRevisionId,
              extractionSchemaId: batch.extractionSchemaId,
              revisionNumber: 1,
              origin: 'suggestion',
              createdAt: '2026-08-15T10:00:00.000Z',
              recordDescription: 'One record.',
              schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
            },
          })
        }
        if (url === '/api/batch-extractions' && init?.method === 'POST')
          return pendingOpen.promise
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(
      screen.getByRole('button', { name: 'Suggest common fields' }),
    )
    await screen.findByDisplayValue('place')
    fireEvent.click(
      screen.getByRole('button', { name: 'Run 1 Source Document' }),
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Back to history' }),
      ).toBeDisabled(),
    )
    expect(screen.getByLabelText('Extraction Schema')).toBeDisabled()
    expect(screen.getByLabelText('Extraction Strategy')).toBeDisabled()
    pendingOpen.resolve(
      response({
        batchExtraction: { ...batch, members: [] },
        disposition: 'created',
        memberFailures: [],
      }),
    )
    await screen.findByText('0 Source Documents · Article')
  })
})
