import { describe, expect, it } from 'vitest'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  batchExtractionProgress,
  batchExtractionRequestSchema,
  batchExtractionSchema,
} from './batchExtraction.contract.js'
import {
  batchSchemaSuggestionCreateRequestSchema,
  batchSchemaSuggestionRunRequestSchema,
} from './batchSchemaSuggestion.contract.js'

const projectContextId = '51000000-0000-4000-8000-000000000001'
const schemaRevisionId = '51000000-0000-4000-8004-000000000001'
const method = { models: null, settings: { article: null } }
const sourceDocumentIds = Array.from(
  { length: BATCH_EXTRACTION_SELECTION_LIMIT + 1 },
  (_, index) =>
    `51000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
)


/** `value` without `key`: the shape a strict schema must refuse when a required field is missing. */
function without<T extends object>(value: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...value }
  delete copy[key]
  return copy
}

describe('Batch selection contracts', () => {
  it('accepts exactly 50 sources for existing and suggested schemas', () => {
    const selected = sourceDocumentIds.slice(0, BATCH_EXTRACTION_SELECTION_LIMIT)
    expect(
      batchExtractionRequestSchema.safeParse({
        projectContextId,
        schemaRevisionId,
        strategy: 'ARTICLE',
        sourceDocumentIds: selected,
        method,
      }).success,
    ).toBe(true)
    expect(
      batchSchemaSuggestionCreateRequestSchema.safeParse({
        projectContextId,
        sourceDocumentIds: selected,
      }).success,
    ).toBe(true)
  })

  it('rejects 51 sources and duplicate selections for both entry paths', () => {
    for (const sourceDocumentSelection of [
      sourceDocumentIds,
      [sourceDocumentIds[0], sourceDocumentIds[0]],
    ]) {
      expect(
        batchExtractionRequestSchema.safeParse({
          projectContextId,
          schemaRevisionId,
          strategy: 'ARTICLE',
          sourceDocumentIds: sourceDocumentSelection,
          method,
        }).success,
      ).toBe(false)
      expect(
        batchSchemaSuggestionCreateRequestSchema.safeParse({
          projectContextId,
          sourceDocumentIds: sourceDocumentSelection,
        }).success,
      ).toBe(false)
    }
  })
})

describe('Batch start methods', () => {
  const selection = { projectContextId, schemaRevisionId, sourceDocumentIds: sourceDocumentIds.slice(0, 1) }

  it("requires the saved method of the strategy's own settings, never a recipe's", () => {
    for (const [strategy, settings] of [['ARTICLE', { article: null }], ['CATALOG', { generic: null }]] as const) {
      const request = { strategy, method: { models: { fields: 'instruct' }, settings } }
      expect(batchExtractionRequestSchema.safeParse({ ...selection, ...request }).success).toBe(true)
      expect(batchSchemaSuggestionRunRequestSchema.safeParse(request).success).toBe(true)
    }
    for (const request of [
      { strategy: 'ARTICLE' },
      { strategy: 'ARTICLE', method: { models: null, settings: { generic: null } } },
      { strategy: 'ARTICLE', method: { models: null, settings: { recipe: null } } },
      { strategy: 'CATALOG', method: { models: null, settings: { recipe: null } } },
    ]) {
      expect(batchExtractionRequestSchema.safeParse({ ...selection, ...request }).success).toBe(false)
      expect(batchSchemaSuggestionRunRequestSchema.safeParse(request).success).toBe(false)
    }
  })

  it('refuses a method that breaks a rule at the field it concerns', () => {
    const article = { context: 'full', context_tokens: 12288, overlap_passages: 1, identity: 'reference', identity_fields: [],
      prompt: 'reference', grounding: 'semantic' }
    const parsed = batchSchemaSuggestionRunRequestSchema.safeParse({ strategy: 'ARTICLE', method: { models: null, settings: { article } } })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues).toContainEqual(expect.objectContaining({
      path: ['method', 'settings', 'article', 'overlap_passages'], message: 'This choice requires bounded source units.',
    }))
  })
})

describe('Batch Extraction contracts', () => {
  const member = (index: number) => ({
    sourceDocumentId: sourceDocumentIds[index],
    sourceRepresentationRevisionId: `51000000-0000-4000-8002-${String(index + 1).padStart(12, '0')}`,
  })
  const succeeded = (index: number, reviewedAt: string | null = null) => ({
    ...member(index),
    executionStatus: 'COMPLETED',
    executionFailureMessage: null,
    latestExtraction: {
      extractionId: `51000000-0000-4000-8006-${String(index + 1).padStart(12, '0')}`,
      outcome: 'SUCCEEDED',
      complete: true,
      reviewable: true,
      createdAt: '2026-09-26T10:00:01.000Z',
      reviewedAt,
    },
  })
  const withoutResult = (index: number, executionStatus: string, executionFailureMessage: string | null) => ({
    ...member(index),
    executionStatus,
    executionFailureMessage,
    latestExtraction: null,
  })
  const batch = {
    batchExtractionId: '51000000-0000-4000-8007-000000000001',
    projectContextId,
    schemaRevisionId,
    extractionSchemaId: '51000000-0000-4000-8005-000000000001',
    extractionSchemaName: 'Places',
    schemaRevisionNumber: 1,
    strategy: 'ARTICLE',
    executionStatus: 'RUNNING',
    createdAt: '2026-09-26T10:00:00.000Z',
    members: [
      succeeded(0),
      succeeded(1, '2026-09-26T10:05:00.000Z'),
      withoutResult(2, 'QUEUED', null),
      withoutResult(3, 'RUNNING', null),
      withoutResult(4, 'FAILED', 'The model was unreachable.'),
      withoutResult(5, 'FAILED', 'This work stopped before it finished. Start it again.'),
    ],
  }

  it('a batch and its members carry derived status and no job timing', () => {
    expect(batchExtractionSchema.safeParse(batch).success).toBe(true)
    for (const jobField of [
      { startedAt: null },
      { finishedAt: null },
      { executionFailureMessage: null },
    ])
      expect(batchExtractionSchema.safeParse({ ...batch, ...jobField }).success).toBe(false)
    expect(batchExtractionSchema.safeParse(without(batch, 'executionStatus')).success).toBe(false)

    const [first] = batch.members
    for (const jobField of [{ startedAt: null }, { finishedAt: null }])
      expect(batchExtractionSchema.safeParse({ ...batch, members: [{ ...first, ...jobField }] }).success)
        .toBe(false)
    for (const required of ['executionStatus', 'executionFailureMessage', 'latestExtraction'] as const)
      expect(batchExtractionSchema.safeParse({ ...batch, members: [without(first, required)] }).success).toBe(false)
    // A member's Extraction is its published result; a failure is the member's own status.
    expect(batchExtractionSchema.safeParse({
      ...batch,
      members: [{ ...first, latestExtraction: { ...first.latestExtraction, outcome: 'FAILED' } }],
    }).success).toBe(false)
    expect(batchExtractionSchema.safeParse({
      ...batch,
      members: [{ ...first, latestExtraction: { ...first.latestExtraction, failureMessage: null } }],
    }).success).toBe(false)
  })

  it('progress counts pending, failed and interrupted members from their status', () => {
    expect(batchExtractionProgress(batchExtractionSchema.parse(batch))).toEqual({
      total: 6,
      extracted: 2,
      // Every member with a published Extraction succeeded; `failed` counts
      // the members whose status settled without one.
      succeeded: 2,
      pending: 2,
      failed: 2,
      reviewed: 1,
      unreviewable: 0,
      needsReview: 1,
    })
  })
})
