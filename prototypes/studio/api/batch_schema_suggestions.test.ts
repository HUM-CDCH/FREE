import { describe, expect, it, vi } from 'vitest'
import type {
  ProjectStore,
  SchemaRevisionRecord,
} from '../../../packages/db/src/project-store.js'
import { createBatchSchemaSuggestionsApi } from './batch_schema_suggestions.js'
import { ApiError } from './_http.js'

type Generate = (typeof import('./_model.js'))['generateSchemaWithModel']

const PROJECT = '51000000-0000-4000-8000-000000000001'
const FIRST = '51000000-0000-4000-8001-000000000001'
const SECOND = '51000000-0000-4000-8001-000000000002'
const FIRST_REPRESENTATION = '51000000-0000-4000-8002-000000000001'
const SECOND_REPRESENTATION = '51000000-0000-4000-8002-000000000002'
const FIRST_SUGGESTION = '51000000-0000-4000-8005-000000000001'
const SECOND_SUGGESTION = '51000000-0000-4000-8005-000000000002'
const SELECTION = 'a'.repeat(64)

const sourceTemplate = { _description: 'One record.', place: 'string' }
const sources = {
  selectionKey: SELECTION,
  suggestions: [
    {
      sourceDocumentId: FIRST,
      sourceRepresentationRevisionId: FIRST_REPRESENTATION,
      template: sourceTemplate,
    },
    {
      sourceDocumentId: SECOND,
      sourceRepresentationRevisionId: SECOND_REPRESENTATION,
      template: sourceTemplate,
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

function request(body: unknown) {
  return new Request('http://test/api/batch-schema-suggestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function mergeRequest() {
  return request({
    action: 'merge',
    projectContextId: PROJECT,
    sourceDocumentIds: [FIRST, SECOND],
  })
}

function work(schemaSuggestionId: string, digest: string) {
  return {
    status: 'work' as const,
    schemaSuggestionId,
    descriptor: {
      artifactReference: digest.repeat(64),
      artifactSha256: digest.repeat(64),
    },
  }
}

type StoreMethods = Pick<
  ProjectStore,
  | 'getBatchSchemaSuggestionInputs'
  | 'confirmBatchSchemaSuggestion'
  | 'beginSourceSchemaSuggestion'
  | 'completeSourceSchemaSuggestion'
  | 'failSourceSchemaSuggestion'
>

function fixture(overrides: Partial<StoreMethods> = {}) {
  const store = {
    getBatchSchemaSuggestionInputs: vi.fn(async () => sources),
    confirmBatchSchemaSuggestion: vi.fn(async () => ({
      status: 'created' as const,
      revision,
    })),
    beginSourceSchemaSuggestion: vi.fn(async () => ({
      status: 'ready' as const,
      template: sourceTemplate,
    })),
    completeSourceSchemaSuggestion: vi.fn(async () => {}),
    failSourceSchemaSuggestion: vi.fn(async () => {}),
    ...overrides,
  }
  const generate = vi.fn(async (): Promise<Awaited<ReturnType<Generate>>> => ({
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
  it('accepts a valid merged schema without enforcing source field coverage', async () => {
    const subject = fixture()
    subject.generate.mockResolvedValueOnce({
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
    expect(subject.store.beginSourceSchemaSuggestion).toHaveBeenCalledTimes(2)
    expect(subject.generate).toHaveBeenCalledOnce()
  })

  it('claims and awaits missing source work sequentially before merging', async () => {
    const missing = {
      ...sources,
      suggestions: sources.suggestions.map((source) => ({
        ...source,
        template: null,
      })),
    }
    const getInputs = vi
      .fn()
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(sources)
      .mockResolvedValueOnce(sources)
    const begin = vi
      .fn()
      .mockResolvedValueOnce(work(FIRST_SUGGESTION, 'a'))
      .mockResolvedValueOnce(work(SECOND_SUGGESTION, 'b'))
    const subject = fixture({
      getBatchSchemaSuggestionInputs: getInputs,
      beginSourceSchemaSuggestion: begin,
    })
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
        template: sourceTemplate,
        raw: '{}',
        pages: null,
      })

    const response = await subject.handle(mergeRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      coverage: [{ nodeId: expect.any(String), present: 2, total: 2 }],
    })
    expect(subject.readMarkdown).toHaveBeenCalledTimes(2)
    expect(subject.generate).toHaveBeenCalledTimes(3)
    expect(
      vi
        .mocked(subject.store.completeSourceSchemaSuggestion)
        .mock.calls.map(([id]) => id),
    ).toEqual([FIRST_SUGGESTION, SECOND_SUGGESTION])
  })

  it('reports live owners with only their unresolved source ids', async () => {
    const pending = {
      ...sources,
      suggestions: [
        { ...sources.suggestions[0], template: null },
        sources.suggestions[1],
      ],
    }
    const subject = fixture({
      getBatchSchemaSuggestionInputs: vi.fn(async () => pending),
      beginSourceSchemaSuggestion: vi
        .fn()
        .mockResolvedValueOnce({ status: 'pending' as const })
        .mockResolvedValueOnce({
          status: 'ready' as const,
          template: sourceTemplate,
        }),
    })

    const response = await subject.handle(mergeRequest())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'suggestions_pending',
        details: { sourceDocumentIds: [FIRST] },
      },
    })
    expect(subject.generate).not.toHaveBeenCalled()
  })

  it('preserves successful work and reports only terminal source failures', async () => {
    const missing = {
      ...sources,
      suggestions: sources.suggestions.map((source) => ({
        ...source,
        template: null,
      })),
    }
    const partiallyReady = {
      ...sources,
      suggestions: [
        { ...sources.suggestions[0], template: null },
        sources.suggestions[1],
      ],
    }
    const subject = fixture({
      getBatchSchemaSuggestionInputs: vi
        .fn()
        .mockResolvedValueOnce(missing)
        .mockResolvedValueOnce(partiallyReady),
      beginSourceSchemaSuggestion: vi
        .fn()
        .mockResolvedValueOnce(work(FIRST_SUGGESTION, 'a'))
        .mockResolvedValueOnce(work(SECOND_SUGGESTION, 'b')),
    })
    subject.generate
      .mockRejectedValueOnce(
        new ApiError(502, 'invalid_model_output', 'provider secret'),
      )
      .mockResolvedValueOnce({
        template: sourceTemplate,
        raw: '{}',
        pages: null,
      })

    const response = await subject.handle(mergeRequest())

    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body).toMatchObject({
      error: {
        code: 'source_suggestion_failed',
        details: {
          failures: [{ sourceDocumentId: FIRST, code: 'invalid_model_output' }],
        },
      },
    })
    expect(JSON.stringify(body).includes('provider secret')).toBe(false)
    expect(subject.store.failSourceSchemaSuggestion).toHaveBeenCalledWith(
      FIRST_SUGGESTION,
      { code: 'invalid_model_output' },
    )
    expect(subject.store.completeSourceSchemaSuggestion).toHaveBeenCalledWith(
      SECOND_SUGGESTION,
      sourceTemplate,
      '{}',
    )
  })

  it('classifies an empty merge as heterogeneous but still rejects reserved Evidence', async () => {
    const empty = fixture()
    empty.generate.mockResolvedValueOnce({
      template: { _description: 'One record.' },
      raw: '{}',
      pages: null,
    })

    const emptyResponse = await empty.handle(mergeRequest())

    expect(emptyResponse.status).toBe(200)
    await expect(emptyResponse.json()).resolves.toMatchObject({
      status: 'heterogeneous',
      selectionKey: SELECTION,
    })

    const evidence = fixture()
    evidence.generate.mockResolvedValueOnce({
      template: {
        _description: 'One record.',
        place: { _description: 'Place.', fuzzyMatches: 'string' },
      },
      raw: '{}',
      pages: null,
    })

    expect((await evidence.handle(mergeRequest())).status).toBe(502)
  })

  it('fences a merge response when a selected current representation changes', async () => {
    const subject = fixture({
      getBatchSchemaSuggestionInputs: vi
        .fn()
        .mockResolvedValueOnce(sources)
        .mockResolvedValueOnce(sources)
        .mockResolvedValueOnce({ ...sources, selectionKey: 'b'.repeat(64) }),
    })

    const response = await subject.handle(mergeRequest())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'selection_changed' },
    })
  })

  it('confirms only the fenced researcher definition and preserves its revision response', async () => {
    const subject = fixture()

    const response = await subject.handle(
      request({
        action: 'confirm',
        projectContextId: PROJECT,
        sourceDocumentIds: [FIRST, SECOND],
        selectionKey: SELECTION,
        recordDescription: 'One record.',
        schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
      }),
    )

    expect(response.status).toBe(201)
    expect(subject.store.confirmBatchSchemaSuggestion).toHaveBeenCalledWith(
      PROJECT,
      [FIRST, SECOND],
      SELECTION,
      {
        recordDescription: 'One record.',
        schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
      },
    )

    const duplicate = await subject.handle(
      request({
        action: 'confirm',
        projectContextId: PROJECT,
        sourceDocumentIds: [FIRST, SECOND],
        selectionKey: SELECTION,
        recordDescription: 'One record.',
        schemaNodes: [
          { id: 'one', name: 'place', type: 'string' },
          { id: 'two', name: 'place', type: 'string' },
        ],
      }),
    )

    expect(duplicate.status).toBe(422)
  })

  it('returns the winning revision when confirmation loses a head race', async () => {
    const subject = fixture({
      confirmBatchSchemaSuggestion: vi.fn(async () => ({
        status: 'conflict' as const,
        currentRevision: revision,
      })),
    })

    const response = await subject.handle(
      request({
        action: 'confirm',
        projectContextId: PROJECT,
        sourceDocumentIds: [FIRST, SECOND],
        selectionKey: SELECTION,
        recordDescription: 'One record.',
        schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
      }),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'revision_conflict',
        details: {
          currentRevision: { schemaRevisionId: revision.schemaRevisionId },
        },
      },
    })
  })
})
