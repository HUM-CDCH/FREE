import { z } from 'zod'
import { BATCH_EXTRACTION_SELECTION_LIMIT } from 'extraction/batch'
import { canonicalUuidSchema } from './projectContext.contract.js'
import { extractionStrategySchema } from './extraction.contract.js'

export { BATCH_EXTRACTION_SELECTION_LIMIT }

/** A durable operation's execution lifecycle, distinct from research review. */
export const projectOperationStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
])

/**
 * A Batch Extraction applies one Schema Revision and one Extraction Strategy to
 * a chosen set of Source Documents. Its members are stored when it opens, so a
 * reader can tell a member that has not run yet from one that produced nothing.
 */
export const batchExtractionRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    schemaRevisionId: canonicalUuidSchema,
    strategy: extractionStrategySchema,
    force: z.boolean().optional(),
    sourceDocumentIds: z
      .array(canonicalUuidSchema)
      .min(1)
      .max(BATCH_EXTRACTION_SELECTION_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict()

export type BatchExtractionRequest = z.infer<typeof batchExtractionRequestSchema>

const batchExtractionMemberSchema = z
  .object({
    sourceDocumentId: canonicalUuidSchema,
    sourceRepresentationRevisionId: canonicalUuidSchema,
    executionStatus: projectOperationStatusSchema.optional(),
    executionFailureMessage: z.string().nullable().optional(),
    startedAt: z.iso.datetime().nullable().optional(),
    finishedAt: z.iso.datetime().nullable().optional(),
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
    executionStatus: projectOperationStatusSchema.optional(),
    executionFailureMessage: z.string().nullable().optional(),
    startedAt: z.iso.datetime().nullable().optional(),
    finishedAt: z.iso.datetime().nullable().optional(),
    createdAt: z.iso.datetime(),
    members: z.array(batchExtractionMemberSchema),
  })
  .strict()

export type BatchExtraction = z.output<typeof batchExtractionSchema>
export type BatchExtractionMember = BatchExtraction['members'][number]

export const batchExtractionOpenResponseSchema = z
  .object({
    batchExtraction: batchExtractionSchema,
    disposition: z.enum(['created', 'replayed']),
  })
  .strict()

export const batchExtractionResponseSchema = z
  .object({ batchExtraction: batchExtractionSchema })
  .strict()

export const batchExtractionListResponseSchema = z
  .object({ batchExtractions: z.array(batchExtractionSchema) })
  .strict()

/**
 * The Extraction Results a Batch Extraction has produced, for one spreadsheet
 * over the whole batch. Members without a result are absent, never empty.
 */
export const batchExtractionResultsResponseSchema = z
  .object({
    batchExtractionId: canonicalUuidSchema,
    executionStatus: projectOperationStatusSchema,
    totalMembers: z.number().int().nonnegative(),
    successfulResults: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    results: z.array(
      z
        .object({
          sourceDocumentId: canonicalUuidSchema,
          extractionId: canonicalUuidSchema,
          result: z.record(z.string(), z.json()),
        })
        .strict(),
    ),
  })
  .strict()

export type BatchExtractionResults = z.output<
  typeof batchExtractionResultsResponseSchema
>

export type BatchExtractionResult = z.output<
  typeof batchExtractionResultsResponseSchema
>['results'][number]

/**
 * Execution counts and the separate persisted research-review digest.
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
  // A succeeded Extraction with no reviewable result can never carry Review
  // Decisions, so it is its own outcome — never counted as what a researcher
  // has reviewed. An Extraction is reviewable whenever it has been reviewed
  // (extraction.contract.ts), so these three groups partition `succeeded`.
  const reviewed = succeeded.filter(
    (member) => member.latestExtraction!.reviewedAt !== null,
  )
  const unreviewable = succeeded.filter(
    (member) => !member.latestExtraction!.reviewable,
  )
  return {
    total: batch.members.length,
    extracted: extracted.length,
    succeeded: succeeded.length,
    pending: batch.members.filter(
      (member) =>
        member.executionStatus === 'QUEUED' ||
        member.executionStatus === 'RUNNING',
    ).length,
    failed: failed.length,
    cancelled: cancelled.length,
    reviewed: reviewed.length,
    unreviewable: unreviewable.length,
    needsReview: succeeded.length - reviewed.length - unreviewable.length,
  }
}
