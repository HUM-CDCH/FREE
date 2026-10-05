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
  const member = (index: number, executionStatus: string, reviewable = executionStatus !== 'QUEUED',
    currentReview: { snapshotVersion: number; feedbackVersion: number; createdAt: string; schemaRevisionId: string } | null = null) => ({
    extractionId: `51000000-0000-4000-8006-${String(index + 1).padStart(12, '0')}`,
    sourceDocumentId: sourceDocumentIds[index],
    sourceRepresentationRevisionId: `51000000-0000-4000-8002-${String(index + 1).padStart(12, '0')}`,
    executionStatus,
    completed: executionStatus === 'COMPLETED',
    reviewable,
    currentReview,
  })
  const review = { snapshotVersion: 1, feedbackVersion: 1, createdAt: '2026-09-26T10:05:00.000Z', schemaRevisionId }
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
      member(0, 'COMPLETED'),
      member(1, 'COMPLETED', true, review),
      member(2, 'QUEUED'),
      member(3, 'RUNNING'),
      member(4, 'FAILED'),
      member(5, 'PAUSED'),
    ],
  }

  it('a batch and its durable members carry derived status and no job timing or old result fields', () => {
    expect(batchExtractionSchema.safeParse(batch).success).toBe(true)
    for (const jobField of [{ startedAt: null }, { finishedAt: null }, { executionFailureMessage: null }])
      expect(batchExtractionSchema.safeParse({ ...batch, ...jobField }).success).toBe(false)
    expect(batchExtractionSchema.safeParse(without(batch, 'executionStatus')).success).toBe(false)

    const [first] = batch.members
    for (const removed of [{ startedAt: null }, { executionFailureMessage: null }, { latestExtraction: null }, { durableExtractionId: first!.extractionId }])
      expect(batchExtractionSchema.safeParse({ ...batch, members: [{ ...first, ...removed }] }).success).toBe(false)
    for (const required of ['extractionId', 'executionStatus', 'completed', 'reviewable', 'currentReview'] as const)
      expect(batchExtractionSchema.safeParse({ ...batch, members: [without(first!, required)] }).success).toBe(false)
  })

  it('counts completion and finalized current cuts without treating paused work as success', () => {
    expect(batchExtractionProgress(batchExtractionSchema.parse(batch))).toEqual({
      total: 6,
      extracted: 2,
      succeeded: 2,
      pending: 2,
      failed: 1,
      reviewed: 1,
      unreviewable: 0,
      needsReview: 1,
    })
    const empty = batchExtractionSchema.parse({ ...batch, members: [member(0, 'COMPLETED', false)] })
    expect(batchExtractionProgress(empty)).toMatchObject({ succeeded: 1, reviewed: 0, needsReview: 0, unreviewable: 1 })
    // A finalized current cut counts as extracted while processing is paused.
    const paused = batchExtractionSchema.parse({ ...batch, members: [member(0, 'PAUSED', true, review)] })
    expect(batchExtractionProgress(paused)).toMatchObject({ extracted: 1, reviewed: 1, needsReview: 0 })
    for (const executionStatus of ['STOPPED', 'PAUSED', 'RUNNING', 'FAILED']) {
      const retained = batchExtractionSchema.parse({ ...batch, members: [{ ...member(0, executionStatus), completed: true }] })
      expect(batchExtractionProgress(retained)).toMatchObject({ extracted: 1, reviewed: 0, needsReview: 1 })
    }
  })
})
