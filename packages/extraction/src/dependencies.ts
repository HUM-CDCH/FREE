import type { TransactionalEnqueue, WorkflowStatuses } from 'db'
import type {
  BatchExtractionSnapshot,
  DocumentExtractionsSnapshot,
  ExtractionAttemptSnapshot,
  ReadBatchInput,
  ReadDocumentExtractionsInput,
  RunSingleInput,
  RunSingleResult,
  ScheduleBatchInput,
  ScheduleBatchResult,
  ScheduleSuggestedBatchInput,
  StabiliseSchemaRevisionInput,
  StabiliseSchemaRevisionResult,
} from './types.js'

/** Researcher-scoped persistence: every read and write is owned by one Researcher Account. */
export interface ExtractionPersistence {
  readExtractionAttempt(extractionId: string): Promise<ExtractionAttemptSnapshot | null>
  scheduleExtraction(input: RunSingleInput): Promise<RunSingleResult | null>
  readDocumentExtractions(input: ReadDocumentExtractionsInput): Promise<DocumentExtractionsSnapshot | null>
  scheduleBatch(input: ScheduleBatchInput): Promise<ScheduleBatchResult | null>
  scheduleSuggestedBatch(input: ScheduleSuggestedBatchInput): Promise<ScheduleBatchResult | null>
  /** Marks a piloted Schema Revision stabilised, or reports why not: 'not-found' when the account does not own the
   *  Project Context or revision, 'not-ready' when no durable pilot review of it has been finalized yet. */
  stabiliseSchemaRevision(
    input: StabiliseSchemaRevisionInput,
  ): Promise<StabiliseSchemaRevisionResult | 'not-found' | 'not-ready'>
  listBatches(projectContextId: string, limit: number): Promise<readonly BatchExtractionSnapshot[] | null>
  readBatch(input: ReadBatchInput): Promise<BatchExtractionSnapshot | null>
}

/**
 * How admission reaches DBOS without `packages/extraction` owning a DBOS client: Studio implements it with its admission
 * client (api/_extractions.ts).
 */
export type ExtractionExecution = Readonly<{
  /** Enqueues an admitted Extraction's durable dispatch in the caller's admission transaction. An implementation refuses
   *  a workflow ID already in use (DBOS `workflowIDReusePolicy: 'reject'`): admission creates each Extraction's row with
   *  its dispatch, so such an ID names a dispatch whose Extraction is gone. */
  enqueue: TransactionalEnqueue
  /** DBOS statuses of the given workflows (a Schema Suggestion's attempt), in one call; rejects when DBOS cannot be
   *  read. */
  statuses: WorkflowStatuses
}>
