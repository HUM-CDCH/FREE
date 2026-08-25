import { z } from 'zod'
import {
  evidenceLinkSchema,
  evidenceLinksHaveUniqueScalarPaths,
  resultPathSchema,
} from './groundedExtraction.js'
import { providerKindSchema } from './modelConfig.contract.js'

export const extractionStrategySchema = z.enum(['ARTICLE', 'CATALOG'])
export type ExtractionStrategy = z.infer<typeof extractionStrategySchema>

export const extractionRetrySelectionSchema = z
  .object({
    retryOfId: z.uuid(),
    retryDocument: z.boolean(),
    rediscover: z.boolean(),
    retryRecordStartBlockIds: z.array(z.string().min(1)),
  })
  .strict()

export type ExtractionRetrySelection = z.infer<
  typeof extractionRetrySelectionSchema
>

const retryFields = {
  retryDocument: z.boolean().default(false),
  rediscover: z.boolean().default(false),
  retryRecordStartBlockIds: z
    .array(z.string().min(1))
    .max(100)
    .default([]),
} as const

const extractionFreshRequestSchema = z
  .object({
    id: z.uuid(),
    sourceRepresentationRevisionId: z.uuid(),
    schemaRevisionId: z.uuid(),
    strategy: extractionStrategySchema,
    /** Set when this Extraction is one member of a Batch Extraction. */
    batchExtractionId: z.uuid().nullable().default(null),
    retryOfId: z.never().optional(),
    retryDocument: z.never().optional(),
    rediscover: z.never().optional(),
    retryRecordStartBlockIds: z.never().optional(),
  })
  .strict()
  .transform((request) => ({
    ...request,
    retryOfId: null,
    retryDocument: false,
    rediscover: false,
    retryRecordStartBlockIds: [],
  }))

const extractionRetryRequestSchema = z
  .object({
    id: z.uuid(),
    retryOfId: z.uuid(),
    ...retryFields,
    // A retry inherits its parent's Batch Extraction, so it is never sent.
    batchExtractionId: z.never().optional(),
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

export const reviewDecisionInputSchema = z
  .object({
    evidenceAnchorId: z.string().min(1),
    reviewedOccurrenceIds: z.array(z.string().min(1)),
  })
  .strict()

export type ReviewDecisionInput = z.infer<typeof reviewDecisionInputSchema>

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
    provenance: z.enum(['executed', 'reused']).default('executed'),
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
    ]),
    durationMs: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    finishReason: z.string().max(64).nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    values: modelCallDiagnosticsSchema.nullable(),
    grounding: groundingDiagnosticsSchema.nullable(),
    catalog: catalogDiagnosticsSchema.nullable().default(null),
    retry: extractionRetrySelectionSchema.nullable().optional(),
  })
  .strict()

export type ExtractionDiagnostics = z.input<typeof extractionDiagnosticsSchema>

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
    outcome: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']),
    complete: z.boolean().nullable(),
    modelAttribution: extractionModelAttributionSchema.nullable(),
    diagnostics: extractionDiagnosticsSchema,
    failure: extractionFailureSchema.nullable(),
    resultPayload: z.record(z.string(), z.json()).nullable(),
    evidenceLinks: z.array(evidenceLinkSchema).nullable(),
    reviewable: z.boolean(),
    retryOfId: z.uuid().nullable(),
    batchExtractionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    reviewedAt: z.iso.datetime().nullable(),
    reviewDecisions: z.array(
      reviewDecisionInputSchema.extend({ reviewDecisionId: z.uuid() }).strict(),
    ),
  })
  .strict()
  .superRefine((attempt, context) => {
    const terminalShape =
      attempt.outcome === 'SUCCEEDED'
        ? attempt.complete !== null &&
          attempt.modelAttribution !== null &&
          attempt.failure === null &&
          attempt.resultPayload !== null &&
          attempt.evidenceLinks !== null
        : attempt.complete === null &&
          attempt.resultPayload === null &&
          attempt.evidenceLinks === null &&
          !attempt.reviewable &&
          attempt.reviewedAt === null &&
          attempt.reviewDecisions.length === 0 &&
          (attempt.outcome === 'FAILED'
            ? attempt.failure !== null
            : attempt.failure === null)
    if (!terminalShape)
      context.addIssue({
        code: 'custom',
        message: 'Extraction terminal fields do not match the outcome.',
      })

    if (
      (attempt.strategy === 'ARTICLE' && attempt.diagnostics.catalog !== null) ||
      (attempt.strategy === 'CATALOG' && attempt.diagnostics.catalog === null)
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

    const cited = new Set(
      attempt.evidenceLinks?.map((link) => link.evidenceAnchorId) ?? [],
    )
    const reviewed = new Set(
      attempt.reviewDecisions.map((decision) => decision.evidenceAnchorId),
    )
    if (
      (attempt.reviewedAt === null && reviewed.size > 0) ||
      (attempt.reviewedAt !== null &&
        (attempt.outcome !== 'SUCCEEDED' ||
          !attempt.reviewable ||
          cited.size !== reviewed.size ||
          [...cited].some((anchorId) => !reviewed.has(anchorId))))
    )
      context.addIssue({
        code: 'custom',
        message: 'Review Decisions do not cover the stored Evidence Anchors.',
      })
  })

export type ExtractionAttempt = z.input<typeof extractionAttemptSchema>

/**
 * One stored Extraction, read back with the Review Decisions its stored
 * Evidence requires. The decisions are derived from the pinned Source
 * Representation, so the browser never needs the parsed document to review.
 */
export const extractionReadResponseSchema = z
  .object({
    extraction: extractionAttemptSchema,
    pendingReviewDecisions: z.array(reviewDecisionInputSchema),
  })
  .strict()

type ExtractionIdentity = {
  sourceRepresentationRevisionId?: string
  schemaRevisionId?: string
  strategy?: ExtractionStrategy
  retryOfId?: string | null
  batchExtractionId?: string | null
}

export function sameExtractionIdentity(
  attempt: ExtractionIdentity,
  request: ExtractionIdentity,
): boolean {
  return (
    (request.sourceRepresentationRevisionId === undefined ||
      attempt.sourceRepresentationRevisionId ===
        request.sourceRepresentationRevisionId) &&
    (request.schemaRevisionId === undefined ||
      attempt.schemaRevisionId === request.schemaRevisionId) &&
    (request.strategy === undefined || attempt.strategy === request.strategy) &&
    (request.batchExtractionId === undefined ||
      attempt.batchExtractionId === request.batchExtractionId) &&
    attempt.retryOfId === request.retryOfId
  )
}
