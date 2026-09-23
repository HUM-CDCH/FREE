import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalPackageStore,
  db,
  stableJson,
  stableUuid,
  uniqueConstraint,
  type CanonicalPackageStore,
  type Database,
  type DatabaseOrm,
} from 'db'
import { ExtractionError } from './errors.js'
import { persistSuggestedBatch } from './postgres-suggested-batch.js'
import { BATCH_EXTRACTION_SELECTION_LIMIT } from './batch.js'
import { sameRetrySelection, validateCatalogRetry } from './catalog.js'
import type {
  ClaimedExtractionJob,
  ExtractionInputReader,
  ExtractionPersistence,
  ExtractionJobFailure,
  ExtractionValueCheckpoint,
  InternalExtractionJobStore,
  PersistedReviewResult,
  LoadedExtractionInputs,
  ReviewAuthority,
  TerminalExtraction,
} from './dependencies.js'
import type {
  BatchExtractionResults,
  BatchExtractionSnapshot,
  CancellationResult,
  DocumentExtractionsSnapshot,
  ExtractionAttemptSnapshot,
  ExtractionSnapshot,
  ExtractionStrategy,
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

type Status = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
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
type BatchMember = Readonly<{
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  executionStatus: Status
  executionFailure: unknown | null
  startedAt: Date | null
  finishedAt: Date | null
  latestExtraction: BatchExtractionSnapshot['members'][number]['latestExtraction']
}>
export type DurableBatchExtraction = Readonly<{
  batchExtractionId: string
  projectContextId: string
  schemaRevisionId: string
  extractionSchemaId: string
  extractionSchemaName: string
  schemaRevisionNumber: number
  strategy: ExtractionStrategy
  executionStatus: Status
  executionFailure: unknown | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
  members: readonly BatchMember[]
}>

function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}
function selectionId(input: ScheduleBatchInput): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([
      input.projectContextId,
      input.schemaRevisionId,
      input.strategy,
      canonicalIds(input.sourceDocumentIds),
    ]))
    .digest('hex')
  const variant = (['8', '9', 'a', 'b'] as const)[parseInt(hash[16]!, 16) & 3]
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
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

function completedAttempt(extraction: ExtractionSnapshot): ExtractionAttemptSnapshot {
  return { ...extraction, executionStatus: 'COMPLETED' }
}
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
    failureMessage: failureMessage(batch.executionFailure),
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    createdAt: batch.createdAt,
    members: batch.members.map((member) => ({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
      executionStatus: member.executionStatus,
      failureMessage: failureMessage(member.executionFailure),
      startedAt: member.startedAt,
      finishedAt: member.finishedAt,
      latestExtraction: member.latestExtraction,
    })),
  }
}

async function loadExtraction(orm: DatabaseOrm, extractionId: string): Promise<ExtractionSnapshot | null> {
  const row = await orm.public.Extraction.select(
    'id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'schemaRevisionId',
    'strategy', 'outcome', 'complete', 'modelAttribution', 'diagnostics', 'failure',
    'resultPayload', 'evidenceLinks', 'reviewable', 'retryOfId', 'batchExtractionId',
    'createdAt', 'reviewedAt',
  ).first({ id: extractionId })
  if (!row) return null
  const representation = await orm.public.SourceRepresentationRevision.select('revisionNumber').first({
    id: row.sourceRepresentationRevisionId,
    sourceDocumentId: row.sourceDocumentId,
  })
  const schema = await orm.public.SchemaRevision.select('extractionSchemaId', 'revisionNumber').first({
    id: row.schemaRevisionId,
  })
  if (!representation || !schema) throw new Error('Stored Extraction pins are unavailable.')
  const review = await orm.public.ExtractionReview.where({ extractionId })
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
    extractionId: row.id,
    sourceDocumentId: row.sourceDocumentId,
    sourceRepresentationRevisionId: row.sourceRepresentationRevisionId,
    sourceRepresentationRevisionNumber: representation.revisionNumber,
    schemaRevisionId: row.schemaRevisionId,
    extractionSchemaId: schema.extractionSchemaId,
    schemaRevisionNumber: schema.revisionNumber,
    strategy: row.strategy,
    outcome: row.outcome,
    complete: row.complete,
    modelAttribution: row.modelAttribution as ExtractionSnapshot['modelAttribution'],
    diagnostics: row.diagnostics as ExtractionSnapshot['diagnostics'],
    result: row.resultPayload as ExtractionSnapshot['result'],
    evidence: row.evidenceLinks as ExtractionSnapshot['evidence'],
    failure: row.failure as ExtractionSnapshot['failure'],
    reviewable: row.reviewable,
    retryOfId: row.retryOfId,
    batchExtractionId: row.batchExtractionId,
    createdAt: row.createdAt,
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

async function loadCompletedJobExtraction(
  orm: DatabaseOrm,
  extractionId: string,
): Promise<ExtractionSnapshot | null> {
  const job = await orm.public.ExtractionJob.select('executionStatus').first({
    id: extractionId,
  })
  if (!job || job.executionStatus !== 'COMPLETED') return null
  const extraction = await loadExtraction(orm, extractionId)
  if (!extraction)
    throw new Error('Completed Extraction Job has no terminal Extraction.')
  return extraction
}

async function loadExtractionAttempt(
  orm: DatabaseOrm,
  extractionId: string,
): Promise<ExtractionAttemptSnapshot | null> {
  const row = await orm.public.ExtractionJob.select(
    'id',
    'kind',
    'sourceDocumentId',
    'sourceRepresentationRevisionId',
    'schemaRevisionId',
    'strategy',
    'executionStatus',
    'complete',
    'modelAttribution',
    'diagnostics',
    'resultPayload',
    'failure',
    'retryOfId',
    'batchExtractionId',
    'createdAt',
  ).first({ id: extractionId })
  if (!row) return null
  if (row.executionStatus === 'COMPLETED') {
    const extraction = await loadExtraction(orm, extractionId)
    if (!extraction)
      throw new Error('Completed Extraction Job has no terminal Extraction.')
    return completedAttempt(extraction)
  }
  if (row.kind !== 'INTERACTIVE') return null
  const representation = await orm.public.SourceRepresentationRevision.select(
    'revisionNumber',
  ).first({
    id: row.sourceRepresentationRevisionId,
    sourceDocumentId: row.sourceDocumentId,
  })
  const schema = await orm.public.SchemaRevision.select(
    'extractionSchemaId',
    'revisionNumber',
  ).first({ id: row.schemaRevisionId })
  if (!representation || !schema)
    throw new Error('Stored Extraction Job pins are unavailable.')
  return {
    extractionId: row.id,
    sourceDocumentId: row.sourceDocumentId,
    sourceRepresentationRevisionId: row.sourceRepresentationRevisionId,
    sourceRepresentationRevisionNumber: representation.revisionNumber,
    schemaRevisionId: row.schemaRevisionId,
    extractionSchemaId: schema.extractionSchemaId,
    schemaRevisionNumber: schema.revisionNumber,
    strategy: row.strategy,
    executionStatus: row.executionStatus,
    outcome: null,
    complete: row.complete,
    modelAttribution: row.modelAttribution as ExtractionAttemptSnapshot['modelAttribution'],
    diagnostics: row.diagnostics as ExtractionAttemptSnapshot['diagnostics'],
    result: row.resultPayload as ExtractionAttemptSnapshot['result'],
    evidence: null,
    failure: row.failure as ExtractionAttemptSnapshot['failure'],
    reviewable: false,
    retryOfId: row.retryOfId,
    batchExtractionId: row.batchExtractionId,
    createdAt: row.createdAt,
    reviewedAt: null,
    reviewDecisions: [],
  }
}

type ScheduledJob = Readonly<{
  id: string
  projectContextId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  catalogRecipe: string | null
  retryOfId: string | null
  retryDocument: boolean | null
  rediscover: boolean | null
  retryRecordStartBlockIds: readonly string[] | null
  batchExtractionId: string | null
}>

function jobIdentityMatches(
  row: Readonly<{
    kind: 'INTERACTIVE' | 'BATCH_MEMBER'
    sourceRepresentationRevisionId: string
    schemaRevisionId: string
    strategy: ExtractionStrategy
    catalogRecipe: string | null
    retryOfId: string | null
    retryDocument: boolean | null
    rediscover: boolean | null
    retryRecordStartBlockIds: unknown
  }>,
  job: ScheduledJob,
): boolean {
  const retryRecordStartBlockIds = Array.isArray(row.retryRecordStartBlockIds) &&
      row.retryRecordStartBlockIds.every((id): id is string => typeof id === 'string')
    ? row.retryRecordStartBlockIds
    : null
  const retryMatches = job.retryOfId === null
    ? row.retryOfId === null && row.retryDocument === null &&
      row.rediscover === null && retryRecordStartBlockIds === null
    : row.retryOfId === job.retryOfId &&
      row.retryDocument !== null && row.rediscover !== null &&
      retryRecordStartBlockIds !== null &&
      sameRetrySelection({
        retryDocument: row.retryDocument,
        rediscover: row.rediscover,
        retryRecordStartBlockIds,
      }, {
        retryDocument: job.retryDocument!,
        rediscover: job.rediscover!,
        retryRecordStartBlockIds: job.retryRecordStartBlockIds!,
      })
  return row.kind === 'INTERACTIVE' &&
    row.sourceRepresentationRevisionId === job.sourceRepresentationRevisionId &&
    row.schemaRevisionId === job.schemaRevisionId &&
    row.strategy === job.strategy &&
    row.catalogRecipe === job.catalogRecipe &&
    retryMatches
}

async function resolveScheduledJob(
  transaction: DatabaseTransaction,
  input: RunSingleInput,
  researcherAccountId: string,
): Promise<ScheduledJob | null> {
  const { orm } = transaction
  if (input.kind === 'retry') {
    const parent = await loadExtractionAttempt(orm, input.retryOfId)
    if (!parent) return null
    if (!(await ownsResearcherJob(transaction, researcherAccountId, parent.extractionId)))
      return null
    const retry = validateCatalogRetry(parent, input)
    const document = await orm.public.SourceDocument.select('projectContextId').first({
      id: parent.sourceDocumentId,
    })
    if (!document) return null
    return {
      id: input.extractionId,
      projectContextId: document.projectContextId,
      sourceDocumentId: parent.sourceDocumentId,
      sourceRepresentationRevisionId: parent.sourceRepresentationRevisionId,
      schemaRevisionId: parent.schemaRevisionId,
      strategy: 'CATALOG',
      catalogRecipe: null,
      retryOfId: parent.extractionId,
      retryDocument: retry.selection.retryDocument,
      rediscover: retry.selection.rediscover,
      retryRecordStartBlockIds: canonicalIds(retry.selection.retryRecordStartBlockIds),
      batchExtractionId: parent.batchExtractionId,
    }
  }
  const representation = await orm.public.SourceRepresentationRevision.select(
    'sourceDocumentId',
  ).first({ id: input.sourceRepresentationRevisionId })
  const document = representation
    ? await orm.public.SourceDocument.select('projectContextId').first({
        id: representation.sourceDocumentId,
      })
    : null
  const schema = await orm.public.SchemaRevision.select('extractionSchemaId').first({
    id: input.schemaRevisionId,
  })
  const schemaOwner = schema
    ? await orm.public.ExtractionSchema.select('projectContextId').first({
        id: schema.extractionSchemaId,
      })
    : null
  const project = document
    ? await orm.public.ProjectContext.select('researcherAccountId').first({
        id: document.projectContextId,
      })
    : null
  if (!representation || !document || !schemaOwner ||
      schemaOwner.projectContextId !== document.projectContextId ||
      !project ||
      project.researcherAccountId !== researcherAccountId)
    return null
  return {
    id: input.extractionId,
    projectContextId: document.projectContextId,
    sourceDocumentId: representation.sourceDocumentId,
    sourceRepresentationRevisionId: input.sourceRepresentationRevisionId,
    schemaRevisionId: input.schemaRevisionId,
    strategy: input.strategy,
    catalogRecipe: input.strategy === 'CATALOG' ? input.catalogRecipe ?? null : null,
    retryOfId: null,
    retryDocument: null,
    rediscover: null,
    retryRecordStartBlockIds: null,
    batchExtractionId: null,
  }
}

async function scheduleInteractiveExtraction(
  database: Database,
  input: RunSingleInput,
  researcherAccountId: string,
): Promise<RunSingleResult | null> {
  let disposition: 'created' | 'replayed' = 'created'
  try {
    const status = await database.transaction(async (transaction) => {
      const { orm } = transaction
      const existingJob = await orm.public.ExtractionJob.select(
        'kind', 'projectContextId', 'sourceRepresentationRevisionId',
        'schemaRevisionId', 'strategy', 'catalogRecipe', 'retryOfId', 'retryDocument',
        'rediscover', 'retryRecordStartBlockIds',
      ).first({ id: input.extractionId })
      const job = await resolveScheduledJob(transaction, input, researcherAccountId)
      if (!job) return 'missing' as const
      if (existingJob) {
        const project = await orm.public.ProjectContext.select('researcherAccountId').first({
          id: existingJob.projectContextId,
        })
        if (project?.researcherAccountId !== researcherAccountId) return 'missing' as const
        return jobIdentityMatches(existingJob, job) ? 'replayed' as const : 'conflict' as const
      }
      await orm.public.ExtractionJob.create({
        ...job,
        kind: 'INTERACTIVE',
        retryRecordStartBlockIds: job.retryRecordStartBlockIds,
      })
      return 'created' as const
    })
    if (status === 'missing') return null
    if (status === 'conflict')
      throw new ExtractionError(
        'extraction_id_conflict',
        'That Extraction ID is already bound to different inputs.',
      )
    disposition = status
  } catch (error) {
    if (!uniqueConstraint(error)) throw error
    return scheduleInteractiveExtraction(database, input, researcherAccountId)
  }
  const extraction = await loadExtractionAttempt(database.orm, input.extractionId)
  if (!extraction) return null
  return { disposition, extraction }
}

async function loadDocumentExtractions(
  orm: DatabaseOrm,
  input: ReadDocumentExtractionsInput,
): Promise<DocumentExtractionsSnapshot | null> {
  const jobs = await orm.public.ExtractionJob.where({
    sourceDocumentId: input.sourceDocumentId,
  }).select(
    'id', 'kind', 'executionStatus', 'sourceRepresentationRevisionId', 'createdAt',
  ).all()
  const jobsById = new Map(jobs.map((job) => [job.id, job]))
  const candidates = jobs
    .filter((job) => job.kind === 'INTERACTIVE' || job.executionStatus === 'COMPLETED')
    .map((job) => ({
      id: job.id,
      sourceRepresentationRevisionId: job.sourceRepresentationRevisionId,
      scheduledAt: job.createdAt,
    })).sort((left, right) =>
    right.scheduledAt.getTime() - left.scheduledAt.getTime() ||
    right.id.localeCompare(left.id))
  const selected = input.extractionId
    ? candidates.find((candidate) => candidate.id === input.extractionId) ?? null
    : candidates[0] ?? null
  if (input.extractionId && !selected) return null
  const representationId = selected?.sourceRepresentationRevisionId ??
    (await orm.public.SourceRepresentationRevision.where({
      sourceDocumentId: input.sourceDocumentId,
    }).select('id').orderBy([
      (revision) => revision.revisionNumber.desc(),
      (revision) => revision.id.desc(),
    ]).first())?.id
  if (!representationId) return null
  const reviewedRows = await orm.public.Extraction.where({
    sourceDocumentId: input.sourceDocumentId,
  }).where((attempt) => attempt.reviewedAt.isNotNull())
    .select('id')
    .orderBy([
      (attempt) => attempt.reviewedAt.desc(),
      (attempt) => attempt.createdAt.desc(),
      (attempt) => attempt.id.desc(),
    ]).all()
  const latestReviewedId = reviewedRows.find((row) =>
    jobsById.get(row.id)?.executionStatus === 'COMPLETED')?.id ?? null
  return {
    sourceRepresentationRevisionId: representationId,
    latestAttempt: selected ? await loadExtractionAttempt(orm, selected.id) : null,
    latestReviewed: latestReviewedId
      ? await loadExtractionAttempt(orm, latestReviewedId)
      : null,
  }
}

export async function loadBatch(
  orm: DatabaseOrm,
  projectContextId: string,
  batchExtractionId: string,
): Promise<DurableBatchExtraction | null> {
  const row = await orm.public.BatchExtraction.select(
    'id', 'schemaRevisionId', 'strategy', 'createdAt',
  ).first({ id: batchExtractionId, projectContextId })
  if (!row) return null
  const schema = await orm.public.SchemaRevision.select('extractionSchemaId', 'revisionNumber').first({
    id: row.schemaRevisionId,
  })
  const owner = schema
    ? await orm.public.ExtractionSchema.select('name').first({ id: schema.extractionSchemaId })
    : null
  if (!schema || !owner) throw new Error('Stored Batch Extraction pins are unavailable.')
  const memberRows = await orm.public.BatchExtractionMember.where({ batchExtractionId })
    .select('sourceDocumentId', 'sourceRepresentationRevisionId', 'initialExtractionJobId')
    .orderBy((member) => member.sourceDocumentId.asc()).all()
  const members: BatchMember[] = []
  for (const member of memberRows) {
    const job = await orm.public.ExtractionJob.select(
      'executionStatus', 'failure', 'startedAt', 'finishedAt',
    ).first({
      id: member.initialExtractionJobId,
      batchExtractionId,
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
    })
    if (!job) throw new Error('Stored Batch Extraction member job is unavailable.')
    const extraction = await orm.public.Extraction.where({
      batchExtractionId,
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
    }).select('id', 'outcome', 'complete', 'reviewable', 'createdAt', 'reviewedAt', 'failure')
      .orderBy([(attempt) => attempt.createdAt.desc(), (attempt) => attempt.id.desc()]).first()
    if (job.executionStatus === 'COMPLETED' && !extraction)
      throw new Error('Completed Batch Extraction member is missing its Extraction.')
    members.push({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
      executionStatus: job.executionStatus,
      executionFailure: job.failure,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      latestExtraction: extraction ? {
        extractionId: extraction.id,
        outcome: extraction.outcome,
        complete: extraction.complete,
        reviewable: extraction.reviewable,
        createdAt: extraction.createdAt,
        reviewedAt: extraction.reviewedAt,
        failureMessage: failureMessage(extraction.failure),
      } : null,
    })
  }
  const executionStatus: Status = members.every((member) =>
    member.executionStatus === 'QUEUED')
    ? 'QUEUED'
    : members.every((member) =>
        member.executionStatus === 'COMPLETED' ||
        member.executionStatus === 'FAILED')
      ? 'COMPLETED'
      : 'RUNNING'
  const started = members
    .map((member) => member.startedAt)
    .filter((value): value is Date => value !== null)
    .sort((left, right) => left.getTime() - right.getTime())
  const finished = members
    .map((member) => member.finishedAt)
    .filter((value): value is Date => value !== null)
    .sort((left, right) => right.getTime() - left.getTime())
  return {
    batchExtractionId: row.id,
    projectContextId,
    schemaRevisionId: row.schemaRevisionId,
    extractionSchemaId: schema.extractionSchemaId,
    extractionSchemaName: owner.name,
    schemaRevisionNumber: schema.revisionNumber,
    strategy: row.strategy as ExtractionStrategy,
    executionStatus,
    executionFailure: null,
    startedAt: started[0] ?? null,
    finishedAt: executionStatus === 'COMPLETED' ? finished[0] ?? null : null,
    createdAt: row.createdAt,
    members,
  }
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
  input: ReadBatchInput,
): Promise<BatchExtractionResults | null> {
  const batch = await loadBatch(
    orm,
    input.projectContextId,
    input.batchExtractionId,
  )
  if (!batch) return null
  const extractions = await orm.public.Extraction.where({
    batchExtractionId: input.batchExtractionId,
  }).select(
    'id', 'sourceDocumentId', 'sourceRepresentationRevisionId',
    'outcome', 'resultPayload', 'reviewedAt', 'createdAt',
  ).orderBy([
    (attempt) => attempt.createdAt.desc(),
    (attempt) => attempt.id.desc(),
  ]).all()
  const latest = new Map<string, (typeof extractions)[number]>()
  for (const extraction of extractions) {
    const key = `${extraction.sourceDocumentId}:${extraction.sourceRepresentationRevisionId}`
    if (!latest.has(key)) latest.set(key, extraction)
  }
  const reviewedExtractionIds = [...latest.values()]
    .filter((extraction) =>
      extraction.outcome === 'SUCCEEDED' && extraction.resultPayload !== null && extraction.reviewedAt !== null,
    )
    .map((extraction) => extraction.id)
  const decisionsByExtractionId = reviewedExtractionIds.length > 0
    ? await loadFinalizedDecisions(orm, reviewedExtractionIds)
    : new Map<string, readonly ResultDecision[]>()
  const results: Array<BatchExtractionResults['results'][number]> = []
  let pending = 0
  let failed = 0
  let cancelled = 0
  for (const member of batch.members) {
    const extraction = latest.get(`${member.sourceDocumentId}:${member.sourceRepresentationRevisionId}`)
    if (!extraction) {
      if (member.executionStatus === 'QUEUED' || member.executionStatus === 'RUNNING') pending += 1
      else if (member.executionStatus === 'FAILED') {
        const code = member.executionFailure && typeof member.executionFailure === 'object'
          ? (member.executionFailure as { code?: unknown }).code
          : null
        if (code === 'cancelled') cancelled += 1
        else failed += 1
      }
      continue
    }
    if (extraction.outcome === 'FAILED') { failed += 1; continue }
    if (extraction.outcome === 'CANCELLED') { cancelled += 1; continue }
    if (extraction.outcome !== 'SUCCEEDED' || extraction.resultPayload === null) continue
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

function normalizeDecisions(decisions: ReviewAuthority['reviewDecisions']) {
  return decisions.map((decision) => ({
    resultPath: [...decision.resultPath],
    resultPathKey: JSON.stringify(decision.resultPath),
    evidenceAnchorId: decision.evidenceAnchorId,
    reviewedOccurrenceIds: [...new Set(decision.reviewedOccurrenceIds)].sort(),
    action: decision.action,
    reviewedValue: decision.reviewedValue,
  })).sort((left, right) => left.resultPathKey.localeCompare(right.resultPathKey))
}

function reviewAuthorityMatchesExtraction(
  extraction: ExtractionSnapshot,
  submitted: ReturnType<typeof normalizeDecisions>,
  authority: ReviewAuthority,
): boolean {
  if (!Array.isArray(extraction.evidence)) return false
  const evidenceByPath = new Map<string, string>()
  for (const link of extraction.evidence) {
    if (
      !link ||
      typeof link !== 'object' ||
      typeof link.evidenceAnchorId !== 'string' ||
      !Array.isArray(link.resultPath) ||
      !link.resultPath.every(
        (segment: unknown) =>
          typeof segment === 'string' ||
          (typeof segment === 'number' &&
            Number.isInteger(segment) &&
            segment >= 0),
      )
    )
      return false
    const key = JSON.stringify(link.resultPath)
    if (evidenceByPath.has(key)) return false
    evidenceByPath.set(key, link.evidenceAnchorId)
  }
  return (
    evidenceByPath.size === authority.evidenceResultPathKeys.size &&
    [...authority.evidenceResultPathKeys].every((key) =>
      evidenceByPath.has(key),
    ) &&
    submitted.length === evidenceByPath.size &&
    new Set(submitted.map((decision) => decision.resultPathKey)).size ===
      submitted.length &&
    submitted.every((decision) => {
      const owned = authority.occurrenceIdsByAnchor.get(
        decision.evidenceAnchorId,
      )
      return (
        evidenceByPath.get(decision.resultPathKey) ===
          decision.evidenceAnchorId &&
        owned !== undefined &&
        decision.reviewedOccurrenceIds.length === owned.size &&
        decision.reviewedOccurrenceIds.every((id) => owned.has(id)) &&
        ['APPROVED', 'EDITED', 'REJECTED'].includes(decision.action) &&
        ((decision.action === 'EDITED') ===
          (decision.reviewedValue !== null))
      )
    })
  )
}
async function reviewDigest(orm: DatabaseOrm, extractionId: string): Promise<string | null> {
  const extraction = await orm.public.Extraction.select('reviewedAt').first({ id: extractionId })
  if (!extraction?.reviewedAt) return null
  return (await orm.public.ExtractionReview.where({ extractionId })
    .select('decisionDigest')
    .orderBy((review) => review.revisionNumber.desc())
    .first())?.decisionDigest ?? null
}
type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0]

async function ownsResearcherJob(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  extractionId: string,
): Promise<boolean> {
  const { sql } = transaction
  const query = sql.public.extractionJob
    .innerJoin(sql.public.projectContext, (fields, functions) =>
      functions.eq(
        fields.extractionJob.projectContextId,
        fields.projectContext.id,
      ),
    )
    .select('extractionId', (fields) => fields.extractionJob.id)
    .where((fields, functions) =>
      functions.and(
        functions.eq(fields.extractionJob.id, extractionId),
        functions.eq(
          fields.projectContext.researcherAccountId,
          researcherAccountId,
        ),
      ),
    )
  return (await transaction.execute(query.build()).first()) !== null
}

async function cancelInteractiveExtraction(
  database: Database,
  extractionId: string,
  researcherAccountId: string,
): Promise<CancellationResult> {
  return database.transaction(async (transaction) => {
    if (!(await ownsResearcherJob(transaction, researcherAccountId, extractionId)))
      return 'not-found'
    const row = await transaction.orm.public.ExtractionJob.select(
      'kind', 'executionStatus',
    ).first({ id: extractionId })
    if (!row || row.kind !== 'INTERACTIVE' ||
        (row.executionStatus !== 'QUEUED' && row.executionStatus !== 'RUNNING'))
      return 'not-found'
    const now = new Date()
    if (row.executionStatus === 'QUEUED') {
      const cancelled = await transaction.orm.public.ExtractionJob.where({
        id: extractionId,
        kind: 'INTERACTIVE',
        executionStatus: 'QUEUED',
      }).updateAll({
        executionStatus: 'FAILED',
        failure: { code: 'cancelled', message: 'Extraction cancelled.', phase: 'loading' },
        finishedAt: now,
      })
      if (cancelled.length === 1) return 'cancellation-requested'
    }
    const requested = await transaction.orm.public.ExtractionJob.where({
      id: extractionId,
      kind: 'INTERACTIVE',
      executionStatus: 'RUNNING',
    }).updateAll({ cancelRequestedAt: now })
    return requested.length === 1 ? 'cancellation-requested' : 'not-found'
  })
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

async function loadResearcherExtraction(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  extractionId: string,
): Promise<ExtractionSnapshot | null> {
  if (
    !(await ownsResearcherJob(
      transaction,
      researcherAccountId,
      extractionId,
    ))
  )
    return null
  return loadCompletedJobExtraction(transaction.orm, extractionId)
}

async function readStoredReviewDraft(database: Database, accountId: string, extractionId: string): Promise<ReviewDraft | null> {
    return database.transaction(async (transaction) => {
      if (!await ownsResearcherJob(transaction, accountId, extractionId)) return null
      const row = await transaction.orm.public.Extraction.select('reviewDraft', 'reviewDraftVersion', 'reviewedAt').first({ id: extractionId })
      if (!row) return null
      return { version: row.reviewDraftVersion, decisions: row.reviewedAt ? [] : (row.reviewDraft ?? []) as unknown as ReviewDraft['decisions'] }
    })
  }

async function saveStoredReviewDraft(database: Database, accountId: string, extractionId: string, draft: ReviewDraft): Promise<ReviewDraft> {
    return database.transaction(async (transaction) => {
      if (!await ownsResearcherJob(transaction, accountId, extractionId))
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
    if (!await ownsResearcherJob(transaction, accountId, extractionId))
      throw new ExtractionError('not_found', 'That Extraction was not found.')
    const updated = await transaction.orm.public.Extraction.where({
      id: extractionId, reviewable: true, reviewDraftVersion: version,
    }).updateAll({ reviewedAt: null, reviewDraft: [], reviewDraftVersion: version + 1 })
    if (updated.length !== 1) throw new ExtractionError('review_conflict', 'The review changed elsewhere. Reload before continuing.')
    return { decisions: [], version: version + 1 }
  })
}

/**
 * The worker's store: it leases jobs and reads their pinned inputs without a
 * Researcher Account, because ownership was checked when the job was scheduled.
 */
class PostgresExtractionJobStore implements InternalExtractionJobStore, ExtractionInputReader {
  private readonly database: Database
  private readonly packages: CanonicalPackageStore
  constructor(
    database: Database = db,
    packages: CanonicalPackageStore = canonicalPackageStore,
  ) {
    this.database = database
    this.packages = packages
  }

  async loadExtractionInputs(
    sourceRepresentationRevisionId: string,
    schemaRevisionId: string,
  ): Promise<LoadedExtractionInputs | null> {
    const loaded = await this.database.transaction(async ({ orm }) => {
      const representation = await orm.public.SourceRepresentationRevision.select(
        'id', 'sourceDocumentId', 'artifactReference', 'artifactSha256',
      ).first({ id: sourceRepresentationRevisionId })
      if (!representation) return null
      const document = await orm.public.SourceDocument.select('projectContextId').first({ id: representation.sourceDocumentId })
      const schema = await orm.public.SchemaRevision.select('id', 'extractionSchemaId', 'schemaTree').first({ id: schemaRevisionId })
      if (!document || !schema) return null
      const owner = await orm.public.ExtractionSchema.select('projectContextId').first({ id: schema.extractionSchemaId })
      if (!owner || owner.projectContextId !== document.projectContextId) return null
      return { representation, document, schema }
    })
    if (!loaded) return null
    const artifact = await this.packages.read({
      artifactReference: loaded.representation.artifactReference,
      artifactSha256: loaded.representation.artifactSha256,
    }, 'source')
    return {
      sourceDocumentId: loaded.representation.sourceDocumentId,
      projectContextId: loaded.document.projectContextId,
      sourceRepresentationRevisionId: loaded.representation.id,
      schemaRevisionId: loaded.schema.id,
      schemaTree: loaded.schema.schemaTree,
      parsedDocument: JSON.parse(new TextDecoder().decode(artifact.bytes)),
    }
  }

  readExtractionAttempt(extractionId: string): Promise<ExtractionAttemptSnapshot | null> {
    return loadExtractionAttempt(this.database.orm, extractionId)
  }

  async claim(
    owner: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<ClaimedExtractionJob | null> {
    for (const kind of ['INTERACTIVE', 'BATCH_MEMBER'] as const) {
      const queued = await this.database.orm.public.ExtractionJob.where({
        kind,
        executionStatus: 'QUEUED',
      }).select(
        'id', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe',
        'retryOfId', 'retryDocument', 'rediscover', 'retryRecordStartBlockIds',
        'batchExtractionId', 'leaseVersion', 'startedAt', 'createdAt',
        'complete', 'modelAttribution', 'diagnostics', 'resultPayload',
      ).orderBy([
        (job) => job.createdAt.asc(),
        (job) => job.id.asc(),
      ]).first()
      const expired = await this.database.orm.public.ExtractionJob.where({
        kind,
        executionStatus: 'RUNNING',
      }).select(
        'id', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe',
        'retryOfId', 'retryDocument', 'rediscover', 'retryRecordStartBlockIds',
        'batchExtractionId', 'leaseVersion', 'leaseExpiresAt', 'startedAt', 'createdAt',
        'cancelRequestedAt', 'complete', 'modelAttribution', 'diagnostics', 'resultPayload',
      ).orderBy([
        (job) => job.createdAt.asc(),
        (job) => job.id.asc(),
      ]).all()
      const reclaimable = expired.find((job) =>
        job.leaseExpiresAt === null || job.leaseExpiresAt.getTime() <= now.getTime())
      const candidate = [queued, reclaimable]
        .filter((job): job is NonNullable<typeof queued | typeof reclaimable> => job !== null && job !== undefined)
        .sort((left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id))[0]
      if (!candidate) continue
      if ('cancelRequestedAt' in candidate && candidate.cancelRequestedAt !== null) {
        await this.database.orm.public.ExtractionJob.where({
          id: candidate.id,
          leaseVersion: candidate.leaseVersion,
          executionStatus: 'RUNNING',
        }).updateAll({
          executionStatus: 'FAILED',
          failure: {
            code: 'cancelled',
            message: 'Extraction cancelled.',
            phase: candidate.resultPayload === null ? 'extracting' : 'grounding',
          },
          finishedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        return this.claim(owner, now, leaseExpiresAt)
      }
      const version = candidate.leaseVersion + 1
      const claimIdentity = {
        id: candidate.id,
        leaseVersion: candidate.leaseVersion,
        executionStatus: queued?.id === candidate.id ? 'QUEUED' : 'RUNNING',
      } as const
      const claimUpdate = {
        executionStatus: 'RUNNING',
        failure: null,
        startedAt: candidate.startedAt ?? now,
        finishedAt: null,
        leaseOwner: owner,
        leaseVersion: version,
        leaseExpiresAt,
      } as const
      // updateAll keeps lease predicates in the UPDATE after waiting for a row lock.
      let [claimed] = queued?.id === candidate.id
        ? await this.database.orm.public.ExtractionJob.where(claimIdentity)
          .updateAll(claimUpdate)
        : await this.database.orm.public.ExtractionJob.where({
            ...claimIdentity,
            executionStatus: 'RUNNING',
          }).where((job) => job.leaseExpiresAt.lte(now)).updateAll(claimUpdate)
      if (!claimed && queued?.id !== candidate.id)
        [claimed] = await this.database.orm.public.ExtractionJob.where({
          ...claimIdentity,
          executionStatus: 'RUNNING',
          leaseExpiresAt: null,
        }).updateAll(claimUpdate)
      if (!claimed) return this.claim(owner, now, leaseExpiresAt)
      const retryRecordStartBlockIds = candidate.retryRecordStartBlockIds
      const input = candidate.retryOfId
        ? {
            kind: 'retry' as const,
            extractionId: candidate.id,
            retryOfId: candidate.retryOfId,
            retryDocument: candidate.retryDocument ?? true,
            rediscover: candidate.rediscover ?? true,
            retryRecordStartBlockIds: Array.isArray(retryRecordStartBlockIds)
              ? retryRecordStartBlockIds.filter((id): id is string => typeof id === 'string')
              : [],
          }
        : candidate.batchExtractionId
          ? {
              kind: 'batch-member' as const,
              extractionId: candidate.id,
              sourceRepresentationRevisionId: candidate.sourceRepresentationRevisionId,
              schemaRevisionId: candidate.schemaRevisionId,
              strategy: candidate.strategy,
              batchExtractionId: candidate.batchExtractionId,
            }
          : {
              kind: 'fresh' as const,
              extractionId: candidate.id,
              sourceRepresentationRevisionId: candidate.sourceRepresentationRevisionId,
              schemaRevisionId: candidate.schemaRevisionId,
              strategy: candidate.strategy,
              catalogRecipe: candidate.catalogRecipe,
            }
      const checkpoint = candidate.resultPayload !== null &&
          candidate.complete !== null &&
          candidate.modelAttribution !== null &&
          candidate.diagnostics !== null
        ? {
            result: candidate.resultPayload as Readonly<Record<string, unknown>>,
            complete: candidate.complete,
            modelAttribution: candidate.modelAttribution as ExtractionValueCheckpoint['modelAttribution'],
            diagnostics: candidate.diagnostics as ExtractionValueCheckpoint['diagnostics'],
          }
        : null
      return {
        input,
        checkpoint,
        lease: { owner, version, expiresAt: leaseExpiresAt },
      }
    }
    return null
  }

  async renew(
    id: string,
    lease: ClaimedExtractionJob['lease'],
    expiresAt: Date,
  ): Promise<'owned' | 'cancelled' | 'lost'> {
    const row = await this.database.orm.public.ExtractionJob.select(
      'cancelRequestedAt',
    ).first({
      id,
      executionStatus: 'RUNNING',
      leaseOwner: lease.owner,
      leaseVersion: lease.version,
    })
    if (!row) return 'lost'
    if (row.cancelRequestedAt !== null) return 'cancelled'
    const updated = await this.database.orm.public.ExtractionJob.where({
      id,
      executionStatus: 'RUNNING',
      leaseOwner: lease.owner,
      leaseVersion: lease.version,
    }).updateAll({ leaseExpiresAt: expiresAt })
    return updated.length === 1 ? 'owned' : 'lost'
  }

  async checkpoint(
    id: string,
    lease: ClaimedExtractionJob['lease'],
    checkpoint: ExtractionValueCheckpoint,
  ): Promise<boolean> {
    const updated = await this.database.orm.public.ExtractionJob.where({
      id,
      executionStatus: 'RUNNING',
      leaseOwner: lease.owner,
      leaseVersion: lease.version,
      cancelRequestedAt: null,
    }).updateAll({
      complete: checkpoint.complete,
      modelAttribution: checkpoint.modelAttribution,
      diagnostics: checkpoint.diagnostics,
      resultPayload: checkpoint.result,
    })
    return updated.length === 1
  }

  async complete(
    id: string,
    lease: ClaimedExtractionJob['lease'],
    input: TerminalExtraction,
    finishedAt: Date,
  ): Promise<boolean> {
    return this.database.transaction(async ({ orm }) => {
      const job = await orm.public.ExtractionJob.select('id').first({
        id,
        executionStatus: 'RUNNING',
        leaseOwner: lease.owner,
        leaseVersion: lease.version,
        cancelRequestedAt: null,
      })
      if (!job) return false
      await orm.public.Extraction.create({
        id: input.extractionId,
        sourceDocumentId: input.sourceDocumentId,
        sourceRepresentationRevisionId: input.sourceRepresentationRevisionId,
        schemaRevisionId: input.schemaRevisionId,
        strategy: input.strategy,
        outcome: 'SUCCEEDED',
        complete: input.complete,
        modelAttribution: input.modelAttribution,
        diagnostics: input.diagnostics,
        failure: null,
        resultPayload: input.result,
        evidenceLinks: input.evidence,
        reviewable: input.reviewable,
        retryOfId: input.retryOfId,
        batchExtractionId: input.batchExtractionId,
      })
      const updated = await orm.public.ExtractionJob.where({
        id,
        executionStatus: 'RUNNING',
        leaseOwner: lease.owner,
        leaseVersion: lease.version,
        cancelRequestedAt: null,
      }).updateAll({
        executionStatus: 'COMPLETED',
        complete: null,
        modelAttribution: null,
        diagnostics: null,
        resultPayload: null,
        failure: null,
        finishedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      if (updated.length !== 1)
        throw new Error('Extraction Job lease was lost during terminal promotion.')
      return true
    })
  }

  async fail(
    id: string,
    lease: ClaimedExtractionJob['lease'],
    failure: ExtractionJobFailure,
    finishedAt: Date,
  ): Promise<boolean> {
    const active = {
      id,
      executionStatus: 'RUNNING',
      leaseOwner: lease.owner,
      leaseVersion: lease.version,
    } as const
    const failed = await this.database.orm.public.ExtractionJob.where({
      ...active,
      cancelRequestedAt: null,
    }).updateAll({
      executionStatus: 'FAILED',
      failure,
      finishedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    if (failed.length === 1) return true
    const cancelled = await this.database.orm.public.ExtractionJob.where({
      id,
      executionStatus: 'RUNNING',
      leaseOwner: lease.owner,
      leaseVersion: lease.version,
    })
      .where((job) => job.cancelRequestedAt.isNotNull())
      .updateAll({
        executionStatus: 'FAILED',
        failure: {
          code: 'cancelled',
          message: 'Extraction cancelled.',
          phase: failure.phase,
        },
        finishedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
    return cancelled.length === 1
  }
}
class ResearcherPostgresExtractionPersistence implements ExtractionPersistence {
  private readonly researcherAccountId: string
  private readonly database: Database
  private readonly packages: CanonicalPackageStore

  constructor(
    researcherAccountId: string,
    database: Database = db,
    packages: CanonicalPackageStore = canonicalPackageStore,
  ) {
    this.researcherAccountId = researcherAccountId
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

  scheduleExtraction(input: RunSingleInput): Promise<RunSingleResult | null> {
    return scheduleInteractiveExtraction(
      this.database,
      input,
      this.researcherAccountId,
    )
  }

  readExtractionAttempt(
    extractionId: string,
  ): Promise<ExtractionAttemptSnapshot | null> {
    return this.database.transaction(async (transaction) => {
      const job = await transaction.orm.public.ExtractionJob.select(
        'kind', 'executionStatus',
      ).first({
        id: extractionId,
      })
      if (!job ||
          (job.kind !== 'INTERACTIVE' && job.executionStatus !== 'COMPLETED') ||
          !(await ownsResearcherJob(
        transaction,
        this.researcherAccountId,
        extractionId,
      ))) return null
      return loadExtractionAttempt(transaction.orm, extractionId)
    })
  }

  cancelExtraction(extractionId: string): Promise<CancellationResult> {
    return cancelInteractiveExtraction(
      this.database,
      extractionId,
      this.researcherAccountId,
    )
  }

  async readDocumentExtractions(
    input: ReadDocumentExtractionsInput,
  ): Promise<DocumentExtractionsSnapshot | null> {
    return this.database.transaction(async (transaction) => {
      if (!(await ownsResearcherDocument(
        transaction,
        this.researcherAccountId,
        input.sourceDocumentId,
      ))) return null
      return loadDocumentExtractions(transaction.orm, input)
    })
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
    let status:
      | 'not-found'
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
        if (
          extraction.outcome !== 'SUCCEEDED' ||
          !extraction.reviewable ||
          !Array.isArray(extraction.evidence)
        )
          return 'invalid' as const
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
      if (!uniqueConstraint(error)) throw error
      status = await this.database.transaction(async (transaction) => {
        if (
          !(await ownsResearcherJob(
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

  private readBatchForResearcher(
    projectContextId: string,
    batchExtractionId: string,
  ): Promise<DurableBatchExtraction | null> {
    return this.database.transaction(async (transaction) => {
      if (
        !(await ownsResearcherBatch(
          transaction,
          this.researcherAccountId,
          projectContextId,
          batchExtractionId,
        ))
      )
        return null
      return loadBatch(
        transaction.orm,
        projectContextId,
        batchExtractionId,
      )
    })
  }

  async scheduleBatch(
    input: ScheduleBatchInput,
  ): Promise<ScheduleBatchResult | null> {
    const batchExtractionId =
      input.repetition === 'create-new' ? randomUUID() : selectionId(input)
    try {
      const opened = await this.database.transaction(async ({ orm }) => {
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
        }> = []
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
          const representation =
            await orm.public.SourceRepresentationRevision.where({
              sourceDocumentId,
            })
              .select('id')
              .orderBy((revision) => revision.revisionNumber.desc())
              .first()
          if (!representation) return 'invalid' as const
          members.push({
            sourceDocumentId,
            sourceRepresentationRevisionId: representation.id,
          })
        }
        await orm.public.BatchExtraction.create({
          id: batchExtractionId,
          projectContextId: input.projectContextId,
          schemaRevisionId: input.schemaRevisionId,
          strategy: input.strategy,
        })
        for (const member of members) {
          const initialExtractionJobId = stableUuid(
            'batch-member-extraction-job',
            stableJson([batchExtractionId, member.sourceRepresentationRevisionId]),
          )
          await orm.public.ExtractionJob.create({
            id: initialExtractionJobId,
            kind: 'BATCH_MEMBER',
            projectContextId: input.projectContextId,
            ...member,
            schemaRevisionId: input.schemaRevisionId,
            strategy: input.strategy,
            batchExtractionId,
          })
          await orm.public.BatchExtractionMember.create({
            batchExtractionId,
            ...member,
            initialExtractionJobId,
          })
        }
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
      )
      if (!batch)
        throw new Error('Persisted Batch Extraction could not be read.')
      return { disposition: 'created', batch: snapshot(batch) }
    } catch (error) {
      if (!uniqueConstraint(error)) throw error
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
          (member, index) => member.sourceDocumentId === selected[index],
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
      { loadBatch, semanticSuggestionTree, snapshot },
    )
  }

  async listBatches(
    projectContextId: string,
    limit: number,
  ): Promise<readonly BatchExtractionSnapshot[] | null> {
    return this.database.transaction(async ({ orm }) => {
      if (
        !(await orm.public.ProjectContext.select('id').first({
          id: projectContextId,
          researcherAccountId: this.researcherAccountId,
        }))
      )
        return null
      const rows = await orm.public.BatchExtraction.where({
        projectContextId,
      })
        .select('id')
        .orderBy([
          (batch) => batch.createdAt.desc(),
          (batch) => batch.id.desc(),
        ])
        .take(limit)
        .all()
      const batches: BatchExtractionSnapshot[] = []
      for (const row of rows) {
        const batch = await loadBatch(orm, projectContextId, row.id)
        if (batch) batches.push(snapshot(batch))
      }
      return batches
    })
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

  readBatchResults(
    input: ReadBatchInput,
  ): Promise<BatchExtractionResults | null> {
    return this.database.transaction(async (transaction) => {
      if (
        !(await ownsResearcherBatch(
          transaction,
          this.researcherAccountId,
          input.projectContextId,
          input.batchExtractionId,
        ))
      )
        return null
      return loadResults(transaction.orm, input)
    })
  }
}

export function createResearcherExtractionPersistence(
  researcherAccountId: string,
  database: Database = db,
  packages: CanonicalPackageStore = canonicalPackageStore,
): ExtractionPersistence {
  return new ResearcherPostgresExtractionPersistence(
    researcherAccountId,
    database,
    packages,
  )
}

export function createInternalExtractionJobStore(
  database: Database = db,
  packages: CanonicalPackageStore = canonicalPackageStore,
): InternalExtractionJobStore & ExtractionInputReader {
  return new PostgresExtractionJobStore(database, packages)
}
