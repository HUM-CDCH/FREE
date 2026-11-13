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
    completed: z.boolean(),
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
    /** Opened before its Schema Revision was approved: a trial round. Absent from an older server. */
    trial: z.boolean().optional(),
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

/** A Source Document's latest Extraction as the project's summary counts it: its newest completed or reviewed one,
 *  in a Batch Extraction or of the document alone (`batchExtractionId` null). */
const latestExtractionSchema = z
  .object({
    sourceDocumentId: canonicalUuidSchema,
    extractionId: canonicalUuidSchema,
    schemaRevisionId: canonicalUuidSchema,
    sourceRepresentationRevisionId: canonicalUuidSchema,
    batchExtractionId: canonicalUuidSchema.nullable(),
    createdAt: z.iso.datetime(),
    completed: z.boolean(),
    /** Its latest finalized cut: the results and decisions reviewed. */
    review: z.object({ snapshotVersion: z.number().int().positive(), feedbackVersion: z.number().int().nonnegative() }).strict().nullable(),
  })
  .strict()

export type LatestExtraction = z.output<typeof latestExtractionSchema>

export const batchExtractionListResponseSchema = z
  // Only when asked for (`latest=1`): each document's latest Extraction, its most recently reviewed one, and its newest
  // of any state, which it shows.
  .object({ batchExtractions: z.array(batchExtractionSchema), latestExtractions: z.array(latestExtractionSchema).optional(),
    reviewedExtractions: z.array(latestExtractionSchema).optional(), newestExtractionIds: z.array(canonicalUuidSchema).optional() })
  .strict()

/** A member's run has settled for now: paused, stopped, failed or completed, so its saved values hold still. */
const SETTLED: ReadonlySet<BatchExtractionMember['executionStatus']> = new Set(['PAUSED', 'STOPPED', 'FAILED', 'COMPLETED'])

/** Whether a member's saved values can be reviewed: it holds some, and its run completed once or has settled. This is
 *  what the document's Results, the chat's review step and the batch's review grid all review; a member stopped or
 *  failed partway keeps what it saved. */
export const reviewableMember = (member: BatchExtractionMember) =>
  member.reviewable && (member.completed || SETTLED.has(member.executionStatus))

/** Whether a member's document was run again since: it shows another Extraction (`newest`, each document's), so only
 *  that newer run is reviewed. Unknown (`newest` null) is never superseded. */
export const supersededMember = (member: BatchExtractionMember, newest: ReadonlySet<string> | null) =>
  newest !== null && !newest.has(member.extractionId)

/** The batch as its outcome counts it: a member superseded before it was reviewed can no longer be, so it is left out;
 *  one reviewed before it was superseded still counts as reviewed. */
export const currentBatch = (batch: BatchExtraction, newest: ReadonlySet<string> | null): BatchExtraction => newest === null ? batch
  : { ...batch, members: batch.members.filter((member) => member.currentReview !== null || !supersededMember(member, newest)) }

/**
 * Execution counts and the separate persisted research-review digest.
 */
export function batchExtractionProgress(batch: BatchExtraction) {
  const extracted = batch.members.filter((member) => member.completed || member.currentReview !== null)
  // Reviewed, or reviewable now: a member stopped or failed partway with saved values is reviewed like any other.
  const toReview = batch.members.filter((member) => member.currentReview !== null || reviewableMember(member))
  // A completed member without saved values can never be finalized, so it is its own outcome — never counted as what a
  // researcher has reviewed. These three groups partition `extracted`.
  const reviewed = extracted.filter((member) => member.currentReview !== null)
  const unreviewable = extracted.filter((member) => !member.reviewable && member.currentReview === null)
  return {
    total: batch.members.length,
    extracted: extracted.length,
    succeeded: extracted.length,
    // The members a researcher can actually review: those reviewed, and those with saved values whose run completed or
    // settled (a member stopped or failed partway included). Completion is measured against these, never every member.
    reviewable: toReview.length,
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
    needsReview: toReview.length - reviewed.length,
  }
}
