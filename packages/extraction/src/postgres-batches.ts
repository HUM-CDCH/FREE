/**
 * Owns the Batch Extraction read model: a batch is its member durable Extractions, each with its head's status, and the
 * batch's status follows from theirs. Each member keeps its own result/decision cuts, reviewed and exported through
 * the durable repository.
 */

import type { Database, DatabaseOrm } from 'db'
import { durableStatus } from './durable-contract.js'
import { modelChoice, recordedSettings, type ActiveSettings } from './extraction-method.js'
import { deriveAttempts, readAttemptRows } from './postgres-attempts.js'
import { ownsResearcherBatch } from './postgres-ownership.js'
import type {
  BatchExtractionMemberSnapshot,
  BatchExtractionSnapshot,
  ExtractionModelChoice,
  ExtractionStrategy,
  ProjectOperationStatus,
} from './types.js'

export type DurableBatchExtraction = Readonly<{
  batchExtractionId: string
  projectContextId: string
  schemaRevisionId: string
  extractionSchemaId: string
  extractionSchemaName: string
  schemaRevisionNumber: number
  strategy: ExtractionStrategy
  /** The batch's one admitted method, which every member was admitted with; null for a batch admitted before
   *  methods were recorded. */
  requestedModels: ExtractionModelChoice | null
  requestedSettings: ActiveSettings | null
  executionStatus: ProjectOperationStatus
  createdAt: Date
  members: readonly BatchExtractionMemberSnapshot[]
}>

export function snapshot(batch: DurableBatchExtraction): BatchExtractionSnapshot {
  return {
    batchExtractionId: batch.batchExtractionId,
    projectContextId: batch.projectContextId,
    schemaRevisionId: batch.schemaRevisionId,
    extractionSchemaId: batch.extractionSchemaId,
    extractionSchemaName: batch.extractionSchemaName,
    schemaRevisionNumber: batch.schemaRevisionNumber,
    strategy: batch.strategy,
    executionStatus: batch.executionStatus,
    createdAt: batch.createdAt,
    members: batch.members,
  }
}

/**
 * Batches with their members: the batch's durable Extraction rows are its selection, each with its head's status. A
 * batch is QUEUED while every member is, COMPLETED once every member is completed, failed or stopped, and RUNNING
 * otherwise (a paused member keeps it running until it is resumed or stopped).
 */
export async function loadBatches(
  orm: DatabaseOrm,
  projectContextId: string,
  batchExtractionIds: readonly string[],
): Promise<DurableBatchExtraction[]> {
  if (batchExtractionIds.length === 0) return []
  const batches = await orm.public.BatchExtraction.where((batch) => batch.id.in([...batchExtractionIds]))
    .where({ projectContextId })
    .select('id', 'schemaRevisionId', 'strategy', 'requestedModels', 'requestedSettings', 'createdAt')
    .all()
  if (batches.length === 0) return []
  const memberIds = await orm.public.Extraction.where((row) => row.batchExtractionId.in(batches.map((batch) => batch.id)))
    .select('id')
    .all()
  const derived = await deriveAttempts(orm, memberIds.length === 0 ? [] : await readAttemptRows(orm, memberIds.map((row) => row.id)))
  const schemas = await orm.public.SchemaRevision.where(row => row.id.in(batches.map(batch => batch.schemaRevisionId)))
    .select('id', 'extractionSchemaId', 'revisionNumber').all()
  const owners = schemas.length ? await orm.public.ExtractionSchema.where(row => row.id.in(schemas.map(schema => schema.extractionSchemaId)))
    .select('id', 'name').all() : []
  const schemasById = new Map(schemas.map(schema => [schema.id, schema]))
  const ownersById = new Map(owners.map(owner => [owner.id, owner]))
  const loaded: DurableBatchExtraction[] = []
  for (const id of batchExtractionIds) {
    const batch = batches.find((candidate) => candidate.id === id)
    if (!batch) continue
    const durableMembers = [...derived.values()].filter(({ row }) => row.batchExtractionId === batch.id)
    // A Batch Extraction is visible only while at least one of its members has a live durable head.
    if (durableMembers.length === 0) continue
    const schema = schemasById.get(batch.schemaRevisionId)
    const owner = schema ? ownersById.get(schema.extractionSchemaId) : null
    if (!schema || !owner) throw new Error('Stored Batch Extraction pins are unavailable.')
    const members: BatchExtractionMemberSnapshot[] = durableMembers
      .sort((left, right) => left.row.sourceDocumentId.localeCompare(right.row.sourceDocumentId))
      .map(({ row, head, completed, reviewable, currentReview }) => ({
        extractionId: row.id,
        sourceDocumentId: row.sourceDocumentId,
        sourceRepresentationRevisionId: row.sourceRepresentationRevisionId,
        executionStatus: durableStatus(head),
        completed,
        reviewable,
        // Pilot progress counts a finalized current cut produced by this batch's own Schema Revision only.
        currentReview: currentReview?.schemaRevisionId === batch.schemaRevisionId ? currentReview : null,
      }))
    const executionStatus: ProjectOperationStatus =
      members.length > 0 && members.every((member) => member.executionStatus === 'QUEUED')
        ? 'QUEUED'
        : members.every((member) => member.executionStatus === 'COMPLETED' || member.executionStatus === 'FAILED' || member.executionStatus === 'STOPPED')
          ? 'COMPLETED'
          : 'RUNNING'
    loaded.push({
      batchExtractionId: batch.id,
      projectContextId,
      schemaRevisionId: batch.schemaRevisionId,
      extractionSchemaId: schema.extractionSchemaId,
      extractionSchemaName: owner.name,
      schemaRevisionNumber: schema.revisionNumber,
      strategy: batch.strategy as ExtractionStrategy,
      requestedModels: modelChoice(batch.requestedModels),
      // A batch has no recipe: its members pin none.
      requestedSettings: recordedSettings(batch.requestedSettings, batch.strategy as ExtractionStrategy, null),
      executionStatus,
      createdAt: batch.createdAt,
      members,
    })
  }
  return loaded
}

export async function loadBatch(
  orm: DatabaseOrm,
  projectContextId: string,
  batchExtractionId: string,
): Promise<DurableBatchExtraction | null> {
  return (await loadBatches(orm, projectContextId, [batchExtractionId]))[0] ?? null
}

export async function readBatchForResearcher(
  database: Database,
  researcherAccountId: string,
  projectContextId: string,
  batchExtractionId: string,
): Promise<DurableBatchExtraction | null> {
  const owned = await database.transaction((transaction) =>
    ownsResearcherBatch(transaction, researcherAccountId, projectContextId, batchExtractionId))
  if (!owned) return null
  return loadBatch(database.orm, projectContextId, batchExtractionId)
}
