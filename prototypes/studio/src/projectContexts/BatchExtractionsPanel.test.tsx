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
import {
  resetModelKeyResendForTesting,
  subscribeToModelKeyResend,
} from '../auth/authenticatedFetch'
import { setModelKeyAccount } from '../modelKeys/modelKeyHandoff'
import { saveModelKey } from '../modelKeys/modelKeyStore'
import type { SavedMethodState } from '../savedMethod'
import type { ModelConfig } from '../../shared/modelConfig.contract'

// The account keeps every service default unless a test saves otherwise: each start then submits
// `{ models: null, settings: { <its slot>: null } }`.
const saved = vi.hoisted(() => {
  const config = (members: Partial<ModelConfig> = {}): ModelConfig => ({
    connections: [],
    routes: { schemaSuggestion: null, interaction: null },
    extractionModels: {},
    ingestionModels: {},
    extractionSettings: {},
    ...members,
  })
  return { config, state: { status: 'ready', config: config() } as SavedMethodState, refresh: vi.fn() }
})
vi.mock('../savedMethod', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../savedMethod')>()),
  useSavedMethod: () => saved,
}))
const SERVICE_DEFAULTS = { models: null, settings: { article: null } }

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
  executionStatus: 'COMPLETED' as const,
  createdAt: '2026-08-14T10:42:00.000Z',
  members: [
    {
      sourceDocumentId: failedDocumentId,
      sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
      executionStatus: 'FAILED' as const,
      executionFailureMessage: 'The provider rejected this document.',
      latestExtraction: null,
    },
    {
      sourceDocumentId: cancelledDocumentId,
      sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000002',
      executionStatus: 'FAILED' as const,
      executionFailureMessage: 'Extraction cancelled.',
      latestExtraction: null,
    },
  ],
}

/** `member` once its Extraction was published: COMPLETED, with its reviewable result by default. */
function publishedMember(
  member: (typeof batch.members)[number],
  extraction: { extractionId?: string; complete?: boolean; reviewable?: boolean } = {},
) {
  return {
    ...member,
    executionStatus: 'COMPLETED' as const,
    executionFailureMessage: null,
    latestExtraction: {
      extractionId:
        member.sourceDocumentId === failedDocumentId
          ? extractionId
          : '51000000-0000-4000-8006-000000000002',
      outcome: 'SUCCEEDED' as const,
      complete: true,
      reviewable: true,
      createdAt: '2026-08-14T10:44:00.000Z',
      reviewedAt: null,
      ...extraction,
    },
  }
}

/** The chosen schema's current revision: its saved record scope is the batch's strategy (an Article by default). */
const chosenRevision = (recordScope: 'document' | 'records' | null = 'document') => ({
  schemaRevisionId,
  extractionSchemaId: batch.extractionSchemaId,
  revisionNumber: 1,
  origin: 'researcher-edit',
  createdAt: '2026-08-14T10:00:00.000Z',
  recordDescription: 'One place record.',
  recordScope,
  schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
})

/** Answers the chosen schema's reads (its current revision and its history), or null for any other request. */
function chosenSchemaRead(url: string, revision = chosenRevision()) {
  if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`)) return response({ revision })
  if (url.startsWith('/api/schema-revisions?')) return response({ revisions: [] })
  return null
}

const appendedRevisionId = '51000000-0000-4000-8004-000000000002'

/** Answers an append to the chosen schema: revision 2, with the record scope the write names, else revision 1's. */
function appendChosenRevision(init: RequestInit | undefined, writes: Array<Record<string, unknown>> = []) {
  const request = JSON.parse(String(init?.body)) as {
    recordDescription: string
    schemaNodes: unknown[]
    recordScope?: 'document' | 'records'
  }
  writes.push(request)
  return response({
    revision: {
      ...chosenRevision(request.recordScope ?? 'document'),
      schemaRevisionId: appendedRevisionId,
      revisionNumber: 2,
      createdAt: '2026-08-14T10:01:00.000Z',
      recordDescription: request.recordDescription,
      schemaNodes: request.schemaNodes,
    },
  })
}

/** A batch Run action once it can start: the chosen schema's revision, whose scope is the strategy, has been read. */
async function enabledRun(name: string) {
  const run = await screen.findByRole('button', { name })
  await waitFor(() => expect(run).toBeEnabled())
  return run
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
    attempt: 1,
    executionStatus: 'COMPLETED',
    phase: 'READY',
    proposal: suggestedDefinition,
    sourceCoverage: null,
    draft: suggestedDefinition,
    draftVersion: 0,
    failure: null,
    confirmedSchemaRevisionId: null,
    batchExtractionId: null,
    createdAt: '2026-08-15T10:00:00.000Z',
    sources: batch.members.map((member) => ({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
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
  saved.state = { status: 'ready', config: saved.config() }
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setModelKeyAccount(null)
  resetModelKeyResendForTesting()
  localStorage.clear()
})

/** Opens a new Batch Extraction over every Source Document and chooses suggested fields; the panel then adopts the
 *  listed suggestion whose pins match the selection. */
async function openSuggestedFields() {
  fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
  await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
  fireEvent.change(screen.getByLabelText('Extraction Schema'), {
    target: { value: '__suggest_common_fields__' },
  })
  return screen.findByLabelText('Suggested common fields')
}

/** A fetch stub answering the panel's reads with `suggestions()`, and `other` for anything else it is given. */
function suggestionFetch(
  suggestions: () => unknown[],
  other: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/batch-extractions?'))
      return response({ batchExtractions: [] })
    if (url.startsWith('/api/batch-schema-suggestions?'))
      return response({ batchSchemaSuggestions: suggestions() })
    if (url.startsWith('/api/extraction-schemas?'))
      return response({ extractionSchemas: [] })
    const answer = await other(url, init)
    if (answer) return answer
    const chosen = chosenSchemaRead(url)
    if (chosen) return chosen
    throw new Error(`Unexpected request: ${url}`)
  })
}

describe('BatchExtractionsPanel', () => {
  it.each(['reprocessed', 'unavailable'] as const)('refreshes displayed sample coverage before admission (%s)', async (changed) => {
    let refresh = false
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?')) return response({ batchExtractions: [] })
      if (url.startsWith('/api/batch-schema-suggestions?')) return response({ batchSchemaSuggestions: [] })
      if (url.startsWith('/api/extraction-schemas?')) return response({ extractionSchemas: [{
        extractionSchemaId: batch.extractionSchemaId, name: 'Places', createdAt: batch.createdAt,
        currentRevision: { schemaRevisionId, revisionNumber: 1, origin: 'researcher-edit', createdAt: batch.createdAt },
      }] })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`)) return response({ revision: {
        schemaRevisionId, extractionSchemaId: batch.extractionSchemaId, revisionNumber: 1,
        origin: 'researcher-edit', createdAt: batch.createdAt, ...suggestedDefinition, recordScope: 'document',
      } })
      if (url.startsWith('/api/schema-revisions?')) return response({ revisions: [] })
      if (url === '/api/sample_facts') {
        if (refresh && changed === 'unavailable') throw new Error('Coverage read failed')
        return response({ sources: documents.map((document, index) => ({ sourceDocumentId: document.sourceDocumentId,
          sourceRepresentationRevisionId: refresh ? '51000000-0000-4000-8002-000000000003' : batch.members[index].sourceRepresentationRevisionId,
          admitted: !refresh && index === 0 ? 1 : 0, savedDrafts: 0, finalized: !refresh && index === 0 ? 1 : 0,
          fullResults: 0, pages: !refresh && index === 0 ? [1, 2] : [], reviewedPages: !refresh && index === 0 ? [1, 2] : [],
        })) })
      }
      if (url === '/api/batch-extractions' && init?.method === 'POST') throw new Error('Admission failed')
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await screen.findByText(/2 unique physical pages/)
    await screen.findByLabelText('Extraction Schema fields')
    refresh = true
    fireEvent.click(screen.getByRole('button', { name: 'Run 2 Source Documents' }))
    await screen.findByText('Admission failed')
    expect(screen.queryByText(/2 unique physical pages/)).toBeNull()
    if (changed === 'unavailable') expect(screen.getByText('Sample coverage unavailable.')).toBeVisible()
    else expect(screen.getByText(/0 unique physical pages/)).toBeVisible()
    const calls = fetch.mock.calls.map(([url]) => String(url))
    expect(calls.lastIndexOf('/api/sample_facts')).toBeLessThan(calls.indexOf('/api/batch-extractions'))
  })

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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
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
            recordScope: 'document',
            schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
          },
        })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: [] })
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
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
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
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
    await enabledRun('Run 50 Source Documents')

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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
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
              recordScope: definition.recordScope ?? 'document',
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
              recordScope: 'document',
              schemaNodes: [
                { id: 'place', name: 'place', type: 'string' },
              ],
            },
          })
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
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
    fireEvent.click(await enabledRun('Run 1 Source Document'))
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

  it('shows the saved advanced settings; a method_changed refusal opens them with a refresh and no run failure', async () => {
    const message = 'Your saved advanced settings changed after this summary was shown. Nothing was started; review the updated summary and start again.'
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/schema-revisions?')) return response({ revisions: [] })
      if (url.startsWith('/api/batch-extractions?')) return response({ batchExtractions: [] })
      if (url === '/api/batch-extractions' && init?.method === 'POST')
        return new Response(JSON.stringify({ error: { code: 'method_changed', message } }), {
          status: 409, headers: { 'content-type': 'application/json' },
        })
      if (url.startsWith('/api/extraction-schemas?'))
        return response({
          extractionSchemas: [{
            extractionSchemaId: batch.extractionSchemaId, name: 'Places', createdAt: '2026-08-14T10:00:00.000Z',
            currentRevision: { schemaRevisionId, revisionNumber: 1, origin: 'researcher-edit', createdAt: '2026-08-14T10:00:00.000Z' },
          }],
        })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
        return response({
          revision: {
            schemaRevisionId, extractionSchemaId: batch.extractionSchemaId, revisionNumber: 1, origin: 'researcher-edit',
            createdAt: '2026-08-14T10:00:00.000Z', recordDescription: 'One place record.',
            recordScope: 'document',
            schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
          },
        })
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    saved.refresh.mockClear()
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await screen.findByLabelText('Extraction Schema fields')
    expect(screen.getByText('Saved advanced settings: Service defaults')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(await enabledRun('Run 1 Source Document'))

    const refusal = await screen.findByText(message, { exact: false })
    expect(refusal).toHaveAttribute('role', 'alert')
    expect(screen.queryByText(/could not be opened/)).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh summary' }))
    expect(saved.refresh).toHaveBeenCalledOnce()
    expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument()
  })

  it('shows a record scope refusal with the server\'s message where a changed method is shown', async () => {
    const message = 'The schema is saved as an Article; refresh to run it.'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?')) return response({ batchExtractions: [] })
      if (url === '/api/batch-extractions' && init?.method === 'POST')
        return new Response(JSON.stringify({ error: { code: 'record_scope_mismatch', message } }), {
          status: 409, headers: { 'content-type': 'application/json' },
        })
      if (url.startsWith('/api/extraction-schemas?'))
        return response({
          extractionSchemas: [{
            extractionSchemaId: batch.extractionSchemaId, name: 'Places', createdAt: '2026-08-14T10:00:00.000Z',
            currentRevision: { schemaRevisionId, revisionNumber: 1, origin: 'researcher-edit', createdAt: '2026-08-14T10:00:00.000Z' },
          }],
        })
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
      throw new Error(`Unexpected request: ${url}`)
    }))
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await screen.findByLabelText('Extraction Schema fields')
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(await enabledRun('Run 1 Source Document'))

    expect(await screen.findByText(message, { exact: false })).toHaveAttribute('role', 'alert')
    expect(screen.queryByText(/could not be opened/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh summary' })).toBeInTheDocument()
  })

  it('waits for an Article or Catalog choice on a schema that saved none, and saves it before the run', async () => {
    const help = 'Article: one object for the whole document. Catalog: a collection of records.'
    const writes: Array<Record<string, unknown>> = []
    const posted: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/schema-revisions' && init?.method === 'POST') return appendChosenRevision(init, writes)
      if (url.startsWith('/api/batch-extractions?')) return response({ batchExtractions: [] })
      if (url === '/api/batch-extractions' && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)))
        return response({ batchExtraction: { ...batch, members: [] }, disposition: 'created' })
      }
      if (url.startsWith('/api/extraction-schemas?'))
        return response({
          extractionSchemas: [{
            extractionSchemaId: batch.extractionSchemaId, name: 'Places', createdAt: '2026-08-14T10:00:00.000Z',
            currentRevision: { schemaRevisionId, revisionNumber: 1, origin: 'researcher-edit', createdAt: '2026-08-14T10:00:00.000Z' },
          }],
        })
      const chosen = chosenSchemaRead(url, chosenRevision(null))
      if (chosen) return chosen
      throw new Error(`Unexpected request: ${url}`)
    }))
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await screen.findByLabelText('Extraction Schema fields')
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)

    const strategy = screen.getByLabelText('Batch extraction strategy')
    await waitFor(() => expect(strategy).toBeEnabled())
    expect(strategy).toHaveValue('')
    expect(strategy).toHaveAccessibleDescription(help)
    expect(screen.queryByText(/Saved advanced settings/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run 1 Source Document' })).toBeDisabled()

    fireEvent.change(strategy, { target: { value: 'ARTICLE' } })
    await waitFor(() => expect(writes).toEqual([expect.objectContaining({ expectedRevisionNumber: 1, recordScope: 'document' })]))
    expect(strategy).toHaveValue('ARTICLE')
    expect(screen.queryByText(help)).not.toBeInTheDocument()
    fireEvent.click(await enabledRun('Run 1 Source Document'))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ strategy: 'ARTICLE', schemaRevisionId: appendedRevisionId })
  })

  it('refuses Run while the chosen schema\'s scope save failed, and Retry saves it before the run', async () => {
    const writes: Array<Record<string, unknown>> = []
    const posted: Array<Record<string, unknown>> = []
    let failNextWrite = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/schema-revisions' && init?.method === 'POST') {
        if (failNextWrite) {
          failNextWrite = false
          return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'The database is unavailable.' } }), {
            status: 503, headers: { 'content-type': 'application/json' },
          })
        }
        return appendChosenRevision(init, writes)
      }
      if (url.startsWith('/api/batch-extractions?')) return response({ batchExtractions: [] })
      if (url === '/api/batch-extractions' && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)))
        return response({ batchExtraction: { ...batch, members: [] }, disposition: 'created' })
      }
      if (url.startsWith('/api/extraction-schemas?'))
        return response({
          extractionSchemas: [{
            extractionSchemaId: batch.extractionSchemaId, name: 'Places', createdAt: '2026-08-14T10:00:00.000Z',
            currentRevision: { schemaRevisionId, revisionNumber: 1, origin: 'researcher-edit', createdAt: '2026-08-14T10:00:00.000Z' },
          }],
        })
      const chosen = chosenSchemaRead(url, chosenRevision(null))
      if (chosen) return chosen
      throw new Error(`Unexpected request: ${url}`)
    }))
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await screen.findByLabelText('Extraction Schema fields')
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    const strategy = screen.getByLabelText('Batch extraction strategy')
    await waitFor(() => expect(strategy).toBeEnabled())

    fireEvent.change(strategy, { target: { value: 'CATALOG' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('The database is unavailable.')
    expect(strategy).toHaveValue('CATALOG')
    expect(screen.getByRole('button', { name: 'Run 1 Source Document' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
    await waitFor(() => expect(writes).toEqual([expect.objectContaining({ expectedRevisionNumber: 1, recordScope: 'records' })]))
    fireEvent.click(await enabledRun('Run 1 Source Document'))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ strategy: 'CATALOG', schemaRevisionId: appendedRevisionId })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('with the unified Catalog enabled, a Catalog batch submits the same unified method as a single run', async () => {
    const posted: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/schema-revisions?')) return response({ revisions: [] })
      if (url === '/api/schema-revisions' && init?.method === 'POST') return appendChosenRevision(init)
      if (url.startsWith('/api/batch-extractions?')) return response({ batchExtractions: [] })
      if (url === '/api/batch-extractions' && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ error: { code: 'method_changed', message: 'Stale.' } }), {
          status: 409, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.startsWith('/api/extraction-schemas?'))
        return response({
          extractionSchemas: [{
            extractionSchemaId: batch.extractionSchemaId, name: 'Places', createdAt: '2026-08-14T10:00:00.000Z',
            currentRevision: { schemaRevisionId, revisionNumber: 1, origin: 'researcher-edit', createdAt: '2026-08-14T10:00:00.000Z' },
          }],
        })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
        return response({
          revision: {
            schemaRevisionId, extractionSchemaId: batch.extractionSchemaId, revisionNumber: 1, origin: 'researcher-edit',
            createdAt: '2026-08-14T10:00:00.000Z', recordDescription: 'One place record.',
            recordScope: 'document',
            schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
          },
        })
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
      throw new Error(`Unexpected request: ${url}`)
    }))
    saved.state = { status: 'ready', config: saved.config(), unifiedCatalog: true }
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await screen.findByLabelText('Extraction Schema fields')
    await waitFor(() => expect(screen.getByLabelText('Batch extraction strategy')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Batch extraction strategy'), { target: { value: 'CATALOG' } })
    expect(await screen.findByText('Saved advanced settings: Unified Catalog, defaults version 1')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(await enabledRun('Run 1 Source Document'))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ strategy: 'CATALOG', method: { models: null, settings: { unified: { defaults: 1 } } } })
  })

  it('reads failed and cancelled members as Failed with their own message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ batchExtractions: [batch] })),
    )
    const onNavigate = renderPanel()

    await screen.findByText('2 failed')
    fireEvent.click(screen.getByRole('button', { name: /Places/ }))

    const members = screen.getByRole('list', { name: 'Batch Extraction members' })
    for (const [name, message] of [
      [/Failed\.pdf/, 'The provider rejected this document.'],
      [/Cancelled\.pdf/, 'Extraction cancelled.'],
    ] as const) {
      const member = within(members).getByRole('button', { name })
      expect(member).toHaveTextContent('Failed')
      expect(member).toHaveTextContent(message)
      expect(member).toBeDisabled()
    }
    expect(onNavigate).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'document' }),
    )
  })

  it('opens a published member result in the document workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({
        batchExtractions: [{ ...batch, members: [publishedMember(batch.members[0]), batch.members[1]] }],
      })),
    )
    const onNavigate = renderPanel()

    await screen.findByText('1 need review · 1 failed')
    fireEvent.click(screen.getByRole('button', { name: /Places/ }))
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
      members: [publishedMember(batch.members[0], { complete: false, reviewable: false })],
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    const run = await enabledRun('Run 1 Source Document')
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

  it('saves Catalog as the chosen schema\'s record scope and opens the Batch Extraction with it', async () => {
    const writes: Array<Record<string, unknown>> = []
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/schema-revisions' && init?.method === 'POST')
          return appendChosenRevision(init, writes)
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    // Saved Article settings are the other strategy's: a Catalog batch submits only its generic limits.
    saved.state = {
      status: 'ready',
      config: saved.config({
        extractionModels: { fields: 'instruct' },
        extractionSettings: { catalog: { generic: { record_chars: 30_000 } } },
      }),
    }
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    // The select shows the chosen revision's saved scope; choosing Catalog appends a revision that names it.
    const strategySelect = screen.getByLabelText('Batch extraction strategy')
    await waitFor(() => expect(strategySelect).toHaveValue('ARTICLE'))
    await waitFor(() => expect(strategySelect).toBeEnabled())
    fireEvent.change(strategySelect, { target: { value: 'CATALOG' } })
    await waitFor(() => expect(writes).toEqual([expect.objectContaining({ expectedRevisionNumber: 1, recordScope: 'records' })]))
    expect(strategySelect).toHaveValue('CATALOG')
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(await enabledRun('Run 1 Source Document'))

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
      expect.objectContaining({
        strategy: 'CATALOG',
        schemaRevisionId: appendedRevisionId,
        method: { models: { fields: 'instruct' }, settings: { generic: { record_chars: 30_000 } } },
      }),
    )
  })

  it('starts nothing until the saved method is read: Run and Run again wait for it', async () => {
    const posted: string[] = []
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'POST') posted.push(url)
        if (url.startsWith('/api/batch-extractions?'))
          return response({ batchExtractions: [batch] })
        if (url.startsWith('/api/batch-schema-suggestions?'))
          return response({ batchSchemaSuggestions: [] })
        if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
          return response({ revision: chosenRevision() })
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    saved.state = { status: 'loading' }
    renderPanel(vi.fn(), batchExtractionId)

    expect(await screen.findByRole('button', { name: 'Run again' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Back to history/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    await waitFor(() => expect(screen.getByLabelText('Extraction Schema')).toHaveValue(schemaRevisionId))
    // The chosen schema's fields render above the sources once read; its saved scope is the strategy.
    await waitFor(() => expect(screen.getByLabelText('Batch extraction strategy')).toHaveValue('ARTICLE'))
    const failedDocument = () => screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!
    fireEvent.click(failedDocument())
    expect(screen.getByRole('button', { name: 'Run 1 Source Document' })).toBeDisabled()

    // Once it is read, a selection can start.
    saved.state = { status: 'ready', config: saved.config() }
    fireEvent.click(failedDocument())
    expect(screen.getByRole('button', { name: 'Run 2 Source Documents' })).toBeEnabled()
    expect(posted.filter((url) => url !== '/api/sample_facts')).toEqual([])
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(await enabledRun('Run 1 Source Document'))

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
      members: [publishedMember(batch.members[0], { reviewable: false })],
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(await enabledRun('Run 1 Source Document'))
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(await enabledRun('Run 1 Source Document'))

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
        publishedMember(batch.members[0], {
          extractionId: '51000000-0000-4000-8006-000000000003',
          reviewable: false,
        }),
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(await enabledRun('Run 1 Source Document'))

    await screen.findByText('1 with no reviewable result · 1 failed')
    expect(
      fetch.mock.calls.some(
        ([url, init]) => url === '/api/extractions' && init?.method === 'POST',
      ),
    ).toBe(false)
  })

  it('keeps a Batch member with no result from opening an older Extraction', async () => {
    const openedBatch = {
      ...batch,
      members: [
        {
          ...batch.members[0],
          executionFailureMessage: 'This work stopped before it finished. Start it again.',
        },
        publishedMember(batch.members[1]),
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    const onNavigate = renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(await enabledRun('Run 1 Source Document'))

    fireEvent.click(await screen.findByText('1 need review · 1 failed'))
    const members = await screen.findByRole('list', {
      name: 'Batch Extraction members',
    })
    const failedMember = within(members).getByRole('button', {
      name: /Failed\.pdf/,
    })
    expect(failedMember).toHaveTextContent('Failed')
    expect(failedMember).toBeDisabled()
    fireEvent.click(failedMember)
    // Opening this batch routed to it, so what must not happen is opening a
    // Source Document for a member that produced no Extraction Result.
    expect(onNavigate).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'document' }),
    )
    expect(members).toHaveTextContent('This work stopped before it finished. Start it again.')
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
          return response({ revision: chosenRevision() })
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(await enabledRun('Run 2 Source Documents'))

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
          return response({ revision: chosenRevision() })
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
        throw new Error(`Unexpected request: ${url}`)
      },
    )
    vi.stubGlobal('fetch', fetch)
    const onNavigate = renderPanel()

    fireEvent.click(
      await screen.findByRole('button', { name: 'New Batch Extraction' }),
    )
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.click(await enabledRun('Run 2 Source Documents'))

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

  it('Run again shows the saved settings it submits; a method_changed refusal is shown there with a refresh', async () => {
    const message = 'Your saved advanced settings changed after this summary was shown. Nothing was started; review the updated summary and start again.'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/batch-extractions?')) return response({ batchExtractions: [batch] })
      if (url === '/api/batch-extractions' && init?.method === 'POST')
        return new Response(JSON.stringify({ error: { code: 'method_changed', message } }), {
          status: 409, headers: { 'content-type': 'application/json' },
        })
      if (url.startsWith('/api/batch-schema-suggestions?')) return response({ batchSchemaSuggestions: [] })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`)) return response({ revision: chosenRevision() })
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
      throw new Error(`Unexpected request: ${url}`)
    }))
    saved.refresh.mockClear()
    renderPanel(vi.fn(), batchExtractionId)

    const rerun = await screen.findByRole('button', { name: 'Run again' })
    expect(screen.getByText('Saved advanced settings: Service defaults')).toBeInTheDocument()
    fireEvent.click(rerun)
    expect(await screen.findByText(message, { exact: false })).toHaveAttribute('role', 'alert')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh summary' }))
    expect(saved.refresh).toHaveBeenCalledOnce()
    expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument()
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
          return response({ revision: chosenRevision() })
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
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
      method: SERVICE_DEFAULTS,
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
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

  it('shows the retained proposal and no per-source progress', async () => {
    // Attempt 2 failed; attempt 1's proposal and draft stay, and the latest failure does not make the draft unrunnable.
    const failed = readySuggestion({
      attempt: 2,
      executionStatus: 'FAILED',
      failure: {
        code: 'source_suggestion_failed',
        message: 'Fields could not be suggested for every selected Source Document.',
      },
    })
    vi.stubGlobal('fetch', suggestionFetch(() => [failed]))
    renderPanel()

    const suggested = await openSuggestedFields()
    expect(within(suggested).getByText('place')).toBeVisible()
    expect(
      within(suggested).getByText('Fields could not be suggested for every selected Source Document.'),
    ).toBeVisible()
    expect(within(suggested).getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(screen.queryByLabelText('Source suggestion progress')).not.toBeInTheDocument()
    expect(screen.queryByText(/merging common fields|complete ·|Queued|Running/)).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run 2 Source Documents' })).toBeEnabled(),
    )
  })

  it('says which selected Source Document was suggested from excerpts, and what was not read', async () => {
    const excerpted = readySuggestion({
      sourceCoverage: [
        {
          sourceDocumentId: failedDocumentId,
          sourceCoverage: { complete: false, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }] },
          combined: true,
        },
        { sourceDocumentId: cancelledDocumentId, sourceCoverage: { complete: true }, combined: true },
      ],
    })
    vi.stubGlobal('fetch', suggestionFetch(() => [excerpted]))
    renderPanel()

    const suggested = await openSuggestedFields()
    expect(within(suggested).getByText('place')).toBeVisible()
    expect(
      within(suggested).getByText(
        'Failed.pdf: Suggested from excerpts: the middle of page 1 was not read (4,040 of 50,040 characters).',
      ),
    ).toBeVisible()
    expect(within(suggested).queryByText(/Cancelled\.pdf/)).not.toBeInTheDocument()
  })

  it('says which Source Document suggestion the common fields left out, and one not recorded says nothing', async () => {
    const uncombined = readySuggestion({
      sourceCoverage: [
        { sourceDocumentId: failedDocumentId, sourceCoverage: null, combined: true },
        { sourceDocumentId: cancelledDocumentId, sourceCoverage: { complete: true }, combined: false },
      ],
    })
    vi.stubGlobal('fetch', suggestionFetch(() => [uncombined]))
    renderPanel()

    const suggested = await openSuggestedFields()
    expect(within(suggested).getByText('place')).toBeVisible()
    expect(
      within(suggested).getByText(
        'Cancelled.pdf: Left out of the common fields: the selected suggestions together were too long to combine in one request.',
      ),
    ).toBeVisible()
    expect(within(suggested).queryByText(/Failed\.pdf/)).not.toBeInTheDocument()
  })

  it('declares excerpted sources beside a heterogeneous outcome too', async () => {
    const heterogeneous = readySuggestion({
      phase: 'HETEROGENEOUS',
      proposal: null,
      draft: null,
      sourceCoverage: [
        {
          sourceDocumentId: cancelledDocumentId,
          sourceCoverage: { complete: false, sourceCharacters: 60_000, omitted: [{ page: null, start: 23_000, end: 37_000 }] },
          combined: true,
        },
      ],
    })
    vi.stubGlobal('fetch', suggestionFetch(() => [heterogeneous]))
    renderPanel()

    const suggested = await openSuggestedFields()
    expect(await within(suggested).findByText(/No reliable common field set was found/)).toBeVisible()
    expect(
      within(suggested).getByText(
        'Cancelled.pdf: Suggested from excerpts: the middle of the source was not read (14,000 of 60,000 characters).',
      ),
    ).toBeVisible()
  })

  it('disables editing and Run while an attempt runs and keeps the draft', async () => {
    const suggestions: unknown[] = [readySuggestion({ attempt: 2, executionStatus: 'RUNNING' })]
    const fetch = suggestionFetch(() => suggestions)
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    const suggested = await openSuggestedFields()
    expect(within(suggested).getByText('place')).toBeVisible()
    expect(within(suggested).getByText('Suggesting common fields…')).toBeVisible()
    expect(within(suggested).queryByTitle('Edit place')).not.toBeInTheDocument()
    expect(within(suggested).queryByRole('button', { name: /Regenerate/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run 2 Source Documents' })).toBeDisabled()
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH' || init?.method === 'POST'),
    ).toEqual([])
  })

  it('a model_key_required failure resends this browser\'s keys once, and Try again posts the next expected attempt', async () => {
    const account = '10000000-0000-4000-8000-000000000001'
    saveModelKey(
      account,
      { id: '11111111-1111-4111-8111-111111111111', provider: 'openai-compatible', baseUrl: 'https://a.example/v1' },
      'sk-test-batch-suggestion',
    )
    setModelKeyAccount(account)
    const resends = vi.fn()
    subscribeToModelKeyResend(resends)
    const keyless = readySuggestion({
      executionStatus: 'FAILED',
      phase: null,
      proposal: null,
      sourceCoverage: null,
      draft: null,
      failure: {
        code: 'model_key_required',
        message: 'Studio does not hold the key for this Model Connection.',
      },
    })
    const requests: Array<{ request: string; body?: unknown }> = []
    let suggestions: unknown[] = [keyless]
    vi.stubGlobal(
      'fetch',
      suggestionFetch(
        () => suggestions,
        (url, init) => {
          if (url === '/api/model-keys' && init?.method === 'PUT') {
            requests.push({ request: 'PUT /api/model-keys' })
            return response({ accepted: [] })
          }
          if (url.startsWith(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/retry?`) && init?.method === 'POST') {
            requests.push({ request: 'POST retry', body: JSON.parse(String(init.body)) })
            suggestions = [readySuggestion({ ...keyless, attempt: 2, executionStatus: 'QUEUED', failure: null })]
            return response({ batchSchemaSuggestion: suggestions[0] })
          }
          return undefined
        },
      ),
    )
    renderPanel()

    const suggested = await openSuggestedFields()
    expect(within(suggested).getByText('Model key not available')).toBeVisible()
    await waitFor(() => expect(resends).toHaveBeenCalledOnce())

    fireEvent.click(within(suggested).getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(requests).toEqual([
        { request: 'PUT /api/model-keys' },
        { request: 'POST retry', body: { expectedAttempt: 1 } },
      ]),
    )
    expect(await screen.findByText('Suggesting common fields…')).toBeVisible()
    // Every reread of the failed attempt, and the retry's answer, left it at one resend.
    expect(resends).toHaveBeenCalledOnce()
  })

  it('an empty selection keeps the draft and disables Run and Try again', async () => {
    // Another tab deleted both members: the next save answers the suggestion without pins, its attempt interrupted.
    const orphaned = (draft: unknown) =>
      readySuggestion({
        executionStatus: 'FAILED',
        failure: { code: 'interrupted', message: 'This work stopped before it finished. Start it again.' },
        draft,
        draftVersion: 1,
        sources: [],
      })
    let suggestions: unknown[] = [readySuggestion()]
    vi.stubGlobal(
      'fetch',
      suggestionFetch(
        () => suggestions,
        (url, init) => {
          if (url.startsWith(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/draft?`) && init?.method === 'PATCH') {
            const body = JSON.parse(String(init.body)) as { recordDescription: string; schemaNodes: unknown[] }
            suggestions = [orphaned({ recordDescription: body.recordDescription, schemaNodes: body.schemaNodes })]
            return response({ batchSchemaSuggestion: suggestions[0] })
          }
          return undefined
        },
      ),
    )
    renderPanel()

    const suggested = await openSuggestedFields()
    fireEvent.click(within(suggested).getByTitle('Edit place'))
    fireEvent.change(within(suggested).getByPlaceholderText('field_name'), {
      target: { value: 'location' },
    })
    fireEvent.click(within(suggested).getByRole('button', { name: 'Save' }))

    expect(await within(suggested).findByText('This work stopped before it finished. Start it again.', {}, { timeout: 2_000 })).toBeVisible()
    expect(within(suggested).getByText('location')).toBeVisible()
    expect(within(suggested).getByRole('button', { name: 'Try again' })).toBeDisabled()
    expect(within(suggested).queryByRole('button', { name: /Regenerate/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run 2 Source Documents' })).toBeDisabled()
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
            headers: new Headers(),
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
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
        expect(JSON.parse(String(init.body))).toEqual({ expectedAttempt: 1 })
        suggestions = [
          readySuggestion({
            attempt: 2,
            proposal: retriedDefinition,
            draft: retriedDefinition,
            draftVersion: 1,
          }),
        ]
        return response({ batchSchemaSuggestion: suggestions[0] })
      }
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
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
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
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
    fireEvent.click(await enabledRun('Run 2 Source Documents'))
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
        const chosen = chosenSchemaRead(url)
        if (chosen) return chosen
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

  it('shows a previously confirmed suggestion read-only, with nothing to regenerate', async () => {
    // A confirmed suggestion is immutable: another run of its fields starts from its Extraction Schema.
    const confirmed = readySuggestion({
      confirmedSchemaRevisionId: schemaRevisionId,
      batchExtractionId,
    })
    const fetch = suggestionFetch(() => [confirmed])
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    const suggested = await openSuggestedFields()
    expect(within(suggested).getByText('place')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Run 2 Source Documents' }),
    ).toBeDisabled()
    expect(within(suggested).queryByRole('button', { name: /Regenerate|Try again/ })).not.toBeInTheDocument()
    expect(within(suggested).queryByTitle('Edit place')).not.toBeInTheDocument()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
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
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(screen.getByRole('button', { name: 'Suggest common fields' }))
    expect(await screen.findByText('place')).toBeVisible()

    fireEvent.click(await enabledRun('Run 1 Source Document'))
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
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'New Batch Extraction' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Extraction Schema'), {
      target: { value: '__suggest_common_fields__' },
    })
    fireEvent.click(screen.getByText('Failed.pdf').closest('label')!.querySelector('input')!)
    fireEvent.click(screen.getByRole('button', { name: 'Suggest common fields' }))
    await screen.findByText('place')
    fireEvent.click(await enabledRun('Run 1 Source Document'))

    await screen.findByText('0 Source Documents · Article')
    const run = fetch.mock.calls.find(
      ([url, init]) =>
        String(url).startsWith(
          `/api/batch-schema-suggestions/${batchSchemaSuggestionId}/run?`,
        ) && init?.method === 'POST',
    )
    expect(run?.[1]?.signal).toBeUndefined()
    // The suggestion runs on the saved method the start view read.
    expect(JSON.parse(String(run?.[1]?.body))).toEqual({ strategy: 'ARTICLE', method: SERVICE_DEFAULTS })
  })

  it.each([
    ['xlsx', false],
    ['xlsx', true],
    ['csv', true],
  ] as const)('exports the whole Batch Extraction through its pinned Schema Revision (%s, contested=%s)', async (format, contested) => {
    const succeededMember = publishedMember(batch.members[1])
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
      recordScope: 'document',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    }
    const result = { records: [{ place: contested ? null : 'Rome' }] }
    const candidates = ['Rome', 'Paris']
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
              result,
              ...(contested ? { contested: [{ resultPath: ['records', 0, 'place'], candidates }] } : {}),
            },
          ],
        })
      if (url.startsWith(`/api/schema-revisions/${schemaRevisionId}?`))
        return response({ revision: pinnedRevision })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: [] })
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderPanel()

    fireEvent.click(await screen.findByText('Places · Schema Revision 1'))
    await screen.findByRole('list', { name: 'Batch Extraction members' })
    const exportButton = screen.getByRole('button', { name: 'Export' })
    await waitFor(() => expect(exportButton).toBeEnabled())

    fireEvent.click(exportButton)
    fireEvent.click(screen.getByRole('button', { name: format === 'xlsx' ? 'Excel' : 'CSV' }))

    await waitFor(() =>
      expect(exportBatchExtractionResults).toHaveBeenCalledWith(
        [
          {
            sourceDocumentId: cancelledDocumentId,
            sourceDocumentName: 'Cancelled.pdf',
            result,
            ...(contested ? { contested: [{ record: 0, path: ['place'], candidates }] } : {}),
          },
        ],
        {
          format,
          filename: 'Places revision 1 batch 51000000 partial',
          batchExtractionId,
          schemaNodes: pinnedRevision.schemaNodes,
          choices: { rowsRepresent: '$', otherRepeatedFields: 'preserve' },
        },
      ),
    )
    expect(
      screen.getByText(
        'Includes 1 of 2 Source Documents; 0 pending, 1 failed, 0 cancelled.' + (contested
          ? format === 'xlsx' ? ' 1 contested field is left empty and listed on the Review notes sheet.'
            : ' CSV leaves 1 contested field empty; their candidates are only in the Excel Review notes sheet and in Studio.'
          : '') + ' Batch exports hold values only; open a Source Document for its Extraction and Evidence sheets.',
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
            recordScope: 'document',
            schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
          },
        })
      if (url.startsWith('/api/batch-schema-suggestions?'))
        return response({ batchSchemaSuggestions: [] })
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
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
    const succeededMember = publishedMember(batch.members[1])
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
      recordScope: 'document',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    }
    const reviewedExtractionId = succeededMember.latestExtraction.extractionId
    const attempt = {
      extractionId: reviewedExtractionId,
      sourceDocumentId: cancelledDocumentId,
      sourceRepresentationRevisionId: succeededMember.sourceRepresentationRevisionId,
      schemaRevisionId,
      strategy: 'ARTICLE' as const,
      catalogRecipe: null,
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
      },
      failure: null,
      resultPayload: { records: [{ place: 'Rome' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-1' }],
      reviewable: true,
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
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
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
    const succeededMember = publishedMember(batch.members[1])
    const pinnedRevision = {
      schemaRevisionId,
      extractionSchemaId: batch.extractionSchemaId,
      revisionNumber: 1,
      origin: 'researcher-edit',
      createdAt: '2026-08-14T10:00:00.000Z',
      recordDescription: 'One place record.',
      recordScope: 'document',
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
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
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
    const succeededMember = publishedMember(batch.members[0])
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
            recordScope: 'document',
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
      const chosen = chosenSchemaRead(url)
      if (chosen) return chosen
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
