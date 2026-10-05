/**
 * Owns how a durable Extraction reads: its public row's pins, its status from its coordination head (ADR 0017: the
 * head owns the visible lifecycle; DBOS dispatches and recovers attempts), and its latest named finalization. Every read
 * of an Extraction, a document's attempts and a batch's members goes through here. A public Extraction row without a
 * live durable head is not an Extraction this reader shows: it is neither listed, opened nor counted.
 */

import type { DatabaseOrm } from 'db'
import { durableHeadSchema, durableStatus, durableValueSchema, type DurableHead } from './durable-contract.js'
import { modelChoice, recordedSettings } from './extraction-method.js'
import type {
  DocumentExtractionsSnapshot,
  ExtractionAttemptSnapshot,
  ExtractionStrategy,
  FinalizedReview,
  ReadDocumentExtractionsInput,
} from './types.js'

/** One Extraction row as reads use it. */
export function readAttemptRows(orm: DatabaseOrm, extractionIds: readonly string[]) {
  return orm.public.Extraction.where((row) => row.id.in([...extractionIds]))
    .select(
      'id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe',
      'requestedModels', 'requestedSettings', 'batchExtractionId', 'createdAt',
    )
    .all()
}
export type AttemptRow = Awaited<ReturnType<typeof readAttemptRows>>[number]

/** A row with its durable head, current-cut review summary and latest finalization. */
export type DerivedAttempt = Readonly<{
  row: AttemptRow
  head: DurableHead
  /** The latest named finalization of any of its cuts; the cut it names stays openable beside later work. */
  finalizedReview: FinalizedReview | null
  /** Whether its current result cut holds saved values to review. */
  reviewable: boolean
  /** A finalization of its current cut whose values share one producing schema (guided pilot progress). */
  currentReview: (FinalizedReview & Readonly<{ schemaRevisionId: string }>) | null
}>

export async function readRuntimeHeads(orm: DatabaseOrm, ids: readonly string[]): Promise<ReadonlyMap<string, DurableHead>> {
  if (!ids.length) return new Map()
  const heads = await orm.extraction_runtime.Head.where(row => row.id.in([...ids])).all()
  return new Map(heads.filter(h => !h.deleted).map(h => [h.id, durableHeadSchema.parse(h)]))
}

/** Guided pilot progress uses a finalized current result cut and its actual
 * producing schema. Historical or mixed-schema reviews never unlock an
 * adopted revision. */
export async function readDurableSummaries(orm: DatabaseOrm, heads: ReadonlyMap<string, DurableHead>) {
  const summaries = new Map<string, { reviewable: boolean; review: DerivedAttempt['currentReview'] }>()
  await Promise.all([...heads.values()].map(async head => {
    // Read only the current cut, never every historical snapshot's payload.
    const snapshot = await orm.extraction_runtime.Snapshot.select('values').first({ extractionId: head.id, version: head.snapshotVersion })
    const values = snapshot ? durableValueSchema.array().parse(snapshot.values).filter(value => value.processing === 'saved') : []
    const summary: { reviewable: boolean; review: DerivedAttempt['currentReview'] } = { reviewable: values.length > 0, review: null }
    summaries.set(head.id, summary)
    const schemaRevisionId = values[0]?.schemaRevisionId
    if (!schemaRevisionId || values.some(value => value.schemaRevisionId !== schemaRevisionId)) return
    const finalized = await orm.extraction_runtime.Finalization.where({ extractionId: head.id, snapshotVersion: head.snapshotVersion })
      .select('snapshotVersion', 'feedbackVersion', 'createdAt').orderBy(row => row.createdAt.desc()).first()
    if (finalized) summary.review = { ...finalized, schemaRevisionId }
  }))
  return summaries
}

/** The durable Extractions among `rows`, each with its head and review summaries; rows without a live head are omitted. */
export async function deriveAttempts(
  orm: DatabaseOrm,
  rows: readonly AttemptRow[],
): Promise<ReadonlyMap<string, DerivedAttempt>> {
  const heads = await readRuntimeHeads(orm, rows.map(row => row.id))
  const summaries = await readDurableSummaries(orm, heads)
  const finalizations = heads.size ? await orm.extraction_runtime.Finalization.where(row => row.extractionId.in([...heads.keys()]))
    .select('extractionId', 'snapshotVersion', 'feedbackVersion', 'createdAt').orderBy(row => row.createdAt.desc()).all() : []
  const derived = new Map<string, DerivedAttempt>()
  for (const row of rows) {
    const head = heads.get(row.id)
    if (!head) continue
    const finalized = finalizations.find(item => item.extractionId === row.id)
    derived.set(row.id, {
      row, head,
      finalizedReview: finalized
        ? { snapshotVersion: finalized.snapshotVersion, feedbackVersion: finalized.feedbackVersion, createdAt: finalized.createdAt }
        : null,
      reviewable: summaries.get(row.id)?.reviewable ?? false,
      currentReview: summaries.get(row.id)?.review ?? null,
    })
  }
  return derived
}

/** An Extraction as the wire shows it: its pins, its durable status and its latest finalized review cut. Values,
 *  decisions and history are read from the durable repository. */
export async function attemptSnapshot(orm: DatabaseOrm, attempt: DerivedAttempt): Promise<ExtractionAttemptSnapshot> {
  const { row } = attempt
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
    executionStatus: durableStatus(attempt.head),
    finalizedReview: attempt.finalizedReview,
  }
}

async function loadAttempts(
  orm: DatabaseOrm,
  extractionIds: readonly string[],
): Promise<ReadonlyMap<string, ExtractionAttemptSnapshot>> {
  const ids = [...new Set(extractionIds)]
  if (ids.length === 0) return new Map()
  const derived = await deriveAttempts(orm, await readAttemptRows(orm, ids))
  const attempts = new Map<string, ExtractionAttemptSnapshot>()
  for (const [id, attempt] of derived) attempts.set(id, await attemptSnapshot(orm, attempt))
  return attempts
}

export async function loadDocumentExtractions(
  orm: DatabaseOrm,
  input: ReadDocumentExtractionsInput,
): Promise<DocumentExtractionsSnapshot | null> {
  const rows = await orm.public.Extraction.where({ sourceDocumentId: input.sourceDocumentId })
    .select('id', 'sourceRepresentationRevisionId', 'createdAt')
    .all()
  const heads = await readRuntimeHeads(orm, rows.map(row => row.id))
  // Every durable Extraction of the document, interactive or a batch member, in any lifecycle state.
  const candidates = rows.filter(row => heads.has(row.id))
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
  // "Latest reviewed" is the Extraction with the most recent named finalization; its snapshot names that cut.
  const finalizations = heads.size ? await orm.extraction_runtime.Finalization.where(row => row.extractionId.in([...heads.keys()]))
    .select('extractionId', 'createdAt').orderBy(row => row.createdAt.desc()).all() : []
  const reviewedTime = (id: string) => finalizations.find(item => item.extractionId === id)?.createdAt ?? null
  const latestReviewed = candidates
    .filter((row) => reviewedTime(row.id) !== null)
    .sort((left, right) =>
      reviewedTime(right.id)!.getTime() - reviewedTime(left.id)!.getTime() ||
      right.createdAt.getTime() - left.createdAt.getTime() ||
      right.id.localeCompare(left.id))[0] ?? null
  const attempts = await loadAttempts(orm, [
    ...(selected ? [selected.id] : []),
    ...(latestReviewed ? [latestReviewed.id] : []),
  ])
  return {
    sourceRepresentationRevisionId: representationId,
    latestAttempt: selected ? attempts.get(selected.id) ?? null : null,
    latestReviewed: latestReviewed ? attempts.get(latestReviewed.id) ?? null : null,
  }
}
