// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportBatchExtractionResults } from 'extraction-result-export'
import BatchExtractionsPanel from './BatchExtractionsPanel'
import type { NavigableRoute } from '../projectNavigation'

vi.mock('extraction-result-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('extraction-result-export')>()),
  exportBatchExtractionResults: vi.fn(async () => {}),
}))

const projectContextId = '51000000-0000-4000-8000-000000000001'
const schemaRevisionId = '51000000-0000-4000-8004-000000000001'
const batchExtractionId = '51000000-0000-4000-8007-000000000001'
const failedDocumentId = '51000000-0000-4000-8001-000000000001'
const cancelledDocumentId = '51000000-0000-4000-8001-000000000002'
const extractionId = '51000000-0000-4000-8006-000000000001'
const batchSchemaSuggestionId = '51000000-0000-4000-8008-000000000001'

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

const suggestedDefinition = {
  recordDescription: 'One record.',
  schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
}

function readySuggestion(overrides: Record<string, unknown> = {}) {
  return {
    batchSchemaSuggestionId,
    projectContextId,
    selectionKey: 'a'.repeat(64),
    executionStatus: 'COMPLETED',
    phase: 'READY',
    sourceKind: 'DOCUMENTS',
    purpose: null,
    columnFieldMapping: null,
    projectSpreadsheetVersionId: null,
    proposal: suggestedDefinition,
    coverage: [{ nodeId: 'place', present: 1, total: 1 }],
    draft: suggestedDefinition,
    draftVersion: 0,
    failure: null,
    confirmedSchemaRevisionId: null,
    batchExtractionId: null,
    startedAt: '2026-08-15T10:00:00.000Z',
    finishedAt: '2026-08-15T10:00:01.000Z',
    createdAt: '2026-08-15T10:00:00.000Z',
    sources: batch.members.map((member) => ({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
      executionStatus: 'COMPLETED',
      definition: suggestedDefinition,
      failure: null,
      startedAt: '2026-08-15T10:00:00.000Z',
      finishedAt: '2026-08-15T10:00:01.000Z',
    })),
    ...overrides,
  }
}

function response(body: unknown) {
  return Response.json(body)
}

/**
 * The panel is routed: the open Batch Extraction is a prop, and opening one is
 * a navigation. This stands in for the router so a click reaches the panel the
 * same way a real route change does.
 */
function RoutedPanel({
  batchExtractionId = null,
  onNavigate,
  sourceDocuments = documents,
}: {
  batchExtractionId?: string | null
  onNavigate: (route: NavigableRoute) => void
  sourceDocuments?: typeof documents
}) {
  const [open, setOpen] = useState<string | null>(batchExtractionId)
  const [view, setView] = useState<'grid' | null>(null)
  return (
    <BatchExtractionsPanel
      projectContextId={projectContextId}
      sourceDocuments={sourceDocuments}
      openBatchExtractionId={open}
      openBatchExtractionView={view}
      onNavigate={(route) => {
        if (route.kind === 'project' && route.tab === 'extractions') {
          setOpen(route.batchExtractionId ?? null)
          setView(route.view ?? null)
        }
        onNavigate(route)
      }}
    />
  )
}

function renderPanel(
  onNavigate = vi.fn(),
  batchExtractionId?: string | null,
  sourceDocuments: typeof documents = documents,
) {
  render(
    <RoutedPanel
      batchExtractionId={batchExtractionId}
      onNavigate={onNavigate}
      sourceDocuments={sourceDocuments}
    />,
  )
  return onNavigate
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('BatchExtractionsPanel', () => {
  it('does not abort a slow poll to start the next interval refresh', async () => {
    vi.useFakeTimers()
    const runningBatch = { ...batch, executionStatus: 'RUNNING' as const }
    const slowRead = Promise.withResolvers<Response>()
    let batchReads = 0
    let abortedReads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?')) {
          batchReads += 1
          if (batchReads === 1)
            return Promise.resolve(
              response({ batchExtractions: [runningBatch] }),
            )
          init?.signal?.addEventListener('abort', () => {
            abortedReads += 1
          })
          return slowRead.promise
        }
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return Promise.resolve(response({ batchSchemaSuggestions: [] }))
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(batchReads).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(batchReads).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(batchReads).toBe(2)
    expect(abortedReads).toBe(0)
    slowRead.resolve(response({ batchExtractions: [runningBatch] }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  })

  it('renders markup-like batch schema and member names as inert text', async () => {
    const schemaName = '<img src=x onerror="batch-secret">'
    const sourceName = '<script>member-secret</script>.pdf'
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({
          batchExtractions: [{ ...batch, extractionSchemaName: schemaName }],
        })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
        return response({
          revision: {
            schemaRevisionId,
            extractionSchemaId: batch.extractionSchemaId,
            revisionNumber: 1,
            origin: 'researcher-edit',
            createdAt: '2026-08-14T10:00:00.000Z',
            recordDescription: 'One record.',
            schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
          },
        })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel(vi.fn(), null, [
      { ...documents[0], name: sourceName },
      documents[1],
    ])

    fireEvent.click(await screen.findByText(`${schemaName} · Schema Revision 1`))
    expect(await screen.findByText(sourceName, { exact: true })).toBeVisible()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })

  it('bounds a Batch Extraction list outage and retries the same screen', async () => {
    let listReads = 0
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?')) {
        listReads += 1
        return listReads === 1
          ? Response.json(
              {
                error: {
                  code: 'persistence_unavailable',
                  message: 'Batch Extraction storage is unavailable.',
                },
              },
              { status: 503 },
            )
          : response({ batchExtractions: [batch] })
      }
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load Batch Extractions. Batch Extraction storage is unavailable.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Places · Schema Revision 1')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(listReads).toBe(2)
  })

  it('allows exactly 50 selected sources and gates 51 in existing and suggested modes', async () => {
    const manyDocuments = Array.from({ length: 51 }, (_, index) => ({
      sourceDocumentId: `51000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
      name: `Source ${String(index + 1).padStart(2, '0')}.pdf`,
      pageCount: 1,
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [] })
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: [] })
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
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel(vi.fn(), null, manyDocuments)

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    const checkboxes = await screen.findAllByRole('checkbox')
    expect(checkboxes).toHaveLength(51)
    expect(screen.getByText(/takes at most 50/)).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Run 51 Source Documents' }),
    ).toBeDisabled()

    fireEvent.click(checkboxes[0]!)
    expect(screen.queryByText(/takes at most 50/)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Run 50 Source Documents' }),
    ).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    expect(
      screen.getByRole('button', { name: 'Suggest common fields' }),
    ).toBeEnabled()
    fireEvent.click(checkboxes[0]!)
    expect(
      screen.getByRole('button', { name: 'Suggest common fields' }),
    ).toBeDisabled()
  })

  it('selects every source document by default and toggles the full selection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [] })
        if (url.startsWith('/api/extraction-schemas?'))
          return response({ extractionSchemas: [] })
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )

    const checkboxes = await screen.findAllByRole('checkbox')
    expect(checkboxes).toHaveLength(2)
    checkboxes.forEach((checkbox) => expect(checkbox).toBeChecked())
    expect(
      screen.getByRole('button', { name: 'Run 2 Source Documents' }),
    ).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Unselect all' }))

    checkboxes.forEach((checkbox) => expect(checkbox).not.toBeChecked())
    expect(screen.getByText('0 selected')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Select all' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))

    checkboxes.forEach((checkbox) => expect(checkbox).toBeChecked())
    expect(screen.getByText('2 selected')).toBeVisible()
  })

  it('edits and saves a saved schema with the shared schema workbench', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/schema-revisions' && init?.method === 'POST') {
          const definition = JSON.parse(String(init.body))
          return response({
            revision: {
              schemaRevisionId:
                '51000000-0000-4000-8004-000000000002',
              extractionSchemaId: batch.extractionSchemaId,
              revisionNumber: 2,
              origin: 'researcher-edit',
              createdAt: '2026-08-14T10:01:00.000Z',
              recordDescription: definition.recordDescription,
              schemaNodes: definition.schemaNodes,
            },
          })
        }
        if (url.startsWith('/api/schema-revisions?'))
          return response({ revisions: [] })
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [] })
        if (url === '/api/batch-extractions' && init?.method === 'POST')
          return response({
            batchExtraction: { ...batch, members: [] },
            disposition: 'created',
          })
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
        if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
          return response({
            revision: {
              schemaRevisionId,
              extractionSchemaId: batch.extractionSchemaId,
              revisionNumber: 1,
              origin: 'researcher-edit',
              createdAt: '2026-08-14T10:00:00.000Z',
              recordDescription: 'One place record.',
              schemaNodes: [
                { id: 'place', name: 'place', type: 'string' },
              ],
            },
          })
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )

    const schema = await screen.findByLabelText('Extraction Schema fields')
    expect(await within(schema).findByText('One place record.')).toBeVisible()
    expect(within(schema).getByText('place')).toBeVisible()
    expect(within(schema).getByRole('button', { name: 'Fields' })).toBeVisible()
    expect(within(schema).getByRole('button', { name: 'JSON' })).toBeVisible()
    expect(
      within(schema).getByPlaceholderText('Describe a change to the schema…'),
    ).toBeVisible()

    fireEvent.click(within(schema).getByTitle('Edit place'))
    fireEvent.change(within(schema).getByPlaceholderText('field_name'), {
      target: { value: 'location' },
    })
    fireEvent.click(within(schema).getByRole('button', { name: 'Save' }))
    expect(addEventListener).toHaveBeenCalledWith(
      'beforeunload',
      expect.any(Function),
    )
    addEventListener.mockRestore()

    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            url === '/api/schema-revisions' && init?.method === 'POST',
        ),
      ).toBe(true),
    )
    const save = fetch.mock.calls.find(
      ([url, init]) =>
        url === '/api/schema-revisions' && init?.method === 'POST',
    )
    expect(JSON.parse(String(save?.[1]?.body)).schemaNodes[0].name).toBe(
      'location',
    )

    fireEvent.click(
      screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!,
    )
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
    const open = fetch.mock.calls.find(
      ([url, init]) =>
        url === '/api/batch-extractions' && init?.method === 'POST',
    )
    expect(JSON.parse(String(open?.[1]?.body)).schemaRevisionId).toBe(
      '51000000-0000-4000-8004-000000000002',
    )
  })

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

  it('opens a Batch Extraction with the selected Catalog strategy', async () => {
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
            batchExtraction: { ...batch, strategy: 'CATALOG', members: [] },
            disposition: 'created',
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
    const strategySelect = screen.getByLabelText('Batch extraction strategy')
    expect(strategySelect).toHaveValue('ARTICLE')
    fireEvent.change(strategySelect, { target: { value: 'CATALOG' } })
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Run 1 Source Document' }))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/batch-extractions',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const body = JSON.parse(
      String(
        fetch.mock.calls.find(
          ([url, init]) =>
            url === '/api/batch-extractions' && init?.method === 'POST',
        )?.[1]?.body,
      ),
    )
    expect(body).toEqual(
      expect.objectContaining({ strategy: 'CATALOG', schemaRevisionId }),
    )
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
            disposition: 'replayed',
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
            disposition: 'created',
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

  it('keeps a Batch member with no result from opening an older Extraction', async () => {
    const openedBatch = {
      ...batch,
      executionStatus: 'COMPLETED',
      executionFailureMessage: null,
      startedAt: '2026-08-14T10:42:00.000Z',
      finishedAt: '2026-08-14T10:43:00.000Z',
      members: [
        {
          ...batch.members[0],
          executionStatus: 'FAILED',
          executionFailureMessage: 'Extraction storage is unavailable.',
          startedAt: '2026-08-14T10:42:00.000Z',
          finishedAt: '2026-08-14T10:43:00.000Z',
          latestExtraction: null,
        },
        {
          ...batch.members[1],
          executionStatus: 'COMPLETED',
          executionFailureMessage: null,
          startedAt: '2026-08-14T10:42:00.000Z',
          finishedAt: '2026-08-14T10:43:00.000Z',
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
            batchExtraction: openedBatch,
            disposition: 'created',
          })
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    const onNavigate = renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(
      screen.getByRole('button', { name: 'Run 1 Source Document' }),
    )

    fireEvent.click(await screen.findByText('1 without a result · 1 cancelled'))
    const members = await screen.findByRole('list', {
      name: 'Batch Extraction members',
    })
    const failedMember = within(members).getByRole('button', {
      name: /Failed\.pdf/,
    })
    expect(failedMember).toHaveTextContent('No result in this batch')
    expect(failedMember).toBeDisabled()
    fireEvent.click(failedMember)
    // Opening this batch routed to it, so what must not happen is opening a
    // Source Document for a member that produced no Extraction Result.
    expect(onNavigate).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'document' }),
    )
    expect(members).toHaveTextContent('Extraction storage is unavailable.')
  })

  it('opens the routed Batch Extraction without a click', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [batch] })
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: [] })
        if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
          return response({ revision: null })
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel(vi.fn(), batchExtractionId)

    const members = await screen.findByRole('list', {
      name: 'Batch Extraction members',
    })
    expect(within(members).getByText('Cancelled.pdf')).toBeInTheDocument()
    // Leaving the batch returns to the history it was routed away from.
    fireEvent.click(screen.getByRole('button', { name: /Back to history/ }))
    expect(
      await screen.findByText('Places · Schema Revision 1'),
    ).toBeInTheDocument()
  })

  it('says an unchanged selection reopened the Batch Extraction it already has', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
          return response({ batchExtraction: batch, disposition: 'replayed' })
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: [] })
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(
      screen.getByRole('button', { name: 'Run 2 Source Documents' }),
    )

    expect(await screen.findByRole('status')).toHaveTextContent(
      /already been run/,
    )
  })

  it('reopens an older replay without changing durable newest-first history order', async () => {
    const newer = {
      ...batch,
      batchExtractionId: '51000000-0000-4000-8007-000000000009',
      createdAt: '2026-08-14T11:42:00.000Z',
    }
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [newer, batch] })
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: [] })
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
          return response({ batchExtraction: batch, disposition: 'replayed' })
        if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
          return response({ revision: null })
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    const onNavigate = renderPanel()

    fireEvent.click(
      await screen.findByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(
      screen.getByRole('button', { name: 'Run 2 Source Documents' }),
    )

    expect(await screen.findByRole('status')).toHaveTextContent(
      /already been run/,
    )
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ batchExtractionId }),
    )
    expect(
      await screen.findByRole('list', { name: 'Batch Extraction members' }),
    ).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /Back to history/ }))
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll('time')).map((time) =>
          time.getAttribute('datetime'),
        ),
      ).toEqual([newer.createdAt, batch.createdAt]),
    )
    expect(
      fetch.mock.calls.filter(
        ([url, init]) =>
          url === '/api/batch-extractions' && init?.method === 'POST',
      ),
    ).toHaveLength(1)
  })

  it('runs the open Batch Extraction selection again as its own Batch Extraction', async () => {
    const reran = {
      ...batch,
      batchExtractionId: '51000000-0000-4000-8007-000000000002',
      createdAt: '2026-08-14T11:00:00.000Z',
      executionStatus: 'QUEUED' as const,
      members: batch.members.map((member) => ({
        ...member,
        executionStatus: 'QUEUED' as const,
        latestExtraction: null,
      })),
    }
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [batch] })
        if (url === '/api/batch-extractions' && init?.method === 'POST')
          return response({ batchExtraction: reran, disposition: 'created' })
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: [] })
        if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
          return response({ revision: null })
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    const onNavigate = renderPanel(vi.fn(), batchExtractionId)

    fireEvent.click(await screen.findByRole('button', { name: 'Run again' }))

    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith({
        kind: 'project',
        projectContextId,
        tab: 'extractions',
        batchExtractionId: reran.batchExtractionId,
      }),
    )
    // The stored Batch Extraction is immutable research state, so running the
    // same selection again must ask for a fresh one rather than reopen it.
    expect(
      JSON.parse(
        String(
          fetch.mock.calls.find(
            ([url, init]) =>
              url === '/api/batch-extractions' && init?.method === 'POST',
          )?.[1]?.body,
        ),
      ),
    ).toEqual({
      projectContextId,
      schemaRevisionId,
      strategy: 'ARTICLE',
      sourceDocumentIds: [failedDocumentId, cancelledDocumentId],
      force: true,
    })
  })

  it('shows a stale cross-account Batch Extraction as missing only after the scoped list is read', async () => {
    const listed = Promise.withResolvers<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?')) return listed.promise
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: [] })
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel(vi.fn(), '51000000-0000-4000-8007-000000000009')

    // Unread is not missing: the batch is unknown until the list answers.
    expect(
      await screen.findByText('Loading Batch Extractions…'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('That Batch Extraction is no longer listed.'),
    ).not.toBeInTheDocument()

    listed.resolve(response({ batchExtractions: [batch] }))

    expect(
      await screen.findByText('That Batch Extraction is no longer listed.'),
    ).toBeInTheDocument()
  })

  it('identifies each Source Document with terminal status and a sanitized failure category', async () => {
    const failedSuggestion = readySuggestion({
      executionStatus: 'FAILED',
      phase: 'SOURCES',
      proposal: null,
      draft: null,
      failure: {
        code: 'invalid_model_output',
        message:
          'Fields could not be suggested for every selected Source Document. Try again.',
      },
      sources: [
        {
          sourceDocumentId: failedDocumentId,
          sourceRepresentationRevisionId:
            '51000000-0000-4000-8002-000000000001',
          executionStatus: 'FAILED',
          definition: null,
          failure: {
            code: 'invalid_model_output',
            message: 'provider secret must never reach the researcher',
          },
          startedAt: '2026-08-15T10:00:00.000Z',
          finishedAt: '2026-08-15T10:00:01.000Z',
        },
      ],
    })
    let suggestions: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [] })
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: suggestions })
        if (url.startsWith('/api/extraction-schemas?'))
          return response({ extractionSchemas: [] })
        if (url === '/api/batch-schema-suggestions' && init?.method === 'POST') {
          suggestions = [failedSuggestion]
          return response({ batchSchemaSuggestion: failedSuggestion })
        }
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

    const progress = await screen.findByLabelText('Source suggestion progress')
    expect(within(progress).getByText('0 of 1 complete · 1 failed')).toBeVisible()
    expect(within(progress).getByText('Failed.pdf')).toBeVisible()
    expect(within(progress).getByText('Failed — Invalid model output')).toBeVisible()
    expect(screen.queryByText(/provider secret/)).not.toBeInTheDocument()
  })

  it('keeps a created suggestion when an older list response resolves last', async () => {
    const listedBody = Promise.withResolvers<unknown>()
    const listedStarted = Promise.withResolvers<void>()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return Promise.resolve(response({ batchExtractions: [] }))
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => {
              listedStarted.resolve()
              return listedBody.promise
            },
          } as Response)
        if (url.startsWith('/api/extraction-schemas?'))
          return new Promise<Response>((resolve) => {
            setTimeout(
              () => resolve(response({ extractionSchemas: [] })),
              25,
            )
          })
        if (
          url === '/api/batch-schema-suggestions' &&
          init?.method === 'POST'
        )
          return Promise.resolve(
            response({ batchSchemaSuggestion: readySuggestion() }),
          )
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel()
    await act(async () => listedStarted.promise)

    const openSuggestion = async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'New Batch Extraction' }),
      )
      await waitFor(() =>
        expect(screen.getAllByRole('checkbox')).toHaveLength(2),
      )
      await waitFor(() =>
        expect(screen.getByLabelText('Extraction Schema')).toBeEnabled(),
      )
      fireEvent.change(screen.getByLabelText('Extraction Schema'), {
        target: { value: '__suggest_common_fields__' },
      })
      await screen.findByLabelText('Suggested common fields')
    }

    await openSuggestion()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Suggest common fields' }),
    )
    expect(await screen.findByText('place')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Back to history/ }))

    await openSuggestion()
    expect(
      within(screen.getByLabelText('Suggested common fields')).getByText(
        'place',
      ),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Back to history/ }))

    await act(async () => {
      listedBody.resolve({ batchSchemaSuggestions: [] })
      await listedBody.promise
    })
    await openSuggestion()

    expect(
      within(screen.getByLabelText('Suggested common fields')).getByText(
        'place',
      ),
    ).toBeVisible()
  })

  it('shows suggested fields in the schema slot and regenerates them', async () => {
    let suggestions: unknown[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({ batchExtractions: [] })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: suggestions })
      if (url.startsWith('/api/extraction-schemas?'))
        return response({ extractionSchemas: [] })
      if (url === '/api/batch-schema-suggestions' && init?.method === 'POST') {
        suggestions = [readySuggestion()]
        return response({ batchSchemaSuggestion: suggestions[0] })
      }
      if (
        url.startsWith(
          `/api/batch-schema-suggestions/${batchSchemaSuggestionId}/retry?`,
        ) &&
        init?.method === 'POST'
      ) {
        const retriedDefinition = {
          recordDescription: 'One retried record.',
          schemaNodes: [{ id: 'year', name: 'year', type: 'number' }],
        }
        suggestions = [
          readySuggestion({
            proposal: retriedDefinition,
            draft: retriedDefinition,
            draftVersion: 1,
            finishedAt: '2026-08-15T10:00:02.000Z',
          }),
        ]
        return response({ batchSchemaSuggestion: suggestions[0] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Suggest common fields' }))

    const suggested = await screen.findByLabelText('Suggested common fields')
    const sourcesHeading = screen.getByRole('heading', {
      name: 'Source Documents',
    })
    expect(
      suggested.compareDocumentPosition(sourcesHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    fireEvent.click(within(suggested).getByRole('button', { name: 'Regenerate' }))
    fireEvent.click(within(suggested).getByRole('button', { name: /Regenerate schema/ }))
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(
          ([url, init]) =>
            String(url).startsWith(
              `/api/batch-schema-suggestions/${batchSchemaSuggestionId}/retry?`,
            ) && init?.method === 'POST',
        ),
      ).toHaveLength(1),
    )
    expect(await within(suggested).findByText('year')).toBeVisible()
    expect(within(suggested).queryByText('place')).not.toBeInTheDocument()
    expect(
      fetch.mock.calls.filter(
        ([url, init]) =>
          url === '/api/batch-schema-suggestions' && init?.method === 'POST',
      ),
    ).toHaveLength(1)
  })

  it('serializes overlapping suggestion edits without re-adopting save echoes', async () => {
    let suggestions: unknown[] = [readySuggestion()]
    const firstSave = Promise.withResolvers<Response>()
    const patchBodies: Array<{
      expectedDraftVersion: number
      recordDescription: string
      schemaNodes: Array<{ id: string; name: string; type: string }>
    }> = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({ batchExtractions: [] })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: suggestions })
      if (url.startsWith('/api/extraction-schemas?'))
        return response({ extractionSchemas: [] })
      if (
        url.includes(
          `/api/batch-schema-suggestions/${batchSchemaSuggestionId}/draft?`,
        ) &&
        init?.method === 'PATCH'
      ) {
        const body = JSON.parse(String(init.body)) as (typeof patchBodies)[number]
        patchBodies.push(body)
        if (patchBodies.length === 1) return firstSave.promise
        const saved = readySuggestion({
          draft: {
            recordDescription: body.recordDescription,
            schemaNodes: body.schemaNodes,
          },
          draftVersion: 2,
        })
        suggestions = [saved]
        return response({ batchSchemaSuggestion: saved })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    const suggested = await screen.findByLabelText('Suggested common fields')

    fireEvent.click(within(suggested).getByTitle('Edit place'))
    fireEvent.change(within(suggested).getByPlaceholderText('field_name'), {
      target: { value: 'location' },
    })
    fireEvent.click(within(suggested).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patchBodies).toHaveLength(1), { timeout: 2_000 })

    fireEvent.click(within(suggested).getByTitle('Edit location'))
    fireEvent.change(within(suggested).getByPlaceholderText('field_name'), {
      target: { value: 'city' },
    })
    fireEvent.click(within(suggested).getByRole('button', { name: 'Save' }))

    const firstSaved = readySuggestion({
      draft: {
        recordDescription: patchBodies[0]!.recordDescription,
        schemaNodes: patchBodies[0]!.schemaNodes,
      },
      draftVersion: 1,
    })
    suggestions = [firstSaved]
    firstSave.resolve(response({ batchSchemaSuggestion: firstSaved }))

    await waitFor(() => expect(patchBodies).toHaveLength(2), { timeout: 2_000 })
    expect(patchBodies.map(({ expectedDraftVersion }) => expectedDraftVersion)).toEqual([
      0,
      1,
    ])
    expect(await within(suggested).findByText('city')).toBeVisible()
    expect(within(suggested).queryByText('location')).not.toBeInTheDocument()
  })

  it('gates Run after a failed suggested-draft save until a new edit saves', async () => {
    let suggestions: unknown[] = [readySuggestion()]
    const calls: string[] = []
    const patchBodies: Array<{
      recordDescription: string
      schemaNodes: Array<{ id: string; name: string; type: string }>
    }> = []
    const confirmed = readySuggestion({
      draftVersion: 1,
      confirmedSchemaRevisionId: schemaRevisionId,
      batchExtractionId,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [] })
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: suggestions })
        if (url.startsWith('/api/extraction-schemas?'))
          return response({ extractionSchemas: [] })
        if (
          url.includes(
            `/api/batch-schema-suggestions/${batchSchemaSuggestionId}/draft?`,
          ) &&
          init?.method === 'PATCH'
        ) {
          calls.push('patch')
          const body = JSON.parse(String(init.body)) as (typeof patchBodies)[number]
          patchBodies.push(body)
          if (patchBodies.length === 1)
            return new Response(
              JSON.stringify({
                error: {
                  code: 'persistence_unavailable',
                  message: 'Try again.',
                },
              }),
              {
                status: 503,
                headers: { 'content-type': 'application/json' },
              },
            )
          const saved = readySuggestion({
            draft: {
              recordDescription: body.recordDescription,
              schemaNodes: body.schemaNodes,
            },
            draftVersion: 1,
          })
          suggestions = [saved]
          return response({ batchSchemaSuggestion: saved })
        }
        if (
          url.startsWith(
            `/api/batch-schema-suggestions/${batchSchemaSuggestionId}/run?`,
          ) &&
          init?.method === 'POST'
        ) {
          calls.push('run')
          suggestions = [confirmed]
          return response({ batchSchemaSuggestion: confirmed })
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    const suggested = await screen.findByLabelText('Suggested common fields')
    fireEvent.click(within(suggested).getByTitle('Edit place'))
    fireEvent.change(within(suggested).getByPlaceholderText('field_name'), {
      target: { value: 'location' },
    })
    fireEvent.click(within(suggested).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patchBodies).toHaveLength(1), { timeout: 2_000 })
    expect(await screen.findByText('Try again.')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Run 2 Source Documents' }),
    ).toBeDisabled()

    fireEvent.click(within(suggested).getByTitle('Edit location'))
    fireEvent.change(within(suggested).getByPlaceholderText('field_name'), {
      target: { value: 'location_name' },
    })
    fireEvent.click(within(suggested).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patchBodies).toHaveLength(2), { timeout: 2_000 })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Run 2 Source Documents' }),
      ).toBeEnabled(),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Run 2 Source Documents' }),
    )
    await waitFor(() => expect(calls).toEqual(['patch', 'patch', 'run']))
    expect(patchBodies[1]?.schemaNodes[0]?.name).toBe('location_name')
  })

  it('gates Run while a field editor contains an unacknowledged invalid value', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [] })
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: [readySuggestion()] })
        if (url.startsWith('/api/extraction-schemas?'))
          return response({ extractionSchemas: [] })
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    const suggested = await screen.findByLabelText('Suggested common fields')
    const run = screen.getByRole('button', {
      name: 'Run 2 Source Documents',
    })
    await waitFor(() => expect(run).toBeEnabled())

    fireEvent.click(within(suggested).getByTitle('Edit place'))
    fireEvent.change(within(suggested).getByPlaceholderText('field_name'), {
      target: { value: '' },
    })
    expect(run).toBeDisabled()

    fireEvent.click(
      within(suggested).getByRole('button', { name: 'Cancel field edit' }),
    )
    await waitFor(() => expect(run).toBeEnabled())
  })

  it('shows and regenerates a previously confirmed suggestion', async () => {
    const confirmed = readySuggestion({
      confirmedSchemaRevisionId: schemaRevisionId,
      batchExtractionId,
    })
    const retried = readySuggestion({
      executionStatus: 'QUEUED',
      phase: 'MERGING',
      proposal: null,
      coverage: null,
      draft: null,
    })
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [] })
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: [confirmed] })
        if (url.startsWith('/api/extraction-schemas?'))
          return response({ extractionSchemas: [] })
        if (
          url.startsWith(
            `/api/batch-schema-suggestions/${batchSchemaSuggestionId}/retry?`,
          ) &&
          init?.method === 'POST'
        )
          return response({ batchSchemaSuggestion: retried })
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })

    const suggested = await screen.findByLabelText('Suggested common fields')
    expect(within(suggested).getByText('place')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Run 2 Source Documents' }),
    ).toBeDisabled()
    fireEvent.click(within(suggested).getByRole('button', { name: 'Regenerate' }))
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/retry?') && init?.method === 'POST',
        ),
      ).toBe(true),
    )
  })

  it('confirms a saved suggestion atomically through one durable run action', async () => {
    const confirmed = readySuggestion({
      draftVersion: 1,
      confirmedSchemaRevisionId: schemaRevisionId,
      batchExtractionId,
    })
    let suggestions: unknown[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({ batchExtractions: [{ ...batch, members: [] }] })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: suggestions })
      if (url.startsWith('/api/extraction-schemas?'))
        return response({ extractionSchemas: [] })
      if (url === '/api/batch-schema-suggestions' && init?.method === 'POST') {
        suggestions = [readySuggestion()]
        return response({ batchSchemaSuggestion: suggestions[0] })
      }
      if (url.startsWith(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/draft?`))
        return response({ batchSchemaSuggestion: confirmed })
      if (url.startsWith(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/run?`)) {
        suggestions = [confirmed]
        return response({ batchSchemaSuggestion: confirmed })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Suggest common fields' }))
    expect(await screen.findByText('place')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Run 1 Source Document' }))
    await screen.findByText('0 Source Documents · Article')
    expect(
      fetch.mock.calls.filter(
        ([url, init]) =>
          String(url).startsWith(
            `/api/batch-schema-suggestions/${batchSchemaSuggestionId}/run?`,
          ) && init?.method === 'POST',
      ),
    ).toHaveLength(1)
    expect(
      fetch.mock.calls.some(
        ([url]) => String(url) === '/api/batch-extractions',
      ),
    ).toBe(false)
  })

  it('does not attach browser cancellation to a durable suggestion run', async () => {
    const confirmed = readySuggestion({
      draftVersion: 1,
      confirmedSchemaRevisionId: schemaRevisionId,
      batchExtractionId,
    })
    let suggestions: unknown[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({ batchExtractions: [{ ...batch, members: [] }] })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: suggestions })
      if (url.startsWith('/api/extraction-schemas?'))
        return response({ extractionSchemas: [] })
      if (url === '/api/batch-schema-suggestions' && init?.method === 'POST') {
        suggestions = [readySuggestion()]
        return response({ batchSchemaSuggestion: suggestions[0] })
      }
      if (url.startsWith(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/draft?`))
        return response({ batchSchemaSuggestion: confirmed })
      if (url.startsWith(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/run?`)) {
        suggestions = [confirmed]
        return response({ batchSchemaSuggestion: confirmed })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Suggest common fields' }))
    await screen.findByText('place')
    fireEvent.click(screen.getByRole('button', { name: 'Run 1 Source Document' }))

    await screen.findByText('0 Source Documents · Article')
    const run = fetch.mock.calls.find(
      ([url, init]) =>
        String(url).startsWith(
          `/api/batch-schema-suggestions/${batchSchemaSuggestionId}/run?`,
        ) && init?.method === 'POST',
    )
    expect(run?.[1]?.signal).toBeUndefined()
  })

  it('exports the whole Batch Extraction through its pinned Schema Revision', async () => {
    const succeededMember = {
      ...batch.members[1],
      executionStatus: 'COMPLETED',
      executionFailureMessage: null,
      startedAt: '2026-08-14T10:42:00.000Z',
      finishedAt: '2026-08-14T10:43:00.000Z',
      latestExtraction: {
        ...batch.members[1].latestExtraction,
        outcome: 'SUCCEEDED' as const,
        complete: true,
        reviewable: true,
      },
    }
    const listedBatch = {
      ...batch,
      executionStatus: 'COMPLETED',
      members: [batch.members[0], succeededMember],
    }
    const pinnedRevision = {
      schemaRevisionId,
      extractionSchemaId: batch.extractionSchemaId,
      revisionNumber: 1,
      origin: 'researcher-edit',
      createdAt: '2026-08-14T10:00:00.000Z',
      recordDescription: 'One place record.',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    }
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({ batchExtractions: [listedBatch] })
      if (
        url.startsWith(
          `/api/batch-extractions/${batchExtractionId}/results?`,
        )
      )
        return response({
          batchExtractionId,
          executionStatus: 'COMPLETED',
          totalMembers: 2,
          successfulResults: 1,
          pending: 0,
          failed: 1,
          cancelled: 0,
          results: [
            {
              sourceDocumentId: cancelledDocumentId,
              extractionId: succeededMember.latestExtraction.extractionId,
              result: { records: [{ place: 'Rome' }] },
            },
          ],
        })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
        return response({ revision: pinnedRevision })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(await screen.findByText('Places · Schema Revision 1'))
    await screen.findByRole('list', { name: 'Batch Extraction members' })
    const exportButton = screen.getByRole('button', { name: 'Export' })
    await waitFor(() => expect(exportButton).toBeEnabled())

    fireEvent.click(exportButton)
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }))

    await waitFor(() =>
      expect(exportBatchExtractionResults).toHaveBeenCalledWith(
        [
          {
            sourceDocumentId: cancelledDocumentId,
            sourceDocumentName: 'Cancelled.pdf',
            result: { records: [{ place: 'Rome' }] },
          },
        ],
        {
          format: 'xlsx',
          filename: 'Places revision 1 batch 51000000 partial',
          batchExtractionId,
          schemaNodes: pinnedRevision.schemaNodes,
          choices: { rowsRepresent: '$', otherRepeatedFields: 'preserve' },
        },
      ),
    )
    expect(
      screen.getByText(
        'Includes 1 of 2 Source Documents; 0 pending, 1 failed, 0 cancelled.',
      ),
    ).toBeVisible()
  })

  it('offers no export while no member has produced a result', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({ batchExtractions: [batch] })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
        return response({
          revision: {
            schemaRevisionId,
            extractionSchemaId: batch.extractionSchemaId,
            revisionNumber: 1,
            origin: 'researcher-edit',
            createdAt: '2026-08-14T10:00:00.000Z',
            recordDescription: 'One place record.',
            schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
          },
        })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(await screen.findByText('Places · Schema Revision 1'))
    await screen.findByRole('list', { name: 'Batch Extraction members' })

    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    expect(
      screen.getByText(
        'No successful Extraction Results are available to export.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review grid' })).toBeDisabled()
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).includes('/results?'),
      ),
    ).toBe(false)
  })

  it('opens the review grid, edits a field there, saves it, and returns to results', async () => {
    const succeededMember = {
      ...batch.members[1],
      executionStatus: 'COMPLETED' as const,
      executionFailureMessage: null,
      startedAt: '2026-08-14T10:42:00.000Z',
      finishedAt: '2026-08-14T10:43:00.000Z',
      latestExtraction: {
        ...batch.members[1].latestExtraction,
        outcome: 'SUCCEEDED' as const,
        complete: true,
        reviewable: true,
      },
    }
    const listedBatch = {
      ...batch,
      executionStatus: 'COMPLETED' as const,
      members: [batch.members[0], succeededMember],
    }
    const pinnedRevision = {
      schemaRevisionId,
      extractionSchemaId: batch.extractionSchemaId,
      revisionNumber: 1,
      origin: 'researcher-edit',
      createdAt: '2026-08-14T10:00:00.000Z',
      recordDescription: 'One place record.',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    }
    const reviewedExtractionId = succeededMember.latestExtraction.extractionId
    const attempt = {
      extractionId: reviewedExtractionId,
      sourceDocumentId: cancelledDocumentId,
      sourceRepresentationRevisionId: succeededMember.sourceRepresentationRevisionId,
      schemaRevisionId,
      strategy: 'ARTICLE' as const,
      executionStatus: 'COMPLETED' as const,
      outcome: 'SUCCEEDED' as const,
      complete: true,
      modelAttribution: { provider: 'ollama', modelId: 'fixture' },
      diagnostics: {
        phase: 'grounding',
        durationMs: 1,
        modelCalls: 0,
        finishReason: null,
        inputTokens: null,
        outputTokens: null,
        grounding: null,
        catalog: null,
        retry: null,
      },
      failure: null,
      resultPayload: { records: [{ place: 'Rome' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-1' }],
      reviewable: true,
      retryOfId: null,
      batchExtractionId,
      createdAt: '2026-08-14T10:43:00.000Z',
      reviewedAt: null,
      reviewDecisions: [],
    }
    const pendingReviewDecisions = [
      {
        resultPath: ['records', 0, 'place'],
        evidenceAnchorId: 'anchor-1',
        reviewedOccurrenceIds: ['occurrence-1'],
        action: 'APPROVED' as const,
        reviewedValue: null,
      },
    ]
    let reviewed = false
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({
          batchExtractions: [
            reviewed
              ? {
                  ...listedBatch,
                  members: [
                    listedBatch.members[0],
                    {
                      ...succeededMember,
                      latestExtraction: {
                        ...succeededMember.latestExtraction,
                        reviewedAt: '2026-08-14T10:45:00.000Z',
                      },
                    },
                  ],
                }
              : listedBatch,
          ],
        })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
        return response({ revision: pinnedRevision })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: [] })
      if (url === `/api/extractions/${reviewedExtractionId}` && (init?.method ?? 'GET') === 'GET')
        return response({ extraction: attempt, pendingReviewDecisions })
      if (url === `/api/extractions/${reviewedExtractionId}/review/draft` && init?.method === 'POST') {
        const draft = JSON.parse(String(init.body))
        return response({ ...draft, version: draft.version + 1 })
      }
      if (url === `/api/extractions/${reviewedExtractionId}/review` && init?.method === 'POST') {
        reviewed = true
        return response({
          ...attempt,
          reviewedAt: '2026-08-14T10:45:00.000Z',
          reviewDecisions: [
            { ...pendingReviewDecisions[0], action: 'EDITED', reviewedValue: 'Milan', createdAt: '2026-08-14T10:45:00.000Z' },
          ],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(await screen.findByText('Places · Schema Revision 1'))
    await screen.findByRole('list', { name: 'Batch Extraction members' })
    const gridButton = screen.getByRole('button', { name: 'Review grid' })
    await waitFor(() => expect(gridButton).toBeEnabled())
    fireEvent.click(gridButton)

    expect(await screen.findByText('Rome')).toBeVisible()

    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' })
    const zoomReset = screen.getByRole('button', { name: 'Fit columns to screen width' })
    expect(zoomReset).toHaveTextContent('100%')
    fireEvent.click(zoomIn)
    fireEvent.click(zoomIn)
    expect(zoomReset).toHaveTextContent('120%')
    fireEvent.click(zoomOut)
    expect(zoomReset).toHaveTextContent('110%')
    fireEvent.click(zoomReset)
    expect(zoomReset).toHaveTextContent('Fit')

    fireEvent.click(screen.getByText('Rome'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const input = screen.getByDisplayValue('Rome')
    fireEvent.change(input, { target: { value: 'Milan' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument()

    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([callUrl, callInit]) =>
            String(callUrl) === `/api/extractions/${reviewedExtractionId}/review` &&
            callInit?.method === 'POST' &&
            JSON.parse(String(callInit.body)).reviewDecisions[0].reviewedValue === 'Milan',
        ),
      ).toBe(true),
    )
    await screen.findByText('Reviewed')

    fireEvent.click(screen.getByRole('button', { name: /Back to results/ }))
    await screen.findByRole('list', { name: 'Batch Extraction members' })
  })

  it('explains a pinned Schema Revision failure and retries it explicitly', async () => {
    const succeededMember = {
      ...batch.members[1],
      executionStatus: 'COMPLETED',
      latestExtraction: {
        ...batch.members[1].latestExtraction,
        outcome: 'SUCCEEDED' as const,
        complete: true,
        reviewable: true,
      },
    }
    const pinnedRevision = {
      schemaRevisionId,
      extractionSchemaId: batch.extractionSchemaId,
      revisionNumber: 1,
      origin: 'researcher-edit',
      createdAt: '2026-08-14T10:00:00.000Z',
      recordDescription: 'One place record.',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    }
    let schemaReads = 0
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({
          batchExtractions: [
            {
              ...batch,
              executionStatus: 'COMPLETED',
              members: [succeededMember],
            },
          ],
        })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`)) {
        schemaReads += 1
        if (schemaReads === 1) throw new Error('Schema storage is offline.')
        return response({ revision: pinnedRevision })
      }
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(await screen.findByText('Places · Schema Revision 1'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Schema storage is offline.',
    )
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()

    fireEvent.click(
      screen.getByRole('button', { name: 'Retry Schema Revision' }),
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled(),
    )
    expect(schemaReads).toBe(2)
    expect(
      screen.queryByRole('button', { name: 'Retry Schema Revision' }),
    ).not.toBeInTheDocument()
  })

  it('preserves export choices while a Batch result read fails and retries', async () => {
    vi.mocked(exportBatchExtractionResults).mockClear()
    const succeededMember = {
      ...batch.members[0],
      latestExtraction: {
        ...batch.members[0].latestExtraction,
        outcome: 'SUCCEEDED' as const,
        complete: true,
        reviewable: true,
        failureMessage: null,
      },
    }
    let resultReads = 0
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?'))
        return response({
          batchExtractions: [
            { ...batch, executionStatus: 'COMPLETED', members: [succeededMember] },
          ],
        })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
        return response({
          revision: {
            schemaRevisionId,
            extractionSchemaId: batch.extractionSchemaId,
            revisionNumber: 1,
            origin: 'researcher-edit',
            createdAt: '2026-08-14T10:00:00.000Z',
            recordDescription: 'One place record.',
            schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
          },
        })
      if (url.includes(`/batch-extractions/${batchExtractionId}/results?`)) {
        resultReads += 1
        return resultReads === 1
          ? Response.json(
              {
                error: {
                  code: 'persistence_unavailable',
                  message: 'Batch Extraction results are unavailable.',
                },
              },
              { status: 503 },
            )
          : response({
              batchExtractionId,
              executionStatus: 'COMPLETED',
              totalMembers: 1,
              successfulResults: 1,
              pending: 0,
              failed: 0,
              cancelled: 0,
              results: [
                {
                  sourceDocumentId: failedDocumentId,
                  extractionId,
                  result: { records: [{ place: 'Rome' }] },
                },
              ],
            })
      }
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(await screen.findByText('Places · Schema Revision 1'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.change(screen.getByLabelText('Other repeated fields'), {
      target: { value: 'omit' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Batch Extraction results are unavailable.',
    )
    expect(exportBatchExtractionResults).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(screen.getByLabelText('Other repeated fields')).toHaveValue('omit')
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }))

    await waitFor(() => expect(exportBatchExtractionResults).toHaveBeenCalledOnce())
    expect(resultReads).toBe(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
