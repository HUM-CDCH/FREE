import { db, isUniqueViolation, type Database } from 'db'
import type { ExtractionExecution, ExtractionPersistence } from './dependencies.js'
import { ExtractionError } from './errors.js'
import {
  admitBatchExtraction,
  admitBatchMember,
  admitInteractiveExtraction,
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
  readDurableSummaries,
} from './postgres-attempts.js'
import { loadBatch, loadBatches, readBatchForResearcher, snapshot } from './postgres-batches.js'
import { ownsResearcherDocument, ownsResearcherExtraction } from './postgres-ownership.js'
import { persistSuggestedBatch, semanticSuggestionTree } from './postgres-suggested-batch.js'
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

const SUPERSEDED_MESSAGE =
  "This document has been reprocessed. No new Extraction was started. Open the document from the project's Sources list to run on its current source revision. You can continue reviewing this earlier Extraction."

class ResearcherPostgresExtractionPersistence implements ExtractionPersistence {
  private readonly researcherAccountId: string
  private readonly execution: ExtractionExecution
  private readonly database: Database

  constructor(
    researcherAccountId: string,
    execution: ExtractionExecution,
    database: Database,
  ) {
    this.researcherAccountId = researcherAccountId
    this.execution = execution
    this.database = database
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
    const attempt = (await deriveAttempts(orm, await readAttemptRows(orm, [input.extractionId]))).get(input.extractionId)
    if (!attempt) throw new Error('Admitted Extraction could not be read.')
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
    if (!row) return null
    const attempt = (await deriveAttempts(this.database.orm, [row])).get(row.id)
    return attempt ? attemptSnapshot(this.database.orm, attempt) : null
  }

  async readDocumentExtractions(
    input: ReadDocumentExtractionsInput,
  ): Promise<DocumentExtractionsSnapshot | null> {
    const owned = await this.database.transaction((transaction) =>
      ownsResearcherDocument(transaction, this.researcherAccountId, input.sourceDocumentId))
    if (!owned) return null
    return loadDocumentExtractions(this.database.orm, input)
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
        loadBatch: (orm, projectContextId, batchExtractionId) => loadBatch(orm, projectContextId, batchExtractionId),
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
    )
    return batch ? snapshot(batch) : null
  }

  async stabiliseSchemaRevision(
    input: StabiliseSchemaRevisionInput,
  ): Promise<StabiliseSchemaRevisionResult | 'not-found' | 'not-ready'> {
    return this.database.transaction(async ({ orm }) => {
      const revision = await orm.public.SchemaRevision.select(
        'id',
        'extractionSchemaId',
        'stabilisedAt',
      ).first({ id: input.schemaRevisionId })
      const schema = revision
        ? await orm.public.ExtractionSchema.select('projectContextId').first({
            id: revision.extractionSchemaId,
          })
        : null
      if (!revision || !schema || schema.projectContextId !== input.projectContextId)
        return 'not-found' as const
      if (
        !(await orm.public.ProjectContext.select('id').first({
          id: input.projectContextId,
          researcherAccountId: this.researcherAccountId,
        }))
      )
        return 'not-found' as const
      // Already stabilised: the recorded timestamp is the answer, and a
      // repeated request never moves it.
      if (revision.stabilisedAt)
        return {
          schemaRevisionId: revision.id,
          stabilisedAt: revision.stabilisedAt.toISOString(),
        }
      // Stabilising unlocks collection-scale extraction, so it requires a finalized durable pilot review whose current
      // result cut this revision produced.
      const nativeIds = await orm.extraction_runtime.Head.where({ projectId: input.projectContextId, deleted: false }).select('id').all()
      const summaries = await readDurableSummaries(orm, await readRuntimeHeads(orm, nativeIds.map(row => row.id)))
      if (![...summaries.values()].some(summary => summary.review?.schemaRevisionId === input.schemaRevisionId))
        return 'not-ready' as const
      const stabilisedAt = new Date()
      const updated = await orm.public.SchemaRevision.where({
        id: input.schemaRevisionId,
        stabilisedAt: null,
      }).updateAll({ stabilisedAt })
      if (updated.length !== 1) return 'not-ready' as const
      return {
        schemaRevisionId: input.schemaRevisionId,
        stabilisedAt: stabilisedAt.toISOString(),
      }
    })
  }
}

/**
 * The researcher-scoped persistence behind ExtractionModule. Admission always commits through the shared pool
 * (withPoolClientTransaction); `database` carries every other read and write.
 */
export function createResearcherExtractionPersistence(
  researcherAccountId: string,
  execution: ExtractionExecution,
  infrastructure: Readonly<{ database?: Database }> = {},
): ExtractionPersistence {
  return new ResearcherPostgresExtractionPersistence(researcherAccountId, execution, infrastructure.database ?? db)
}
