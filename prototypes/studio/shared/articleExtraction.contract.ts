import { z } from 'zod'
import {
  evidenceLinkSchema,
  evidenceLinksHaveUniqueScalarPaths,
  resultPathSchema,
} from './groundedExtraction.js'
import { providerKindSchema } from './modelConfig.contract.js'

export const articleExtractionRequestSchema = z
  .object({
    id: z.uuid(),
    sourceRepresentationRevisionId: z.uuid(),
    schemaRevisionId: z.uuid(),
    strategy: z.literal('ARTICLE'),
  })
  .strict()

export type ArticleExtractionRequest = z.infer<
  typeof articleExtractionRequestSchema
>

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

export const extractionDiagnosticsSchema = z
  .object({
    phase: z.enum(['loading', 'extracting', 'grounding', 'persisting']),
    durationMs: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    finishReason: z.string().max(64).nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    grounding: z
      .object({
        groundedPaths: z.array(resultPathSchema),
        ungroundedPaths: z.array(resultPathSchema),
        issueCodes: z.array(
          z.enum([
            'missing_claim',
            'unknown_claim_label',
            'unknown_anchor_label',
            'malformed_selection',
            'conflicting_anchor_selection',
            'grounding_failed',
          ]),
        ),
        batches: z.array(
          z
            .object({
              resultPath: resultPathSchema.nullable(),
              candidateCount: z.number().int().nonnegative(),
              fallback: z.boolean(),
              finishReason: z.string().max(64).nullable(),
              inputTokens: z.number().int().nonnegative().nullable(),
              outputTokens: z.number().int().nonnegative().nullable(),
              durationMs: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
  })
  .strict()

export type ExtractionDiagnostics = z.infer<
  typeof extractionDiagnosticsSchema
>

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
    strategy: z.literal('ARTICLE'),
    outcome: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']),
    complete: z.boolean().nullable(),
    modelAttribution: extractionModelAttributionSchema.nullable(),
    diagnostics: extractionDiagnosticsSchema,
    failure: extractionFailureSchema.nullable(),
    resultPayload: z.record(z.string(), z.json()).nullable(),
    evidenceLinks: z.array(evidenceLinkSchema).nullable(),
    reviewable: z.boolean(),
    retryOfId: z.uuid().nullable(),
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

export type ExtractionAttempt = z.infer<typeof extractionAttemptSchema>

export function sameExtractionIdentity(
  attempt: Pick<
    ExtractionAttempt,
    | 'sourceRepresentationRevisionId'
    | 'schemaRevisionId'
    | 'strategy'
  >,
  request: ArticleExtractionRequest,
): boolean {
  return (
    attempt.sourceRepresentationRevisionId ===
      request.sourceRepresentationRevisionId &&
    attempt.schemaRevisionId === request.schemaRevisionId &&
    attempt.strategy === request.strategy
  )
}

export function normalizeReviewDecisions(
  decisions: readonly ReviewDecisionInput[],
): ReviewDecisionInput[] {
  return decisions
    .map((decision) => ({
      evidenceAnchorId: decision.evidenceAnchorId,
      reviewedOccurrenceIds: [...new Set(decision.reviewedOccurrenceIds)].sort(),
    }))
    .sort((left, right) =>
      left.evidenceAnchorId.localeCompare(right.evidenceAnchorId),
    )
}
