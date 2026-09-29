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
}>

export type ReviewDecisionAction = 'APPROVED' | 'EDITED' | 'REJECTED'

export type ReviewDecisionInput = Readonly<{
  resultPath: ResultPath
  /** Null for a field with no Evidence Link — ungrounded-with-value or
   *  missing, reviewable the same way just without an anchor behind it. */
  evidenceAnchorId: string | null
  reviewedOccurrenceIds: readonly string[]
  action: ReviewDecisionAction
  reviewedValue: unknown | null
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

export type ExtractionRetrySelection = Readonly<{
  retryOfId: string
  retryDocument: boolean
  rediscover: boolean
  retryRecordStartBlockIds: readonly string[]
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
  catalog: CatalogDiagnostics | null
  retry: ExtractionRetrySelection | null
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
  outcome: ExtractionOutcome
  complete: boolean | null
  modelAttribution: ExtractionModelAttribution | null
  diagnostics: ExtractionDiagnostics
  result: Readonly<Record<string, unknown>> | null
  evidence: readonly EvidenceLink[] | null
  failure: ExtractionFailure | null
  reviewable: boolean
  retryOfId: string | null
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
  executionStatus: ProjectOperationStatus
  outcome: ExtractionOutcome | null
  complete: boolean | null
  modelAttribution: ExtractionModelAttribution | null
  diagnostics: ExtractionDiagnostics | null
  result: Readonly<Record<string, unknown>> | null
  evidence: readonly EvidenceLink[] | null
  failure: ExtractionFailure | null
  reviewable: boolean
  retryOfId: string | null
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
}>

export type RetryExtractionInput = Readonly<{
  kind: 'retry'
  extractionId: string
  retryOfId: string
  retryDocument: boolean
  rediscover: boolean
  retryRecordStartBlockIds: readonly string[]
}>

export type RunSingleInput = FreshExtractionInput | RetryExtractionInput
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
  version: number
  decisions: readonly ReviewDecisionInput[]
}>

export type BatchExtractionMemberSnapshot = Readonly<{
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  executionStatus: ProjectOperationStatus
  failureMessage: string | null
  startedAt: Date | null
  finishedAt: Date | null
  latestExtraction: Readonly<{
    extractionId: string
    outcome: ExtractionOutcome
    complete: boolean | null
    reviewable: boolean
    createdAt: Date
    reviewedAt: Date | null
    failureMessage: string | null
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
  executionStatus: ProjectOperationStatus
  failureMessage: string | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
  members: readonly BatchExtractionMemberSnapshot[]
}>

export type ScheduleBatchInput = Readonly<{
  projectContextId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  sourceDocumentIds: readonly string[]
  repetition: BatchRepetition
}>

export type ScheduleSuggestedBatchInput = Readonly<{
  projectContextId: string
  batchSchemaSuggestionId: string
  strategy: ExtractionStrategy
}>

export type ScheduleBatchResult = Readonly<{
  disposition: BatchDisposition
  batch: BatchExtractionSnapshot
}>

export type StabiliseSchemaRevisionInput = Readonly<{
  projectContextId: string
  schemaRevisionId: string
}>

export type StabiliseSchemaRevisionResult = Readonly<{
  schemaRevisionId: string
  stabilisedAt: string
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
export type ValidateExtractionInput = Readonly<{
  projectContextId: string
  evaluationCorpusId: string
  extractionId: string
}>

export type ListEvaluationRunsInput = Readonly<{
  projectContextId: string
  evaluationCorpusId: string
  limit?: number
}>

/** A precision/recall/F1 snapshot, frozen at the schema revision + corpus
 *  version it was computed against (design.md D4/D4b in
 *  extraction-quality-evaluation). Exactly one of `batchExtractionId`/
 *  `extractionId` is set — a batch run scores a whole corpus re-run, a
 *  single-document run scores one existing Extraction attempt; both expose
 *  the same `metrics` shape. */
export type EvaluationRunSnapshot = Readonly<{
  evaluationRunId: string
  evaluationCorpusVersionId: string
  schemaRevisionId: string
  batchExtractionId: string | null
  extractionId: string | null
  computedAt: Date
  metrics: Readonly<{
    correctFields: number
    totalGoldFields: number
    totalExtractedFields: number
    precision: number
    recall: number
    f1: number
  }>
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
  runSingle(input: RunSingleInput, signal?: AbortSignal): Promise<RunSingleResult>
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
  /** Marks a piloted Schema Revision stabilised, unlocking batch/collection-level
   *  extraction against it (guided-pilot-extraction-workflow design.md D2). Requires
   *  at least one already-reviewed pilot Extraction against that revision. */
  stabiliseSchemaRevision(input: StabiliseSchemaRevisionInput): Promise<StabiliseSchemaRevisionResult>
  listBatches(input: ListBatchesInput): Promise<readonly BatchExtractionSnapshot[]>
  readBatch(input: ReadBatchInput): Promise<BatchExtractionSnapshot>
  readBatchResults(input: ReadBatchInput): Promise<BatchExtractionResults>
  /** Scores one existing Extraction attempt against its document's current
   *  `GoldRecord`s (no batch/corpus re-run) — the single-document path of
   *  extraction-quality-evaluation design.md D4b, `n=1` of what a batch
   *  Evaluation Run scores. */
  validateExtraction(input: ValidateExtractionInput): Promise<EvaluationRunSnapshot>
  listEvaluationRuns(input: ListEvaluationRunsInput): Promise<readonly EvaluationRunSnapshot[]>
}

export interface ExtractionRuntime {
  forResearcher(researcherAccountId: string): ExtractionModule
  run(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}
import type { ScalarFieldType as SchemaScalarFieldType } from './allowed-values.js'
import type { CatalogBoundary } from './catalog-boundaries.js'
import type { SchemaNode } from './schema.js'
