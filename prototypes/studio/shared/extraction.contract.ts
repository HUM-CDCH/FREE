import { z } from 'zod'
import { nativeFieldsSchema } from 'extraction/native-fields'
import {
  activeSettingsSchema,
  articleSettingsIssues,
  extractionMethodIntentSchema,
  settingsFit,
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
    /** The page the researcher was reading when Run was clicked (one-based): the order kei reads records in, never
     *  which records. Absent when the view names none. */
    startPage: z.number().int().positive().optional(),
  })
  .strict()
  .refine((request) => request.catalogRecipe === undefined || request.strategy === 'CATALOG', {
    path: ['catalogRecipe'],
    message: 'A recipe applies to a Catalog Extraction only.',
  })
  .refine((request) => settingsFit(request.strategy, request.catalogRecipe ?? null, request.method.settings), {
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
  evidenceAnchorId: z.string().min(1).nullable(),
  reviewedOccurrenceIds: z.array(z.string().min(1)),
  action: reviewDecisionActionSchema,
  reviewedValue: z.json().nullable(),
  /** A correction's own Evidence: the published passage its value is printed in; absent when none was found. */
  reviewedEvidence: z.array(z.object({
    evidenceAnchorId: z.string().min(1), reviewedOccurrenceIds: z.array(z.string().min(1)),
  }).strict()).nullable().optional(),
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

/** The Parsing Service's claim accounting, derived on read from the stored evidence, ungrounded paths, issues and
 *  policy-skipped paths (`packages/extraction` `claimAccounting`): every claim once, in one of four verifier states. */
export const claimAccountingSchema = z
  .object({
    claims: z.number().int().nonnegative(), excluded: z.number().int().nonnegative(), eligible: z.number().int().nonnegative(),
    supported: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative(), notCompleted: z.number().int().nonnegative(),
    reasons: z.record(z.string(), z.number().int().nonnegative()),
    excludedPolicies: z.record(z.string(), z.number().int().nonnegative()),
    unfinished: z.array(z.object({ resultPath: resultPathSchema, reasons: z.array(z.string()).min(1) }).strict()),
  })
  .strict()
export type ClaimAccounting = z.infer<typeof claimAccountingSchema>

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
    claims: claimAccountingSchema.nullable(),
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

const count = z.number().int().nonnegative()
const candidatePathSchema = z.array(z.union([z.string(), z.number().int().nonnegative(), z.null()]))
const unifiedCandidateSchema = z
  .object({
    path: candidatePathSchema, value: z.json(), quote: z.string().nullable(), support: z.enum(['literal', 'supporting']).nullable(),
    spans: z.array(textSpanSchema), alternatives: z.array(z.array(textSpanSchema)), window: count, reason: z.string().nullable(),
    raw: z.string().nullable(), item: z.object({ window: count, index: count }).strict().nullable(),
  })
  .strict()

/** The unified Catalog's review material (version 3): the method it ran under, the source ranges it could not settle
 *  or was not given, each stage's processing, and every proposal, rejection, conflict and uncertain list item. Source
 *  accounting, processing and evidence stay apart; recall is not measured. */
export const unifiedDiagnosticsSchema = z
  .object({
    nativeFields: nativeFieldsSchema.optional(),
    method: z.object({ requested: z.record(z.string(), z.json()), effective: z.record(z.string(), z.json()) }).strict(),
    records: z.object({ execution: z.string(), discovery: z.string() }).strict(),
    entries: count,
    unsettledEntries: z.array(z.object({ id: z.string(), label: z.string().nullable(), end: z.enum(['unresolved', 'beyond_scope']) }).strict()),
    // Entries the supplied source ends inside: settled, shown apart. Absent from results settled before it existed.
    sourceEndEntries: z.array(z.object({ id: z.string(), label: z.string().nullable() }).strict()).optional(),
    unresolved: z.array(textSpanSchema),
    withheld: z.array(textSpanSchema),
    processing: z.object({
      discovery: z.object({ windows: count, failed: count }).strict(),
      entries: z.object({ entries: count, windows: count, failed: count }).strict(),
      verification: z.object({ enabled: z.boolean(), undecided: count }).strict(),
      document: z.object({ applicable: z.boolean(), windows: count, failed: count }).strict(),
    }).strict(),
    completeness: z.object({
      accounting: z.boolean(), boundaries: z.boolean(), processing: z.boolean(), evidence: z.boolean(), recall: z.literal('unmeasured'),
    }).strict(),
    proposed: z.array(unifiedCandidateSchema),
    rejected: z.array(unifiedCandidateSchema),
    competitors: z.array(z.record(z.string(), z.json())),
    items: z.array(z.object({ path: resultPathSchema, observed: count, resolved: count, partial: count }).strict()),
    document: z.object({
      status: z.literal('unverified'), applicable: z.boolean(), candidates: z.array(unifiedCandidateSchema),
      conflicts: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), candidates: z.array(z.json()) }).strict()),
    }).strict(),
    contextOmitted: z.array(textSpanSchema.extend({
      stage: z.string(), record: z.number().int().nullable(), kind: z.enum(['heading', 'before', 'after']),
    }).strict()),
  })
  .strict()

export type UnifiedDiagnostics = z.infer<typeof unifiedDiagnosticsSchema>

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
    unified: unifiedDiagnosticsSchema.nullable().optional(),
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
    durable: z.literal(true).optional(),
    finalizedReview: z.object({snapshotVersion:z.number().int().positive(),feedbackVersion:z.number().int().nonnegative(),createdAt:z.iso.datetime()}).strict().nullable().optional(),
    executionStatus: z.enum(['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING', 'STOPPED', 'COMPLETED', 'FAILED']),
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
    const shape = attempt.durable ? empty :
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
          cited.size > reviewed.size ||
          [...cited].some(([path, anchorId]) => reviewed.get(path) !== anchorId)))
    )
      context.addIssue({
        code: 'custom',
        message: 'Review Decisions do not cover the stored Evidence Anchors.',
      })
  })

export type ExtractionAttempt = z.infer<typeof extractionAttemptSchema>

/** One value of a record still being read (design §1): grounded once its link exists, checking while it is a
 *  candidate, reading while the call that would answer it is in flight or failed, empty when that call succeeded
 *  without it, contested when verified values disagreed and arbitration chose none (its candidates beside it). */
export const partialValueStateSchema = z.enum(['grounded', 'checking', 'reading', 'empty', 'contested'])
export type PartialValueState = z.infer<typeof partialValueStateSchema>
export const partialValueSchema = z
  .object({ value: z.json(), state: partialValueStateSchema, candidates: z.array(z.json()).optional() })
  .strict()
export type PartialValue = z.infer<typeof partialValueSchema>

export const partialRecordSchema = z
  .object({
    index: z.number().int().nonnegative(),
    label: z.string().nullable(),
    page: z.number().int().positive().nullable(),
    /** queued: discovered, not read yet; reading: its values call is in flight; checking: candidates under
     *  verification; finished: kei published the entry. */
    state: z.enum(['queued', 'reading', 'checking', 'finished']),
    /** The values so far, in the artifact's shape; null before the values call returned. */
    record: z.record(z.string(), z.json()).nullable(),
    /** Each leaf of `record` by its record-relative path (every step a string, JSON-encoded), with its state. */
    values: z.record(z.string(), partialValueSchema),
    evidenceLinks: z.array(evidenceLinkSchema),
  })
  .strict()
export type PartialRecord = z.infer<typeof partialRecordSchema>

/** A running Extraction's partial view (design §5): a view of files kei already wrote, never the record of truth.
 *  Records are in the order they were read: nearest the start page first, then source order. */
export const partialResultSchema = z
  .object({
    strategy: extractionStrategySchema,
    startedAtPage: z.number().int().positive().nullable(),
    discovered: z.number().int().nonnegative(),
    finished: z.number().int().nonnegative(),
    records: z.array(partialRecordSchema),
    document: z
      .object({
        contextsAnswered: z.number().int().nonnegative(),
        contexts: z.number().int().nonnegative(),
        groundingBatches: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict()
export type PartialResult = z.infer<typeof partialResultSchema>

/**
 * One stored Extraction, read back with the Review Decisions its stored
 * Evidence requires. The decisions are derived from the pinned Source
 * Representation, so the browser never needs the parsed document to review.
 */
export const extractionReadResponseSchema = z
  .object({
    extraction: extractionAttemptSchema,
    pendingReviewDecisions: z.array(reviewDecisionInputSchema).nullable(),
    /** The partial view while the attempt is RUNNING; null otherwise (absent in older stubs: read it as null). */
    partial: partialResultSchema.nullable().optional(),
    reviewDraft: z.object({
      version: z.number().int().nonnegative(),
      decisions: z.array(reviewDecisionInputSchema),
      attention: z.object({
        cells: z.array(z.object({ nodeId: z.string(), resultPath: resultPathSchema, presence: z.enum(['grounded', 'ungrounded', 'missing']),
          decision: z.object({ action: reviewDecisionActionSchema }).nullable() })),
        grounded: z.int().nonnegative(), ungrounded: z.int().nonnegative(), missing: z.int().nonnegative(), requiredRemaining: z.int().nonnegative(),
      }).optional(),
      // Drafted while the Extraction ran, not kept at settlement (results review redesign §5.3).
      dropped: z.array(z.object({ resultPath: resultPathSchema, evidenceAnchorId: z.string().min(1).nullable() }).strict()).optional(),
    }).strict().optional(),
  })
  .strict()

export const extractionReviewDraftSchema = z.object({
  version: z.number().int().nonnegative(),
  decisions: z.array(reviewDecisionInputSchema),
}).strict()

export const resetExtractionReviewSchema = z.object({
  expectedDraftVersion: z.number().int().nonnegative(),
}).strict()
