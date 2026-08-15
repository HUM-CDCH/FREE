import { describe, expect, it, vi } from 'vitest'
import type { ProjectStore } from '../../../packages/db/src/project-store.js'
import { createBatchSchemaSuggestionsApi } from './batch_schema_suggestions.js'

type Generate = typeof import('./_model.js')['generateSchemaWithModel']

const PROJECT = '51000000-0000-4000-8000-000000000001'
const FIRST = '51000000-0000-4000-8001-000000000001'
const SECOND = '51000000-0000-4000-8001-000000000002'
const FIRST_REPRESENTATION = '51000000-0000-4000-8002-000000000001'
const SECOND_REPRESENTATION = '51000000-0000-4000-8002-000000000002'
const SELECTION = 'a'.repeat(64)

const sources = {
  selectionKey: SELECTION,
  suggestions: [
    {
      sourceDocumentId: FIRST,
      sourceRepresentationRevisionId: FIRST_REPRESENTATION,
      template: { _description: 'One record.', place: 'string' },
    },
    {
      sourceDocumentId: SECOND,
      sourceRepresentationRevisionId: SECOND_REPRESENTATION,
      template: { _description: 'One record.', place: 'string' },
    },
  ],
}

function request(body: unknown) {
  return new Request('http://test/api/batch-schema-suggestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function fixture(
  overrides: Partial<
    Pick<
      ProjectStore,
      'getBatchSchemaSuggestionInputs' | 'confirmBatchSchemaSuggestion'
    >
  > = {},
) {
  const store = {
    getBatchSchemaSuggestionInputs: vi.fn(async () => sources),
    confirmBatchSchemaSuggestion: vi.fn(async () => ({
      status: 'created' as const,
      revision: {
        schemaRevisionId: '51000000-0000-4000-8004-000000000001',
        extractionSchemaId: '51000000-0000-4000-8003-000000000001',
        revisionNumber: 1,
        origin: 'suggestion' as const,
        schemaTree: {
          recordDescription: 'One record.',
          schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
        },
        createdAt: new Date('2026-08-15T10:00:00Z'),
      },
    })),
    ...overrides,
  }
  const generate = vi.fn(async (): Promise<Awaited<ReturnType<Generate>>> => ({
    template: { _description: 'One record.', place: 'string' },
    raw: '{"place":"string"}',
    pages: null,
  }))
  return {
    store,
    generate,
    handle: createBatchSchemaSuggestionsApi(store, generate as Generate),
  }
}

describe('/api/batch-schema-suggestions', () => {
  it('returns only source-verified common fields and exact coverage', async () => {
    const subject = fixture()
    const response = await subject.handle(
      request({
        action: 'merge',
        projectContextId: PROJECT,
        sourceDocumentIds: [SECOND, FIRST],
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ready',
      selectionKey: SELECTION,
      coverage: [{ present: 2, total: 2 }],
    })
    expect(subject.store.getBatchSchemaSuggestionInputs).toHaveBeenCalledWith(
      PROJECT,
      [SECOND, FIRST],
    )
  })

  it('rejects model-authored Evidence and fields missing from one selected source', async () => {
    const evidence = fixture()
    evidence.generate.mockResolvedValueOnce({
      template: {
        _description: 'One record.',
        place: { _description: 'Place.', fuzzyMatches: 'string' },
      },
      raw: '{}',
      pages: null,
    })
    expect(
      (
        await evidence.handle(
          request({
            action: 'merge',
            projectContextId: PROJECT,
            sourceDocumentIds: [FIRST, SECOND],
          }),
        )
      ).status,
    ).toBe(502)

    const uncovered = fixture()
    uncovered.generate.mockResolvedValueOnce({
      template: { _description: 'One record.', hallucinated: 'string' },
      raw: '{}',
      pages: null,
    })
    expect(
      (
        await uncovered.handle(
          request({
            action: 'merge',
            projectContextId: PROJECT,
            sourceDocumentIds: [FIRST, SECOND],
          }),
        )
      ).status,
    ).toBe(502)
  })

  it('fences a merge response when a selected current representation changes', async () => {
    const subject = fixture({
      getBatchSchemaSuggestionInputs: vi
        .fn()
        .mockResolvedValueOnce(sources)
        .mockResolvedValueOnce({ ...sources, selectionKey: 'b'.repeat(64) }),
    })
    const response = await subject.handle(
      request({
        action: 'merge',
        projectContextId: PROJECT,
        sourceDocumentIds: [FIRST, SECOND],
      }),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
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
    expect(await response.json()).toMatchObject({
      revision: { schemaRevisionId: '51000000-0000-4000-8004-000000000001' },
    })

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
})
