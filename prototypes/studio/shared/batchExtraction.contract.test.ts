import { describe, expect, it } from 'vitest'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  batchExtractionRequestSchema,
} from './batchExtraction.contract.js'
import { batchSchemaSuggestionCreateRequestSchema } from './batchSchemaSuggestion.contract.js'

const projectContextId = '51000000-0000-4000-8000-000000000001'
const schemaRevisionId = '51000000-0000-4000-8004-000000000001'
const sourceDocumentIds = Array.from(
  { length: BATCH_EXTRACTION_SELECTION_LIMIT + 1 },
  (_, index) =>
    `51000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
)

describe('Batch selection contracts', () => {
  it('accepts exactly 50 sources for existing and suggested schemas', () => {
    const selected = sourceDocumentIds.slice(0, BATCH_EXTRACTION_SELECTION_LIMIT)
    expect(
      batchExtractionRequestSchema.safeParse({
        projectContextId,
        schemaRevisionId,
        strategy: 'ARTICLE',
        sourceDocumentIds: selected,
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
