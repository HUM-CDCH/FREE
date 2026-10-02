import { z } from 'zod'
import {
  activeSettingsSchema,
  articleSettingsIssues,
  extractionMethodIntentSchema,
  settingsSlot,
  type ArticleSettings,
} from 'extraction/extraction-method'
import {
  evidenceLinkSchema,
  evidenceLinksHaveUniqueScalarPaths,
  resultPathSchema,
  textSpanSchema,
} from './groundedExtraction.js'
import {
  extractionModelChoiceSchema,
  extractionModelKeySchema,
  providerKindSchema,
} from './modelConfig.contract.js'

export { extractionModelChoiceSchema, type ExtractionModelChoice } from './modelConfig.contract.js'

export const extractionStrategySchema = z.enum(['ARTICLE', 'CATALOG'])
export type ExtractionStrategy = z.infer<typeof extractionStrategySchema>

/** Durable failure code for Catalog records skipped by the record limit. */
export const CATALOG_NOT_ATTEMPTED_LIMIT = 'not_attempted_limit'

const requestUuid = z.uuid().transform((value) => value.toLowerCase())

/** A numbered-catalogue recipe reference (`id@version`), chosen per Catalog Extraction; kei-exp owns the recipes. */
export const catalogRecipeSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/)

/** The two roles an Extraction's model calls split into: `fields` reads values off the source, `reasoning` decides over
 *  labelled text (record starts, grounding, arbitration). kei-exp routes each role to one of its deployment's models. */
export const extractionModelRoleSchema = z.enum(['fields', 'reasoning'])
export type ExtractionModelRole = z.infer<typeof extractionModelRoleSchema>

/** The model (its served repo id) each role actually ran on, as kei-exp reports it in the artifact. */
export const extractionModelsUsedSchema = z
  .object({ fields: z.string().min(1), reasoning: z.string().min(1) })
  .strict()

/** kei-exp's `GET /api/extraction-models`: the deployment's extraction models, the roles each may take and whether its
 *  server serves it now, and the default key per role. */
export const extractionModelListingSchema = z
  .object({
    defaults: z.object({ fields: extractionModelKeySchema, reasoning: extractionModelKeySchema }).strict(),
    models: z.array(
      z
        .object({
          key: extractionModelKeySchema,
          repo: z.string().min(1),
          roles: z.array(extractionModelRoleSchema),
          reachable: z.boolean(),
          serving: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
export type ExtractionModelListing = z.infer<typeof extractionModelListingSchema>

export const extractionRequestSchema = z
  .object({
    id: requestUuid,
    sourceRepresentationRevisionId: requestUuid,
    schemaRevisionId: requestUuid,
    strategy: extractionStrategySchema,
    catalogRecipe: catalogRecipeSchema.optional(),
    /** The saved method the start view showed: the Extraction Model Choice and this strategy's settings. Admission
     *  refuses it when the account's saved method changed since, and pins it otherwise. */
    method: extractionMethodIntentSchema,
  })
  .strict()
  .refine((request) => request.catalogRecipe === undefined || request.strategy === 'CATALOG', {
    path: ['catalogRecipe'],
    message: 'A recipe applies to a Catalog Extraction only.',
  })
  .refine((request) => settingsSlot(request.strategy, request.catalogRecipe ?? null) in request.method.settings, {
    path: ['method', 'settings'],
    message: 'The saved settings do not match this Extraction Strategy.',
  })
  .superRefine(methodRuleIssues)

/** A direct request gets the same field-addressed refusals as the Advanced tab (design §3): the contract's own rules. */
export function methodRuleIssues(request: { method: z.output<typeof extractionMethodIntentSchema> }, context: z.RefinementCtx): void {
  const settings = request.method.settings
  const article: ArticleSettings | null = 'article' in settings ? settings.article : null
  if (!article) return
  for (const issue of articleSettingsIssues(article))
    context.addIssue({ code: 'custom', path: ['method', 'settings', 'article', issue.path], message: issue.message })
}

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
  .object({ reviewDecisions: z.array(reviewDecisionInputSchema), expectedDraftVersion: z.number().int().nonnegative().default(0) })
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
    issueCodes: z.array(z.string()),
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
    headingLevel: z.number().int().positive().nullable(),
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

const reviewCandidateSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number().int().nonnegative(), z.null()])),
    value: z.json(),
    quote: z.string().nullable(),
    key: z.string().nullable(),
    provenance: z.string().nullable(),
    spans: z.array(textSpanSchema),
    alternatives: z.array(z.array(textSpanSchema)),
    window: z.number().int().nonnegative(),
    reason: z.string().optional(),
    raw: z.string().optional(),
  })
  .strict()

/** The recipe path's review material: proposals and rejections kept outside the accepted result, competitors, the
 *  segmentation's source coverage and the separated completeness. No confidence number is derived from any of it. */
export const groundedDiagnosticsSchema = z
  .object({
    recipe: catalogRecipeSchema,
    segmentationFingerprint: z.string(),
    budget: z
      .object({
        inputTokens: z.number().int().positive(),
        outputTokens: z.number().int().positive(),
        tokenizer: z.record(z.string(), z.json()),
      })
      .strict(),
    segmentationDiagnostics: z.array(
      z
        .object({ code: z.string(), detail: z.string(), block: z.string().nullable(), spans: z.array(textSpanSchema) })
        .strict(),
    ),
    normalization: z
      .object({ version: z.number().int().positive(), rules: z.array(z.literal('glossary')) })
      .strict(),
    recordBlocks: z.array(z.object({ block: z.string(), entry_label: z.string() }).strict()),
    proposed: z.array(reviewCandidateSchema),
    rejected: z.array(reviewCandidateSchema),
    competitors: z.array(z.record(z.string(), z.json())),
    coverage: z.record(z.string(), z.json()),
    completeness: z
      .object({
        processing: z.boolean(),
        coverage: z.boolean(),
        grounding: z.boolean(),
        recall: z.literal('unmeasured'),
      })
      .strict(),
  })
  .strict()

export type GroundedDiagnostics = z.infer<typeof groundedDiagnosticsSchema>

/** What kei-exp recorded running: its dumped options, and the prompt, method and protocol versions it reports. */
const effectiveMethodSchema = z
  .object({ options: z.record(z.string(), z.json()), versions: z.record(z.string(), z.number().int()) })
  .strict()

/** Schema-policy verification's accounting: all and eligible record leaves apart, and each policy-skipped value. */
const groundingEligibilitySchema = z
  .object({
    allRecordLeaves: z.number().int().nonnegative(),
    eligibleRecordLeaves: z.number().int().nonnegative(),
    skipped: z.array(z.object({ resultPath: resultPathSchema, policy: z.enum(['derived', 'unverified']) }).strict()),
    eligibleGrounding: z.enum(['complete', 'partial', 'not_applicable']),
  })
  .strict()

/** The quote or exact source span (code-point offsets into its segment) an accepted Article link was verified with. */
const supportProofSchema = z
  .object({
    resultPath: resultPathSchema, segment: z.string(), cell: z.string().nullable(), quote: z.string(), attribution: z.string(),
    span: z.string().optional(), start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional(),
  })
  .strict()

/** One unresolved scalar conflict: its absolute result path and the disagreeing candidate values, nothing more. */
export const contestedValueSchema = z
  .object({ resultPath: resultPathSchema, candidates: z.array(z.json()) })
  .strict()

export type ContestedValue = z.infer<typeof contestedValueSchema>

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
    grounded: groundedDiagnosticsSchema.nullable().optional(),
    /** The model each role ran on, as kei-exp resolved the run's choice over its deployment defaults. */
    models: extractionModelsUsedSchema.nullable().optional(),
    effectiveMethod: effectiveMethodSchema.nullable().optional(),
    eligibility: groundingEligibilitySchema.nullable().optional(),
    support: z.array(supportProofSchema).nullable().optional(),
    /** Values the service left empty because their sources disagreed (absent when none): not documented absence. */
    contested: z.array(contestedValueSchema).optional(),
  })
  .strict()

export type ExtractionDiagnostics = z.infer<typeof extractionDiagnosticsSchema>

const modelTargetAttributionSchema = z
  .object({ provider: z.union([providerKindSchema, z.literal('kei-exp')]), modelId: z.string().min(1) })
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
    /** The numbered-catalogue recipe a Catalog Extraction ran with; null for generic Catalog and for Article. */
    catalogRecipe: catalogRecipeSchema.nullable(),
    /** The run's Extraction Model Choice as requested; null when every role kept kei-exp's deployment default. */
    requestedModels: extractionModelChoiceSchema.nullable().optional(),
    /** The settings admitted with the run; null when it predates recorded settings ("Not recorded"). */
    requestedSettings: activeSettingsSchema.nullable().optional(),
    executionStatus: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']),
    /** SUCCEEDED once COMPLETED; a failed, cancelled or interrupted Extraction is FAILED with its failure instead. */
    outcome: z.literal('SUCCEEDED').nullable(),
    complete: z.boolean().nullable(),
    modelAttribution: extractionModelAttributionSchema.nullable(),
    diagnostics: extractionDiagnosticsSchema.nullable(),
    failure: extractionFailureSchema.nullable(),
    resultPayload: z.record(z.string(), z.json()).nullable(),
    evidenceLinks: z.array(evidenceLinkSchema).nullable(),
    reviewable: z.boolean(),
    batchExtractionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    reviewedAt: z.iso.datetime().nullable(),
    reviewDecisions: z.array(reviewDecisionSchema),
  })
  .strict()
  .superRefine((attempt, context) => {
    const empty = attempt.complete === null && attempt.modelAttribution === null && attempt.diagnostics === null &&
      attempt.resultPayload === null && attempt.evidenceLinks === null && !attempt.reviewable &&
      attempt.reviewedAt === null && attempt.reviewDecisions.length === 0
    const shape =
      attempt.executionStatus === 'COMPLETED'
        // A succeeded Extraction: its result, evidence and diagnostics, and no failure.
        ? attempt.outcome === 'SUCCEEDED' && attempt.diagnostics !== null && attempt.complete !== null &&
          attempt.modelAttribution !== null && attempt.failure === null && attempt.resultPayload !== null &&
          attempt.evidenceLinks !== null
        // Queued, running, failed, cancelled or interrupted: no outcome on the wire and no result; a failure exactly
        // when FAILED.
        : attempt.outcome === null && empty && (attempt.executionStatus === 'FAILED') === (attempt.failure !== null)
    if (!shape) context.addIssue({ code: 'custom', message: 'Extraction fields do not match the execution state.' })
    if (attempt.catalogRecipe !== null && attempt.strategy !== 'CATALOG')
      context.addIssue({ code: 'custom', path: ['catalogRecipe'], message: 'A recipe applies to a Catalog Extraction only.' })

    if (
      attempt.strategy === 'ARTICLE' && attempt.diagnostics?.catalog != null
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
    reviewDraft: z.object({ version: z.number().int().nonnegative(), decisions: z.array(reviewDecisionInputSchema) }).strict().optional(),
  })
  .strict()

export const extractionReviewDraftSchema = z.object({
  version: z.number().int().nonnegative(),
  decisions: z.array(reviewDecisionInputSchema),
}).strict()

export const resetExtractionReviewSchema = z.object({
  expectedDraftVersion: z.number().int().nonnegative(),
}).strict()
