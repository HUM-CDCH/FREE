/**
 * Owns the Batch Extraction read model: a batch is its member Extraction rows, each with its derived status, and the
 * batch's status follows from theirs. Results export each published member with its latest finalized review applied.
 */

import type { Database, DatabaseOrm, WorkflowStatuses } from 'db'
import {
  decodeReviewedValue,
  deriveAttempts,
  failureMessage,
  readAttemptRows,
  type AttemptRow,
} from './postgres-attempts.js'
import { ownsResearcherBatch } from './postgres-ownership.js'
import type {
  BatchExtractionResults,
  BatchExtractionSnapshot,
  ExtractionFailure,
  ExtractionStrategy,
  ProjectOperationStatus,
  ReadBatchInput,
  ResultPath,
  ReviewDecisionAction,
} from './types.js'

type BatchMember = Readonly<{
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  executionStatus: ProjectOperationStatus
  executionFailure: ExtractionFailure | null
  latestExtraction: BatchExtractionSnapshot['members'][number]['latestExtraction']
  /** The member's Extraction as read, for its result. */
  extraction: AttemptRow
}>
export type DurableBatchExtraction = Readonly<{
  batchExtractionId: string
  projectContextId: string
  schemaRevisionId: string
  extractionSchemaId: string
  extractionSchemaName: string
  schemaRevisionNumber: number
  strategy: ExtractionStrategy
  executionStatus: ProjectOperationStatus
  createdAt: Date
  members: readonly BatchMember[]
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
    members: batch.members.map((member) => ({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
      executionStatus: member.executionStatus,
      failureMessage: failureMessage(member.executionFailure),
      latestExtraction: member.latestExtraction,
    })),
  }
}

/**
 * Batches with their members: the batch's Extraction rows are its selection, and a member without an outcome takes
 * its status from DBOS, read once for every listed batch. A batch is QUEUED while every member is, COMPLETED once
 * every surviving member is settled or interrupted, and RUNNING otherwise.
 */
export async function loadBatches(
  orm: DatabaseOrm,
  statuses: WorkflowStatuses,
  projectContextId: string,
  batchExtractionIds: readonly string[],
): Promise<DurableBatchExtraction[]> {
  if (batchExtractionIds.length === 0) return []
  const batches = await orm.public.BatchExtraction.where((batch) => batch.id.in([...batchExtractionIds]))
    .where({ projectContextId })
    .select('id', 'schemaRevisionId', 'strategy', 'createdAt')
    .all()
  if (batches.length === 0) return []
  const memberIds = await orm.public.Extraction.where((row) => row.batchExtractionId.in(batches.map((batch) => batch.id)))
    .select('id')
    .all()
  const rows = memberIds.length === 0 ? [] : await readAttemptRows(orm, memberIds.map((row) => row.id))
  const derived = await deriveAttempts(orm, statuses, rows)
  const loaded: DurableBatchExtraction[] = []
  for (const id of batchExtractionIds) {
    const batch = batches.find((candidate) => candidate.id === id)
    if (!batch) continue
    const schema = await orm.public.SchemaRevision.select('extractionSchemaId', 'revisionNumber').first({
      id: batch.schemaRevisionId,
    })
    const owner = schema
      ? await orm.public.ExtractionSchema.select('name').first({ id: schema.extractionSchemaId })
      : null
    if (!schema || !owner) throw new Error('Stored Batch Extraction pins are unavailable.')
    const members: BatchMember[] = rows
      .filter((row) => row.batchExtractionId === batch.id)
      .sort((left, right) => left.sourceDocumentId.localeCompare(right.sourceDocumentId))
      .map((read) => {
        const { row, executionStatus, failure } = derived.get(read.id)!
        return {
          sourceDocumentId: row.sourceDocumentId,
          sourceRepresentationRevisionId: row.sourceRepresentationRevisionId,
          executionStatus,
          executionFailure: failure,
          latestExtraction: row.outcome === 'SUCCEEDED'
            ? {
                extractionId: row.id,
                outcome: row.outcome,
                complete: row.complete,
                reviewable: row.reviewable,
                createdAt: row.createdAt,
                reviewedAt: row.reviewedAt,
              }
            : null,
          extraction: row,
        }
      })
    const executionStatus: ProjectOperationStatus =
      members.length > 0 && members.every((member) => member.executionStatus === 'QUEUED')
        ? 'QUEUED'
        : members.every((member) => member.executionStatus === 'COMPLETED' || member.executionStatus === 'FAILED')
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
      executionStatus,
      createdAt: batch.createdAt,
      members,
    })
  }
  return loaded
}

export async function loadBatch(
  orm: DatabaseOrm,
  statuses: WorkflowStatuses,
  projectContextId: string,
  batchExtractionId: string,
): Promise<DurableBatchExtraction | null> {
  return (await loadBatches(orm, statuses, projectContextId, [batchExtractionId]))[0] ?? null
}

type ResultDecision = Readonly<{
  resultPath: ResultPath
  action: ReviewDecisionAction
  reviewedValue: unknown
}>

/** Mirrors the client-side projection in `reviewDecisions.ts` (`applyReviewDecisions`),
 *  so an exported Batch result reflects a saved review the same way the Studio UI does:
 *  REJECTED clears the value, EDITED overwrites it, APPROVED leaves the raw value alone. */
function applyReviewDecisionsToResult(result: unknown, decisions: readonly ResultDecision[]): unknown {
  const copy = structuredClone(result)
  for (const decision of decisions) {
    if (decision.action === 'APPROVED') continue
    setAtPath(copy, decision.resultPath, decision.action === 'EDITED' ? decision.reviewedValue : null)
  }
  return copy
}

function setAtPath(root: unknown, path: readonly (string | number)[], value: unknown) {
  if (path.length === 0) return
  let parent = root
  for (const segment of path.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object') return
    parent = (parent as Record<string | number, unknown>)[segment]
  }
  if (parent !== null && typeof parent === 'object')
    (parent as Record<string | number, unknown>)[path[path.length - 1]] = value
}

/** Batch-loads only the latest finalized revision for each Extraction. */
async function loadFinalizedDecisions(
  orm: DatabaseOrm,
  extractionIds: readonly string[],
): Promise<Map<string, readonly ResultDecision[]>> {
  const revisions = await orm.public.ExtractionReview
    .where((review) => review.extractionId.in([...extractionIds]))
    .select('id', 'extractionId')
    .orderBy((review) => review.revisionNumber.desc())
    .all()
  const latest = new Map<string, (typeof revisions)[number]>()
  for (const review of revisions)
    if (!latest.has(review.extractionId)) latest.set(review.extractionId, review)
  const reviews = [...latest.values()]
  const byExtractionId = new Map<string, ResultDecision[]>()
  if (reviews.length === 0) return byExtractionId
  const extractionIdByReviewId = new Map(reviews.map((review) => [review.id, review.extractionId]))
  const decisionRows = await orm.public.ReviewDecision
    .where((decision) => decision.extractionReviewId.in(reviews.map((review) => review.id)))
    .select('extractionReviewId', 'resultPath', 'action', 'reviewedValue')
    .all()
  for (const row of decisionRows) {
    const extractionId = extractionIdByReviewId.get(row.extractionReviewId)
    if (!extractionId) continue
    const bucket = byExtractionId.get(extractionId) ?? []
    bucket.push({
      resultPath: row.resultPath as ResultPath,
      action: row.action as ReviewDecisionAction,
      reviewedValue: decodeReviewedValue(row.reviewedValue),
    })
    byExtractionId.set(extractionId, bucket)
  }
  return byExtractionId
}

export async function loadResults(
  orm: DatabaseOrm,
  statuses: WorkflowStatuses,
  input: ReadBatchInput,
): Promise<BatchExtractionResults | null> {
  const batch = await loadBatch(orm, statuses, input.projectContextId, input.batchExtractionId)
  if (!batch) return null
  const reviewedExtractionIds = batch.members
    .map((member) => member.extraction)
    .filter((extraction) =>
      extraction.outcome === 'SUCCEEDED' && extraction.resultPayload !== null && extraction.reviewedAt !== null)
    .map((extraction) => extraction.id)
  const decisionsByExtractionId = reviewedExtractionIds.length > 0
    ? await loadFinalizedDecisions(orm, reviewedExtractionIds)
    : new Map<string, readonly ResultDecision[]>()
  const results: Array<BatchExtractionResults['results'][number]> = []
  let pending = 0
  let failed = 0
  let cancelled = 0
  for (const member of batch.members) {
    const { extraction } = member
    if (member.executionStatus === 'QUEUED' || member.executionStatus === 'RUNNING') {
      pending += 1
      continue
    }
    if (extraction.outcome !== 'SUCCEEDED') {
      // kei's own cancel settles FAILED with code `cancelled`: a cancellation either way. Interrupted work failed.
      if (extraction.outcome === 'CANCELLED' || member.executionFailure?.code === 'cancelled') cancelled += 1
      else failed += 1
      continue
    }
    if (extraction.resultPayload === null) continue
    const decisions = decisionsByExtractionId.get(extraction.id)
    results.push({
      sourceDocumentId: member.sourceDocumentId,
      extractionId: extraction.id,
      result: (decisions
        ? applyReviewDecisionsToResult(extraction.resultPayload, decisions)
        : extraction.resultPayload) as Record<string, unknown>,
    })
  }
  return {
    batchExtractionId: batch.batchExtractionId,
    executionStatus: batch.executionStatus,
    totalMembers: batch.members.length,
    successfulResults: results.length,
    pending,
    failed,
    cancelled,
    results,
  }
}

export async function readBatchForResearcher(
  database: Database,
  researcherAccountId: string,
  projectContextId: string,
  batchExtractionId: string,
  statuses: WorkflowStatuses,
): Promise<DurableBatchExtraction | null> {
  const owned = await database.transaction((transaction) =>
    ownsResearcherBatch(transaction, researcherAccountId, projectContextId, batchExtractionId))
  if (!owned) return null
  return loadBatch(database.orm, statuses, projectContextId, batchExtractionId)
}
