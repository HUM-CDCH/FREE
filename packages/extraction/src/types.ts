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
}>

export type ReviewDecisionAction = 'APPROVED' | 'EDITED' | 'REJECTED'

export type ReviewDecisionInput = Readonly<{
  resultPath: ResultPath
  evidenceAnchorId: string
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
  finalizeReview(extractionId: string, decisions: readonly ReviewDecisionInput[]): Promise<FinalizeReviewResult>
  readDocumentExtractions(input: ReadDocumentExtractionsInput): Promise<DocumentExtractionsSnapshot | null>
  scheduleBatch(input: ScheduleBatchInput): Promise<ScheduleBatchResult>
  scheduleSuggestedBatch(input: ScheduleSuggestedBatchInput): Promise<ScheduleBatchResult>
  listBatches(input: ListBatchesInput): Promise<readonly BatchExtractionSnapshot[]>
  readBatch(input: ReadBatchInput): Promise<BatchExtractionSnapshot>
  readBatchResults(input: ReadBatchInput): Promise<BatchExtractionResults>
}

export interface ExtractionRuntime {
  forResearcher(researcherAccountId: string): ExtractionModule
  run(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}
import type { ScalarFieldType as SchemaScalarFieldType } from './allowed-values.js'
import type { CatalogBoundary } from './catalog-boundaries.js'
import type { SchemaNode } from './schema.js'
