import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Error as DBOSErrors } from '@dbos-inc/dbos-sdk'
import {
  canonicalPackageStore,
  db,
  executionOf,
  INTERRUPTED_FAILURE,
  isUniqueViolation,
  lockSourceDocumentRow,
  stableJson,
  stableUuid,
  withPoolClientTransaction,
  type CanonicalPackageStore,
  type Database,
  type DatabaseOrm,
  type DatabaseTransaction,
  type WorkflowStatuses,
} from 'db'
import { BATCH_EXTRACTION_SELECTION_LIMIT } from './batch.js'
import type {
  ExtractionExecution,
  ExtractionPersistence,
  LoadedExtractionInputs,
  PersistedReviewResult,
} from './dependencies.js'
import { ExtractionError } from './errors.js'
import { extractWorkflowId } from './kei-handoff.js'
import { modelChoice } from './model-choice.js'
import { persistSuggestedBatch } from './postgres-suggested-batch.js'
import { normalizeDecisions, reviewAuthorityMatchesExtraction, type ReviewAuthority } from './review-rules.js'
import {
  EXTRACTION_QUEUE,
  extractionAttributes,
  RUN_EXTRACTION,
  type AdmittedExtraction,
  type ExtractionStore,
  type SettledExtraction,
} from './workflows.js'
import type {
  BatchExtractionResults,
  BatchExtractionSnapshot,
  CancellationResult,
  DocumentExtractionsSnapshot,
  ExtractionAttemptSnapshot,
  ExtractionFailure,
  ExtractionModelChoice,
  ExtractionSnapshot,
  ExtractionStrategy,
  ProjectOperationStatus,
  ReadBatchInput,
  ReadDocumentExtractionsInput,
  ResultPath,
  ReviewDecisionAction,
  ReviewDraft,
  RunSingleInput,
  RunSingleResult,
  ScheduleBatchInput,
  ScheduleBatchResult,
  ScheduleSuggestedBatchInput,
} from './types.js'

const SUPERSEDED_MESSAGE =
  "This document has been reprocessed. No new Extraction was started. Open the document from the project's Sources list to run on its current source revision. You can continue reviewing this earlier Extraction."
const EXTRACTION_KEY = 'extraction_pkey'
const BATCH_KEY = 'batchExtraction_pkey'

/**
 * The statuses of work admitted just now: each workflow was enqueued in the transaction that committed its row, so it
 * is QUEUED (an outcome on the row still wins). A created admission answers with them, so a DBOS read cannot turn a
 * committed admission into a failure the client would retry with a new identity.
 */
const JUST_ADMITTED: WorkflowStatuses = async (workflowIds) => new Map(workflowIds.map((id) => [id, 'ENQUEUED']))

const encodeReviewedValue = (value: unknown) =>
  value === null ? null : { value }

function decodeReviewedValue(stored: unknown): unknown {
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

function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}
function selectionId(input: ScheduleBatchInput): string {
  const models = modelChoice(input.models)
  const hash = createHash('sha256')
    .update(JSON.stringify([
      input.projectContextId,
      input.schemaRevisionId,
      input.strategy,
      canonicalIds(input.sourceDocumentIds),
      ...(models === null ? [] : [models]),
    ]))
    .digest('hex')
  const variant = (['8', '9', 'a', 'b'] as const)[parseInt(hash[16]!, 16) & 3]
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
/** A batch member's Extraction ID: a replayed batch admission reproduces its members (plan decision 8). */
function batchMemberExtractionId(batchExtractionId: string, sourceDocumentId: string): string {
  return stableUuid('batch-member-extraction', stableJson([batchExtractionId, sourceDocumentId]))
}
function withoutNodeIds(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const node = { ...(value as Record<string, unknown>) }
  const children = node.children
  delete node.id
  delete node.children
  return {
    ...node,
    ...(Array.isArray(children)
      ? { children: children.map(withoutNodeIds) }
      : children === undefined ? {} : { children }),
  }
}
export function semanticSuggestionTree(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(withoutNodeIds)
  if (!tree || typeof tree !== 'object') return tree
  const { schemaNodes, ...definition } = tree as Record<string, unknown>
  return Array.isArray(schemaNodes)
    ? { ...definition, schemaNodes: schemaNodes.map(withoutNodeIds) }
    : tree
}
function failureMessage(failure: unknown): string | null {
  if (!failure || typeof failure !== 'object') return null
  const stored = failure as { code?: unknown; message?: unknown }
  if (stored.code === 'unexpected_failure') return 'The operation failed unexpectedly.'
  return typeof stored.message === 'string' ? stored.message : null
}

/** One Extraction row as reads use it. */
function readAttemptRows(orm: DatabaseOrm, extractionIds: readonly string[]) {
  return orm.public.Extraction.where((row) => row.id.in([...extractionIds]))
    .select(
      'id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe',
      'requestedModels', 'outcome', 'complete', 'modelAttribution', 'diagnostics', 'failure', 'resultPayload',
      'evidenceLinks',
      'reviewable', 'batchExtractionId', 'createdAt', 'reviewedAt',
    )
    .all()
}
type AttemptRow = Awaited<ReturnType<typeof readAttemptRows>>[number]
/** A row and how its work stands: from its outcome, or else from its workflow's DBOS status. */
type DerivedAttempt = Readonly<{
  row: AttemptRow
  executionStatus: ProjectOperationStatus
  failure: ExtractionFailure | null
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
async function deriveAttempts(
  orm: DatabaseOrm,
  statuses: WorkflowStatuses,
  rows: readonly AttemptRow[],
): Promise<ReadonlyMap<string, DerivedAttempt>> {
  const unsettled = rows.filter((row) => row.outcome === null)
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

async function pinsOf(orm: DatabaseOrm, row: AttemptRow) {
  const representation = await orm.public.SourceRepresentationRevision.select('revisionNumber').first({
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
    schemaRevisionId: row.schemaRevisionId,
    extractionSchemaId: schema.extractionSchemaId,
    schemaRevisionNumber: schema.revisionNumber,
    strategy: row.strategy as ExtractionStrategy,
    catalogRecipe: row.catalogRecipe,
    requestedModels: modelChoice(row.requestedModels),
    batchExtractionId: row.batchExtractionId,
    createdAt: row.createdAt,
  }
}

/** A published (SUCCEEDED) Extraction with its latest finalized review. */
async function extractionSnapshot(orm: DatabaseOrm, row: AttemptRow): Promise<ExtractionSnapshot> {
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
      createdAt: decision.createdAt,
    })),
  }
}

/** An attempt as the wire shows it: the full result once published; otherwise its status, its failure if any, and
 *  no result fields (plan decision 6). */
async function attemptSnapshot(orm: DatabaseOrm, attempt: DerivedAttempt): Promise<ExtractionAttemptSnapshot> {
  if (attempt.row.outcome === 'SUCCEEDED')
    return { ...(await extractionSnapshot(orm, attempt.row)), executionStatus: 'COMPLETED' }
  return {
    ...(await pinsOf(orm, attempt.row)),
    executionStatus: attempt.executionStatus,
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

/**
 * The one terminal write of an Extraction. The no-outcome predicate lives in the UPDATE (updateAll keeps its guards;
 * update selects an id first), so completion, failure and cancellation race to one winner, a replayed step finds the
 * outcome written, and a deleted row updates nothing.
 */
export async function settleExtraction(
  orm: DatabaseOrm,
  extractionId: string,
  settled: SettledExtraction,
): Promise<'settled' | 'already-settled' | 'missing'> {
  const fields = settled.outcome === 'SUCCEEDED'
    ? {
        outcome: 'SUCCEEDED' as const,
        complete: settled.extraction.complete,
        modelAttribution: settled.extraction.modelAttribution,
        diagnostics: settled.extraction.diagnostics,
        failure: null,
        resultPayload: settled.extraction.result,
        evidenceLinks: settled.extraction.evidence,
        reviewable: settled.extraction.reviewable,
      }
    // A failed or cancelled Extraction carries its failure and nothing else.
    : {
        outcome: settled.outcome,
        failure: settled.failure,
        complete: null,
        modelAttribution: null,
        diagnostics: null,
        resultPayload: null,
        evidenceLinks: null,
        reviewable: false,
      }
  const updated = await orm.public.Extraction.where({ id: extractionId, outcome: null }).updateAll(fields)
  if (updated.length === 1) return 'settled'
  return (await orm.public.Extraction.select('id').first({ id: extractionId })) ? 'already-settled' : 'missing'
}

type AdmissionPins = Readonly<{
  owner: string
  projectContextId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  extractionSchemaId: string
  strategy: ExtractionStrategy
  catalogRecipe: string | null
  requestedModels: ExtractionModelChoice | null
  preprocessId: string
}>

/** The pins an interactive request names, when every one of them exists and belongs to the researcher's project. */
async function resolveAdmission(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  input: RunSingleInput,
): Promise<AdmissionPins | null> {
  const { orm } = transaction
  const representation = await orm.public.SourceRepresentationRevision.select(
    'sourceDocumentId', 'preprocessId',
  ).first({ id: input.sourceRepresentationRevisionId })
  const document = representation
    ? await orm.public.SourceDocument.select('projectContextId').first({ id: representation.sourceDocumentId })
    : null
  const schema = await orm.public.SchemaRevision.select('extractionSchemaId').first({ id: input.schemaRevisionId })
  const schemaOwner = schema
    ? await orm.public.ExtractionSchema.select('projectContextId').first({ id: schema.extractionSchemaId })
    : null
  const project = document
    ? await orm.public.ProjectContext.select('researcherAccountId').first({ id: document.projectContextId })
    : null
  if (!representation || !document || !schema || !schemaOwner ||
      schemaOwner.projectContextId !== document.projectContextId ||
      !project || project.researcherAccountId !== researcherAccountId)
    return null
  return {
    owner: researcherAccountId,
    projectContextId: document.projectContextId,
    sourceDocumentId: representation.sourceDocumentId,
    sourceRepresentationRevisionId: input.sourceRepresentationRevisionId,
    schemaRevisionId: input.schemaRevisionId,
    extractionSchemaId: schema.extractionSchemaId,
    strategy: input.strategy,
    catalogRecipe: input.strategy === 'CATALOG' ? input.catalogRecipe ?? null : null,
    requestedModels: modelChoice(input.models),
    preprocessId: representation.preprocessId,
  }
}

type AdmittedIdentity = Readonly<{
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: string
  catalogRecipe: string | null
  requestedModels: unknown
  batchExtractionId: string | null
}>

/** An identical interactive request: the same pins and choices. A batch member's ID is never an interactive one. */
function sameAdmission(row: AdmittedIdentity, pins: AdmissionPins): boolean {
  return row.batchExtractionId === null &&
    row.sourceDocumentId === pins.sourceDocumentId &&
    row.sourceRepresentationRevisionId === pins.sourceRepresentationRevisionId &&
    row.schemaRevisionId === pins.schemaRevisionId &&
    row.strategy === pins.strategy &&
    row.catalogRecipe === pins.catalogRecipe &&
    isDeepStrictEqual(modelChoice(row.requestedModels), pins.requestedModels)
}

/** DBOS refused the workflow ID (workflowIDReusePolicy 'reject'): its Extraction is gone, so the ID is spent. */
function workflowIdInUse(error: unknown): boolean {
  return DBOSErrors.isWorkflowIDInUseError(error)
}

/**
 * Admits one interactive Extraction: its row and its `runExtraction` workflow commit together on one pooled client
 * (spec, *Admission: one transaction*), or neither does.
 */
async function admitInteractiveExtraction(
  execution: ExtractionExecution,
  researcherAccountId: string,
  input: RunSingleInput,
  attempt = 0,
): Promise<'created' | 'replayed' | 'conflict' | 'superseded' | 'missing'> {
  try {
    return await withPoolClientTransaction(async (transaction, client) => {
      const pins = await resolveAdmission(transaction, researcherAccountId, input)
      if (pins === null) return 'missing'
      const identity = () => transaction.orm.public.Extraction.select(
        'sourceDocumentId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe',
        'requestedModels', 'batchExtractionId',
      ).first({ id: input.extractionId })
      // Another researcher's Extraction under this ID is concealed behind the same missing answer.
      const replay = async (row: AdmittedIdentity) =>
        sameAdmission(row, pins)
          ? 'replayed' as const
          : (await ownsResearcherExtraction(transaction, researcherAccountId, input.extractionId))
              ? 'conflict' as const
              : 'missing' as const
      // Replay resolution comes first: an identical repeat replays even when its revision is superseded now (PR #140).
      const existing = await identity()
      if (existing) return replay(existing)
      // A new identity is admitted only on the document's current revision, decided under the Source Document row
      // lock that reprocess publication also takes (PR #140).
      if (!(await lockSourceDocumentRow(transaction, pins.sourceDocumentId))) return 'missing'
      // A request with this ID may have committed while this one waited for the document lock.
      const raced = await identity()
      if (raced) return replay(raced)
      const current = await transaction.orm.public.SourceRepresentationRevision.where({
        sourceDocumentId: pins.sourceDocumentId,
      }).select('id').orderBy((revision) => revision.revisionNumber.desc()).first()
      // No revision left means the document vanished while this waited for the lock.
      if (!current) return 'missing'
      if (current.id !== pins.sourceRepresentationRevisionId) return 'superseded'
      await transaction.orm.public.Extraction.create({
        id: input.extractionId,
        sourceDocumentId: pins.sourceDocumentId,
        sourceRepresentationRevisionId: pins.sourceRepresentationRevisionId,
        schemaRevisionId: pins.schemaRevisionId,
        strategy: pins.strategy,
        catalogRecipe: pins.catalogRecipe,
        requestedModels: pins.requestedModels,
        batchExtractionId: null,
      })
      await execution.enqueue(client, {
        workflowName: RUN_EXTRACTION,
        workflowID: extractWorkflowId(input.extractionId),
        queueName: EXTRACTION_QUEUE,
        authenticatedUser: pins.owner,
        attributes: extractionAttributes({ ...pins, batchExtractionId: null }),
      }, input.extractionId)
      return 'created'
    })
  } catch (error) {
    // A concurrent first request committed this primary key: reload and compare in a new transaction (spec, *Replays*).
    // Unrelated constraint errors are not replays.
    if (attempt === 0 && isUniqueViolation(error, EXTRACTION_KEY))
      return admitInteractiveExtraction(execution, researcherAccountId, input, 1)
    if (workflowIdInUse(error)) return 'conflict'
    throw error
  }
}

async function ownsResearcherExtraction(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  extractionId: string,
): Promise<boolean> {
  const { sql } = transaction
  const query = sql.public.extraction
    .innerJoin(sql.public.sourceDocument, (fields, functions) =>
      functions.eq(fields.extraction.sourceDocumentId, fields.sourceDocument.id),
    )
    .innerJoin(sql.public.projectContext, (fields, functions) =>
      functions.eq(fields.sourceDocument.projectContextId, fields.projectContext.id),
    )
    .select('extractionId', (fields) => fields.extraction.id)
    .where((fields, functions) =>
      functions.and(
        functions.eq(fields.extraction.id, extractionId),
        functions.eq(fields.projectContext.researcherAccountId, researcherAccountId),
      ),
    )
  return (await transaction.execute(query.build()).first()) !== null
}

async function ownsResearcherDocument(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  sourceDocumentId: string,
): Promise<boolean> {
  const { sql } = transaction
  const query = sql.public.sourceDocument
    .innerJoin(sql.public.projectContext, (fields, functions) =>
      functions.eq(
        fields.sourceDocument.projectContextId,
        fields.projectContext.id,
      ),
    )
    .select('sourceDocumentId', (fields) => fields.sourceDocument.id)
    .where((fields, functions) =>
      functions.and(
        functions.eq(fields.sourceDocument.id, sourceDocumentId),
        functions.eq(
          fields.projectContext.researcherAccountId,
          researcherAccountId,
        ),
      ),
    )
  const row = await transaction.execute(query.build()).first()
  return row !== null
}

async function ownsResearcherBatch(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  projectContextId: string,
  batchExtractionId: string,
): Promise<boolean> {
  const { sql } = transaction
  const query = sql.public.batchExtraction
    .innerJoin(sql.public.projectContext, (fields, functions) =>
      functions.eq(
        fields.batchExtraction.projectContextId,
        fields.projectContext.id,
      ),
    )
    .select('batchExtractionId', (fields) => fields.batchExtraction.id)
    .where((fields, functions) =>
      functions.and(
        functions.eq(fields.batchExtraction.id, batchExtractionId),
        functions.eq(
          fields.batchExtraction.projectContextId,
          projectContextId,
        ),
        functions.eq(
          fields.projectContext.researcherAccountId,
          researcherAccountId,
        ),
      ),
    )
  const row = await transaction.execute(query.build()).first()
  return row !== null
}

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

async function loadDocumentExtractions(
  orm: DatabaseOrm,
  statuses: WorkflowStatuses,
  input: ReadDocumentExtractionsInput,
): Promise<DocumentExtractionsSnapshot | null> {
  const rows = await orm.public.Extraction.where({ sourceDocumentId: input.sourceDocumentId })
    .select('id', 'batchExtractionId', 'outcome', 'sourceRepresentationRevisionId', 'createdAt', 'reviewedAt')
    .all()
  // An interactive attempt in any state, or a published result of any kind: a pending or failed batch member is not a
  // result and never displaces one (spec, *One Extraction row*).
  const candidates = rows
    .filter((row) => row.batchExtractionId === null || row.outcome === 'SUCCEEDED')
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
  const latestReviewed = rows
    .filter((row) => row.outcome === 'SUCCEEDED' && row.reviewedAt !== null)
    .sort((left, right) =>
      right.reviewedAt!.getTime() - left.reviewedAt!.getTime() ||
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
async function loadBatches(
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

async function loadResults(
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

async function reviewDigest(orm: DatabaseOrm, extractionId: string): Promise<string | null> {
  const extraction = await orm.public.Extraction.select('reviewedAt').first({ id: extractionId })
  if (!extraction?.reviewedAt) return null
  return (await orm.public.ExtractionReview.where({ extractionId })
    .select('decisionDigest')
    .orderBy((review) => review.revisionNumber.desc())
    .first())?.decisionDigest ?? null
}
async function loadResearcherExtraction(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  extractionId: string,
): Promise<ExtractionSnapshot | null> {
  if (!(await ownsResearcherExtraction(transaction, researcherAccountId, extractionId))) return null
  const [row] = await readAttemptRows(transaction.orm, [extractionId])
  // Review reads a published result only.
  return row?.outcome === 'SUCCEEDED' ? extractionSnapshot(transaction.orm, row) : null
}

async function readStoredReviewDraft(database: Database, accountId: string, extractionId: string): Promise<ReviewDraft | null> {
  return database.transaction(async (transaction) => {
    if (!await ownsResearcherExtraction(transaction, accountId, extractionId)) return null
    const row = await transaction.orm.public.Extraction.select('reviewDraft', 'reviewDraftVersion', 'reviewedAt').first({ id: extractionId })
    if (!row) return null
    return { version: row.reviewDraftVersion, decisions: row.reviewedAt ? [] : (row.reviewDraft ?? []) as unknown as ReviewDraft['decisions'] }
  })
}

async function saveStoredReviewDraft(database: Database, accountId: string, extractionId: string, draft: ReviewDraft): Promise<ReviewDraft> {
  return database.transaction(async (transaction) => {
    if (!await ownsResearcherExtraction(transaction, accountId, extractionId))
      throw new ExtractionError('not_found', 'That Extraction was not found.')
    // updateAll keeps the version predicate in the atomic UPDATE; update first
    // selects an identity, then updates by primary key and loses that guard.
    const updated = await transaction.orm.public.Extraction.where({
      id: extractionId, reviewedAt: null, reviewable: true, reviewDraftVersion: draft.version,
    }).updateAll({ reviewDraft: draft.decisions, reviewDraftVersion: draft.version + 1 })
    if (updated.length !== 1) throw new ExtractionError('review_conflict', 'The review changed elsewhere. Reload before continuing.')
    return { decisions: draft.decisions, version: draft.version + 1 }
  })
}

async function resetStoredReview(database: Database, accountId: string, extractionId: string, version: number): Promise<ReviewDraft> {
  return database.transaction(async (transaction) => {
    if (!await ownsResearcherExtraction(transaction, accountId, extractionId))
      throw new ExtractionError('not_found', 'That Extraction was not found.')
    const updated = await transaction.orm.public.Extraction.where({
      id: extractionId, reviewable: true, reviewDraftVersion: version,
    }).updateAll({ reviewedAt: null, reviewDraft: [], reviewDraftVersion: version + 1 })
    if (updated.length !== 1) throw new ExtractionError('review_conflict', 'The review changed elsewhere. Reload before continuing.')
    return { decisions: [], version: version + 1 }
  })
}

/** Identity constraints a concurrent suggested-batch handoff of the same suggestion commits first. */
const SUGGESTED_BATCH_KEYS = [
  'extractionSchema_pkey',
  'schemaRevision_pkey',
  'schemaRevision_extractionSchemaId_revisionNumber_key',
  BATCH_KEY,
  EXTRACTION_KEY,
  'batchSchemaSuggestion_confirmedSchemaRevisionId_key',
  'batchSchemaSuggestion_batchExtractionId_key',
] as const

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

  private async ownedInputs(
    transaction: DatabaseTransaction,
    sourceRepresentationRevisionId: string,
    schemaRevisionId: string,
  ) {
    const { sql } = transaction
    const query = sql.public.sourceRepresentationRevision
      .innerJoin(sql.public.sourceDocument, (fields, functions) =>
        functions.eq(
          fields.sourceRepresentationRevision.sourceDocumentId,
          fields.sourceDocument.id,
        ),
      )
      .innerJoin(sql.public.projectContext, (fields, functions) =>
        functions.eq(
          fields.sourceDocument.projectContextId,
          fields.projectContext.id,
        ),
      )
      .innerJoin(sql.public.extractionSchema, (fields, functions) =>
        functions.eq(
          fields.sourceDocument.projectContextId,
          fields.extractionSchema.projectContextId,
        ),
      )
      .innerJoin(sql.public.schemaRevision, (fields, functions) =>
        functions.eq(
          fields.extractionSchema.id,
          fields.schemaRevision.extractionSchemaId,
        ),
      )
      .select((fields) => ({
        sourceDocumentId: fields.sourceDocument.id,
        projectContextId: fields.projectContext.id,
        sourceRepresentationRevisionId:
          fields.sourceRepresentationRevision.id,
        artifactReference:
          fields.sourceRepresentationRevision.artifactReference,
        artifactSha256: fields.sourceRepresentationRevision.artifactSha256,
        schemaRevisionId: fields.schemaRevision.id,
        schemaTree: fields.schemaRevision.schemaTree,
      }))
      .where((fields, functions) =>
        functions.and(
          functions.eq(
            fields.sourceRepresentationRevision.id,
            sourceRepresentationRevisionId,
          ),
          functions.eq(fields.schemaRevision.id, schemaRevisionId),
          functions.eq(
            fields.projectContext.researcherAccountId,
            this.researcherAccountId,
          ),
        ),
      )
    return transaction.execute(query.build()).first()
  }

  private async ownedRepresentation(
    transaction: DatabaseTransaction,
    sourceRepresentationRevisionId: string,
  ) {
    const { sql } = transaction
    const query = sql.public.sourceRepresentationRevision
      .innerJoin(sql.public.sourceDocument, (fields, functions) =>
        functions.eq(
          fields.sourceRepresentationRevision.sourceDocumentId,
          fields.sourceDocument.id,
        ),
      )
      .innerJoin(sql.public.projectContext, (fields, functions) =>
        functions.eq(
          fields.sourceDocument.projectContextId,
          fields.projectContext.id,
        ),
      )
      .select((fields) => ({
        artifactReference:
          fields.sourceRepresentationRevision.artifactReference,
        artifactSha256: fields.sourceRepresentationRevision.artifactSha256,
      }))
      .where((fields, functions) =>
        functions.and(
          functions.eq(
            fields.sourceRepresentationRevision.id,
            sourceRepresentationRevisionId,
          ),
          functions.eq(
            fields.projectContext.researcherAccountId,
            this.researcherAccountId,
          ),
        ),
      )
    return transaction.execute(query.build()).first()
  }

  async loadExtractionInputs(
    sourceRepresentationRevisionId: string,
    schemaRevisionId: string,
  ): Promise<LoadedExtractionInputs | null> {
    const loaded = await this.database.transaction((transaction) =>
      this.ownedInputs(
        transaction,
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
      this.ownedRepresentation(transaction, sourceRepresentationRevisionId),
    )
    if (!row) return null
    const artifact = await this.packages.read(row, 'source')
    return JSON.parse(new TextDecoder().decode(artifact.bytes))
  }

  readExtraction(
    extractionId: string,
  ): Promise<ExtractionSnapshot | null> {
    return this.database.transaction((transaction) =>
      loadResearcherExtraction(
        transaction,
        this.researcherAccountId,
        extractionId,
      ),
    )
  }

  async scheduleExtraction(input: RunSingleInput): Promise<RunSingleResult | null> {
    const disposition = await admitInteractiveExtraction(this.execution, this.researcherAccountId, input)
    if (disposition === 'missing') return null
    if (disposition === 'conflict')
      throw new ExtractionError('extraction_id_conflict', 'That Extraction ID is already bound to different inputs.')
    if (disposition === 'superseded')
      throw new ExtractionError('source_representation_superseded', SUPERSEDED_MESSAGE)
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
    if (!row || (row.batchExtractionId !== null && row.outcome !== 'SUCCEEDED')) return null
    const [attempt] = (await deriveAttempts(this.database.orm, this.execution.statuses, [row])).values()
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

  async finalizeReview(
    extractionId: string,
    authority: ReviewAuthority,
  ): Promise<PersistedReviewResult> {
    const submitted = normalizeDecisions(authority.reviewDecisions)
    const digest = JSON.stringify(submitted)
    if (submitted.length !== authority.reviewDecisions.length)
      return { status: 'invalid' }
    let status: 'not-found'
      | 'invalid'
      | 'conflict'
      | 'replayed'
      | 'reviewed'
    try {
      status = await this.database.transaction(async (transaction) => {
        const { orm } = transaction
        const extraction = await loadResearcherExtraction(
          transaction,
          this.researcherAccountId,
          extractionId,
        )
        if (!extraction) return 'not-found' as const
        if (!reviewAuthorityMatchesExtraction(extraction, submitted, authority))
          return 'invalid' as const
        if (extraction.reviewedAt)
          return (await reviewDigest(orm, extractionId)) === digest
            ? ('replayed' as const)
            : ('conflict' as const)
        const claimed = await orm.public.Extraction.where({
          id: extractionId, reviewedAt: null, reviewDraftVersion: authority.expectedDraftVersion ?? 0,
        }).updateAll({ reviewedAt: new Date(), reviewDraft: null, reviewDraftVersion: (authority.expectedDraftVersion ?? 0) + 1 })
        if (claimed.length !== 1) return (await reviewDigest(orm, extractionId)) === digest ? 'replayed' as const : 'conflict' as const
        const previous = await orm.public.ExtractionReview.where({ extractionId })
          .select('revisionNumber').orderBy((review) => review.revisionNumber.desc()).first()
        const review = await orm.public.ExtractionReview.create({
          extractionId,
          revisionNumber: (previous?.revisionNumber ?? 0) + 1,
          decisionDigest: digest,
        })
        for (const decision of submitted)
          await orm.public.ReviewDecision.create({
            extractionReviewId: review.id,
            ...decision,
            reviewedValue: encodeReviewedValue(decision.reviewedValue),
          })
        return 'reviewed' as const
      })
    } catch (error) {
      // A concurrent finalization committed this review's revision first.
      if (!isUniqueViolation(error)) throw error
      status = await this.database.transaction(async (transaction) => {
        if (
          !(await ownsResearcherExtraction(
            transaction,
            this.researcherAccountId,
            extractionId,
          ))
        )
          return 'not-found' as const
        return (await reviewDigest(transaction.orm, extractionId)) === digest
          ? ('replayed' as const)
          : ('conflict' as const)
      })
    }
    if (
      status === 'not-found' ||
      status === 'invalid' ||
      status === 'conflict'
    )
      return { status }
    const extraction = await this.readExtraction(extractionId)
    if (!extraction)
      throw new Error('Reviewed Extraction could not be read.')
    return { status, extraction }
  }

  private async readBatchForResearcher(
    projectContextId: string,
    batchExtractionId: string,
    statuses: WorkflowStatuses = this.execution.statuses,
  ): Promise<DurableBatchExtraction | null> {
    const owned = await this.database.transaction((transaction) =>
      ownsResearcherBatch(transaction, this.researcherAccountId, projectContextId, batchExtractionId))
    if (!owned) return null
    return loadBatch(this.database.orm, statuses, projectContextId, batchExtractionId)
  }

  /**
   * Admits a Batch Extraction: the batch, one pending Extraction per selected Source Document (deterministic IDs) and
   * every member's `runExtraction` workflow commit together on one pooled client. Each member pins its document's
   * current revision under the document's row lock, taken in sorted order so batches and reprocesses never deadlock
   * (PR #140).
   */
  async scheduleBatch(
    input: ScheduleBatchInput,
  ): Promise<ScheduleBatchResult | null> {
    const batchExtractionId =
      input.repetition === 'create-new' ? randomUUID() : selectionId(input)
    const requestedModels = modelChoice(input.models)
    try {
      const opened = await withPoolClientTransaction(async (transaction, client) => {
        const { orm } = transaction
        if (
          !(await orm.public.ProjectContext.select('id').first({
            id: input.projectContextId,
            researcherAccountId: this.researcherAccountId,
          }))
        )
          return 'missing' as const
        if (
          input.sourceDocumentIds.length === 0 ||
          input.sourceDocumentIds.length > BATCH_EXTRACTION_SELECTION_LIMIT ||
          new Set(input.sourceDocumentIds).size !== input.sourceDocumentIds.length
        )
          return 'invalid' as const
        const schema =
          await orm.public.SchemaRevision.select(
            'extractionSchemaId',
          ).first({ id: input.schemaRevisionId })
        const owner = schema
          ? await orm.public.ExtractionSchema.select(
              'projectContextId',
            ).first({ id: schema.extractionSchemaId })
          : null
        if (
          !schema ||
          !owner ||
          owner.projectContextId !== input.projectContextId
        )
          return 'missing' as const
        const current = await orm.public.SchemaRevision.where({
          extractionSchemaId: schema.extractionSchemaId,
        })
          .select('id')
          .orderBy((revision) => revision.revisionNumber.desc())
          .first()
        if (current?.id !== input.schemaRevisionId)
          return 'invalid' as const
        const members: Array<{
          sourceDocumentId: string
          sourceRepresentationRevisionId: string
          preprocessId: string
        }> = []
        // canonicalIds' sorted order is the deadlock guard: batches sharing members lock alike.
        for (const sourceDocumentId of canonicalIds(
          input.sourceDocumentIds,
        )) {
          if (
            !(await orm.public.SourceDocument.select('id').first({
              id: sourceDocumentId,
              projectContextId: input.projectContextId,
            }))
          )
            return 'missing' as const
          if (!(await lockSourceDocumentRow(transaction, sourceDocumentId)))
            return 'missing' as const
          const representation =
            await orm.public.SourceRepresentationRevision.where({
              sourceDocumentId,
            })
              .select('id', 'preprocessId')
              .orderBy((revision) => revision.revisionNumber.desc())
              .first()
          if (!representation) return 'invalid' as const
          members.push({
            sourceDocumentId,
            sourceRepresentationRevisionId: representation.id,
            preprocessId: representation.preprocessId,
          })
        }
        await orm.public.BatchExtraction.create({
          id: batchExtractionId,
          projectContextId: input.projectContextId,
          schemaRevisionId: input.schemaRevisionId,
          strategy: input.strategy,
        })
        for (const member of members)
          await admitBatchMember(orm, client, this.execution, {
            owner: this.researcherAccountId,
            projectContextId: input.projectContextId,
            extractionSchemaId: schema.extractionSchemaId,
            schemaRevisionId: input.schemaRevisionId,
            strategy: input.strategy,
            requestedModels,
            batchExtractionId,
            ...member,
          })
        return 'created' as const
      })
      if (opened === 'missing') return null
      if (opened === 'invalid')
        throw new ExtractionError(
          'invalid_extraction_pins',
          'Use the Current Schema Revision and Source Documents in this Project Context with a Source Representation.',
        )
      const batch = await this.readBatchForResearcher(
        input.projectContextId,
        batchExtractionId,
        JUST_ADMITTED,
      )
      if (!batch)
        throw new Error('Persisted Batch Extraction could not be read.')
      return { disposition: 'created', batch: snapshot(batch) }
    } catch (error) {
      // The batch's primary key: an equal selection committed first. Its member rows are compared with this request.
      if (!isUniqueViolation(error, BATCH_KEY) && !workflowIdInUse(error)) throw error
      const batch = await this.readBatchForResearcher(
        input.projectContextId,
        batchExtractionId,
      )
      const selected = canonicalIds(input.sourceDocumentIds)
      if (
        !batch ||
        batch.schemaRevisionId !== input.schemaRevisionId ||
        batch.strategy !== input.strategy ||
        batch.members.length !== selected.length ||
        !batch.members.every(
          (member, index) =>
            member.sourceDocumentId === selected[index] &&
            isDeepStrictEqual(modelChoice(member.extraction.requestedModels), requestedModels),
        )
      )
        throw new ExtractionError(
          'batch_conflict',
          'The Batch Extraction identity belongs to another selection.',
          { cause: error },
        )
      return { disposition: 'replayed', batch: snapshot(batch) }
    }
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
    const batch = await this.readBatchForResearcher(
      input.projectContextId,
      input.batchExtractionId,
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

export type BatchMemberAdmission = Readonly<{
  owner: string
  projectContextId: string
  extractionSchemaId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  requestedModels: ExtractionModelChoice | null
  batchExtractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  preprocessId: string
}>

/** One pending member Extraction and its `runExtraction` workflow, in the batch's admission transaction. */
async function admitBatchMember(
  orm: DatabaseOrm,
  client: Parameters<ExtractionExecution['enqueue']>[0],
  execution: ExtractionExecution,
  member: BatchMemberAdmission,
): Promise<void> {
  const id = batchMemberExtractionId(member.batchExtractionId, member.sourceDocumentId)
  await orm.public.Extraction.create({
    id,
    sourceDocumentId: member.sourceDocumentId,
    sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
    schemaRevisionId: member.schemaRevisionId,
    strategy: member.strategy,
    catalogRecipe: null,
    requestedModels: member.requestedModels,
    batchExtractionId: member.batchExtractionId,
  })
  await execution.enqueue(client, {
    workflowName: RUN_EXTRACTION,
    workflowID: extractWorkflowId(id),
    queueName: EXTRACTION_QUEUE,
    authenticatedUser: member.owner,
    attributes: extractionAttributes(member),
  }, id)
}
export type AdmitBatchMember = typeof admitBatchMember

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

/**
 * The store `runExtraction` works through. It reads without a Researcher Account: ownership was checked when the
 * Extraction was admitted, and deletion cascades the row with its source.
 */
export function createExtractionStore(
  infrastructure: Readonly<{ database?: Database; packages?: CanonicalPackageStore }> = {},
): ExtractionStore {
  const database = infrastructure.database ?? db
  const packages = infrastructure.packages ?? canonicalPackageStore
  const { orm } = database
  return {
    async loadAdmitted(extractionId): Promise<AdmittedExtraction | null> {
      const row = await orm.public.Extraction.select(
        'id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe',
        'requestedModels', 'batchExtractionId',
      ).first({ id: extractionId, outcome: null })
      if (!row) return null
      const document = await orm.public.SourceDocument.select('projectContextId').first({ id: row.sourceDocumentId })
      const project = document
        ? await orm.public.ProjectContext.select('researcherAccountId').first({ id: document.projectContextId })
        : null
      const revision = await orm.public.SourceRepresentationRevision.select('preprocessId').first({
        id: row.sourceRepresentationRevisionId, sourceDocumentId: row.sourceDocumentId,
      })
      const schema = await orm.public.SchemaRevision.select('extractionSchemaId', 'schemaTree').first({ id: row.schemaRevisionId })
      if (!document || !project || !revision || !schema) return null
      return {
        extractionId: row.id,
        owner: project.researcherAccountId,
        projectContextId: document.projectContextId,
        sourceDocumentId: row.sourceDocumentId,
        sourceRepresentationRevisionId: row.sourceRepresentationRevisionId,
        schemaRevisionId: row.schemaRevisionId,
        extractionSchemaId: schema.extractionSchemaId,
        strategy: row.strategy as ExtractionStrategy,
        catalogRecipe: row.catalogRecipe,
        requestedModels: modelChoice(row.requestedModels),
        batchExtractionId: row.batchExtractionId,
        preprocessId: revision.preprocessId,
        schemaTree: schema.schemaTree,
      }
    },
    async readPinnedDocument(sourceRepresentationRevisionId) {
      const revision = await orm.public.SourceRepresentationRevision.select('artifactReference', 'artifactSha256')
        .first({ id: sourceRepresentationRevisionId })
      if (!revision) return null
      try {
        const artifact = await packages.read(revision, 'source')
        return JSON.parse(new TextDecoder().decode(artifact.bytes)) as unknown
      } catch (error) {
        throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is unavailable.', { cause: error })
      }
    },
    settle: (extractionId, settled) => settleExtraction(orm, extractionId, settled),
  }
}
