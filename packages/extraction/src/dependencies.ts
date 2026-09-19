import type { ZodType } from 'zod'
import type { CatalogPolicy } from './catalog.js'
import type {
  BatchExtractionResults,
  BatchExtractionSnapshot,
  CancellationResult,
  DocumentExtractionsSnapshot,
  EvaluationRunSnapshot,
  ExtractionDiagnostics,
  ExtractionAttemptSnapshot,
  EvidenceLink,
  ExtractionFailure,
  ExtractionModelAttribution,
  ExtractionSnapshot,
  ExtractionStrategy,
  ListEvaluationRunsInput,
  ModelAttribution,
  ModelGenerationMetadata,
  ReadBatchInput,
  ReadDocumentExtractionsInput,
  ReviewDecisionInput,
  ReviewDraft,
  RunSingleInput,
  RunSingleResult,
  ScheduleBatchInput,
  ScheduleBatchResult,
  ScheduleSuggestedBatchInput,
  ValidateExtractionInput,
} from './types.js'

export type LoadedExtractionInputs = Readonly<{
  sourceDocumentId: string
  projectContextId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  schemaTree: unknown
  parsedDocument: unknown
}>

export type TerminalExtraction = Readonly<{
  extractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  complete: boolean | null
  modelAttribution: ExtractionModelAttribution | null
  diagnostics: ExtractionDiagnostics
  failure: ExtractionFailure | null
  result: Readonly<Record<string, unknown>> | null
  evidence: readonly EvidenceLink[] | null
  reviewable: boolean
  retryOfId: string | null
  batchExtractionId: string | null
}>

export type ReviewAuthority = Readonly<{
  expectedDraftVersion?: number
  reviewDecisions: readonly ReviewDecisionInput[]
  occurrenceIdsByAnchor: ReadonlyMap<string, ReadonlySet<string>>
  evidenceResultPathKeys: ReadonlySet<string>
}>

export type PersistedReviewResult =
  | Readonly<{ status: 'reviewed' | 'replayed'; extraction: ExtractionSnapshot }>
  | Readonly<{ status: 'conflict' | 'invalid' | 'not-found' }>

/** The pinned inputs one Extraction Job reads while it executes. */
export interface ExtractionInputReader {
  loadExtractionInputs(
    sourceRepresentationRevisionId: string,
    schemaRevisionId: string,
  ): Promise<LoadedExtractionInputs | null>
  readExtractionAttempt(extractionId: string): Promise<ExtractionAttemptSnapshot | null>
}

/** Researcher-scoped persistence: every read and write is owned by one Researcher Account. */
export interface ExtractionPersistence extends ExtractionInputReader {
  readCanonicalParsedDocument(sourceRepresentationRevisionId: string): Promise<unknown | null>
  readExtraction(extractionId: string): Promise<ExtractionSnapshot | null>
  scheduleExtraction(input: RunSingleInput): Promise<RunSingleResult | null>
  cancelExtraction(extractionId: string): Promise<CancellationResult>
  finalizeReview(extractionId: string, authority: ReviewAuthority): Promise<PersistedReviewResult>
  readReviewDraft(extractionId: string): Promise<ReviewDraft | null>
  saveReviewDraft(extractionId: string, draft: ReviewDraft): Promise<ReviewDraft>
  resetReview(extractionId: string, expectedDraftVersion: number): Promise<ReviewDraft>
  readDocumentExtractions(input: ReadDocumentExtractionsInput): Promise<DocumentExtractionsSnapshot | null>
  scheduleBatch(input: ScheduleBatchInput): Promise<ScheduleBatchResult | null>
  scheduleSuggestedBatch(input: ScheduleSuggestedBatchInput): Promise<ScheduleBatchResult | null>
  listBatches(projectContextId: string, limit: number): Promise<readonly BatchExtractionSnapshot[] | null>
  readBatch(input: ReadBatchInput): Promise<BatchExtractionSnapshot | null>
  readBatchResults(input: ReadBatchInput): Promise<BatchExtractionResults | null>
  validateExtraction(input: ValidateExtractionInput): Promise<EvaluationRunSnapshot | null>
  listEvaluationRuns(input: ListEvaluationRunsInput): Promise<readonly EvaluationRunSnapshot[] | null>
}

export type ExtractionModelRequest = Readonly<{
  document: Readonly<{
    markdown: string
    pages: number
  }>
  template: Readonly<Record<string, unknown>>
  /** A stricter output contract for model work such as canonical ID selection. */
  outputSchema?: ZodType
  instruction?: string
  signal: AbortSignal
}>

export type ExtractionModelResponse = Readonly<{
  result: Readonly<Record<string, unknown>>
  metadata: ModelGenerationMetadata
}>

export interface ExtractionModel {
  extract(request: ExtractionModelRequest): Promise<ExtractionModelResponse>
}

export type GroundingSelection = Readonly<{
  claimLabel: string
  anchorLabel: string | null
}>

/** What a claim's value means: its record, its field path and the schema
 *  description of that field. A string found under another field is not
 *  evidence. */
export type GroundingClaimField = Readonly<{
  record: string | null
  field: string
  description: string | null
}>

export type GroundingModelRequest = Readonly<{
  claims: Readonly<Record<string, string | number | boolean>>
  anchors: Readonly<Record<string, string>>
  /** Present when the policy asks for field-aware grounding. */
  claimFields?: Readonly<Record<string, GroundingClaimField>>
  /** Claims of the same records already linked in code, shown as context
   *  that needs no answer (policy.groundedContext). */
  linkedClaims?: Readonly<Record<string, { value: string | number | boolean; anchorLabel: string; field: GroundingClaimField | null }>>
  signal: AbortSignal
}>

export type GroundingModelResponse = Readonly<{
  selections: readonly GroundingSelection[]
  metadata: ModelGenerationMetadata
}>

export interface GroundingModel {
  ground(request: GroundingModelRequest): Promise<GroundingModelResponse>
}

export type ExtractionModelSession = Readonly<{
  attribution: ModelAttribution
  model: ExtractionModel
  groundingModel: GroundingModel
}>

export interface ExtractionModelSessions {
  open(): Promise<ExtractionModelSession>
}
export type BatchMemberExtractionInput = Readonly<{
  extractionId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  batchExtractionId: string
}>

export type ExtractionJobInput =
  | RunSingleInput
  | (BatchMemberExtractionInput & Readonly<{ kind: 'batch-member' }>)

export type ExtractionValueCheckpoint = Readonly<{
  complete: boolean
  modelAttribution: ExtractionModelAttribution
  diagnostics: ExtractionDiagnostics
  result: Readonly<Record<string, unknown>>
}>

export type ClaimedExtractionJob = Readonly<{
  input: ExtractionJobInput
  checkpoint: ExtractionValueCheckpoint | null
  lease: Readonly<{ owner: string; version: number; expiresAt: Date }>
}>

export type ExtractionJobFailure = Readonly<{
  code: string
  message: string
  phase: ExtractionDiagnostics['phase']
}>

export interface InternalExtractionJobStore {
  claim(owner: string, now: Date, leaseExpiresAt: Date): Promise<ClaimedExtractionJob | null>
  renew(extractionId: string, lease: ClaimedExtractionJob['lease'], leaseExpiresAt: Date): Promise<'owned' | 'cancelled' | 'lost'>
  checkpoint(extractionId: string, lease: ClaimedExtractionJob['lease'], checkpoint: ExtractionValueCheckpoint): Promise<boolean>
  complete(extractionId: string, lease: ClaimedExtractionJob['lease'], extraction: TerminalExtraction, finishedAt: Date): Promise<boolean>
  fail(extractionId: string, lease: ClaimedExtractionJob['lease'], failure: ExtractionJobFailure, finishedAt: Date): Promise<boolean>
}

export type ExtractionJobExecutor = (
  input: ExtractionJobInput,
  checkpoint: ExtractionValueCheckpoint | null,
  saveCheckpoint: (checkpoint: ExtractionValueCheckpoint) => Promise<void>,
  signal: AbortSignal,
) => Promise<TerminalExtraction>

export type ExtractionJobExecutorDependencies = Readonly<{
  inputs: ExtractionInputReader
  models: ExtractionModelSessions
  now?: () => number
  /** Catalog call structure; DEFAULT_CATALOG_POLICY when absent. */
  policy?: CatalogPolicy
}>
