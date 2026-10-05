import { z } from 'zod'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  PILOT_BATCH_SELECTION_LIMIT,
} from 'extraction/batch'
import { extractionMethodIntentSchema, settingsFit } from 'extraction/extraction-method'
import { canonicalUuidSchema } from './projectContext.contract.js'
import { extractionStrategySchema, methodRuleIssues } from './extraction.contract.js'

export { BATCH_EXTRACTION_SELECTION_LIMIT, PILOT_BATCH_SELECTION_LIMIT }

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
    /** The saved method the start view showed. A batch has no recipe: Article or generic Catalog settings. */
    method: extractionMethodIntentSchema,
  })
  .strict()
  .refine(batchMethodFitsStrategy, {
    path: ['method', 'settings'],
    message: 'The saved settings do not match this Extraction Strategy.',
  })
  .superRefine(methodRuleIssues)

/** A batch has no recipe, so its settings are the Article ones or the generic Catalog ones. */
export function batchMethodFitsStrategy(request: {
  strategy: z.output<typeof extractionStrategySchema>
  method: z.output<typeof extractionMethodIntentSchema>
}): boolean {
  return settingsFit(request.strategy, null, request.method.settings)
}

export type BatchExtractionRequest = z.infer<typeof batchExtractionRequestSchema>

/**
 * A member is one durable Extraction: its head's lifecycle, whether its current result cut holds saved values, and a
 * finalization of that cut produced by the batch's own Schema Revision. Each member keeps its own cuts.
 */
const batchExtractionMemberSchema = z
  .object({
    extractionId: canonicalUuidSchema,
    sourceDocumentId: canonicalUuidSchema,
    sourceRepresentationRevisionId: canonicalUuidSchema,
    executionStatus: z.enum(['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING', 'STOPPED', 'COMPLETED', 'FAILED']),
    reviewable: z.boolean(),
    currentReview: z.object({ snapshotVersion: z.number().int().positive(), feedbackVersion: z.number().int().nonnegative(),
      createdAt: z.iso.datetime(), schemaRevisionId: canonicalUuidSchema }).strict().nullable(),
  })
  .strict()

/** A batch is QUEUED, RUNNING or COMPLETED from its members; it never fails as a whole, its members do. */
export const batchExtractionSchema = z
  .object({
    batchExtractionId: canonicalUuidSchema,
    projectContextId: canonicalUuidSchema,
    schemaRevisionId: canonicalUuidSchema,
    extractionSchemaId: canonicalUuidSchema,
    extractionSchemaName: z.string(),
    schemaRevisionNumber: z.number().int().positive(),
    strategy: extractionStrategySchema,
    executionStatus: projectOperationStatusSchema,
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
 * Execution counts and the separate persisted research-review digest.
 */
export function batchExtractionProgress(batch: BatchExtraction) {
  const extracted = batch.members.filter((member) => member.executionStatus === 'COMPLETED')
  // A completed member without saved values can never be finalized, so it is its own outcome — never counted as what a
  // researcher has reviewed. These three groups partition `extracted`.
  const reviewed = extracted.filter((member) => member.currentReview !== null)
  const unreviewable = extracted.filter((member) => !member.reviewable)
  return {
    total: batch.members.length,
    extracted: extracted.length,
    succeeded: extracted.length,
    pending: batch.members.filter(
      (member) =>
        member.executionStatus === 'QUEUED' ||
        member.executionStatus === 'RUNNING',
    ).length,
    failed: batch.members.filter((member) => member.executionStatus === 'FAILED')
      .length,
    // A paused, failed or stopped member's finalized cut counts as reviewed too.
    reviewed: batch.members.filter((member) => member.currentReview !== null).length,
    unreviewable: unreviewable.length,
    needsReview: extracted.length - reviewed.length - unreviewable.length,
  }
}
