import { z } from 'zod'
import { extractionStrategySchema } from './extraction.contract.js'
import { canonicalUuidSchema } from './projectContext.contract.js'

/**
 * A Batch Extraction applies one Schema Revision and one Extraction Strategy to
 * a chosen set of Source Documents. Its members are stored when it opens, so a
 * reader can tell a member that has not run yet from one that produced nothing.
 */
export const BATCH_EXTRACTION_SELECTION_LIMIT = 50

export const batchExtractionRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    schemaRevisionId: canonicalUuidSchema,
    strategy: extractionStrategySchema,
    force: z.boolean().optional(),
    sourceDocumentIds: z
      .array(canonicalUuidSchema)
      .min(1)
      .max(BATCH_EXTRACTION_SELECTION_LIMIT),
  })
  .strict()

export type BatchExtractionRequest = z.infer<typeof batchExtractionRequestSchema>

const batchExtractionMemberSchema = z
  .object({
    sourceDocumentId: canonicalUuidSchema,
    sourceRepresentationRevisionId: canonicalUuidSchema,
    latestExtraction: z
      .object({
        extractionId: canonicalUuidSchema,
        outcome: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']),
        complete: z.boolean().nullable(),
        reviewable: z.boolean(),
        createdAt: z.iso.datetime(),
        reviewedAt: z.iso.datetime().nullable(),
        failureMessage: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()

export const batchExtractionSchema = z
  .object({
    batchExtractionId: canonicalUuidSchema,
    projectContextId: canonicalUuidSchema,
    schemaRevisionId: canonicalUuidSchema,
    extractionSchemaId: canonicalUuidSchema,
    extractionSchemaName: z.string(),
    schemaRevisionNumber: z.number().int().positive(),
    strategy: extractionStrategySchema,
    createdAt: z.iso.datetime(),
    members: z.array(batchExtractionMemberSchema),
  })
  .strict()

export type BatchExtraction = z.output<typeof batchExtractionSchema>
export type BatchExtractionMember = BatchExtraction['members'][number]

export const batchExtractionResponseSchema = z
  .object({
    batchExtraction: batchExtractionSchema,
    disposition: z.enum(['created', 'running', 'retry', 'complete']),
  })
  .strict()

export const batchExtractionListResponseSchema = z
  .object({ batchExtractions: z.array(batchExtractionSchema) })
  .strict()

/**
 * What one Batch Extraction is doing right now, counted from its members. A
 * member without an Extraction has not run, so `pending` never claims progress
 * that has not happened.
 */
export function batchExtractionProgress(batch: BatchExtraction) {
  const extracted = batch.members.filter((member) => member.latestExtraction)
  const succeeded = extracted.filter(
    (member) => member.latestExtraction!.outcome === 'SUCCEEDED',
  )
  const failed = extracted.filter(
    (member) => member.latestExtraction!.outcome === 'FAILED',
  )
  const cancelled = extracted.filter(
    (member) => member.latestExtraction!.outcome === 'CANCELLED',
  )
  const reviewed = succeeded.filter(
    (member) =>
      member.latestExtraction!.reviewedAt !== null ||
      !member.latestExtraction!.reviewable,
  )
  return {
    total: batch.members.length,
    extracted: extracted.length,
    pending: batch.members.length - extracted.length,
    failed: failed.length,
    cancelled: cancelled.length,
    reviewed: reviewed.length,
    unreviewable: 0,
    needsReview: succeeded.length - reviewed.length,
  }
}
