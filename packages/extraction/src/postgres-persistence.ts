import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalPackageStore,
  db,
  type CanonicalPackageStore,
  type Database,
  type DatabaseOrm,
} from 'db'
import { ExtractionError } from './errors.js'
import { persistSuggestedBatch } from './postgres-suggested-batch.js'
import type {
  ExtractionPersistence,
  PersistedReviewResult,
  LoadedExtractionInputs,
  PersistExtractionResult,
  ReviewAuthority,
  TerminalExtraction,
} from './dependencies.js'
import type {
  BatchExtractionResults,
  BatchExtractionSnapshot,
  DocumentExtractionsSnapshot,
  ExtractionSnapshot,
  ExtractionStrategy,
  ReadBatchInput,
  ReadDocumentExtractionsInput,
  ScheduleBatchInput,
  ScheduleBatchResult,
  ScheduleSuggestedBatchInput,
} from './types.js'

export type OperationLease = Readonly<{ owner: string; version: number; expiresAt: Date }>
type Status = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
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
  leaseOwner: string | null
  leaseVersion: number
  leaseExpiresAt: Date | null
  createdAt: Date
  members: readonly BatchMember[]
}>
export type ClaimedBatchExtraction = DurableBatchExtraction & Readonly<{ lease: OperationLease }>

export function uniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'sqlState' in error && error.sqlState === '23505'
}
function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}
export function stableUuid(namespace: string, value: string): string {
  const hash = createHash('sha256').update(`${namespace}:${value}`).digest('hex')
  const variant = (['8', '9', 'a', 'b'] as const)[parseInt(hash[16]!, 16) & 3]
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
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
  const decisions = await orm.public.ReviewDecision.where({ extractionId })
    .select('evidenceAnchorId', 'reviewedOccurrenceIds')
    .orderBy((decision) => decision.evidenceAnchorId.asc()).all()
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
      evidenceAnchorId: decision.evidenceAnchorId,
      reviewedOccurrenceIds: decision.reviewedOccurrenceIds as string[],
    })),
  }
}

export async function loadBatch(
  orm: DatabaseOrm,
  projectContextId: string,
  batchExtractionId: string,
): Promise<DurableBatchExtraction | null> {
  const row = await orm.public.BatchExtraction.select(
    'id', 'schemaRevisionId', 'strategy', 'executionStatus', 'failure', 'startedAt',
    'finishedAt', 'leaseOwner', 'leaseVersion', 'leaseExpiresAt', 'createdAt',
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
    .select('sourceDocumentId', 'sourceRepresentationRevisionId', 'executionStatus',
      'failure', 'startedAt', 'finishedAt')
    .orderBy((member) => member.sourceDocumentId.asc()).all()
  const members: BatchMember[] = []
  for (const member of memberRows) {
    const extraction = await orm.public.Extraction.where({
      batchExtractionId,
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
    }).select('id', 'outcome', 'complete', 'reviewable', 'createdAt', 'reviewedAt', 'failure')
      .orderBy([(attempt) => attempt.createdAt.desc(), (attempt) => attempt.id.desc()]).first()
    members.push({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
      executionStatus: member.executionStatus as Status,
      executionFailure: member.failure,
      startedAt: member.startedAt,
      finishedAt: member.finishedAt,
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
  return {
    batchExtractionId: row.id,
    projectContextId,
    schemaRevisionId: row.schemaRevisionId,
    extractionSchemaId: schema.extractionSchemaId,
    extractionSchemaName: owner.name,
    schemaRevisionNumber: schema.revisionNumber,
    strategy: row.strategy as ExtractionStrategy,
    executionStatus: row.executionStatus as Status,
    executionFailure: row.failure,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    leaseOwner: row.leaseOwner,
    leaseVersion: row.leaseVersion,
    leaseExpiresAt: row.leaseExpiresAt,
    createdAt: row.createdAt,
    members,
  }
}

async function loadResults(
  orm: DatabaseOrm,
  input: ReadBatchInput,
): Promise<BatchExtractionResults | null> {
  const batch = (await orm.public.BatchExtraction.select('id', 'executionStatus')
    .include('members' as never, (members) => members
      .select('sourceDocumentId', 'sourceRepresentationRevisionId', 'executionStatus')
      .orderBy((member) => member.sourceDocumentId.asc()))
    .include('extractions' as never, (attempts) => attempts
      .select('id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'outcome', 'resultPayload', 'createdAt')
      .orderBy([(attempt) => attempt.createdAt.desc(), (attempt) => attempt.id.desc()]))
    .first({ id: input.batchExtractionId, projectContextId: input.projectContextId })) as unknown as {
      id: string
      executionStatus: Status
      members: Array<{ sourceDocumentId: string; sourceRepresentationRevisionId: string; executionStatus: Status }>
      extractions: Array<{
        id: string
        sourceDocumentId: string
        sourceRepresentationRevisionId: string
        outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
        resultPayload: unknown | null
        createdAt: Date
      }>
    } | null
  if (!batch) return null
  const latest = new Map<string, (typeof batch.extractions)[number]>()
  for (const extraction of batch.extractions) {
    const key = `${extraction.sourceDocumentId}:${extraction.sourceRepresentationRevisionId}`
    if (!latest.has(key)) latest.set(key, extraction)
  }
  const results: Array<BatchExtractionResults['results'][number]> = []
  let pending = 0
  let failed = 0
  let cancelled = 0
  for (const member of batch.members) {
    const extraction = latest.get(`${member.sourceDocumentId}:${member.sourceRepresentationRevisionId}`)
    if (!extraction) {
      if (member.executionStatus === 'QUEUED' || member.executionStatus === 'RUNNING') pending += 1
      else if (member.executionStatus === 'FAILED') failed += 1
      continue
    }
    if (extraction.outcome === 'FAILED') { failed += 1; continue }
    if (extraction.outcome === 'CANCELLED') { cancelled += 1; continue }
    if (extraction.outcome !== 'SUCCEEDED' || extraction.resultPayload === null) continue
    results.push({
      sourceDocumentId: member.sourceDocumentId,
      extractionId: extraction.id,
      result: extraction.resultPayload as Record<string, unknown>,
    })
  }
  return {
    batchExtractionId: batch.id,
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
    evidenceAnchorId: decision.evidenceAnchorId,
    reviewedOccurrenceIds: [...new Set(decision.reviewedOccurrenceIds)].sort(),
  })).sort((left, right) => left.evidenceAnchorId.localeCompare(right.evidenceAnchorId))
}
async function reviewDigest(orm: DatabaseOrm, extractionId: string): Promise<string | null> {
  return (await orm.public.ExtractionReview.select('decisionDigest').first({ extractionId }))?.decisionDigest ?? null
}

export class PostgresExtractionPersistence implements ExtractionPersistence {
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

  async readCanonicalParsedDocument(sourceRepresentationRevisionId: string): Promise<unknown | null> {
    const row = await this.database.orm.public.SourceRepresentationRevision.select(
      'artifactReference', 'artifactSha256',
    ).first({ id: sourceRepresentationRevisionId })
    if (!row) return null
    const artifact = await this.packages.read({
      artifactReference: row.artifactReference,
      artifactSha256: row.artifactSha256,
    }, 'source')
    return JSON.parse(new TextDecoder().decode(artifact.bytes))
  }

  readExtraction(extractionId: string) { return loadExtraction(this.database.orm, extractionId) }

  async readDocumentExtractions(
    input: ReadDocumentExtractionsInput,
  ): Promise<DocumentExtractionsSnapshot | null> {
    return this.database.transaction(async ({ orm }) => {
      const selected = input.extractionId
        ? await orm.public.Extraction.select(
            'id',
            'sourceRepresentationRevisionId',
          ).first({
            id: input.extractionId,
            sourceDocumentId: input.sourceDocumentId,
          })
        : null
      if (input.extractionId && !selected) return null

      const representationId = selected?.sourceRepresentationRevisionId ??
        (await orm.public.SourceRepresentationRevision.where({
          sourceDocumentId: input.sourceDocumentId,
        })
          .select('id')
          .orderBy([
            (revision) => revision.revisionNumber.desc(),
            (revision) => revision.id.desc(),
          ])
          .first())?.id
      if (!representationId) return null

      const latestAttemptRow = selected ??
        await orm.public.Extraction.where({
          sourceDocumentId: input.sourceDocumentId,
        })
          .select('id')
          .orderBy([
            (attempt) => attempt.createdAt.desc(),
            (attempt) => attempt.id.desc(),
          ])
          .first()
      const latestAttempt = latestAttemptRow
        ? await loadExtraction(orm, latestAttemptRow.id)
        : null

      const latestReviewedRow = await orm.public.Extraction.where({
        sourceDocumentId: input.sourceDocumentId,
      })
        .where((attempt) => attempt.reviewedAt.isNotNull())
        .select('id')
        .orderBy([
          (attempt) => attempt.reviewedAt.desc(),
          (attempt) => attempt.createdAt.desc(),
          (attempt) => attempt.id.desc(),
        ])
        .first()
      return {
        sourceRepresentationRevisionId: representationId,
        latestAttempt,
        latestReviewed: latestReviewedRow
          ? await loadExtraction(orm, latestReviewedRow.id)
          : null,
      }
    })
  }

  async persistExtraction(input: TerminalExtraction): Promise<PersistExtractionResult> {
    try {
      const created = await this.database.transaction(async ({ orm }) => {
        const representation = await orm.public.SourceRepresentationRevision.select('id', 'sourceDocumentId').first({
          id: input.sourceRepresentationRevisionId,
          sourceDocumentId: input.sourceDocumentId,
        })
        const document = representation
          ? await orm.public.SourceDocument.select('projectContextId').first({ id: representation.sourceDocumentId }) : null
        const schema = await orm.public.SchemaRevision.select('id', 'extractionSchemaId').first({ id: input.schemaRevisionId })
        const owner = schema
          ? await orm.public.ExtractionSchema.select('projectContextId').first({ id: schema.extractionSchemaId }) : null
        if (!representation || !document || !schema || !owner || owner.projectContextId !== document.projectContextId) return false
        if (input.batchExtractionId) {
          const member = await orm.public.BatchExtractionMember.select('batchExtractionId').first({
            batchExtractionId: input.batchExtractionId,
            sourceDocumentId: input.sourceDocumentId,
            sourceRepresentationRevisionId: input.sourceRepresentationRevisionId,
          })
          if (!member) return false
        }
        await orm.public.Extraction.create({
          id: input.extractionId,
          sourceDocumentId: input.sourceDocumentId,
          sourceRepresentationRevisionId: input.sourceRepresentationRevisionId,
          schemaRevisionId: input.schemaRevisionId,
          strategy: input.strategy,
          outcome: input.outcome,
          complete: input.complete,
          modelAttribution: input.modelAttribution,
          diagnostics: input.diagnostics,
          failure: input.failure,
          resultPayload: input.result,
          evidenceLinks: input.evidence,
          reviewable: input.reviewable,
          retryOfId: input.retryOfId,
          batchExtractionId: input.batchExtractionId,
        })
        return true
      })
      if (!created) return { status: 'invalid' }
      const extraction = await loadExtraction(this.database.orm, input.extractionId)
      if (!extraction) throw new Error('Persisted Extraction could not be read.')
      return { status: 'created', extraction }
    } catch (error) {
      if (!uniqueConstraint(error)) throw error
      const extraction = await loadExtraction(this.database.orm, input.extractionId)
      if (!extraction) throw error
      const same = extraction.sourceRepresentationRevisionId === input.sourceRepresentationRevisionId &&
        extraction.schemaRevisionId === input.schemaRevisionId &&
        extraction.strategy === input.strategy &&
        extraction.batchExtractionId === input.batchExtractionId &&
        extraction.retryOfId === input.retryOfId
      return same ? { status: 'replayed', extraction } : { status: 'conflict', extraction }
    }
  }

  async finalizeReview(extractionId: string, authority: ReviewAuthority): Promise<PersistedReviewResult> {
    const submitted = normalizeDecisions(authority.reviewDecisions)
    const digest = JSON.stringify(submitted)
    if (submitted.length !== authority.reviewDecisions.length ||
      new Set(submitted.map((decision) => decision.evidenceAnchorId)).size !== submitted.length) return { status: 'invalid' }
    let status: 'not-found' | 'invalid' | 'conflict' | 'replayed' | 'reviewed'
    try {
      status = await this.database.transaction(async ({ orm }) => {
        const extraction = await loadExtraction(orm, extractionId)
        if (!extraction) return 'not-found' as const
        if (extraction.outcome !== 'SUCCEEDED' || !extraction.reviewable || !Array.isArray(extraction.evidence)) return 'invalid' as const
        const anchors = new Set<string>()
        const paths = new Set<string>()
        for (const link of extraction.evidence) {
          if (!link || typeof link !== 'object' || typeof link.evidenceAnchorId !== 'string' ||
            !Array.isArray(link.resultPath) || !link.resultPath.every((segment: unknown) =>
              typeof segment === 'string' ||
              (typeof segment === 'number' && Number.isInteger(segment) && segment >= 0))) return 'invalid' as const
          anchors.add(link.evidenceAnchorId)
          const key = JSON.stringify(link.resultPath)
          paths.add(key)
        }
        if (paths.size !== authority.evidenceResultPathKeys.size ||
          [...authority.evidenceResultPathKeys].some((key) => !paths.has(key)) ||
          anchors.size !== submitted.length || submitted.some((decision) => !anchors.has(decision.evidenceAnchorId)) ||
          submitted.some((decision) => {
            const owned = authority.occurrenceIdsByAnchor.get(decision.evidenceAnchorId)
            return !owned || decision.reviewedOccurrenceIds.some((id) => !owned.has(id))
          })) return 'invalid' as const
        if (extraction.reviewedAt) return (await reviewDigest(orm, extractionId)) === digest ? 'replayed' as const : 'conflict' as const
        await orm.public.ExtractionReview.create({ extractionId, decisionDigest: digest })
        for (const decision of submitted) await orm.public.ReviewDecision.create({ extractionId, ...decision })
        await orm.public.Extraction.where({ id: extractionId }).update({ reviewedAt: new Date() })
        return 'reviewed' as const
      })
    } catch (error) {
      if (!uniqueConstraint(error)) throw error
      status = (await reviewDigest(this.database.orm, extractionId)) === digest ? 'replayed' : 'conflict'
    }
    if (status === 'not-found' || status === 'invalid' || status === 'conflict') return { status }
    const extraction = await loadExtraction(this.database.orm, extractionId)
    if (!extraction) throw new Error('Reviewed Extraction could not be read.')
    return { status, extraction }
  }

  async scheduleBatch(input: ScheduleBatchInput): Promise<ScheduleBatchResult | null> {
    const batchExtractionId = input.repetition === 'create-new' ? randomUUID() : selectionId(input)
    const read = () => loadBatch(this.database.orm, input.projectContextId, batchExtractionId)
    try {
      const opened = await this.database.transaction(async ({ orm }) => {
        if (!await orm.public.ProjectContext.select('id').first({ id: input.projectContextId })) return 'missing' as const
        if (input.sourceDocumentIds.length === 0) return 'invalid' as const
        const schema = await orm.public.SchemaRevision.select('extractionSchemaId').first({ id: input.schemaRevisionId })
        const owner = schema ? await orm.public.ExtractionSchema.select('projectContextId').first({ id: schema.extractionSchemaId }) : null
        if (!schema || !owner || owner.projectContextId !== input.projectContextId) return 'invalid' as const
        const current = await orm.public.SchemaRevision.where({ extractionSchemaId: schema.extractionSchemaId })
          .select('id').orderBy((revision) => revision.revisionNumber.desc()).first()
        if (current?.id !== input.schemaRevisionId) return 'invalid' as const
        const members: Array<{ sourceDocumentId: string; sourceRepresentationRevisionId: string }> = []
        for (const sourceDocumentId of canonicalIds(input.sourceDocumentIds)) {
          if (!await orm.public.SourceDocument.select('id').first({ id: sourceDocumentId, projectContextId: input.projectContextId })) return 'invalid' as const
          const representation = await orm.public.SourceRepresentationRevision.where({ sourceDocumentId })
            .select('id').orderBy((revision) => revision.revisionNumber.desc()).first()
          if (!representation) return 'invalid' as const
          members.push({ sourceDocumentId, sourceRepresentationRevisionId: representation.id })
        }
        await orm.public.BatchExtraction.create({
          id: batchExtractionId,
          projectContextId: input.projectContextId,
          schemaRevisionId: input.schemaRevisionId,
          strategy: input.strategy,
        })
        for (const member of members) await orm.public.BatchExtractionMember.create({ batchExtractionId, ...member })
        return 'created' as const
      })
      if (opened === 'missing') return null
      if (opened === 'invalid') throw new ExtractionError('invalid_extraction_pins', 'Use the Current Schema Revision and Source Documents in this Project Context with a Source Representation.')
      const batch = await read()
      if (!batch) throw new Error('Persisted Batch Extraction could not be read.')
      return { disposition: 'created', batch: snapshot(batch) }
    } catch (error) {
      if (!uniqueConstraint(error)) throw error
      const batch = await read()
      const selected = canonicalIds(input.sourceDocumentIds)
      if (!batch || batch.schemaRevisionId !== input.schemaRevisionId || batch.strategy !== input.strategy ||
        batch.members.length !== selected.length || !batch.members.every((member, index) => member.sourceDocumentId === selected[index])) {
        throw new ExtractionError('batch_conflict', 'The Batch Extraction identity belongs to another selection.', { cause: error })
      }
      return { disposition: 'replayed', batch: snapshot(batch) }
    }
  }

  async scheduleSuggestedBatch(input: ScheduleSuggestedBatchInput): Promise<ScheduleBatchResult | null> {
    return persistSuggestedBatch(this.database, input, {
      loadBatch,
      semanticSuggestionTree,
      snapshot,
      stableJson,
      stableUuid,
      uniqueConstraint,
    })
  }

  async listBatches(projectContextId: string, limit: number): Promise<readonly BatchExtractionSnapshot[] | null> {
    if (!await this.database.orm.public.ProjectContext.select('id').first({ id: projectContextId })) return null
    const rows = await this.database.orm.public.BatchExtraction.where({ projectContextId }).select('id')
      .orderBy([(batch) => batch.createdAt.desc(), (batch) => batch.id.desc()]).take(limit).all()
    const batches: BatchExtractionSnapshot[] = []
    for (const row of rows) {
      const batch = await loadBatch(this.database.orm, projectContextId, row.id)
      if (batch) batches.push(snapshot(batch))
    }
    return batches
  }
  async readBatch(input: ReadBatchInput): Promise<BatchExtractionSnapshot | null> {
    const batch = await loadBatch(this.database.orm, input.projectContextId, input.batchExtractionId)
    return batch ? snapshot(batch) : null
  }
  readBatchResults(input: ReadBatchInput) { return loadResults(this.database.orm, input) }
  async claimBatch(owner: string, now: Date, leaseExpiresAt: Date): Promise<ClaimedBatchExtraction | null> {
    const queued = await this.database.orm.public.BatchExtraction.where({ executionStatus: 'QUEUED' })
      .select('id', 'leaseVersion', 'startedAt').orderBy((batch) => batch.createdAt.asc()).first()
    const running = queued ? null : (await this.database.orm.public.BatchExtraction.where({ executionStatus: 'RUNNING' })
      .select('id', 'leaseVersion', 'startedAt', 'leaseExpiresAt').orderBy((batch) => batch.createdAt.asc()).all())
      .find((batch) => batch.leaseExpiresAt === null || batch.leaseExpiresAt.getTime() <= now.getTime())
    const candidate = queued ?? running
    if (!candidate) return null
    const version = candidate.leaseVersion + 1
    const claimed = await this.database.orm.public.BatchExtraction.where({ id: candidate.id, leaseVersion: candidate.leaseVersion }).update({
      executionStatus: 'RUNNING', failure: null, startedAt: candidate.startedAt ?? now,
      finishedAt: null, leaseOwner: owner, leaseVersion: version, leaseExpiresAt,
    })
    if (!claimed) return null
    const batch = await loadBatch(this.database.orm, claimed.projectContextId, candidate.id)
    return batch ? { ...batch, lease: { owner, version, expiresAt: leaseExpiresAt } } : null
  }
  async renewBatchLease(id: string, lease: OperationLease, expiresAt: Date): Promise<boolean> {
    return Boolean(await this.database.orm.public.BatchExtraction.where({ id, leaseOwner: lease.owner, leaseVersion: lease.version }).update({ leaseExpiresAt: expiresAt }))
  }
  async startBatchMember(id: string, sourceDocumentId: string, lease: OperationLease, startedAt: Date): Promise<boolean> {
    return this.database.transaction(async ({ orm }) => {
      if (!await orm.public.BatchExtraction.select('id').first({ id, leaseOwner: lease.owner, leaseVersion: lease.version, executionStatus: 'RUNNING' })) return false
      return Boolean(await orm.public.BatchExtractionMember.where({ batchExtractionId: id, sourceDocumentId }).update({
        executionStatus: 'RUNNING', failure: null, startedAt, finishedAt: null,
      }))
    })
  }
  async completeBatchMember(
    id: string,
    sourceDocumentId: string,
    lease: OperationLease,
    result: Readonly<{ completed: true }> | Readonly<{ failure: unknown }>,
    finishedAt: Date,
  ): Promise<boolean> {
    return this.database.transaction(async ({ orm }) => {
      if (!await orm.public.BatchExtraction.select('id').first({ id, leaseOwner: lease.owner, leaseVersion: lease.version, executionStatus: 'RUNNING' })) return false
      const updated = await orm.public.BatchExtractionMember.where({ batchExtractionId: id, sourceDocumentId }).update(
        'completed' in result
          ? { executionStatus: 'COMPLETED', failure: null, finishedAt }
          : { executionStatus: 'FAILED', failure: result.failure, finishedAt })
      if (!updated) return false
      const members = await orm.public.BatchExtractionMember.where({ batchExtractionId: id }).select('executionStatus').all()
      if (members.length && members.every((member) => member.executionStatus === 'COMPLETED' || member.executionStatus === 'FAILED')) {
        await orm.public.BatchExtraction.where({ id, leaseOwner: lease.owner, leaseVersion: lease.version }).update({
          executionStatus: 'COMPLETED', finishedAt, leaseOwner: null, leaseExpiresAt: null,
        })
      }
      return true
    })
  }
  async failBatch(id: string, lease: OperationLease, failure: unknown, finishedAt: Date): Promise<boolean> {
    return Boolean(await this.database.orm.public.BatchExtraction.where({ id, leaseOwner: lease.owner, leaseVersion: lease.version }).update({
      executionStatus: 'FAILED', failure, finishedAt, leaseOwner: null, leaseExpiresAt: null,
    }))
  }
}

export function createPostgresExtractionPersistence(database: Database = db, packages: CanonicalPackageStore = canonicalPackageStore) {
  return new PostgresExtractionPersistence(database, packages)
}
