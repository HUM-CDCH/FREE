/**
 * Owns how an Extraction attempt reads: its row, its status derived from the row's outcome or else its workflow's DBOS
 * status (never mirrored), and its wire snapshot with the latest finalized review. Every read of an Extraction, a
 * document's attempts and a batch's members goes through here; so does the reviewed-value codec the snapshots decode.
 */

import {
  executionOf,
  INTERRUPTED_FAILURE,
  type DatabaseOrm,
  type WorkflowStatuses,
} from 'db'
import { durableHeadSchema, durableStatus, durableValueSchema, type DurableHead } from './durable-contract.js'
import { extractWorkflowId } from './kei-handoff.js'
import { modelChoice, recordedSettings } from './extraction-method.js'
import type {
  DocumentExtractionsSnapshot,
  ExtractionAttemptSnapshot,
  ExtractionFailure,
  ExtractionSnapshot,
  ExtractionStrategy,
  ExtractionExecutionStatus,
  ReadDocumentExtractionsInput,
} from './types.js'

export const encodeReviewedValue = (value: unknown) =>
  value === null ? null : { value }

export function decodeReviewedValue(stored: unknown): unknown {
  if (stored === null) return null
  const envelope = typeof stored === 'string'
    ? JSON.parse(stored) as unknown
    : stored
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    Array.isArray(envelope) ||
    !Object.hasOwn(envelope, 'value')
  )
    throw new Error('Stored reviewed value is invalid.')
  return (envelope as { value: unknown }).value
}

export function failureMessage(failure: unknown): string | null {
  if (!failure || typeof failure !== 'object') return null
  const stored = failure as { code?: unknown; message?: unknown }
  if (stored.code === 'unexpected_failure') return 'The operation failed unexpectedly.'
  return typeof stored.message === 'string' ? stored.message : null
}

/** One Extraction row as reads use it. */
export function readAttemptRows(orm: DatabaseOrm, extractionIds: readonly string[]) {
  return orm.public.Extraction.where((row) => row.id.in([...extractionIds]))
    .select(
      'id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe',
      'requestedModels', 'requestedSettings', 'outcome', 'complete', 'modelAttribution',
      'diagnostics', 'failure', 'resultPayload', 'evidenceLinks',
      'reviewable', 'batchExtractionId', 'createdAt', 'reviewedAt',
    )
    .all()
}
export type AttemptRow = Awaited<ReturnType<typeof readAttemptRows>>[number]
/** A row and how its work stands: from its outcome, or else from its workflow's DBOS status. */
type DerivedAttempt = Readonly<{
  row: AttemptRow
  executionStatus: ExtractionExecutionStatus
  failure: ExtractionFailure | null
  durable?: true
  finalizedReview?: {snapshotVersion:number;feedbackVersion:number;createdAt:Date} | null
  durableReview?: {snapshotVersion:number;feedbackVersion:number;createdAt:Date;schemaRevisionId:string}
}>

const INTERRUPTED: ExtractionFailure = { ...INTERRUPTED_FAILURE, phase: 'extracting' }

function settledAttempt(row: AttemptRow): DerivedAttempt | null {
  if (row.outcome === 'SUCCEEDED') return { row, executionStatus: 'COMPLETED', failure: null }
  // A failed or cancelled Extraction keeps today's wire shape: FAILED with its failure (plan decision 6).
  if (row.outcome !== null) return { row, executionStatus: 'FAILED', failure: row.failure as ExtractionFailure | null }
  return null
}

/**
 * Status is derived, never mirrored (spec, *Status and ownership*): an outcome on the row wins; the other rows take
 * their `extract:<id>` workflow's DBOS status in one call. A row whose workflow is no longer live is read again: a
 * SUCCESS workflow wrote its outcome just now, and a cancel writes its outcome before it stops the workflow, so an
 * outcome committed between the two reads still wins. A row that still has none is interrupted, never perpetually
 * running. A DBOS outage rejects.
 */
export async function deriveAttempts(
  orm: DatabaseOrm,
  statuses: WorkflowStatuses,
  rows: readonly AttemptRow[],
): Promise<ReadonlyMap<string, DerivedAttempt>> {
  const heads = await readRuntimeHeads(orm, rows.map(row=>row.id))
  const durableReviews=await readDurableReviews(orm,heads)
  const finalizations = heads.size ? await orm.extraction_runtime.Finalization.where(row=>row.extractionId.in([...heads.keys()]))
    .select('extractionId','snapshotVersion','feedbackVersion','createdAt').orderBy(row=>row.createdAt.desc()).all() : []
  const unsettled = rows.filter((row) => row.outcome === null && !heads.has(row.id))
  const current = unsettled.length === 0
    ? new Map<string, string>()
    : await statuses(unsettled.map((row) => extractWorkflowId(row.id)))
  const reread = unsettled.filter((row) => {
    const execution = executionOf(current.get(extractWorkflowId(row.id)))
    return execution === 'REREAD' || execution === 'INTERRUPTED'
  })
  const reloaded = new Map(
    (reread.length === 0 ? [] : await readAttemptRows(orm, reread.map((row) => row.id))).map((row) => [row.id, row]),
  )
  const derived = new Map<string, DerivedAttempt>()
  for (const read of rows) {
    const row = reloaded.get(read.id) ?? read
    const head = heads.get(row.id)
    if (head) {
      const executionStatus=durableStatus(head)
      derived.set(row.id,{row,executionStatus,failure:null,durable:true,durableReview:durableReviews.get(row.id),finalizedReview:finalizations.find(item=>item.extractionId===row.id)??null})
      continue
    }
    const settled = settledAttempt(row)
    if (settled) {
      derived.set(row.id, settled)
      continue
    }
    const execution = executionOf(current.get(extractWorkflowId(row.id)))
    derived.set(row.id, execution === 'QUEUED' || execution === 'RUNNING'
      ? { row, executionStatus: execution, failure: null }
      : { row, executionStatus: 'FAILED', failure: INTERRUPTED })
  }
  return derived
}

export async function readRuntimeHeads(orm: DatabaseOrm, ids: readonly string[]) {
  if (!ids.length) return new Map()
  const heads=await orm.extraction_runtime.Head.where(row=>row.id.in([...ids])).all()
  return new Map(heads.filter(h=>!h.deleted).map(h=>[h.id,durableHeadSchema.parse(h)]))
}

/** Guided pilot progress uses a finalized current result cut and its actual
 * producing schema. Historical or mixed-schema reviews never unlock an
 * adopted revision, and native reviews never mirror public reviewedAt. */
export async function readDurableReviews(orm:DatabaseOrm,heads:ReadonlyMap<string,DurableHead>) {
  const reviews=new Map<string,{snapshotVersion:number;feedbackVersion:number;createdAt:Date;schemaRevisionId:string}>()
  if(!heads.size)return reviews
  const finalizations=await orm.extraction_runtime.Finalization.where(row=>row.extractionId.in([...heads.keys()]))
    .select('extractionId','snapshotVersion','feedbackVersion','createdAt').orderBy(row=>row.createdAt.desc()).all()
  const snapshots=await orm.extraction_runtime.Snapshot.where(row=>row.extractionId.in([...heads.keys()]))
    .select('extractionId','version','values').all()
  for(const finalized of finalizations) {
    if(reviews.has(finalized.extractionId)||finalized.snapshotVersion!==heads.get(finalized.extractionId)?.snapshotVersion)continue
    const snapshot=snapshots.find(row=>row.extractionId===finalized.extractionId&&row.version===finalized.snapshotVersion)
    if(!snapshot)continue
    const values=durableValueSchema.array().parse(snapshot.values).filter(value=>value.processing==='saved')
    const schemaRevisionId=values[0]?.schemaRevisionId
    if(!schemaRevisionId||values.some(value=>value.schemaRevisionId!==schemaRevisionId))continue
    reviews.set(finalized.extractionId,{snapshotVersion:finalized.snapshotVersion,feedbackVersion:finalized.feedbackVersion,
      createdAt:finalized.createdAt,schemaRevisionId})
  }
  return reviews
}

async function pinsOf(orm: DatabaseOrm, row: AttemptRow) {
  const representation = await orm.public.SourceRepresentationRevision.select('revisionNumber', 'preprocessId').first({
    id: row.sourceRepresentationRevisionId,
    sourceDocumentId: row.sourceDocumentId,
  })
  const schema = await orm.public.SchemaRevision.select('extractionSchemaId', 'revisionNumber').first({
    id: row.schemaRevisionId,
  })
  if (!representation || !schema) throw new Error('Stored Extraction pins are unavailable.')
  return {
    extractionId: row.id,
    sourceDocumentId: row.sourceDocumentId,
    sourceRepresentationRevisionId: row.sourceRepresentationRevisionId,
    sourceRepresentationRevisionNumber: representation.revisionNumber,
    preprocessId: representation.preprocessId,
    schemaRevisionId: row.schemaRevisionId,
    extractionSchemaId: schema.extractionSchemaId,
    schemaRevisionNumber: schema.revisionNumber,
    strategy: row.strategy as ExtractionStrategy,
    catalogRecipe: row.catalogRecipe,
    requestedModels: modelChoice(row.requestedModels),
    requestedSettings: recordedSettings(row.requestedSettings, row.strategy as ExtractionStrategy, row.catalogRecipe),
    batchExtractionId: row.batchExtractionId,
    createdAt: row.createdAt,
  }
}

/** A published (SUCCEEDED) Extraction with its latest finalized review. */
export async function extractionSnapshot(orm: DatabaseOrm, row: AttemptRow): Promise<ExtractionSnapshot> {
  if (row.outcome !== 'SUCCEEDED') throw new Error('Only a published Extraction has a result snapshot.')
  const review = await orm.public.ExtractionReview.where({ extractionId: row.id })
    .select('id')
    .orderBy((candidate) => candidate.revisionNumber.desc())
    .first()
  const decisions = row.reviewedAt && review
    ? await orm.public.ReviewDecision.where({ extractionReviewId: review.id })
      .select(
        'resultPath',
        'resultPathKey',
        'evidenceAnchorId',
        'reviewedOccurrenceIds',
        'action',
        'reviewedValue',
        'reviewedEvidence',
        'createdAt',
      )
      .orderBy((decision) => decision.resultPathKey.asc()).all()
    : []
  return {
    ...(await pinsOf(orm, row)),
    outcome: 'SUCCEEDED',
    complete: row.complete,
    modelAttribution: row.modelAttribution as ExtractionSnapshot['modelAttribution'],
    diagnostics: row.diagnostics as ExtractionSnapshot['diagnostics'],
    result: row.resultPayload as ExtractionSnapshot['result'],
    evidence: row.evidenceLinks as ExtractionSnapshot['evidence'],
    failure: null,
    reviewable: row.reviewable,
    reviewedAt: row.reviewedAt,
    reviewDecisions: decisions.map((decision) => ({
      resultPath: decision.resultPath as ExtractionSnapshot['reviewDecisions'][number]['resultPath'],
      evidenceAnchorId: decision.evidenceAnchorId,
      reviewedOccurrenceIds: decision.reviewedOccurrenceIds as string[],
      action: decision.action as ExtractionSnapshot['reviewDecisions'][number]['action'],
      reviewedValue: decodeReviewedValue(decision.reviewedValue),
      ...(decision.reviewedEvidence
        ? { reviewedEvidence: decision.reviewedEvidence as ExtractionSnapshot['reviewDecisions'][number]['reviewedEvidence'] }
        : {}),
      createdAt: decision.createdAt,
    })),
  }
}

/** An attempt as the wire shows it: the full result once published; otherwise its status, its failure if any, and
 *  no result fields (plan decision 6). */
export async function attemptSnapshot(orm: DatabaseOrm, attempt: DerivedAttempt): Promise<ExtractionAttemptSnapshot> {
  if (!attempt.durable && attempt.row.outcome === 'SUCCEEDED')
    return { ...(await extractionSnapshot(orm, attempt.row)), executionStatus: 'COMPLETED' }
  return {
    ...(await pinsOf(orm, attempt.row)),
    executionStatus: attempt.executionStatus,
    ...(attempt.durable ? {durable:true as const,finalizedReview:attempt.finalizedReview??null}:{}),
    outcome: null,
    complete: null,
    modelAttribution: null,
    diagnostics: null,
    result: null,
    evidence: null,
    failure: attempt.failure,
    reviewable: false,
    reviewedAt: null,
    reviewDecisions: [],
  }
}

async function loadAttempts(
  orm: DatabaseOrm,
  statuses: WorkflowStatuses,
  extractionIds: readonly string[],
): Promise<ReadonlyMap<string, ExtractionAttemptSnapshot>> {
  const ids = [...new Set(extractionIds)]
  if (ids.length === 0) return new Map()
  const derived = await deriveAttempts(orm, statuses, await readAttemptRows(orm, ids))
  const attempts = new Map<string, ExtractionAttemptSnapshot>()
  for (const [id, attempt] of derived) attempts.set(id, await attemptSnapshot(orm, attempt))
  return attempts
}

export async function loadDocumentExtractions(
  orm: DatabaseOrm,
  statuses: WorkflowStatuses,
  input: ReadDocumentExtractionsInput,
): Promise<DocumentExtractionsSnapshot | null> {
  const rows = await orm.public.Extraction.where({ sourceDocumentId: input.sourceDocumentId })
    .select('id', 'batchExtractionId', 'outcome', 'sourceRepresentationRevisionId', 'requestedPages', 'createdAt',
      'reviewedAt')
    .all()
  // An interactive attempt in any state, or a published result of any kind: a pending or failed batch member is not a
  // result and never displaces one (spec, *One Extraction row*). A legacy sample row (`requestedPages` set) is neither.
  const whole = rows.filter((row) => row.requestedPages === null)
  const heads=await readRuntimeHeads(orm,whole.map(row=>row.id))
  const candidates = whole
    .filter((row) => row.batchExtractionId === null || row.outcome === 'SUCCEEDED' || heads.has(row.id))
    .sort((left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
  const currentRepresentationId = (await orm.public.SourceRepresentationRevision.where({
    sourceDocumentId: input.sourceDocumentId,
  }).select('id').orderBy([
    (revision) => revision.revisionNumber.desc(),
    (revision) => revision.id.desc(),
  ]).first())?.id
  const selected = input.extractionId
    ? (candidates.find((candidate) => candidate.id === input.extractionId) ?? null)
    : (candidates.find((candidate) => candidate.sourceRepresentationRevisionId === currentRepresentationId) ?? null)
  if (input.extractionId && !selected) return null
  const representationId = selected?.sourceRepresentationRevisionId ?? currentRepresentationId
  if (!representationId) return null
  const durableReviews=heads.size ? await orm.extraction_runtime.Finalization.where(row=>row.extractionId.in([...heads.keys()]))
    .select('extractionId','createdAt').orderBy(row=>row.createdAt.desc()).all() : []
  const reviewedTime=(row:typeof whole[number])=>heads.has(row.id)?durableReviews.find(item=>item.extractionId===row.id)?.createdAt??null:row.reviewedAt
  const latestReviewed = whole
    .filter((row) => heads.has(row.id)?reviewedTime(row)!==null:row.outcome === 'SUCCEEDED' && row.reviewedAt !== null)
    .sort((left, right) =>
      reviewedTime(right)!.getTime() - reviewedTime(left)!.getTime() ||
      right.createdAt.getTime() - left.createdAt.getTime() ||
      right.id.localeCompare(left.id))[0] ?? null
  const attempts = await loadAttempts(orm, statuses, [
    ...(selected ? [selected.id] : []),
    ...(latestReviewed ? [latestReviewed.id] : []),
  ])
  return {
    sourceRepresentationRevisionId: representationId,
    latestAttempt: selected ? attempts.get(selected.id) ?? null : null,
    latestReviewed: latestReviewed ? attempts.get(latestReviewed.id) ?? null : null,
  }
}
