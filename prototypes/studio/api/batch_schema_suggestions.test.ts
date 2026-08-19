import { describe, expect, it, vi } from 'vitest'
import type {
  ProjectStore,
  SchemaRevisionRecord,
} from '../../../packages/db/src/project-store.js'
import { createBatchSchemaSuggestionsApi } from './batch_schema_suggestions.js'

type Generate = (typeof import('./_model.js'))['generateSchemaWithModel']

const PROJECT = '51000000-0000-4000-8000-000000000001'
const FIRST = '51000000-0000-4000-8001-000000000001'
const SECOND = '51000000-0000-4000-8001-000000000002'
const FIRST_REPRESENTATION = '51000000-0000-4000-8002-000000000001'
const SECOND_REPRESENTATION = '51000000-0000-4000-8002-000000000002'
const SELECTION = 'a'.repeat(64)

const sourceTemplate = { _description: 'One record.', place: 'string' }
const sources = {
  selectionKey: SELECTION,
  sources: [
    {
      sourceDocumentId: FIRST,
      sourceRepresentationRevisionId: FIRST_REPRESENTATION,
      descriptor: {
        artifactReference: 'a'.repeat(64),
        artifactSha256: 'a'.repeat(64),
      },
    },
    {
      sourceDocumentId: SECOND,
      sourceRepresentationRevisionId: SECOND_REPRESENTATION,
      descriptor: {
        artifactReference: 'b'.repeat(64),
        artifactSha256: 'b'.repeat(64),
      },
    },
  ],
}

const revision: SchemaRevisionRecord = {
  schemaRevisionId: '51000000-0000-4000-8004-000000000001',
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  revisionNumber: 1,
  origin: 'suggestion',
  schemaTree: {
    recordDescription: 'One record.',
    schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
  },
  createdAt: new Date('2026-08-15T10:00:00Z'),
}

function request(body: unknown, signal?: AbortSignal) {
  return new Request('http://test/api/batch-schema-suggestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

function mergeRequest(signal?: AbortSignal) {
  return request(
    {
      action: 'merge',
      projectContextId: PROJECT,
      sourceDocumentIds: [FIRST, SECOND],
    },
    signal,
  )
}

type StoreMethods = Pick<
  ProjectStore,
  'getBatchSchemaSuggestionSources' | 'confirmBatchSchemaSuggestion'
>

function fixture(overrides: Partial<StoreMethods> = {}) {
  const store = {
    getBatchSchemaSuggestionSources: vi.fn(async () => sources),
    confirmBatchSchemaSuggestion: vi.fn(async () => ({
      status: 'created' as const,
      revision,
    })),
    ...overrides,
  }
  const generate = vi.fn<Generate>(async () => ({
    template: sourceTemplate,
    raw: JSON.stringify(sourceTemplate),
    pages: null,
  }))
  const readMarkdown = vi.fn(async () => ({
    bytes: new TextEncoder().encode('Source'),
    mediaType: 'text/markdown',
  }))
  return {
    store,
    generate,
    readMarkdown,
    handle: createBatchSchemaSuggestionsApi(store, {
      generate: generate as Generate,
      readMarkdown: readMarkdown as never,
    }),
  }
}

describe('/api/batch-schema-suggestions', () => {
  it('generates selected current sources in memory, then merges them', async () => {
    const subject = fixture()
    subject.generate
      .mockResolvedValueOnce({
        template: sourceTemplate,
        raw: '{}',
        pages: null,
      })
      .mockResolvedValueOnce({
        template: sourceTemplate,
        raw: '{}',
        pages: null,
      })
      .mockResolvedValueOnce({
        template: { _description: 'One record.', modelMergedField: 'number' },
        raw: '{}',
        pages: null,
      })

    const response = await subject.handle(mergeRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      coverage: [{ nodeId: expect.any(String), present: 0, total: 2 }],
    })
    expect(subject.store.getBatchSchemaSuggestionSources).toHaveBeenCalledTimes(2)
    expect(subject.readMarkdown).toHaveBeenCalledTimes(2)
    expect(subject.generate).toHaveBeenCalledTimes(3)
    const signals = subject.generate.mock.calls.map((call) => call[0]?.signal)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals).toEqual([signals[0], signals[0], signals[0]])
  })

  it('attributes invalid source templates without persisting model work', async () => {
    const subject = fixture()
    subject.generate
      .mockResolvedValueOnce({
        template: { _description: 'One record.', fuzzyMatches: 'string' },
        raw: '{}',
        pages: null,
      })
      .mockResolvedValueOnce({
        template: sourceTemplate,
        raw: '{}',
        pages: null,
      })

    const response = await subject.handle(mergeRequest())

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'source_suggestion_failed',
        details: {
          failures: [{ sourceDocumentId: FIRST, code: 'invalid_model_output' }],
        },
      },
    })
    expect(subject.generate).toHaveBeenCalledTimes(2)
  })

  it('stops sequential model work when the request is aborted', async () => {
    const subject = fixture()
    const controller = new AbortController()
    subject.generate.mockImplementationOnce(
      ({ signal }) =>
        new Promise<Awaited<ReturnType<Generate>>>((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ) as never,
    )
    const response = subject.handle(mergeRequest(controller.signal))

    await vi.waitFor(() => expect(subject.generate).toHaveBeenCalledOnce())
    controller.abort(new DOMException('Aborted', 'AbortError'))
    await response

    expect(subject.generate).toHaveBeenCalledOnce()
    expect(subject.generate.mock.calls[0]?.[0]?.signal?.aborted).toBe(true)
  })

  it('uses one whole-operation deadline for every model call', async () => {
    const subject = fixture()
    const deadline = new AbortController()
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(deadline.signal)
    subject.generate.mockImplementationOnce(
      ({ signal }) =>
        new Promise<Awaited<ReturnType<Generate>>>((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ) as never,
    )
    const response = subject.handle(mergeRequest())

    await vi.waitFor(() => expect(subject.generate).toHaveBeenCalledOnce())
    deadline.abort(new DOMException('Timed out', 'TimeoutError'))
    await response

    expect(timeout).toHaveBeenCalledWith(10 * 60 * 1000)
    expect(subject.generate).toHaveBeenCalledOnce()
    timeout.mockRestore()
  })

  it('fences a merge response when a selected current representation changes', async () => {
    const subject = fixture({
      getBatchSchemaSuggestionSources: vi
        .fn()
        .mockResolvedValueOnce(sources)
        .mockResolvedValueOnce({ ...sources, selectionKey: 'b'.repeat(64) }),
    })

    const response = await subject.handle(mergeRequest())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'selection_changed' },
    })
  })

  it('confirms the fenced definition and gives symmetric conflicts no revision details', async () => {
    const subject = fixture({
      confirmBatchSchemaSuggestion: vi.fn(async () => ({
        status: 'conflict' as const,
      })),
    })
    const confirmation = request({
      action: 'confirm',
      projectContextId: PROJECT,
      sourceDocumentIds: [FIRST, SECOND],
      selectionKey: SELECTION,
      recordDescription: 'One record.',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    })

    const response = await subject.handle(confirmation)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'revision_conflict',
        message:
          'The Current Schema Revision changed while these fields were being confirmed. Suggest common fields again.',
      },
    })
  })
})
