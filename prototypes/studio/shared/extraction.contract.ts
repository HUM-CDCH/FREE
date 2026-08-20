import { z } from 'zod'
import {
  evidenceLinkSchema,
  evidenceLinksHaveUniqueScalarPaths,
  resultPathSchema,
} from './groundedExtraction.js'
import { providerKindSchema } from './modelConfig.contract.js'

export const extractionStrategySchema = z.literal('ARTICLE')
export type ExtractionStrategy = z.infer<typeof extractionStrategySchema>

export const extractionRequestSchema = z
  .object({
    id: z.uuid(),
    sourceRepresentationRevisionId: z.uuid(),
    schemaRevisionId: z.uuid(),
    strategy: extractionStrategySchema,
  })
  .strict()

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
    reviewDecisions: z.array(reviewDecisionInputSchema),
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
