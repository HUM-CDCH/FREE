import type { ContestedValue } from './contested-values.js'
import type { UnifiedDiagnostics } from './kei-artifact.js'
export type ExtractionStrategy = 'ARTICLE' | 'CATALOG'
export type ExtractionOutcome = 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
export type ExtractionDisposition = 'created' | 'replayed'
export type BatchDisposition = 'created' | 'replayed'
export type BatchRepetition = 'reuse-equal-selection' | 'create-new'
export type ProjectOperationStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'

export type ScalarFieldType = SchemaScalarFieldType
export type ExtractionSchemaNode = SchemaNode

export type ResultPath = readonly (string | number)[]

export type EvidenceLink = Readonly<{
  resultPath: ResultPath
  evidenceAnchorId: string
  precision?: 'cell' | 'segment' | 'input'
  /** The value occurs as a bounded token in the linked anchor. Absent on
   *  boolean values and on links stored before this check existed. */
  verbatim?: boolean
  /** Candidate anchors containing the value; above one, the passage is
   *  ambiguous. A reviewer's doubt, not a probability; never auto-accept. */
  lexicalHits?: number
  /** How the link was made when not by the grounder: the values call cited
   *  the block and code found the value in it, or code found the value in
   *  exactly one candidate. Absent means the grounder chose the anchor. */
  linkedBy?: 'citation_lexical' | 'lexical'
  /** Version 2 (recipe Catalog) evidence: code-point spans of the value in its canonical segment, the key that
   *  introduced it or the heading it was inherited from, and the precision its box can claim. Version 3 (unified
   *  Catalog): the verified value's literal span or supporting passage. Absent on version 1. */
  grounding?: EvidenceGrounding | VerifiedGrounding
}>

export type TextSpan = Readonly<{ segment: string; start: number; end: number }>

export type EvidenceGrounding = Readonly<{
  linkedBy: 'key' | 'structure'
  provenance: 'token' | 'positional' | 'inherited'
  textSpans: readonly TextSpan[]
  keySpans: readonly TextSpan[]
  alternatives: readonly (readonly TextSpan[])[]
  heading: string | null
  precision: 'cell' | 'segment' | 'input'
  raw: string
  /** The document's own glossary expansion of `raw`, with both glossary spans; the record keeps the raw value. */
  normalized: Readonly<{ value: string; rule: 'glossary'; keySpan: TextSpan; expansionSpan: TextSpan }> | null
}>

/** Version 3 evidence: a separate verification request accepted the value; `literal` spans print the value itself,
 *  `supporting` spans are the passage that supports a yes/no, a label or a derived value. `itemSpans` locate the list
 *  item the value belongs to. */
export type VerifiedGrounding = Readonly<{
  linkedBy: 'verification'
  support: 'literal' | 'supporting'
  textSpans: readonly TextSpan[]
  alternatives: readonly (readonly TextSpan[])[]
  precision: 'cell' | 'segment' | 'input'
  raw: string
  itemSpans: readonly TextSpan[] | null
}>

/** A candidate the recipe path kept for review rather than accepting: proposed (quote-supported, no rule ties it to
 *  its field) or rejected (a check failed, with the reason). Never part of the accepted Extraction Result. */
export type ReviewCandidate = Readonly<{
  path: readonly (string | number | null)[]
  value: unknown
  quote: string | null
  key: string | null
  provenance: string | null
  spans: readonly TextSpan[]
  alternatives: readonly (readonly TextSpan[])[]
  window: number
  reason?: string
  raw?: string
}>

export type GroundedDiagnostics = Readonly<{
  recipe: string
  segmentationFingerprint: string
  budget: Readonly<{ inputTokens: number; outputTokens: number; tokenizer: Readonly<Record<string, unknown>> }>
  /** What segmentation could not settle (reading order, numbering, glossary...), each with its source spans. */
  segmentationDiagnostics: readonly Readonly<{ code: string; detail: string; block: string | null; spans: readonly TextSpan[] }>[]
  /** Which value normalizations the result applied (expansions sit beside raw values on the evidence). */
  normalization: Readonly<{ version: number; rules: readonly 'glossary'[] }>
  recordBlocks: readonly Readonly<{ block: string; entry_label: string }>[]
  proposed: readonly ReviewCandidate[]
  rejected: readonly ReviewCandidate[]
  competitors: readonly Readonly<Record<string, unknown>>[]
  coverage: Readonly<Record<string, unknown>>
  completeness: Readonly<{ processing: boolean; coverage: boolean; grounding: boolean; recall: 'unmeasured' }>
}>

export type ReviewDecisionAction = 'APPROVED' | 'EDITED' | 'REJECTED'

export type ReviewDecisionInput = Readonly<{
  resultPath: ResultPath
  evidenceAnchorId: string | null
  reviewedOccurrenceIds: readonly string[]
  action: ReviewDecisionAction
  reviewedValue: unknown | null
  /** An EDITED decision's own Evidence: the published passage its corrected value is printed in. */
  reviewedEvidence?: readonly Readonly<{ evidenceAnchorId: string; reviewedOccurrenceIds: readonly string[] }>[] | null
}>

export type ReviewDecision = ReviewDecisionInput & Readonly<{
  createdAt: Date
}>

export type ModelGenerationMetadata = Readonly<{
  finishReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
}>

export type ModelAttribution = Readonly<{
  provider: string
  modelId: string
}>

export type ExtractionModelAttribution = ModelAttribution

/** The two roles an Extraction's model calls split into: `fields` reads values off the source, `reasoning` decides
 *  over labelled text (record starts, grounding, arbitration). */
export type ExtractionModelRole = 'fields' | 'reasoning'

/** An Extraction Model Choice: per role, a model key of kei-exp's deployment (`instruct`, `nuextract`...), chosen for
 *  one run. A role left out keeps kei-exp's deployment default. Not a Capability Route or a FREE Model Connection. */
export type ExtractionModelChoice = Readonly<Partial<Record<ExtractionModelRole, string>>>

/** The model (its served repo id) each role actually ran on, as kei-exp resolved the choice. */
export type ExtractionModelsUsed = Readonly<Record<ExtractionModelRole, string>>

export type GroundingBatchSnapshot = Readonly<{
  resultPath: ResultPath | null
  candidateCount: number
  fallback: boolean
  outcome: 'succeeded' | 'failed'
  finishReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number
}>

export type CatalogCallDiagnostics = Readonly<{
  provenance: 'executed' | 'reused'
  outcome: 'succeeded' | 'failed' | 'not_attempted'
  finishReason: string | null
  calls: number
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number
  failureCode: string | null
}>

export type CatalogStage = 'document-values' | 'discovery' | 'record-values' | 'grounding'

export type CatalogStageDiagnostics = CatalogCallDiagnostics & Readonly<{
  stage: CatalogStage
}>

export type CatalogRecordDiagnostics = CatalogCallDiagnostics & Readonly<{
  ordinal: number
  boundary: CatalogBoundary
}>

export type CatalogDiagnostics = Readonly<{
  stages: readonly CatalogStageDiagnostics[]
  records: readonly CatalogRecordDiagnostics[]
  documentValues: Readonly<Record<string, unknown>> | null
}>

/** The method as kei-exp recorded running it: its dumped `options`, and the prompt version plus each method and
 *  protocol version the artifact reports (`method`, `spanGrounding`, `groundingRouting`, `rendering`, `grouping`,
 *  `selection`). */
export type EffectiveMethod = Readonly<{
  options: Readonly<Record<string, unknown>>
  versions: Readonly<Record<string, number>>
}>

/** Schema-policy verification's accounting: every record leaf, the leaves eligible for verification, the values a
 *  policy skipped and why, and whether the eligible ones were all grounded. Nothing eligible is not applicable. */
export type GroundingEligibility = Readonly<{
  allRecordLeaves: number
  eligibleRecordLeaves: number
  skipped: readonly Readonly<{ resultPath: ResultPath; policy: 'derived' | 'unverified' }>[]
  eligibleGrounding: 'complete' | 'partial' | 'not_applicable'
}>

/** The quote or offered source span an accepted Article link was verified with; `start`/`end` are code-point offsets
 *  into its segment. A proof is never an Evidence link. */
export type SupportProof = Readonly<{
  resultPath: ResultPath
  segment: string
  cell: string | null
  quote: string
  attribution: string
  span?: string
  start?: number
  end?: number
}>

export type ExtractionDiagnostics = Readonly<{
  phase: 'loading' | 'extracting' | 'grounding' | 'persisting'
  durationMs: number
  modelCalls: number
  finishReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  ungroundedPaths: readonly ResultPath[]
  groundingIssues: readonly Readonly<Record<string, unknown>>[]
  groundingBatches: readonly GroundingBatchSnapshot[]
  /** Document-level field names (`valueSource: "document"`) the extractor could not verify: read
   *  once for the whole source, copied into every record and grounded in none. They are not
   *  ungrounded values — no passage was ever expected to carry them. */
  unverifiedFields: readonly string[]
  catalog: CatalogDiagnostics | null
  /** The recipe path's review material and separated completeness; absent on version 1 results. */
  grounded?: GroundedDiagnostics | null
  /** The unified Catalog's method, source accounting, processing and review material; version 3 results only. */
  unified?: UnifiedDiagnostics | null
  /** The model each role ran on; absent on results from before kei-exp routed calls by role. */
  models?: ExtractionModelsUsed | null
  /** What the Parsing Service reports it ran; absent on results from before it was kept. */
  effectiveMethod?: EffectiveMethod | null
  /** Schema-policy verification's accounting; null when the run used no schema evidence policy. */
  eligibility?: GroundingEligibility | null
  /** The quote or exact source span each accepted Article link was verified with; null when the run reported none. */
  support?: readonly SupportProof[] | null
}>

export type ExtractionFailure = Readonly<{
  code: string
  message: string
  phase: ExtractionDiagnostics['phase']
}>

export type ExtractionSnapshot = Readonly<{
  extractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  sourceRepresentationRevisionNumber: number
  schemaRevisionId: string
  extractionSchemaId: string
  schemaRevisionNumber: number
  strategy: ExtractionStrategy
  /** The numbered-catalogue recipe a Catalog Extraction ran with; null for generic Catalog and for Article. */
  catalogRecipe: string | null
  /** The run's Extraction Model Choice; null (or absent) when every role kept kei-exp's deployment default. */
  requestedModels?: ExtractionModelChoice | null
  /** The settings admitted with the run (`{article}`, `{generic}` or `{recipe}`, each null for service defaults);
   *  null or absent when the run predates recorded settings ("Not recorded"). */
  requestedSettings?: ActiveSettings | null
  /** Only a published Extraction has a result snapshot. */
  outcome: 'SUCCEEDED'
  complete: boolean | null
  modelAttribution: ExtractionModelAttribution | null
  diagnostics: ExtractionDiagnostics
  result: Readonly<Record<string, unknown>> | null
  evidence: readonly EvidenceLink[] | null
  failure: ExtractionFailure | null
  reviewable: boolean
  batchExtractionId: string | null
  createdAt: Date
  reviewedAt: Date | null
  reviewDecisions: readonly ReviewDecision[]
}>

export type ExtractionAttemptSnapshot = Readonly<{
  extractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  sourceRepresentationRevisionNumber: number
  schemaRevisionId: string
  extractionSchemaId: string
  schemaRevisionNumber: number
  strategy: ExtractionStrategy
  /** The numbered-catalogue recipe a Catalog Extraction ran with; null for generic Catalog and for Article. */
  catalogRecipe: string | null
  /** The run's Extraction Model Choice; null (or absent) when every role kept kei-exp's deployment default. */
  requestedModels?: ExtractionModelChoice | null
  /** The settings admitted with the run (`{article}`, `{generic}` or `{recipe}`, each null for service defaults);
   *  null or absent when the run predates recorded settings ("Not recorded"). */
  requestedSettings?: ActiveSettings | null
  executionStatus: ProjectOperationStatus
  /** SUCCEEDED once published; a failed, cancelled or interrupted attempt is FAILED with its failure instead. */
  outcome: 'SUCCEEDED' | null
  complete: boolean | null
  modelAttribution: ExtractionModelAttribution | null
  diagnostics: ExtractionDiagnostics | null
  result: Readonly<Record<string, unknown>> | null
  evidence: readonly EvidenceLink[] | null
  failure: ExtractionFailure | null
  reviewable: boolean
  batchExtractionId: string | null
  createdAt: Date
  reviewedAt: Date | null
  reviewDecisions: readonly ReviewDecision[]
}>

export type FreshExtractionInput = Readonly<{
  kind: 'fresh'
  extractionId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  /** The numbered-catalogue recipe chosen for this Catalog Extraction; null or absent for generic Catalog. */
  catalogRecipe?: string | null
  /** The saved method the researcher saw at start: admission refuses it unless it is still the account's, then pins it. */
  method: ExtractionMethodIntent
}>

export type RunSingleInput = FreshExtractionInput
export type RunSingleResult = Readonly<{
  disposition: ExtractionDisposition
  extraction: ExtractionAttemptSnapshot
}>
export type CancellationResult =
  | 'cancellation-requested'
  | 'not-found'

export type FinalizeReviewResult = Readonly<{
  disposition: 'reviewed' | 'replayed'
  extraction: ExtractionSnapshot
}>


export type ReviewPreparation = Readonly<{
  extraction: ExtractionSnapshot
  reviewDecisions: readonly ReviewDecisionInput[]
}>

export type ReviewDraft = Readonly<{
  attention?: ReturnType<typeof import('./review-attention.js').reviewAttention>
  version: number
  decisions: readonly ReviewDecisionInput[]
}>

export type BatchExtractionMemberSnapshot = Readonly<{
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  executionStatus: ProjectOperationStatus
  /** Why the member failed, was cancelled or was interrupted; null unless its status is FAILED. */
  failureMessage: string | null
  /** The member's published Extraction; a member that failed has none. */
  latestExtraction: Readonly<{
    extractionId: string
    outcome: 'SUCCEEDED'
    complete: boolean | null
    reviewable: boolean
    createdAt: Date
    reviewedAt: Date | null
  }> | null
}>

export type BatchExtractionSnapshot = Readonly<{
  batchExtractionId: string
  projectContextId: string
  schemaRevisionId: string
  extractionSchemaId: string
  extractionSchemaName: string
  schemaRevisionNumber: number
  strategy: ExtractionStrategy
  /** QUEUED while every member is, COMPLETED once every member has settled, RUNNING otherwise; never FAILED. */
  executionStatus: ProjectOperationStatus
  createdAt: Date
  members: readonly BatchExtractionMemberSnapshot[]
}>

export type ScheduleBatchInput = Readonly<{
  projectContextId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  /** The saved method the researcher saw at start; one snapshot for the batch and every member. */
  method: ExtractionMethodIntent
  sourceDocumentIds: readonly string[]
  repetition: BatchRepetition
}>

export type ScheduleSuggestedBatchInput = Readonly<{
  projectContextId: string
  batchSchemaSuggestionId: string
  strategy: ExtractionStrategy
  /** The saved method the researcher saw at start; one snapshot for the batch and every member. */
  method: ExtractionMethodIntent
}>

export type ScheduleBatchResult = Readonly<{
  disposition: BatchDisposition
  batch: BatchExtractionSnapshot
}>

export type ListBatchesInput = Readonly<{
  projectContextId: string
  limit?: number
}>

export type ReadBatchInput = Readonly<{
  projectContextId: string
  batchExtractionId: string
}>

export type BatchExtractionResultItem = Readonly<{
  sourceDocumentId: string
  extractionId: string
  result: Readonly<Record<string, unknown>>
  /** The result's values its sources disagreed on and no review has supplied; absent when there are none. */
  contested?: readonly ContestedValue[]
}>

export type BatchExtractionResults = Readonly<{
  batchExtractionId: string
  executionStatus: ProjectOperationStatus
  totalMembers: number
  successfulResults: number
  pending: number
  failed: number
  cancelled: number
  results: readonly BatchExtractionResultItem[]
}>
export type ReadDocumentExtractionsInput = Readonly<{
  sourceDocumentId: string
  extractionId?: string
}>

export type DocumentExtractionsSnapshot = Readonly<{
  sourceRepresentationRevisionId: string
  latestAttempt: ExtractionAttemptSnapshot | null
  latestReviewed: ExtractionAttemptSnapshot | null
}>


export interface ExtractionModule {
  runSingle(input: RunSingleInput): Promise<RunSingleResult>
  readExtractionAttempt(extractionId: string): Promise<ExtractionAttemptSnapshot | null>
  cancelSingle(extractionId: string): Promise<CancellationResult>
  prepareReview(extractionId: string): Promise<ReviewPreparation>
  finalizeReview(extractionId: string, decisions: readonly ReviewDecisionInput[], expectedDraftVersion?: number): Promise<FinalizeReviewResult>
  readReviewDraft(extractionId: string): Promise<ReviewDraft>
  saveReviewDraft(extractionId: string, draft: ReviewDraft): Promise<ReviewDraft>
  resetReview(extractionId: string, expectedDraftVersion: number): Promise<ReviewDraft>
  readDocumentExtractions(input: ReadDocumentExtractionsInput): Promise<DocumentExtractionsSnapshot | null>
  scheduleBatch(input: ScheduleBatchInput): Promise<ScheduleBatchResult>
  scheduleSuggestedBatch(input: ScheduleSuggestedBatchInput): Promise<ScheduleBatchResult>
  listBatches(input: ListBatchesInput): Promise<readonly BatchExtractionSnapshot[]>
  readBatch(input: ReadBatchInput): Promise<BatchExtractionSnapshot>
  readBatchResults(input: ReadBatchInput): Promise<BatchExtractionResults>
}
import type { ScalarFieldType as SchemaScalarFieldType } from './allowed-values.js'
import type { ActiveSettings, ExtractionMethodIntent } from './extraction-method.js'
type CatalogBoundary = {
  startBlockId: string
  startContentIndex: number
  endContentIndex: number
  headingText: string
  headingLevel: number | null
}
import type { SchemaNode } from './schema.js'
