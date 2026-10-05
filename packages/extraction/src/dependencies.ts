import type { TransactionalEnqueue, WorkflowStatuses } from 'db'
import type {
  BatchExtractionResults,
  BatchExtractionSnapshot,
  CancellationResult,
  DocumentExtractionsSnapshot,
  ExtractionDiagnostics,
  ExtractionAttemptSnapshot,
  EvidenceLink,
  ExtractionFailure,
  ExtractionModelAttribution,
  ExtractionSnapshot,
  ExtractionStrategy,
  ReadBatchInput,
  ReadDocumentExtractionsInput,
  ReviewDraft,
  RunSingleInput,
  RunSingleResult,
  ScheduleBatchInput,
  ScheduleBatchResult,
  ScheduleSuggestedBatchInput,
  StabiliseSchemaRevisionInput,
  StabiliseSchemaRevisionResult,
} from './types.js'
import type { ReviewAuthority } from './review-rules.js'

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
  batchExtractionId: string | null
}>

export type PersistedReviewResult =
  | Readonly<{ status: 'reviewed' | 'replayed'; extraction: ExtractionSnapshot }>
  | Readonly<{ status: 'conflict' | 'invalid' | 'not-found' }>

/** An Extraction's pinned inputs and its attempt, as the researcher-scoped module reads them. */
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
  /** Marks a piloted Schema Revision stabilised, or reports why not: 'not-found' when the account does not own the
   *  Project Context or revision, 'not-ready' when no pilot Extraction against it has been reviewed yet. */
  stabiliseSchemaRevision(
    input: StabiliseSchemaRevisionInput,
  ): Promise<StabiliseSchemaRevisionResult | 'not-found' | 'not-ready'>
  listBatches(projectContextId: string, limit: number): Promise<readonly BatchExtractionSnapshot[] | null>
  readBatch(input: ReadBatchInput): Promise<BatchExtractionSnapshot | null>
  readBatchResults(input: ReadBatchInput): Promise<BatchExtractionResults | null>
}

/**
 * How admission reaches DBOS without `packages/extraction` owning a DBOS client: Studio implements it with its admission
 * client (api/_extractions.ts), the PostgreSQL tests with their own.
 */
export type ExtractionExecution = Readonly<{
  /** Enqueues `runExtraction` in the caller's admission transaction. An implementation refuses a workflow ID already in
   *  use (DBOS `workflowIDReusePolicy: 'reject'`): admission creates each Extraction's row with its workflow, so such an
   *  ID names a workflow whose Extraction is gone, and reusing it would silently return that workflow. */
  enqueue: TransactionalEnqueue
  /** The DBOS status of `extract:<id>` workflows, in one call; rejects when DBOS cannot be read. */
  statuses: WorkflowStatuses
  /** Stops `extract:<id>` and its kei child `kei-extract:<id>` while they are live (best effort, after the cancel commits). */
  cancel(extractionId: string): Promise<void>
}>
