import { z } from 'zod'
import {
  evidenceLinkSchema,
  evidenceLinksHaveUniqueScalarPaths,
  resultPathSchema,
} from './groundedExtraction.js'
import { providerKindSchema } from './modelConfig.contract.js'

export const extractionStrategySchema = z.enum(['ARTICLE', 'CATALOG'])
export type ExtractionStrategy = z.infer<typeof extractionStrategySchema>

/** Durable failure code for Catalog records skipped by the record limit. */
export const CATALOG_NOT_ATTEMPTED_LIMIT = 'not_attempted_limit'

const requestUuid = z.uuid().transform((value) => value.toLowerCase())

export const extractionRetrySelectionSchema = z
  .object({
    retryOfId: requestUuid,
    retryDocument: z.boolean(),
    rediscover: z.boolean(),
    retryRecordStartBlockIds: z.array(z.string().min(1)),
  })
  .strict()

export type ExtractionRetrySelection = z.infer<
  typeof extractionRetrySelectionSchema
>

const extractionFreshRequestSchema = z
  .object({
    id: requestUuid,
    sourceRepresentationRevisionId: requestUuid,
    schemaRevisionId: requestUuid,
    strategy: extractionStrategySchema,
    retryOfId: z.never().optional(),
    retryDocument: z.never().optional(),
    rediscover: z.never().optional(),
    retryRecordStartBlockIds: z.never().optional(),
  })
  .strict()

const extractionRetryRequestSchema = z
  .object({
    id: requestUuid,
    retryOfId: requestUuid,
    retryDocument: z.boolean().default(false),
    rediscover: z.boolean().default(false),
    // Bounded by the server-side CATALOG_RECORD_LIMIT.
    retryRecordStartBlockIds: z.array(z.string().min(1)).max(100).default([]),
    // A retry inherits its parent's pins and strategy, so they are never sent.
    sourceRepresentationRevisionId: z.never().optional(),
    schemaRevisionId: z.never().optional(),
    strategy: z.never().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      new Set(request.retryRecordStartBlockIds).size !==
      request.retryRecordStartBlockIds.length
    )
      context.addIssue({
        code: 'custom',
        path: ['retryRecordStartBlockIds'],
        message: 'Retry record identities must be unique.',
      })
  })

export const extractionRequestSchema = z.union([
  extractionFreshRequestSchema,
  extractionRetryRequestSchema,
])

export type ExtractionRequest = z.infer<typeof extractionRequestSchema>
export type ExtractionRequestInput = z.input<typeof extractionRequestSchema>

export const reviewDecisionActionSchema = z.enum([
  'APPROVED',
  'EDITED',
  'REJECTED',
])
export type ReviewDecisionAction = z.infer<
  typeof reviewDecisionActionSchema
>

const reviewDecisionShape = {
  resultPath: resultPathSchema,
  evidenceAnchorId: z.string().min(1),
  reviewedOccurrenceIds: z.array(z.string().min(1)),
  action: reviewDecisionActionSchema,
  reviewedValue: z.json().nullable(),
}

function validateReviewDecision(
  decision: {
    action: ReviewDecisionAction
    reviewedValue: unknown
  },
  context: z.RefinementCtx,
) {
  if (decision.action === 'EDITED' && decision.reviewedValue === null)
    context.addIssue({
      code: 'custom',
      path: ['reviewedValue'],
      message: 'An edited Review Decision requires a reviewed value.',
    })
  if (decision.action !== 'EDITED' && decision.reviewedValue !== null)
    context.addIssue({
      code: 'custom',
      path: ['reviewedValue'],
      message: 'Only an edited Review Decision can carry a reviewed value.',
    })
}

export const reviewDecisionInputSchema = z
  .object(reviewDecisionShape)
  .strict()
  .superRefine(validateReviewDecision)

export type ReviewDecisionInput = z.infer<typeof reviewDecisionInputSchema>

export const reviewDecisionSchema = z
  .object({
    ...reviewDecisionShape,
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine(validateReviewDecision)

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>

export const finalizeExtractionReviewSchema = z
  .object({ reviewDecisions: z.array(reviewDecisionInputSchema) })
  .strict()

export const extractionFailureSchema = z
  .object({ code: z.string().min(1), message: z.string().min(1).max(512) })
  .strict()

export type ExtractionFailure = z.infer<typeof extractionFailureSchema>

const modelCallDiagnosticsSchema = z
  .object({
    outcome: z.enum(['succeeded', 'failed']),
    finishReason: z.string().max(64).nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()

const groundingDiagnosticsSchema = z
  .object({
    groundedPaths: z.array(resultPathSchema),
    ungroundedPaths: z.array(resultPathSchema),
    issueCodes: z.array(
      z.enum([
        'missing_claim',
        'unknown_claim_label',
        'unknown_anchor_label',
        'malformed_selection',
        'grounding_failed',
      ]),
    ),
    batches: z.array(
      modelCallDiagnosticsSchema.extend({
        resultPath: resultPathSchema.nullable(),
        candidateCount: z.number().int().nonnegative(),
        fallback: z.boolean(),
      }),
    ),
  })
  .strict()

const catalogCallDiagnosticsSchema = z
  .object({
    provenance: z.enum(['executed', 'reused']),
    outcome: z.enum(['succeeded', 'failed', 'not_attempted']),
    finishReason: z.string().max(64).nullable(),
    calls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    durationMs: z.number().int().nonnegative(),
    failureCode: z.string().min(1).nullable(),
  })
  .strict()

const catalogBoundarySchema = z
  .object({
    startBlockId: z.string().min(1),
    startContentIndex: z.number().int().nonnegative(),
    endContentIndex: z.number().int().nonnegative(),
    headingText: z.string(),
    headingLevel: z.number().int().positive(),
  })
  .strict()

const catalogStageDiagnosticsSchema = catalogCallDiagnosticsSchema.extend({
  stage: z.enum(['document-values', 'discovery', 'record-values', 'grounding']),
}).strict()

const catalogRecordDiagnosticsSchema = catalogCallDiagnosticsSchema.extend({
  ordinal: z.number().int().nonnegative(),
  boundary: catalogBoundarySchema,
}).strict()

export const catalogDiagnosticsSchema = z
  .object({
    stages: z.array(catalogStageDiagnosticsSchema),
    records: z.array(catalogRecordDiagnosticsSchema),
  })
  .strict()

export type CatalogDiagnostics = z.infer<typeof catalogDiagnosticsSchema>

export const extractionDiagnosticsSchema = z
  .object({
    phase: z.enum([
      'loading',
      'extracting',
      'grounding',
      'persisting',
    ]),
    durationMs: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    finishReason: z.string().max(64).nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    grounding: groundingDiagnosticsSchema.nullable(),
    catalog: catalogDiagnosticsSchema.nullable(),
    retry: extractionRetrySelectionSchema.nullable(),
  })
  .strict()

export type ExtractionDiagnostics = z.infer<typeof extractionDiagnosticsSchema>

const modelTargetAttributionSchema = z
  .object({ provider: providerKindSchema, modelId: z.string().min(1) })
  .strict()

export const extractionModelAttributionSchema = modelTargetAttributionSchema

export type ExtractionModelAttribution = z.infer<
  typeof extractionModelAttributionSchema
>

export const extractionAttemptSchema = z
  .object({
    extractionId: z.uuid(),
    sourceDocumentId: z.uuid(),
    sourceRepresentationRevisionId: z.uuid(),
    schemaRevisionId: z.uuid(),
    strategy: extractionStrategySchema,
    executionStatus: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']),
    outcome: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']).nullable(),
    complete: z.boolean().nullable(),
    modelAttribution: extractionModelAttributionSchema.nullable(),
    diagnostics: extractionDiagnosticsSchema.nullable(),
    failure: extractionFailureSchema.nullable(),
    resultPayload: z.record(z.string(), z.json()).nullable(),
    evidenceLinks: z.array(evidenceLinkSchema).nullable(),
    reviewable: z.boolean(),
    retryOfId: z.uuid().nullable(),
    batchExtractionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    reviewedAt: z.iso.datetime().nullable(),
    reviewDecisions: z.array(reviewDecisionSchema),
  })
  .strict()
  .superRefine((attempt, context) => {
    const completed = attempt.executionStatus === 'COMPLETED'
    const terminalShape = completed && attempt.diagnostics !== null && (
      attempt.outcome === 'SUCCEEDED'
        ? attempt.complete !== null && attempt.modelAttribution !== null &&
          attempt.failure === null && attempt.resultPayload !== null &&
          attempt.evidenceLinks !== null
        : (attempt.outcome === 'FAILED' || attempt.outcome === 'CANCELLED') &&
          attempt.complete === null && attempt.resultPayload === null &&
          attempt.evidenceLinks === null && !attempt.reviewable &&
          attempt.reviewedAt === null && attempt.reviewDecisions.length === 0 &&
          (attempt.outcome === 'FAILED' ? attempt.failure !== null : attempt.failure === null)
    )
    const checkpointFields = [
      attempt.complete,
      attempt.modelAttribution,
      attempt.diagnostics,
      attempt.resultPayload,
    ]
    const checkpointed = checkpointFields.every((value) => value !== null)
    const emptyCheckpoint = checkpointFields.every((value) => value === null)
    const jobShape = !completed && attempt.outcome === null &&
      attempt.evidenceLinks === null && !attempt.reviewable &&
      attempt.reviewedAt === null && attempt.reviewDecisions.length === 0 &&
      (checkpointed || emptyCheckpoint) &&
      (attempt.executionStatus === 'FAILED'
        ? attempt.failure !== null
        : attempt.failure === null)
    if (!terminalShape && !jobShape)
      context.addIssue({
        code: 'custom',
        message: 'Extraction fields do not match the execution state.',
      })

    if (
      attempt.diagnostics &&
      ((attempt.strategy === 'ARTICLE' && attempt.diagnostics.catalog != null) ||
      (attempt.strategy === 'CATALOG' && attempt.diagnostics.catalog == null))
    )
      context.addIssue({
        code: 'custom',
        message: 'Catalog diagnostics must match the Extraction strategy.',
      })

    if (
      attempt.resultPayload &&
      attempt.evidenceLinks &&
      !evidenceLinksHaveUniqueScalarPaths(
        attempt.resultPayload,
        attempt.evidenceLinks,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Evidence Links must identify unique populated scalar paths.',
      })

    const evidence = attempt.evidenceLinks ?? []
    const cited = new Map(
      evidence.map((link) => [JSON.stringify(link.resultPath), link.evidenceAnchorId]),
    )
    const reviewed = new Map(
      attempt.reviewDecisions.map((decision) => [
        JSON.stringify(decision.resultPath),
        decision.evidenceAnchorId,
      ]),
    )
    if (
      cited.size !== evidence.length ||
      reviewed.size !== attempt.reviewDecisions.length ||
      (attempt.reviewedAt === null && reviewed.size > 0) ||
      (attempt.reviewedAt !== null &&
        (attempt.outcome !== 'SUCCEEDED' ||
          !attempt.reviewable ||
          cited.size !== reviewed.size ||
          [...cited].some(([path, anchorId]) => reviewed.get(path) !== anchorId)))
    )
      context.addIssue({
        code: 'custom',
        message: 'Review Decisions do not cover the stored Evidence Anchors.',
      })
  })

export type ExtractionAttempt = z.infer<typeof extractionAttemptSchema>

/**
 * One stored Extraction, read back with the Review Decisions its stored
 * Evidence requires. The decisions are derived from the pinned Source
 * Representation, so the browser never needs the parsed document to review.
 */
export const extractionReadResponseSchema = z
  .object({
    extraction: extractionAttemptSchema,
    pendingReviewDecisions: z.array(reviewDecisionInputSchema).nullable(),
  })
  .strict()
