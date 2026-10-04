import {
  canonicalPackageStore,
  db,
  isUniqueViolation,
  type CanonicalPackageStore,
  type Database,
} from 'db'
import type {
  ExtractionExecution,
  ExtractionPersistence,
  LoadedExtractionInputs,
  PersistedReviewResult,
} from './dependencies.js'
import { ExtractionError } from './errors.js'
import {
  admitBatchExtraction,
  admitBatchMember,
  admitInteractiveExtraction,
  JUST_ADMITTED,
  METHOD_CHANGED_MESSAGE,
  refuseUnusableIdentityFields,
  savedMethodStillCurrent,
  SUGGESTED_BATCH_KEYS,
} from './postgres-admission.js'
import {
  attemptSnapshot,
  deriveAttempts,
  loadDocumentExtractions,
  readAttemptRows,
  readRuntimeHeads,
} from './postgres-attempts.js'
import {
  loadBatch,
  loadBatches,
  loadResults,
  readBatchForResearcher,
  snapshot,
} from './postgres-batches.js'
import {
  ownedInputs,
  ownedRepresentation,
  ownsResearcherBatch,
  ownsResearcherDocument,
  ownsResearcherExtraction,
  readResearcherExtraction,
} from './postgres-ownership.js'
import {
  finalizeStoredReview,
  readStoredReviewDraft,
  resetStoredReview,
  saveStoredReviewDraft,
} from './postgres-reviews.js'
import { persistSuggestedBatch, semanticSuggestionTree } from './postgres-suggested-batch.js'
import { settleExtraction } from './postgres-workflow-store.js'
import type { ReviewAuthority } from './review-rules.js'
import type {
  BatchExtractionResults,
  BatchExtractionSnapshot,
  CancellationResult,
  DocumentExtractionsSnapshot,
  ExtractionAttemptSnapshot,
  ExtractionSnapshot,
  ReadBatchInput,
  ReadDocumentExtractionsInput,
  ReviewDraft,
  RunSingleInput,
  RunSingleResult,
  ScheduleBatchInput,
  ScheduleBatchResult,
  ScheduleSuggestedBatchInput,
} from './types.js'

const SUPERSEDED_MESSAGE =
  "This document has been reprocessed. No new Extraction was started. Open the document from the project's Sources list to run on its current source revision. You can continue reviewing this earlier Extraction."

/**
 * Cancels an interactive Extraction (spec, *Cancellation*): the cancelled outcome is written first, because a cancelled
 * workflow cannot record its own; then the Studio workflow and its kei child are stopped, best effort, after the
 * commit. M6's collectGarbage cancels any live work whose row is settled.
 */
async function cancelInteractiveExtraction(
  database: Database,
  execution: ExtractionExecution,
  researcherAccountId: string,
  extractionId: string,
): Promise<CancellationResult> {
  // Durable execution accepts only its fenced Stop command; cancellation
  // through this entrypoint would bypass drain and saved-result protection.
  if ((await readRuntimeHeads(database.orm, [extractionId])).has(extractionId)) return 'not-found'
  const written = await database.transaction(async (transaction) => {
    if (!(await ownsResearcherExtraction(transaction, researcherAccountId, extractionId))) return 'not-found' as const
    const row = await transaction.orm.public.Extraction.select('batchExtractionId').first({ id: extractionId })
    // Interactive Extractions only: a batch member is not cancelled on its own.
    if (!row || row.batchExtractionId !== null) return 'not-found' as const
    return settleExtraction(transaction.orm, extractionId, {
      outcome: 'CANCELLED', failure: { code: 'cancelled', message: 'Extraction cancelled.', phase: 'extracting' },
    })
  })
  if (written !== 'settled') return 'not-found'
  await execution.cancel(extractionId).catch((error: unknown) =>
    console.warn(
      "The cancelled Extraction's workflows could not be stopped now; they stop at their next check.",
      error instanceof Error ? error.message : '',
    ))
  return 'cancellation-requested'
}

class ResearcherPostgresExtractionPersistence implements ExtractionPersistence {
  private readonly researcherAccountId: string
  private readonly execution: ExtractionExecution
  private readonly database: Database
  private readonly packages: CanonicalPackageStore

  constructor(
    researcherAccountId: string,
    execution: ExtractionExecution,
    database: Database,
    packages: CanonicalPackageStore,
  ) {
    this.researcherAccountId = researcherAccountId
    this.execution = execution
    this.database = database
    this.packages = packages
  }

  async loadExtractionInputs(
    sourceRepresentationRevisionId: string,
    schemaRevisionId: string,
  ): Promise<LoadedExtractionInputs | null> {
    const loaded = await this.database.transaction((transaction) =>
      ownedInputs(
        transaction,
        this.researcherAccountId,
        sourceRepresentationRevisionId,
        schemaRevisionId,
      ),
    )
    if (!loaded)
      throw new ExtractionError(
        'not_found',
        'The Extraction inputs were not found.',
      )
    const artifact = await this.packages.read(
      {
        artifactReference: loaded.artifactReference,
        artifactSha256: loaded.artifactSha256,
      },
      'source',
    )
    return {
      sourceDocumentId: loaded.sourceDocumentId,
      projectContextId: loaded.projectContextId,
      sourceRepresentationRevisionId: loaded.sourceRepresentationRevisionId,
      schemaRevisionId: loaded.schemaRevisionId,
      schemaTree: loaded.schemaTree,
      parsedDocument: JSON.parse(new TextDecoder().decode(artifact.bytes)),
    }
  }

  async readCanonicalParsedDocument(
    sourceRepresentationRevisionId: string,
  ): Promise<unknown | null> {
    const row = await this.database.transaction((transaction) =>
      ownedRepresentation(transaction, this.researcherAccountId, sourceRepresentationRevisionId),
    )
    if (!row) return null
    const artifact = await this.packages.read(row, 'source')
    return JSON.parse(new TextDecoder().decode(artifact.bytes))
  }

  readExtraction(
    extractionId: string,
  ): Promise<ExtractionSnapshot | null> {
    return readResearcherExtraction(this.database, this.researcherAccountId, extractionId)
  }

  async scheduleExtraction(input: RunSingleInput): Promise<RunSingleResult | null> {
    const disposition = await admitInteractiveExtraction(this.execution, this.researcherAccountId, input)
    if (disposition === 'missing') return null
    if (disposition === 'conflict')
      throw new ExtractionError('extraction_id_conflict', 'That Extraction ID is already bound to different inputs.')
    if (disposition === 'superseded')
      throw new ExtractionError('source_representation_superseded', SUPERSEDED_MESSAGE)
    if (disposition === 'method-changed') throw new ExtractionError('method_changed', METHOD_CHANGED_MESSAGE)
    const { orm } = this.database
    const [row] = await readAttemptRows(orm, [input.extractionId])
    if (!row) return null
    // A created Extraction answers as just admitted; a replay reads its status like any other read.
    const attempt = (await deriveAttempts(
      orm, disposition === 'created' ? JUST_ADMITTED : this.execution.statuses, [row],
    )).get(row.id)!
    return { disposition, extraction: await attemptSnapshot(orm, attempt) }
  }

  async readExtractionAttempt(
    extractionId: string,
  ): Promise<ExtractionAttemptSnapshot | null> {
    const row = await this.database.transaction(async (transaction) => {
      if (!(await ownsResearcherExtraction(transaction, this.researcherAccountId, extractionId))) return null
      const [owned] = await readAttemptRows(transaction.orm, [extractionId])
      return owned ?? null
    })
    // A batch member is read one by one only once published (its Batch reads its progress).
    if (!row) return null
    const [attempt] = (await deriveAttempts(this.database.orm, this.execution.statuses, [row])).values()
    if(row.batchExtractionId!==null && row.outcome!=='SUCCEEDED' && !attempt?.durable)return null
    return attemptSnapshot(this.database.orm, attempt!)
  }

  cancelExtraction(extractionId: string): Promise<CancellationResult> {
    return cancelInteractiveExtraction(this.database, this.execution, this.researcherAccountId, extractionId)
  }

  async readDocumentExtractions(
    input: ReadDocumentExtractionsInput,
  ): Promise<DocumentExtractionsSnapshot | null> {
    const owned = await this.database.transaction((transaction) =>
      ownsResearcherDocument(transaction, this.researcherAccountId, input.sourceDocumentId))
    if (!owned) return null
    return loadDocumentExtractions(this.database.orm, this.execution.statuses, input)
  }

  readReviewDraft(extractionId: string) { return readStoredReviewDraft(this.database, this.researcherAccountId, extractionId) }
  resetReview(extractionId: string, version: number) { return resetStoredReview(this.database, this.researcherAccountId, extractionId, version) }
  saveReviewDraft(extractionId: string, draft: ReviewDraft) { return saveStoredReviewDraft(this.database, this.researcherAccountId, extractionId, draft) }

  finalizeReview(
    extractionId: string,
    authority: ReviewAuthority,
  ): Promise<PersistedReviewResult> {
    return finalizeStoredReview(this.database, this.researcherAccountId, extractionId, authority)
  }

  scheduleBatch(
    input: ScheduleBatchInput,
  ): Promise<ScheduleBatchResult | null> {
    return admitBatchExtraction(this.database, this.execution, this.researcherAccountId, input)
  }

  scheduleSuggestedBatch(
    input: ScheduleSuggestedBatchInput,
  ): Promise<ScheduleBatchResult | null> {
    return persistSuggestedBatch(
      this.database,
      this.researcherAccountId,
      input,
      {
        execution: this.execution,
        admitBatchMember,
        savedMethodStillCurrent,
        refuseUnusableIdentityFields,
        loadBatch: (orm, projectContextId, batchExtractionId, created) =>
          loadBatch(orm, created ? JUST_ADMITTED : this.execution.statuses, projectContextId, batchExtractionId),
        replayed: (error) => SUGGESTED_BATCH_KEYS.some((key) => isUniqueViolation(error, key)),
        semanticSuggestionTree,
        snapshot,
      },
    )
  }

  async listBatches(
    projectContextId: string,
    limit: number,
  ): Promise<readonly BatchExtractionSnapshot[] | null> {
    const rows = await this.database.transaction(async ({ orm }) => {
      if (
        !(await orm.public.ProjectContext.select('id').first({
          id: projectContextId,
          researcherAccountId: this.researcherAccountId,
        }))
      )
        return null
      return orm.public.BatchExtraction.where({
        projectContextId,
      })
        .select('id')
        .orderBy([
          (batch) => batch.createdAt.desc(),
          (batch) => batch.id.desc(),
        ])
        .take(limit)
        .all()
    })
    if (!rows) return null
    return (await loadBatches(
      this.database.orm,
      this.execution.statuses,
      projectContextId,
      rows.map((row) => row.id),
    )).map(snapshot)
  }

  async readBatch(
    input: ReadBatchInput,
  ): Promise<BatchExtractionSnapshot | null> {
    const batch = await readBatchForResearcher(
      this.database,
      this.researcherAccountId,
      input.projectContextId,
      input.batchExtractionId,
      this.execution.statuses,
    )
    return batch ? snapshot(batch) : null
  }

  async readBatchResults(
    input: ReadBatchInput,
  ): Promise<BatchExtractionResults | null> {
    const owned = await this.database.transaction((transaction) =>
      ownsResearcherBatch(transaction, this.researcherAccountId, input.projectContextId, input.batchExtractionId))
    if (!owned) return null
    return loadResults(this.database.orm, this.execution.statuses, input)
  }
}

/**
 * The researcher-scoped persistence behind ExtractionModule. Admission always commits through the shared pool
 * (withPoolClientTransaction); `database` carries every other read and write.
 */
export function createResearcherExtractionPersistence(
  researcherAccountId: string,
  execution: ExtractionExecution,
  infrastructure: Readonly<{ database?: Database; packages?: CanonicalPackageStore }> = {},
): ExtractionPersistence {
  return new ResearcherPostgresExtractionPersistence(
    researcherAccountId,
    execution,
    infrastructure.database ?? db,
    infrastructure.packages ?? canonicalPackageStore,
  )
}
