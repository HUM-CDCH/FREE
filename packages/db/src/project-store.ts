import type { CanonicalPackageDescriptor } from './artifact-store.js'
import { createHash, randomUUID } from 'node:crypto'
import { db } from './prisma/db.js'

type Database = Pick<typeof db, 'orm' | 'transaction'>

export type SchemaRevisionOrigin =
  'suggestion' | 'researcher-edit' | 'model-edit'

export type SchemaRevisionRecord = {
  schemaRevisionId: string
  extractionSchemaId: string
  revisionNumber: number
  origin: SchemaRevisionOrigin
  schemaTree: unknown
  createdAt: Date
}

export type ExtractionSchemaSummary = {
  extractionSchemaId: string
  name: string
  createdAt: Date
  currentRevision: Pick<
    SchemaRevisionRecord,
    'schemaRevisionId' | 'revisionNumber' | 'origin' | 'createdAt'
  > | null
}

export type ExtractionSchemaRecord = Pick<
  ExtractionSchemaSummary,
  'extractionSchemaId' | 'name' | 'createdAt'
>

export type AppendSchemaRevisionResult =
  | { status: 'created'; revision: SchemaRevisionRecord }
  | { status: 'conflict'; currentRevision: SchemaRevisionRecord }

type StoredSchemaRevision = {
  id: string
  extractionSchemaId: string
  revisionNumber: number
  origin: 'SUGGESTION' | 'RESEARCHER_EDIT' | 'MODEL_EDIT'
  schemaTree: unknown
  createdAt: Date
}

const revisionFields = [
  'id',
  'extractionSchemaId',
  'revisionNumber',
  'origin',
  'schemaTree',
  'createdAt',
] as const

const revisionOrigins: Record<
  StoredSchemaRevision['origin'],
  SchemaRevisionOrigin
> = {
  SUGGESTION: 'suggestion',
  RESEARCHER_EDIT: 'researcher-edit',
  MODEL_EDIT: 'model-edit',
}

function schemaRevision(row: StoredSchemaRevision): SchemaRevisionRecord {
  return {
    schemaRevisionId: row.id,
    extractionSchemaId: row.extractionSchemaId,
    revisionNumber: row.revisionNumber,
    origin: revisionOrigins[row.origin],
    schemaTree: row.schemaTree,
    createdAt: row.createdAt,
  }
}

function uniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'sqlState' in error &&
    error.sqlState === '23505'
  )
}

export type ProjectContextSummary = {
  projectContextId: string
  name: string
  createdAt: Date
}

export type SourceDocumentSummary = {
  sourceDocumentId: string
  name: string
  createdAt: Date
}

export type IngestSourceDocumentInput = {
  ingestionKey: string
  contentSha256: string
  mediaType: string
  originalName: string | null
  artifactReference: string
  artifactSha256: string
  contractVersion: string
  preprocessId: string
  parserName: string
  parserVersion: string
  /** Verify or re-publish the package selected by the durable ingestion result. */
  ensureRetained: (descriptor: CanonicalPackageDescriptor) => Promise<void>
}

export type IngestedSourceDocument = SourceDocumentSummary & {
  sourceRepresentationId: string
  revisionNumber: 1
}

type PersistedSourceDocument = IngestedSourceDocument & {
  descriptor: CanonicalPackageDescriptor
}

export class IngestionKeyConflictError extends Error {
  constructor() {
    super('The ingestion key already belongs to another Source Document.')
    this.name = 'IngestionKeyConflictError'
  }
}

/** One Source Document's head plus its current attempt/review snapshots. */
export type DocumentReopenSnapshot = {
  projectContext: ProjectContextSummary
  sourceDocument: SourceDocumentSummary
  sourceRepresentation: {
    sourceRepresentationId: string
    revisionNumber: number
    createdAt: Date
  }
  annotationSet: {
    annotationSetId: string
    revisionNumber: number
    snapshot: unknown
  } | null
  extractionSchema: {
    extractionSchemaId: string
    name: string
    schemaRevisionId: string
    revisionNumber: number
    schemaTree: unknown
  } | null
  latestAttempt: StoredExtractionAttempt | null
  latestReviewed: StoredExtractionAttempt | null
}

type Orm = typeof db.orm

async function loadStoredAttempt(
  orm: Orm,
  extractionId: string,
): Promise<StoredExtractionAttempt | null> {
  const attempt = await orm.public.Extraction.select(
    'id',
    'sourceDocumentId',
    'sourceRepresentationRevisionId',
    'schemaRevisionId',
    'strategy',
    'outcome',
    'complete',
    'modelAttribution',
    'diagnostics',
    'failure',
    'resultPayload',
    'evidenceLinks',
    'reviewable',
    'retryOfId',
    'batchExtractionId',
    'createdAt',
    'reviewedAt',
  ).first({ id: extractionId })
  if (!attempt) return null
  const representation = await orm.public.SourceRepresentationRevision.select(
    'revisionNumber',
  ).first({
    id: attempt.sourceRepresentationRevisionId,
    sourceDocumentId: attempt.sourceDocumentId,
  })
  const schema = await orm.public.SchemaRevision.select(
    'extractionSchemaId',
    'revisionNumber',
    'schemaTree',
  ).first({ id: attempt.schemaRevisionId })
  if (!representation || !schema)
    throw new Error('Stored Extraction pins are unavailable.')
  const decisions = await orm.public.ReviewDecision.where({ extractionId })
    .select('id', 'evidenceAnchorId', 'reviewedOccurrenceIds')
    .orderBy((decision) => decision.evidenceAnchorId.asc())
    .all()
  return {
    extractionId: attempt.id,
    sourceDocumentId: attempt.sourceDocumentId,
    sourceRepresentationRevisionId: attempt.sourceRepresentationRevisionId,
    sourceRepresentationRevisionNumber: representation.revisionNumber,
    schemaRevisionId: attempt.schemaRevisionId,
    extractionSchemaId: schema.extractionSchemaId,
    schemaRevisionNumber: schema.revisionNumber,
    schemaTree: schema.schemaTree,
    createdAt: attempt.createdAt,
    reviewedAt: attempt.reviewedAt,
    strategy: attempt.strategy,
    outcome: attempt.outcome,
    complete: attempt.complete,
    modelAttribution: attempt.modelAttribution,
    diagnostics: attempt.diagnostics,
    resultPayload: attempt.resultPayload,
    evidenceLinks: attempt.evidenceLinks,
    failure: attempt.failure,
    reviewable: attempt.reviewable,
    retryOfId: attempt.retryOfId,
    batchExtractionId: attempt.batchExtractionId,
    reviewDecisions: decisions.map((decision) => ({
      reviewDecisionId: decision.id,
      evidenceAnchorId: decision.evidenceAnchorId,
      reviewedOccurrenceIds: decision.reviewedOccurrenceIds,
    })),
  }
}

/**
 * Reads one Batch Extraction with its members and, per member, the Extraction
 * the batch produced most recently. A retry appends a further Extraction to the
 * same member, so the latest one is that member's current state.
 */
async function loadBatchExtraction(
  orm: Orm,
  projectContextId: string,
  batchExtractionId: string,
): Promise<BatchExtractionRecord | null> {
  const batch = await orm.public.BatchExtraction.select(
    'id',
    'schemaRevisionId',
    'strategy',
    'executionStatus',
    'failure',
    'startedAt',
    'finishedAt',
    'leaseOwner',
    'leaseVersion',
    'leaseExpiresAt',
    'createdAt',
  ).first({ id: batchExtractionId, projectContextId })
  if (!batch) return null
  const schema = await orm.public.SchemaRevision.select(
    'extractionSchemaId',
    'revisionNumber',
  ).first({ id: batch.schemaRevisionId })
  const extractionSchema = schema
    ? await orm.public.ExtractionSchema.select('name').first({
        id: schema.extractionSchemaId,
      })
    : null
  if (!schema || !extractionSchema)
    throw new Error('Stored Batch Extraction pins are unavailable.')
  const rows = await orm.public.BatchExtractionMember.where({
    batchExtractionId,
  })
    .select(
      'sourceDocumentId',
      'sourceRepresentationRevisionId',
      'executionStatus',
      'failure',
      'startedAt',
      'finishedAt',
    )
    .orderBy((member) => member.sourceDocumentId.asc())
    .all()
  const members: BatchExtractionMemberRecord[] = []
  for (const row of rows) {
    const extraction = await orm.public.Extraction.where({
      batchExtractionId,
      sourceDocumentId: row.sourceDocumentId,
      sourceRepresentationRevisionId: row.sourceRepresentationRevisionId,
    })
      .select(
        'id',
        'outcome',
        'complete',
        'reviewable',
        'createdAt',
        'reviewedAt',
        'failure',
      )
      .orderBy([
        (attempt) => attempt.createdAt.desc(),
        (attempt) => attempt.id.desc(),
      ])
      .first()
    members.push({
      sourceDocumentId: row.sourceDocumentId,
      sourceRepresentationRevisionId: row.sourceRepresentationRevisionId,
      executionStatus: row.executionStatus as ProjectOperationStatus,
      executionFailure: row.failure,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      latestExtraction: extraction
        ? {
            extractionId: extraction.id,
            outcome: extraction.outcome,
            complete: extraction.complete,
            reviewable: extraction.reviewable,
            createdAt: extraction.createdAt,
            reviewedAt: extraction.reviewedAt,
            failure: extraction.failure,
          }
        : null,
    })
  }
  return {
    batchExtractionId: batch.id,
    projectContextId,
    schemaRevisionId: batch.schemaRevisionId,
    extractionSchemaId: schema.extractionSchemaId,
    extractionSchemaName: extractionSchema.name,
    schemaRevisionNumber: schema.revisionNumber,
    strategy: batch.strategy as ExtractionStrategy,
    executionStatus: batch.executionStatus as ProjectOperationStatus,
    executionFailure: batch.failure,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    leaseOwner: batch.leaseOwner,
    leaseVersion: batch.leaseVersion,
    leaseExpiresAt: batch.leaseExpiresAt,
    createdAt: batch.createdAt,
    members,
  }
}

/** Rebuild the durable suggestion snapshot, including its pinned artifacts. */
async function loadBatchSchemaSuggestion(
  orm: Orm,
  projectContextId: string,
  batchSchemaSuggestionId: string,
): Promise<BatchSchemaSuggestionRecord | null> {
  const suggestion = await orm.public.BatchSchemaSuggestion.select(
    'id',
    'selectionKey',
    'executionStatus',
    'phase',
    'proposal',
    'coverage',
    'draft',
    'draftVersion',
    'failure',
    'confirmedSchemaRevisionId',
    'batchExtractionId',
    'startedAt',
    'finishedAt',
    'leaseOwner',
    'leaseVersion',
    'leaseExpiresAt',
    'createdAt',
  ).first({ id: batchSchemaSuggestionId, projectContextId })
  if (!suggestion) return null
  const rows = await orm.public.BatchSchemaSuggestionSource.where({
    batchSchemaSuggestionId,
  })
    .select(
      'sourceDocumentId',
      'sourceRepresentationRevisionId',
      'executionStatus',
      'definition',
      'failure',
      'startedAt',
      'finishedAt',
    )
    .orderBy((source) => source.sourceDocumentId.asc())
    .all()
  const sources: BatchSchemaSuggestionSourceRecord[] = []
  for (const row of rows) {
    const representation =
      await orm.public.SourceRepresentationRevision.select(
        'artifactReference',
        'artifactSha256',
      ).first({ id: row.sourceRepresentationRevisionId })
    if (!representation)
      throw new Error('Stored Batch Schema Suggestion pins are unavailable.')
    sources.push({
      sourceDocumentId: row.sourceDocumentId,
      sourceRepresentationRevisionId: row.sourceRepresentationRevisionId,
      descriptor: {
        artifactReference: representation.artifactReference,
        artifactSha256: representation.artifactSha256,
      },
      executionStatus: row.executionStatus as ProjectOperationStatus,
      definition: row.definition,
      failure: row.failure,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    })
  }
  return {
    batchSchemaSuggestionId: suggestion.id,
    projectContextId,
    selectionKey: suggestion.selectionKey,
    executionStatus: suggestion.executionStatus as ProjectOperationStatus,
    phase: suggestion.phase as BatchSchemaSuggestionPhase,
    proposal: suggestion.proposal,
    coverage: suggestion.coverage,
    draft: suggestion.draft,
    draftVersion: suggestion.draftVersion,
    failure: suggestion.failure,
    confirmedSchemaRevisionId: suggestion.confirmedSchemaRevisionId,
    batchExtractionId: suggestion.batchExtractionId,
    startedAt: suggestion.startedAt,
    finishedAt: suggestion.finishedAt,
    leaseOwner: suggestion.leaseOwner,
    leaseVersion: suggestion.leaseVersion,
    leaseExpiresAt: suggestion.leaseExpiresAt,
    createdAt: suggestion.createdAt,
    sources,
  }
}

async function storedReviewDigest(
  orm: Orm,
  extractionId: string,
): Promise<string | null> {
  const review = await orm.public.ExtractionReview.select(
    'decisionDigest',
  ).first({ extractionId })
  return review?.decisionDigest ?? null
}

function sameAttemptIdentity(
  attempt: StoredExtractionAttempt,
  input: TerminalExtractionInput,
): boolean {
  return (
    attempt.sourceRepresentationRevisionId ===
      input.sourceRepresentationRevisionId &&
    attempt.schemaRevisionId === input.schemaRevisionId &&
    attempt.strategy === input.strategy &&
    attempt.batchExtractionId === input.batchExtractionId
  )
}

function canonicalSourceDocumentIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function stableUuid(namespace: string, value: string): string {
  const hash = createHash('sha256')
    .update(`${namespace}:${value}`)
    .digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${(['8', '9', 'a', 'b'] as const)[parseInt(hash[16], 16) & 3]}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function batchSuggestionSelectionKey(
  projectContextId: string,
  members: readonly {
    sourceDocumentId: string
    sourceRepresentationRevisionId: string
  }[],
): string {
  return createHash('sha256')
    .update(stableJson({ projectContextId, members }))
    .digest('hex')
}

function withoutGeneratedSchemaNodeIds(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const node = { ...(value as Record<string, unknown>) }
  const children = node.children
  delete node.id
  delete node.children
  return {
    ...node,
    ...(Array.isArray(children)
      ? { children: children.map(withoutGeneratedSchemaNodeIds) }
      : children === undefined
        ? {}
        : { children }),
  }
}

function semanticBatchSuggestionTree(schemaTree: unknown): unknown {
  if (Array.isArray(schemaTree))
    return schemaTree.map(withoutGeneratedSchemaNodeIds)
  if (!schemaTree || typeof schemaTree !== 'object') return schemaTree
  const { schemaNodes, ...definition } = schemaTree as Record<string, unknown>
  if (!Array.isArray(schemaNodes)) return schemaTree
  return {
    ...definition,
    schemaNodes: schemaNodes.map(withoutGeneratedSchemaNodeIds),
  }
}

function sameBatchIdentity(
  batch: BatchExtractionRecord,
  input: CreateBatchExtractionInput,
): boolean {
  const selected = canonicalSourceDocumentIds(input.sourceDocumentIds)
  return (
    batch.schemaRevisionId === input.schemaRevisionId &&
    batch.strategy === input.strategy &&
    batch.members.length === selected.length &&
    batch.members.every(
      (member, index) => member.sourceDocumentId === selected[index],
    )
  )
}

async function currentBatchMembers(
  orm: Orm,
  projectContextId: string,
  sourceDocumentIds: readonly string[],
): Promise<
  { sourceDocumentId: string; sourceRepresentationRevisionId: string }[] | null
> {
  const project = await orm.public.ProjectContext.select('id').first({
    id: projectContextId,
  })
  if (!project || sourceDocumentIds.length === 0) return null
  const members: {
    sourceDocumentId: string
    sourceRepresentationRevisionId: string
  }[] = []
  for (const sourceDocumentId of canonicalSourceDocumentIds(
    sourceDocumentIds,
  )) {
    const document = await orm.public.SourceDocument.select('id').first({
      id: sourceDocumentId,
      projectContextId,
    })
    if (!document) return null
    const representation = await orm.public.SourceRepresentationRevision.where({
      sourceDocumentId,
    })
      .select('id')
      .orderBy((revision) => revision.revisionNumber.desc())
      .first()
    if (!representation) return null
    members.push({
      sourceDocumentId,
      sourceRepresentationRevisionId: representation.id,
    })
  }
  return members
}

function normalizeDecisionInput(
  decisions: readonly FinalizeExtractionReviewInput['reviewDecisions'][number][],
) {
  return decisions
    .map((decision) => ({
      evidenceAnchorId: decision.evidenceAnchorId,
      reviewedOccurrenceIds: [
        ...new Set(decision.reviewedOccurrenceIds),
      ].sort(),
    }))
    .sort((left, right) =>
      left.evidenceAnchorId.localeCompare(right.evidenceAnchorId),
    )
}

export type StoredExtractionAttempt = {
  extractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  sourceRepresentationRevisionNumber: number
  schemaRevisionId: string
  extractionSchemaId: string
  schemaRevisionNumber: number
  schemaTree: unknown
  createdAt: Date
  reviewedAt: Date | null
  strategy: 'ARTICLE' | 'CATALOG'
  outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  complete: boolean | null
  modelAttribution: unknown | null
  diagnostics: unknown
  resultPayload: unknown | null
  evidenceLinks: unknown | null
  failure: unknown | null
  reviewable: boolean
  retryOfId: string | null
  batchExtractionId: string | null
  reviewDecisions: Array<{
    reviewDecisionId: string
    evidenceAnchorId: string
    reviewedOccurrenceIds: unknown
  }>
}

export type ExtractionInputs = {
  sourceDocumentId: string
  projectContextId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  schemaTree: unknown
  descriptor: CanonicalPackageDescriptor
}

export type TerminalExtractionInput = {
  extractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: 'ARTICLE' | 'CATALOG'
  outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  complete: boolean | null
  modelAttribution: unknown | null
  diagnostics: unknown
  failure: unknown | null
  resultPayload: unknown | null
  evidenceLinks: unknown | null
  reviewable: boolean
  retryOfId: string | null
  batchExtractionId: string | null
}

export type ExtractionStrategy = 'ARTICLE' | 'CATALOG'

export type ProjectOperationStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'

export type BatchSchemaSuggestionPhase =
  | 'SOURCES'
  | 'MERGING'
  | 'READY'
  | 'HETEROGENEOUS'

/** One selected Source Document, with the Extraction the batch produced for it. */
export type BatchExtractionMemberRecord = {
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  executionStatus?: ProjectOperationStatus
  executionFailure?: unknown | null
  startedAt?: Date | null
  finishedAt?: Date | null
  latestExtraction: {
    extractionId: string
    outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
    complete: boolean | null
    reviewable: boolean
    createdAt: Date
    reviewedAt: Date | null
    failure: unknown | null
  } | null
}

/**
 * One Batch Extraction and its intended selection. Members are stored when the
 * batch is created, so counts stay truthful while its Extractions are still
 * being appended: a member without an Extraction has not run yet.
 */
export type BatchExtractionRecord = {
  batchExtractionId: string
  projectContextId: string
  schemaRevisionId: string
  extractionSchemaId: string
  extractionSchemaName: string
  schemaRevisionNumber: number
  strategy: ExtractionStrategy
  executionStatus?: ProjectOperationStatus
  executionFailure?: unknown | null
  startedAt?: Date | null
  finishedAt?: Date | null
  leaseOwner?: string | null
  leaseVersion?: number
  leaseExpiresAt?: Date | null
  createdAt: Date
  members: BatchExtractionMemberRecord[]
}

export type CreateBatchExtractionInput = {
  batchExtractionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  sourceDocumentIds: readonly string[]
}

export type BatchSchemaSuggestionSourceRecord = {
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  descriptor: CanonicalPackageDescriptor
  executionStatus: ProjectOperationStatus
  definition: unknown | null
  failure: unknown | null
  startedAt: Date | null
  finishedAt: Date | null
}

export type BatchSchemaSuggestionRecord = {
  batchSchemaSuggestionId: string
  projectContextId: string
  selectionKey: string
  executionStatus: ProjectOperationStatus
  phase: BatchSchemaSuggestionPhase
  proposal: unknown | null
  coverage: unknown | null
  draft: unknown | null
  draftVersion: number
  failure: unknown | null
  confirmedSchemaRevisionId: string | null
  batchExtractionId: string | null
  startedAt: Date | null
  finishedAt: Date | null
  leaseOwner: string | null
  leaseVersion: number
  leaseExpiresAt: Date | null
  createdAt: Date
  sources: BatchSchemaSuggestionSourceRecord[]
}

export type OperationLease = {
  owner: string
  version: number
  expiresAt: Date
}

export type UpdateBatchSchemaSuggestionDraftResult =
  | { status: 'updated'; suggestion: BatchSchemaSuggestionRecord }
  | { status: 'conflict'; suggestion: BatchSchemaSuggestionRecord }
  | { status: 'invalid' }
  | null

export type RetryBatchSchemaSuggestionResult =
  | { status: 'retried'; suggestion: BatchSchemaSuggestionRecord }
  | null

export type RunBatchSchemaSuggestionResult =
  | {
      status: 'created' | 'replayed'
      suggestion: BatchSchemaSuggestionRecord
      batch: BatchExtractionRecord
    }
  | { status: 'not-ready' | 'invalid' }
  | null

export type FinalizeExtractionReviewInput = {
  reviewDecisions: Array<{
    evidenceAnchorId: string
    reviewedOccurrenceIds: string[]
  }>
  occurrenceIdsByAnchor: ReadonlyMap<string, ReadonlySet<string>>
  requiredResultPathKeys: ReadonlySet<string>
}

export type ProjectStore = {
  createProjectContext(name: string): Promise<ProjectContextSummary>
  renameProjectContext(
    projectContextId: string,
    name: string,
  ): Promise<ProjectContextSummary | null>
  /**
   * Deletes the Project Context and everything the relational cascade owns,
   * and answers the canonical packages its Source Representation Revisions
   * pinned. Packages are content-addressed and shareable, so the caller removes
   * only candidates no surviving revision references.
   */
  deleteProjectContext(
    projectContextId: string,
  ): Promise<CanonicalPackageDescriptor[] | null>
  deleteSourceDocument(
    projectContextId: string,
    sourceDocumentId: string,
  ): Promise<CanonicalPackageDescriptor[] | null>
  /** Whether any surviving Source Representation Revision pins this package. */
  isPackageReferenced(artifactReference: string): Promise<boolean>
  listProjectContexts(limit: number): Promise<ProjectContextSummary[]>
  getProjectContextWithDocuments(projectContextId: string): Promise<{
    projectContext: ProjectContextSummary
    sourceDocuments: SourceDocumentSummary[]
  } | null>
  getDocumentReopenSnapshot(
    projectContextId: string,
    sourceDocumentId: string,
    extractionId?: string,
  ): Promise<DocumentReopenSnapshot | null>
  getSourceRepresentation(
    sourceRepresentationId: string,
  ): Promise<CanonicalPackageDescriptor | null>
  getExtractionInputs(
    sourceRepresentationRevisionId: string,
    schemaRevisionId: string,
  ): Promise<ExtractionInputs | null>
  getExtractionAttempt(
    extractionId: string,
  ): Promise<StoredExtractionAttempt | null>
  /**
   * Makes a retained canonical package visible as one Source Document and its
   * first representation. The unique ingestion key is the retry authority.
   */
  ingestSourceDocument(
    projectContextId: string,
    input: IngestSourceDocumentInput,
  ): Promise<PersistedSourceDocument | null>
  createBatchSchemaSuggestion(
    projectContextId: string,
    sourceDocumentIds: readonly string[],
  ): Promise<
    | { status: 'created' | 'replayed'; suggestion: BatchSchemaSuggestionRecord }
    | { status: 'invalid' }
    | null
  >
  getBatchSchemaSuggestion(
    projectContextId: string,
    batchSchemaSuggestionId: string,
  ): Promise<BatchSchemaSuggestionRecord | null>
  listBatchSchemaSuggestions(
    projectContextId: string,
    limit: number,
  ): Promise<BatchSchemaSuggestionRecord[] | null>
  updateBatchSchemaSuggestionDraft(
    projectContextId: string,
    batchSchemaSuggestionId: string,
    expectedDraftVersion: number,
    draft: unknown,
  ): Promise<UpdateBatchSchemaSuggestionDraftResult>
  retryBatchSchemaSuggestion(
    projectContextId: string,
    batchSchemaSuggestionId: string,
  ): Promise<RetryBatchSchemaSuggestionResult>
  claimBatchSchemaSuggestion(
    owner: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<(BatchSchemaSuggestionRecord & { lease: OperationLease }) | null>
  renewBatchSchemaSuggestionLease(
    batchSchemaSuggestionId: string,
    lease: OperationLease,
    leaseExpiresAt: Date,
  ): Promise<boolean>
  startBatchSchemaSuggestionSource(
    batchSchemaSuggestionId: string,
    sourceDocumentId: string,
    lease: OperationLease,
    startedAt: Date,
  ): Promise<boolean>
  completeBatchSchemaSuggestionSource(
    batchSchemaSuggestionId: string,
    sourceDocumentId: string,
    lease: OperationLease,
    result: { definition: unknown } | { failure: unknown },
    finishedAt: Date,
  ): Promise<boolean>
  startBatchSchemaSuggestionMerge(
    batchSchemaSuggestionId: string,
    lease: OperationLease,
  ): Promise<boolean>
  completeBatchSchemaSuggestionMerge(
    batchSchemaSuggestionId: string,
    lease: OperationLease,
    result:
      | { proposal: unknown; coverage: unknown; draft: unknown }
      | { heterogeneous: true },
    finishedAt: Date,
  ): Promise<boolean>
  failBatchSchemaSuggestion(
    batchSchemaSuggestionId: string,
    lease: OperationLease,
    failure: unknown,
    finishedAt: Date,
  ): Promise<boolean>
  runBatchSchemaSuggestion(
    projectContextId: string,
    batchSchemaSuggestionId: string,
    strategy: ExtractionStrategy,
  ): Promise<RunBatchSchemaSuggestionResult>
  initializeSchemaRevision(
    projectContextId: string,
    schemaTree: unknown,
  ): Promise<AppendSchemaRevisionResult | null>
  listExtractionSchemas(
    projectContextId: string,
    limit: number,
  ): Promise<ExtractionSchemaSummary[] | null>
  renameExtractionSchema(
    projectContextId: string,
    extractionSchemaId: string,
    name: string,
  ): Promise<ExtractionSchemaRecord | null>
  appendSchemaRevision(
    projectContextId: string,
    extractionSchemaId: string,
    expectedRevisionNumber: number,
    schemaTree: unknown,
  ): Promise<AppendSchemaRevisionResult | null>
  listSchemaRevisions(
    projectContextId: string,
    extractionSchemaId: string,
    limit: number,
  ): Promise<SchemaRevisionRecord[] | null>
  getSchemaRevision(
    projectContextId: string,
    extractionSchemaId: string,
    schemaRevisionId: string,
  ): Promise<SchemaRevisionRecord | null>
  /**
   * Opens one Batch Extraction over the researcher's selection, pinning the
   * Schema Revision, the Extraction Strategy, and each Source Document's
   * Current Source Representation Revision before any Extraction runs. The
   * server-derived Batch Extraction ID is the retry authority.
   */
  createBatchExtraction(
    projectContextId: string,
    input: CreateBatchExtractionInput,
  ): Promise<
    | { status: 'created' | 'replayed'; batch: BatchExtractionRecord }
    | { status: 'invalid' | 'conflict' }
    | null
  >
  listBatchExtractions(
    projectContextId: string,
    limit: number,
  ): Promise<BatchExtractionRecord[] | null>
  getBatchExtraction(
    projectContextId: string,
    batchExtractionId: string,
  ): Promise<BatchExtractionRecord | null>
  retryBatchExtraction(
    projectContextId: string,
    batchExtractionId: string,
  ): Promise<BatchExtractionRecord | null>
  claimBatchExtraction(
    owner: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<(BatchExtractionRecord & { lease: OperationLease }) | null>
  renewBatchExtractionLease(
    batchExtractionId: string,
    lease: OperationLease,
    leaseExpiresAt: Date,
  ): Promise<boolean>
  startBatchExtractionMember(
    batchExtractionId: string,
    sourceDocumentId: string,
    lease: OperationLease,
    startedAt: Date,
  ): Promise<boolean>
  completeBatchExtractionMember(
    batchExtractionId: string,
    sourceDocumentId: string,
    lease: OperationLease,
    result: { failure: unknown } | { completed: true },
    finishedAt: Date,
  ): Promise<boolean>
  failBatchExtraction(
    batchExtractionId: string,
    lease: OperationLease,
    failure: unknown,
    finishedAt: Date,
  ): Promise<boolean>
  persistExtractionAttempt(
    input: TerminalExtractionInput,
  ): Promise<
    | { status: 'created' | 'replayed'; attempt: StoredExtractionAttempt }
    | { status: 'conflict'; attempt: StoredExtractionAttempt }
    | { status: 'invalid' }
  >
  finalizeExtractionReview(
    extractionId: string,
    input: FinalizeExtractionReviewInput,
  ): Promise<
    | { status: 'reviewed' | 'replayed'; attempt: StoredExtractionAttempt }
    | { status: 'conflict' | 'invalid' | 'not-found' }
  >
}

type StoredProjectContext = { id: string; name: string; createdAt: Date }

export const PROJECT_CONTEXT_NAME_LIMIT = 512
export const EXTRACTION_SCHEMA_NAME_LIMIT = 512

/**
 * The durable name contract, enforced where the write happens: no caller can
 * persist a blank, untrimmed, or oversized Project Context name.
 */
function durableName(subject: string, name: string, limit: number): string {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > limit)
    throw new Error(
      `${subject} name must be 1 to ${limit} characters after trimming.`,
    )
  return trimmed
}

const projectContextName = (name: string) =>
  durableName('A Project Context', name, PROJECT_CONTEXT_NAME_LIMIT)
const extractionSchemaName = (name: string) =>
  durableName('An Extraction Schema', name, EXTRACTION_SCHEMA_NAME_LIMIT)

function projectContextSummary(
  row: StoredProjectContext,
): ProjectContextSummary {
  return {
    projectContextId: row.id,
    name: row.name,
    createdAt: row.createdAt,
  }
}

type StoredIngestedSourceDocument = {
  id: string
  originalName: string | null
  contentSha256: string
  createdAt: Date
}

type StoredSourceRepresentation = {
  id: string
  revisionNumber: number
  artifactReference: string
  artifactSha256: string
}

function ingestedSourceDocument(
  document: StoredIngestedSourceDocument,
  representation: StoredSourceRepresentation,
): PersistedSourceDocument {
  return {
    sourceDocumentId: document.id,
    name: document.originalName ?? 'Untitled source document',
    createdAt: document.createdAt,
    sourceRepresentationId: representation.id,
    revisionNumber: 1,
    descriptor: {
      artifactReference: representation.artifactReference,
      artifactSha256: representation.artifactSha256,
    },
  }
}

export function createProjectStore(database: Database = db): ProjectStore {
  return {
    async createProjectContext(name) {
      return projectContextSummary(
        (await database.orm.public.ProjectContext.create({
          name: projectContextName(name),
        })) as StoredProjectContext,
      )
    },
    async renameProjectContext(projectContextId, name) {
      const row = (await database.orm.public.ProjectContext.where({
        id: projectContextId,
      }).update({
        name: projectContextName(name),
      })) as StoredProjectContext | null
      return row && projectContextSummary(row)
    },
    async deleteProjectContext(projectContextId) {
      return database.transaction(async ({ orm }) => {
        const project = await orm.public.ProjectContext.select('id').first({
          id: projectContextId,
        })
        if (!project) return null

        const documents = await orm.public.SourceDocument.where({
          projectContextId,
        })
          .select('id')
          .all()
        const candidates: CanonicalPackageDescriptor[] = []
        for (const document of documents) {
          const representations =
            await orm.public.SourceRepresentationRevision.where({
              sourceDocumentId: document.id,
            })
              .select('artifactReference', 'artifactSha256')
              .all()
          // Rebuilt, like every other descriptor boundary: no other persisted
          // column leaves the store.
          for (const row of representations)
            candidates.push({
              artifactReference: row.artifactReference,
              artifactSha256: row.artifactSha256,
            })
        }

        await orm.public.ProjectContext.where({ id: projectContextId }).delete()
        return candidates
      })
    },
    async deleteSourceDocument(projectContextId, sourceDocumentId) {
      return database.transaction(async ({ orm }) => {
        const document = await orm.public.SourceDocument.select('id').first({
          id: sourceDocumentId,
          projectContextId,
        })
        if (!document) return null
        const representations =
          await orm.public.SourceRepresentationRevision.where({
            sourceDocumentId,
          })
            .select('artifactReference', 'artifactSha256')
            .all()
        await orm.public.SourceDocument.where({ id: sourceDocumentId }).delete()
        return representations.map((row) => ({
          artifactReference: row.artifactReference,
          artifactSha256: row.artifactSha256,
        }))
      })
    },
    async isPackageReferenced(artifactReference) {
      const row = await database.orm.public.SourceRepresentationRevision.select(
        'id',
      ).first({ artifactReference })
      return row !== null
    },
    async listProjectContexts(limit) {
      const rows = await database.orm.public.ProjectContext.select(
        'id',
        'name',
        'createdAt',
      )
        .orderBy([
          (project) => project.createdAt.desc(),
          (project) => project.id.desc(),
        ])
        .take(limit)
        .all()
      return rows.map(({ id, name, createdAt }) => ({
        projectContextId: id,
        name,
        createdAt,
      }))
    },
    async getProjectContextWithDocuments(projectContextId) {
      const row = await database.orm.public.ProjectContext.select(
        'id',
        'name',
        'createdAt',
      ).first({ id: projectContextId })
      if (!row) return null
      const sourceDocuments = await database.orm.public.SourceDocument.where({
        projectContextId,
      })
        .select('id', 'originalName', 'createdAt')
        .orderBy([
          (document) => document.createdAt.asc(),
          (document) => document.id.asc(),
        ])
        .all()
      return {
        projectContext: {
          projectContextId: row.id,
          name: row.name,
          createdAt: row.createdAt,
        },
        sourceDocuments: sourceDocuments.map(
          ({ id, originalName, createdAt }) => ({
            sourceDocumentId: id,
            name: originalName ?? 'Untitled source document',
            createdAt,
          }),
        ),
      }
    },
    async getDocumentReopenSnapshot(
      projectContextId,
      sourceDocumentId,
      extractionId,
    ) {
      return database.transaction(async ({ orm }) => {
        const project = await orm.public.ProjectContext.select(
          'id',
          'name',
          'createdAt',
        ).first({ id: projectContextId })
        if (!project) return null

        const document = await orm.public.SourceDocument.select(
          'id',
          'projectContextId',
          'originalName',
          'createdAt',
        ).first({ id: sourceDocumentId })
        if (!document || document.projectContextId !== projectContextId)
          return null

        const selectedAttempt = extractionId
          ? await loadStoredAttempt(orm, extractionId)
          : null
        if (
          extractionId &&
          (!selectedAttempt ||
            selectedAttempt.sourceDocumentId !== sourceDocumentId)
        )
          return null

        const representation = selectedAttempt
          ? await orm.public.SourceRepresentationRevision.select(
              'id',
              'revisionNumber',
              'createdAt',
            ).first({
              id: selectedAttempt.sourceRepresentationRevisionId,
              sourceDocumentId,
            })
          : await orm.public.SourceRepresentationRevision.where({
              sourceDocumentId,
            })
              .select('id', 'revisionNumber', 'createdAt')
              .orderBy((revision) => revision.revisionNumber.desc())
              .first()
        if (!representation) return null

        const annotationSet = await orm.public.AnnotationSetRevision.where({
          sourceDocumentId,
          sourceRepresentationRevisionId: representation.id,
        })
          .select('id', 'revisionNumber', 'snapshot')
          .orderBy((revision) => revision.revisionNumber.desc())
          .first()

        // An exact Extraction route must reopen the Schema Revision it pinned.
        const extractionSchema = selectedAttempt
          ? await orm.public.ExtractionSchema.select('id', 'name').first({
              id: selectedAttempt.extractionSchemaId,
              projectContextId,
            })
          : await orm.public.ExtractionSchema.where({
              projectContextId,
            })
              .select('id', 'name')
              .orderBy([
                (schema) => schema.createdAt.desc(),
                (schema) => schema.id.desc(),
              ])
              .first()
        const schemaRevision = selectedAttempt
          ? {
              id: selectedAttempt.schemaRevisionId,
              extractionSchemaId: selectedAttempt.extractionSchemaId,
              revisionNumber: selectedAttempt.schemaRevisionNumber,
              schemaTree: selectedAttempt.schemaTree,
            }
          : extractionSchema
            ? await orm.public.SchemaRevision.where({
                extractionSchemaId: extractionSchema.id,
              })
                .select(
                  'id',
                  'extractionSchemaId',
                  'revisionNumber',
                  'schemaTree',
                )
                .orderBy((revision) => revision.revisionNumber.desc())
                .first()
            : null

        const latestAttempt = selectedAttempt
          ? null
          : await orm.public.Extraction.where({
              sourceDocumentId,
              sourceRepresentationRevisionId: representation.id,
            })
              .select('id')
              .orderBy([
                (attempt) => attempt.createdAt.desc(),
                (attempt) => attempt.id.desc(),
              ])
              .first()
        const latestReviewed = await orm.public.Extraction.where({
          sourceDocumentId,
          sourceRepresentationRevisionId: representation.id,
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
          projectContext: {
            projectContextId: project.id,
            name: project.name,
            createdAt: project.createdAt,
          },
          sourceDocument: {
            sourceDocumentId: document.id,
            name: document.originalName ?? 'Untitled source document',
            createdAt: document.createdAt,
          },
          sourceRepresentation: {
            sourceRepresentationId: representation.id,
            revisionNumber: representation.revisionNumber,
            createdAt: representation.createdAt,
          },
          annotationSet: annotationSet && {
            annotationSetId: annotationSet.id,
            revisionNumber: annotationSet.revisionNumber,
            snapshot: annotationSet.snapshot,
          },
          extractionSchema:
            extractionSchema && schemaRevision
              ? {
                  extractionSchemaId: extractionSchema.id,
                  name: extractionSchema.name,
                  schemaRevisionId: schemaRevision.id,
                  revisionNumber: schemaRevision.revisionNumber,
                  schemaTree: schemaRevision.schemaTree,
                }
              : null,
          latestAttempt:
            selectedAttempt ??
            (latestAttempt
              ? await loadStoredAttempt(orm, latestAttempt.id)
              : null),
          latestReviewed: selectedAttempt?.reviewedAt
            ? selectedAttempt
            : latestReviewed
              ? await loadStoredAttempt(orm, latestReviewed.id)
              : null,
        }
      })
    },
    async getSourceRepresentation(sourceRepresentationId) {
      const row = await database.orm.public.SourceRepresentationRevision.select(
        'artifactReference',
        'artifactSha256',
      ).first({ id: sourceRepresentationId })
      // Rebuilt rather than returned: the descriptor is the boundary that keeps
      // every other persisted column server-side.
      return (
        row && {
          artifactReference: row.artifactReference,
          artifactSha256: row.artifactSha256,
        }
      )
    },
    async getExtractionInputs(
      sourceRepresentationRevisionId,
      schemaRevisionId,
    ) {
      return database.transaction(async ({ orm }) => {
        const representation =
          await orm.public.SourceRepresentationRevision.select(
            'id',
            'sourceDocumentId',
            'artifactReference',
            'artifactSha256',
          ).first({ id: sourceRepresentationRevisionId })
        if (!representation) return null
        const document = await orm.public.SourceDocument.select(
          'projectContextId',
        ).first({ id: representation.sourceDocumentId })
        const schema = await orm.public.SchemaRevision.select(
          'id',
          'extractionSchemaId',
          'schemaTree',
        ).first({ id: schemaRevisionId })
        if (!document || !schema) return null
        const extractionSchema = await orm.public.ExtractionSchema.select(
          'projectContextId',
        ).first({
          id: schema.extractionSchemaId,
        })
        if (
          !extractionSchema ||
          extractionSchema.projectContextId !== document.projectContextId
        )
          return null
        return {
          sourceDocumentId: representation.sourceDocumentId,
          projectContextId: document.projectContextId,
          sourceRepresentationRevisionId: representation.id,
          schemaRevisionId: schema.id,
          schemaTree: schema.schemaTree,
          descriptor: {
            artifactReference: representation.artifactReference,
            artifactSha256: representation.artifactSha256,
          },
        }
      })
    },
    async getExtractionAttempt(extractionId) {
      return loadStoredAttempt(database.orm, extractionId)
    },
    async ingestSourceDocument(projectContextId, input) {
      const project = await database.orm.public.ProjectContext.select(
        'id',
      ).first({
        id: projectContextId,
      })
      if (!project) return null

      const existing = async (): Promise<PersistedSourceDocument | null> => {
        const document = await database.orm.public.SourceDocument.select(
          'id',
          'originalName',
          'contentSha256',
          'createdAt',
        ).first({
          ingestionKey: input.ingestionKey,
          projectContextId,
        })
        if (!document) return null
        const representation =
          await database.orm.public.SourceRepresentationRevision.select(
            'id',
            'revisionNumber',
            'artifactReference',
            'artifactSha256',
          ).first({ sourceDocumentId: document.id, revisionNumber: 1 })
        // Parser-run metadata may change package identity; uploaded content is
        // the stable identity for a retry using the same ingestion key.
        if (representation && document.contentSha256 !== input.contentSha256)
          throw new IngestionKeyConflictError()
        return representation
          ? ingestedSourceDocument(
              document as StoredIngestedSourceDocument,
              representation as StoredSourceRepresentation,
            )
          : null
      }

      const persisted = await existing()
      if (persisted) {
        await input.ensureRetained(persisted.descriptor)
        return persisted
      }

      let createdSourceDocumentId: string | null = null
      try {
        const result = await database.transaction(async ({ orm }) => {
          const project = await orm.public.ProjectContext.select('id').first({
            id: projectContextId,
          })
          if (!project) return null

          const document = await orm.public.SourceDocument.create({
            projectContextId,
            ingestionKey: input.ingestionKey,
            contentSha256: input.contentSha256,
            mediaType: input.mediaType,
            originalName: input.originalName,
          })
          createdSourceDocumentId = document.id
          const representation =
            await orm.public.SourceRepresentationRevision.create({
              sourceDocumentId: document.id,
              revisionNumber: 1,
              artifactReference: input.artifactReference,
              artifactSha256: input.artifactSha256,
              contractVersion: input.contractVersion,
              preprocessId: input.preprocessId,
              parserName: input.parserName,
              parserVersion: input.parserVersion,
            })
          return ingestedSourceDocument(
            document as StoredIngestedSourceDocument,
            representation as StoredSourceRepresentation,
          )
        })
        if (!result) return null
        try {
          await input.ensureRetained(result.descriptor)
        } catch (error) {
          await database.orm.public.SourceDocument.where({
            id: createdSourceDocumentId,
            ingestionKey: input.ingestionKey,
          }).delete()
          throw error
        }
        return result
      } catch (error) {
        if (!uniqueConstraint(error)) throw error
        const winner = await existing()
        if (winner) await input.ensureRetained(winner.descriptor)
        if (!winner) throw new IngestionKeyConflictError()
        return winner
      }
    },
    async createBatchSchemaSuggestion(projectContextId, sourceDocumentIds) {
      const create = async () =>
        database.transaction(async ({ orm }) => {
          const project = await orm.public.ProjectContext.select('id').first({
            id: projectContextId,
          })
          if (!project) return 'missing' as const
          const members = await currentBatchMembers(
            orm,
            projectContextId,
            sourceDocumentIds,
          )
          if (!members) return 'invalid' as const
          const selectionKey = batchSuggestionSelectionKey(
            projectContextId,
            members,
          )
          const batchSchemaSuggestionId = stableUuid(
            'batch-schema-suggestion',
            selectionKey,
          )
          await orm.public.BatchSchemaSuggestion.create({
            id: batchSchemaSuggestionId,
            projectContextId,
            selectionKey,
          })
          for (const member of members)
            await orm.public.BatchSchemaSuggestionSource.create({
              batchSchemaSuggestionId,
              ...member,
            })
          return { batchSchemaSuggestionId } as const
        })
      try {
        const created = await create()
        if (created === 'missing') return null
        if (created === 'invalid') return { status: 'invalid' as const }
        const suggestion = await loadBatchSchemaSuggestion(
          database.orm,
          projectContextId,
          created.batchSchemaSuggestionId,
        )
        if (!suggestion)
          throw new Error('Persisted Batch Schema Suggestion could not be read.')
        return { status: 'created' as const, suggestion }
      } catch (error) {
        if (!uniqueConstraint(error)) throw error
        const members = await database.transaction(({ orm }) =>
          currentBatchMembers(orm, projectContextId, sourceDocumentIds),
        )
        if (!members) return { status: 'invalid' as const }
        const suggestion = await loadBatchSchemaSuggestion(
          database.orm,
          projectContextId,
          stableUuid(
            'batch-schema-suggestion',
            batchSuggestionSelectionKey(projectContextId, members),
          ),
        )
        if (!suggestion) throw error
        return { status: 'replayed' as const, suggestion }
      }
    },
    async getBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId) {
      return loadBatchSchemaSuggestion(
        database.orm,
        projectContextId,
        batchSchemaSuggestionId,
      )
    },
    async listBatchSchemaSuggestions(projectContextId, limit) {
      const project = await database.orm.public.ProjectContext.select(
        'id',
      ).first({ id: projectContextId })
      if (!project) return null
      const rows = await database.orm.public.BatchSchemaSuggestion.where({
        projectContextId,
      })
        .select('id')
        .orderBy([
          (suggestion) => suggestion.createdAt.desc(),
          (suggestion) => suggestion.id.desc(),
        ])
        .take(limit)
        .all()
      const suggestions: BatchSchemaSuggestionRecord[] = []
      for (const row of rows) {
        const suggestion = await loadBatchSchemaSuggestion(
          database.orm,
          projectContextId,
          row.id,
        )
        if (suggestion) suggestions.push(suggestion)
      }
      return suggestions
    },
    async updateBatchSchemaSuggestionDraft(
      projectContextId,
      batchSchemaSuggestionId,
      expectedDraftVersion,
      draft,
    ) {
      const result = await database.transaction(async ({ orm }) => {
        const suggestion = await orm.public.BatchSchemaSuggestion.select(
          'id',
          'executionStatus',
          'phase',
          'confirmedSchemaRevisionId',
          'draftVersion',
        ).first({ id: batchSchemaSuggestionId, projectContextId })
        if (!suggestion) return 'missing' as const
        if (
          suggestion.executionStatus !== 'COMPLETED' ||
          suggestion.phase !== 'READY' ||
          suggestion.confirmedSchemaRevisionId !== null
        )
          return 'invalid' as const
        const updated = await orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          draftVersion: expectedDraftVersion,
        }).update({
          draft,
          draftVersion: expectedDraftVersion + 1,
        })
        return updated ? ('updated' as const) : ('conflict' as const)
      })
      if (result === 'missing') return null
      const suggestion = await loadBatchSchemaSuggestion(
        database.orm,
        projectContextId,
        batchSchemaSuggestionId,
      )
      if (!suggestion) return null
      if (result === 'invalid') return { status: 'invalid' as const }
      return { status: result, suggestion }
    },
    async retryBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId) {
      const result = await database.transaction(async ({ orm }) => {
        const suggestion = await orm.public.BatchSchemaSuggestion.select(
          'id',
        ).first({ id: batchSchemaSuggestionId, projectContextId })
        if (!suggestion) return 'missing' as const
        const sources = await orm.public.BatchSchemaSuggestionSource.where({
          batchSchemaSuggestionId,
        })
          .select('sourceDocumentId', 'executionStatus')
          .all()
        const sourceFailures = sources.filter(
          (source) => source.executionStatus !== 'COMPLETED',
        )
        for (const source of sourceFailures)
          await orm.public.BatchSchemaSuggestionSource.where({
            batchSchemaSuggestionId,
            sourceDocumentId: source.sourceDocumentId,
          }).update({
            executionStatus: 'QUEUED',
            failure: null,
            startedAt: null,
            finishedAt: null,
          })
        await orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
        }).update({
          executionStatus: 'QUEUED',
          phase:
            sourceFailures.length > 0 ? 'SOURCES' : ('MERGING' as const),
          failure: null,
          confirmedSchemaRevisionId: null,
          batchExtractionId: null,
          startedAt: null,
          finishedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        return 'retried' as const
      })
      if (result === 'missing') return null
      const suggestion = await loadBatchSchemaSuggestion(
        database.orm,
        projectContextId,
        batchSchemaSuggestionId,
      )
      if (!suggestion)
        throw new Error('Retried Batch Schema Suggestion could not be read.')
      return { status: result, suggestion }
    },
    async claimBatchSchemaSuggestion(owner, now, leaseExpiresAt) {
      const queued = await database.orm.public.BatchSchemaSuggestion.where({
        executionStatus: 'QUEUED',
      })
        .select('id', 'leaseVersion', 'startedAt')
        .orderBy((suggestion) => suggestion.createdAt.asc())
        .first()
      const running = queued
        ? null
        : (await database.orm.public.BatchSchemaSuggestion.where({
            executionStatus: 'RUNNING',
          })
            .select('id', 'leaseVersion', 'startedAt', 'leaseExpiresAt')
            .orderBy((suggestion) => suggestion.createdAt.asc())
            .all()).find(
            (suggestion) =>
              suggestion.leaseExpiresAt === null ||
              suggestion.leaseExpiresAt.getTime() <= now.getTime(),
          )
      const candidate = queued ?? running
      if (!candidate) return null
      const version = candidate.leaseVersion + 1
      const claimed = await database.orm.public.BatchSchemaSuggestion.where({
        id: candidate.id,
        leaseVersion: candidate.leaseVersion,
      }).update({
        executionStatus: 'RUNNING',
        failure: null,
        startedAt: candidate.startedAt ?? now,
        finishedAt: null,
        leaseOwner: owner,
        leaseVersion: version,
        leaseExpiresAt,
      })
      if (!claimed) return null
      const suggestion = await loadBatchSchemaSuggestion(
        database.orm,
        claimed.projectContextId,
        candidate.id,
      )
      if (!suggestion) return null
      return {
        ...suggestion,
        lease: { owner, version, expiresAt: leaseExpiresAt },
      }
    },
    async renewBatchSchemaSuggestionLease(
      batchSchemaSuggestionId,
      lease,
      leaseExpiresAt,
    ) {
      return Boolean(
        await database.orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
        }).update({ leaseExpiresAt }),
      )
    },
    async startBatchSchemaSuggestionSource(
      batchSchemaSuggestionId,
      sourceDocumentId,
      lease,
      startedAt,
    ) {
      return database.transaction(async ({ orm }) => {
        const owned = await orm.public.BatchSchemaSuggestion.select('id').first({
          id: batchSchemaSuggestionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
          executionStatus: 'RUNNING',
        })
        if (!owned) return false
        return Boolean(
          await orm.public.BatchSchemaSuggestionSource.where({
            batchSchemaSuggestionId,
            sourceDocumentId,
          }).update({
            executionStatus: 'RUNNING',
            failure: null,
            startedAt,
            finishedAt: null,
          }),
        )
      })
    },
    async completeBatchSchemaSuggestionSource(
      batchSchemaSuggestionId,
      sourceDocumentId,
      lease,
      result,
      finishedAt,
    ) {
      return database.transaction(async ({ orm }) => {
        const owned = await orm.public.BatchSchemaSuggestion.select('id').first({
          id: batchSchemaSuggestionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
          executionStatus: 'RUNNING',
        })
        if (!owned) return false
        return Boolean(
          await orm.public.BatchSchemaSuggestionSource.where({
            batchSchemaSuggestionId,
            sourceDocumentId,
          }).update(
            'definition' in result
              ? {
                  executionStatus: 'COMPLETED',
                  definition: result.definition,
                  failure: null,
                  finishedAt,
                }
              : {
                  executionStatus: 'FAILED',
                  definition: null,
                  failure: result.failure,
                  finishedAt,
                },
          ),
        )
      })
    },
    async startBatchSchemaSuggestionMerge(batchSchemaSuggestionId, lease) {
      return Boolean(
        await database.orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
          executionStatus: 'RUNNING',
        }).update({ phase: 'MERGING' }),
      )
    },
    async completeBatchSchemaSuggestionMerge(
      batchSchemaSuggestionId,
      lease,
      result,
      finishedAt,
    ) {
      return Boolean(
        await database.orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
          executionStatus: 'RUNNING',
        }).update(
          'heterogeneous' in result
            ? {
                executionStatus: 'COMPLETED',
                phase: 'HETEROGENEOUS',
                proposal: null,
                coverage: null,
                draft: null,
                failure: null,
                finishedAt,
                leaseOwner: null,
                leaseExpiresAt: null,
              }
            : {
                executionStatus: 'COMPLETED',
                phase: 'READY',
                proposal: result.proposal,
                coverage: result.coverage,
                draft: result.draft,
                draftVersion: 1,
                failure: null,
                finishedAt,
                leaseOwner: null,
                leaseExpiresAt: null,
              },
        ),
      )
    },
    async failBatchSchemaSuggestion(
      batchSchemaSuggestionId,
      lease,
      failure,
      finishedAt,
    ) {
      return Boolean(
        await database.orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
        }).update({
          executionStatus: 'FAILED',
          failure,
          finishedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        }),
      )
    },
    async runBatchSchemaSuggestion(
      projectContextId,
      batchSchemaSuggestionId,
      strategy,
    ) {
      const run = async () =>
        database.transaction(async ({ orm }) => {
          const suggestion = await orm.public.BatchSchemaSuggestion.select(
            'id',
            'executionStatus',
            'phase',
            'draft',
            'confirmedSchemaRevisionId',
            'batchExtractionId',
          ).first({ id: batchSchemaSuggestionId, projectContextId })
          if (!suggestion) return 'missing' as const
          if (
            suggestion.confirmedSchemaRevisionId !== null &&
            suggestion.batchExtractionId !== null
          )
            return 'replayed' as const
          if (
            suggestion.executionStatus !== 'COMPLETED' ||
            suggestion.phase !== 'READY' ||
            suggestion.draft === null
          )
            return 'not-ready' as const
          const members = await orm.public.BatchSchemaSuggestionSource.where({
            batchSchemaSuggestionId,
          })
            .select('sourceDocumentId', 'sourceRepresentationRevisionId')
            .orderBy((source) => source.sourceDocumentId.asc())
            .all()
          if (members.length === 0) return 'invalid' as const
          const extractionSchemaId = stableUuid(
            'confirmed-batch-schema-suggestion',
            `${batchSchemaSuggestionId}:${stableJson(
              semanticBatchSuggestionTree(suggestion.draft),
            )}`,
          )
          const existingRevision = await orm.public.SchemaRevision.where({
            extractionSchemaId,
          })
            .select('id')
            .orderBy((revision) => revision.revisionNumber.desc())
            .first()
          const schemaRevisionId = existingRevision?.id ?? stableUuid(
            'confirmed-batch-schema-suggestion-revision',
            extractionSchemaId,
          )
          if (!existingRevision) {
            await orm.public.ExtractionSchema.create({
              id: extractionSchemaId,
              projectContextId,
              name: 'Suggested fields',
            })
            await orm.public.SchemaRevision.create({
              id: schemaRevisionId,
              extractionSchemaId,
              revisionNumber: 1,
              origin: 'SUGGESTION',
              schemaTree: suggestion.draft,
            })
          }
          const batchExtractionId = stableUuid(
            'batch-extraction-from-suggestion',
            batchSchemaSuggestionId,
          )
          await orm.public.BatchExtraction.create({
            id: batchExtractionId,
            projectContextId,
            schemaRevisionId,
            strategy,
          })
          for (const member of members)
            await orm.public.BatchExtractionMember.create({
              batchExtractionId,
              ...member,
            })
          await orm.public.BatchSchemaSuggestion.where({
            id: batchSchemaSuggestionId,
          }).update({
            confirmedSchemaRevisionId: schemaRevisionId,
            batchExtractionId,
          })
          return 'created' as const
        })
      let status: 'created' | 'replayed' | 'missing' | 'not-ready' | 'invalid'
      try {
        status = await run()
      } catch (error) {
        if (!uniqueConstraint(error)) throw error
        status = 'replayed'
      }
      if (status === 'missing') return null
      if (status === 'not-ready' || status === 'invalid') return { status }
      const suggestion = await loadBatchSchemaSuggestion(
        database.orm,
        projectContextId,
        batchSchemaSuggestionId,
      )
      const batch = suggestion?.batchExtractionId
        ? await loadBatchExtraction(
            database.orm,
            projectContextId,
            suggestion.batchExtractionId,
          )
        : null
      if (!suggestion || !batch)
        throw new Error('Confirmed Batch Schema Suggestion could not be read.')
      return { status, suggestion, batch }
    },
    async initializeSchemaRevision(projectContextId, schemaTree) {
      return database.transaction(async ({ orm }) => {
        const project = await orm.public.ProjectContext.select('id').first({
          id: projectContextId,
        })
        if (!project) return null

        const extractionSchema = await orm.public.ExtractionSchema.where({
          projectContextId,
        })
          .select('id')
          .orderBy([
            (schema) => schema.createdAt.desc(),
            (schema) => schema.id.desc(),
          ])
          .first()
        if (extractionSchema) {
          const row = await orm.public.SchemaRevision.where({
            extractionSchemaId: extractionSchema.id,
          })
            .select(...revisionFields)
            .orderBy((revision) => revision.revisionNumber.desc())
            .first()
          if (row)
            return {
              status: 'conflict' as const,
              currentRevision: schemaRevision(row as StoredSchemaRevision),
            }
        }
        const extractionSchemaId = extractionSchema?.id ?? randomUUID()
        if (!extractionSchema) {
          await orm.public.ExtractionSchema.create({
            id: extractionSchemaId,
            projectContextId,
            name: 'Extraction Schema',
          })
        }

        const created = await orm.public.SchemaRevision.create({
          extractionSchemaId,
          revisionNumber: 1,
          origin: 'SUGGESTION',
          schemaTree,
        })
        return {
          status: 'created' as const,
          revision: schemaRevision(created as StoredSchemaRevision),
        }
      })
    },
    async listExtractionSchemas(projectContextId, limit) {
      return database.transaction(async ({ orm }) => {
        const project = await orm.public.ProjectContext.select('id').first({
          id: projectContextId,
        })
        if (!project) return null
        const schemas = await orm.public.ExtractionSchema.where({
          projectContextId,
        })
          .select('id', 'name', 'createdAt')
          .orderBy([
            (schema) => schema.createdAt.desc(),
            (schema) => schema.id.desc(),
          ])
          .take(limit)
          .all()
        // ponytail: bounded to 50 schemas; use a window query if this becomes hot.
        const summaries: ExtractionSchemaSummary[] = []
        for (const schema of schemas) {
          const revision = await orm.public.SchemaRevision.where({
            extractionSchemaId: schema.id,
          })
            .select('id', 'revisionNumber', 'origin', 'createdAt')
            .orderBy((row) => row.revisionNumber.desc())
            .first()
          summaries.push({
            extractionSchemaId: schema.id,
            name: schema.name,
            createdAt: schema.createdAt,
            currentRevision: revision
              ? {
                  schemaRevisionId: revision.id,
                  revisionNumber: revision.revisionNumber,
                  origin:
                    revisionOrigins[
                      revision.origin as StoredSchemaRevision['origin']
                    ],
                  createdAt: revision.createdAt,
                }
              : null,
          })
        }
        return summaries
      })
    },
    async renameExtractionSchema(projectContextId, extractionSchemaId, name) {
      const row = await database.orm.public.ExtractionSchema.where({
        id: extractionSchemaId,
        projectContextId,
      }).update({ name: extractionSchemaName(name) })
      return row
        ? {
            extractionSchemaId: row.id,
            name: row.name,
            createdAt: row.createdAt,
          }
        : null
    },
    async appendSchemaRevision(
      projectContextId,
      extractionSchemaId,
      expectedRevisionNumber,
      schemaTree,
    ) {
      const currentHead = async (): Promise<SchemaRevisionRecord | null> => {
        const row = await database.orm.public.SchemaRevision.where({
          extractionSchemaId,
        })
          .select(...revisionFields)
          .orderBy((revision) => revision.revisionNumber.desc())
          .first()
        return row ? schemaRevision(row as StoredSchemaRevision) : null
      }
      const owner = await database.orm.public.ExtractionSchema.select(
        'id',
      ).first({
        id: extractionSchemaId,
        projectContextId,
      })
      if (!owner) return null

      try {
        return await database.transaction(async ({ orm }) => {
          const row = await orm.public.SchemaRevision.where({
            extractionSchemaId,
          })
            .select(...revisionFields)
            .orderBy((revision) => revision.revisionNumber.desc())
            .first()
          const head = row ? schemaRevision(row as StoredSchemaRevision) : null
          if ((head?.revisionNumber ?? 0) !== expectedRevisionNumber) {
            return head
              ? { status: 'conflict' as const, currentRevision: head }
              : null
          }
          const created = await orm.public.SchemaRevision.create({
            extractionSchemaId,
            revisionNumber: expectedRevisionNumber + 1,
            origin: 'RESEARCHER_EDIT',
            schemaTree,
          })
          return {
            status: 'created' as const,
            revision: schemaRevision(created as StoredSchemaRevision),
          }
        })
      } catch (error) {
        if (!uniqueConstraint(error)) throw error
        const head = await currentHead()
        if (!head) throw error
        return { status: 'conflict', currentRevision: head }
      }
    },
    async listSchemaRevisions(projectContextId, extractionSchemaId, limit) {
      const owner = await database.orm.public.ExtractionSchema.select(
        'id',
      ).first({
        id: extractionSchemaId,
        projectContextId,
      })
      if (!owner) return null
      const rows = await database.orm.public.SchemaRevision.where({
        extractionSchemaId,
      })
        .select(...revisionFields)
        .orderBy((revision) => revision.revisionNumber.desc())
        .take(limit)
        .all()
      return rows.map((row) => schemaRevision(row as StoredSchemaRevision))
    },
    async getSchemaRevision(
      projectContextId,
      extractionSchemaId,
      schemaRevisionId,
    ) {
      const owner = await database.orm.public.ExtractionSchema.select(
        'id',
      ).first({
        id: extractionSchemaId,
        projectContextId,
      })
      if (!owner) return null
      const row = await database.orm.public.SchemaRevision.select(
        ...revisionFields,
      ).first({ id: schemaRevisionId, extractionSchemaId })
      return row ? schemaRevision(row as StoredSchemaRevision) : null
    },
    async createBatchExtraction(projectContextId, input) {
      const load = () =>
        loadBatchExtraction(
          database.orm,
          projectContextId,
          input.batchExtractionId,
        )
      try {
        const opened = await database.transaction(async ({ orm }) => {
          const project = await orm.public.ProjectContext.select('id').first({
            id: projectContextId,
          })
          if (!project) return 'missing' as const
          if (input.sourceDocumentIds.length === 0) return 'invalid' as const
          const schema = await orm.public.SchemaRevision.select(
            'extractionSchemaId',
          ).first({ id: input.schemaRevisionId })
          if (!schema) return 'invalid' as const
          const owner = await orm.public.ExtractionSchema.select(
            'projectContextId',
          ).first({
            id: schema.extractionSchemaId,
          })
          if (!owner || owner.projectContextId !== projectContextId)
            return 'invalid' as const
          const currentSchemaRevision = await orm.public.SchemaRevision.where({
            extractionSchemaId: schema.extractionSchemaId,
          })
            .select('id')
            .orderBy((revision) => revision.revisionNumber.desc())
            .first()
          if (currentSchemaRevision?.id !== input.schemaRevisionId)
            return 'invalid' as const

          // Each member pins the Source Document's Current Source
          // Representation Revision now, so a later ingestion cannot change what
          // this Batch Extraction ran against.
          const members: {
            sourceDocumentId: string
            sourceRepresentationRevisionId: string
          }[] = []
          for (const sourceDocumentId of canonicalSourceDocumentIds(
            input.sourceDocumentIds,
          )) {
            const document = await orm.public.SourceDocument.select('id').first(
              {
                id: sourceDocumentId,
                projectContextId,
              },
            )
            if (!document) return 'invalid' as const
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
            id: input.batchExtractionId,
            projectContextId,
            schemaRevisionId: input.schemaRevisionId,
            strategy: input.strategy,
          })
          for (const member of members)
            await orm.public.BatchExtractionMember.create({
              batchExtractionId: input.batchExtractionId,
              ...member,
            })
          return 'created' as const
        })
        if (opened === 'missing') return null
        if (opened === 'invalid') return { status: 'invalid' as const }
        const batch = await load()
        if (!batch)
          throw new Error('Persisted Batch Extraction could not be read.')
        return { status: 'created', batch }
      } catch (error) {
        if (!uniqueConstraint(error)) throw error
        const batch = await load()
        if (!batch || !sameBatchIdentity(batch, input))
          return { status: 'conflict' }
        return { status: 'replayed', batch }
      }
    },
    async listBatchExtractions(projectContextId, limit) {
      const project = await database.orm.public.ProjectContext.select(
        'id',
      ).first({
        id: projectContextId,
      })
      if (!project) return null
      const rows = await database.orm.public.BatchExtraction.where({
        projectContextId,
      })
        .select('id')
        .orderBy([
          (batch) => batch.createdAt.desc(),
          (batch) => batch.id.desc(),
        ])
        .take(limit)
        .all()
      // ponytail: one member read per listed batch, bounded by `limit`; fold
      // into a single joined query if a Project Context ever lists enough
      // Batch Extractions for this to be hot.
      const batches: BatchExtractionRecord[] = []
      for (const row of rows) {
        const batch = await loadBatchExtraction(
          database.orm,
          projectContextId,
          row.id,
        )
        if (batch) batches.push(batch)
      }
      return batches
    },
    async getBatchExtraction(projectContextId, batchExtractionId) {
      return loadBatchExtraction(
        database.orm,
        projectContextId,
        batchExtractionId,
      )
    },
    async retryBatchExtraction(projectContextId, batchExtractionId) {
      const retried = await database.transaction(async ({ orm }) => {
        const batch = await orm.public.BatchExtraction.select('id').first({
          id: batchExtractionId,
          projectContextId,
        })
        if (!batch) return false
        const members = await orm.public.BatchExtractionMember.where({
          batchExtractionId,
        })
          .select('sourceDocumentId', 'executionStatus')
          .all()
        for (const member of members)
          if (member.executionStatus !== 'COMPLETED')
            await orm.public.BatchExtractionMember.where({
              batchExtractionId,
              sourceDocumentId: member.sourceDocumentId,
            }).update({
              executionStatus: 'QUEUED',
              failure: null,
              startedAt: null,
              finishedAt: null,
            })
        await orm.public.BatchExtraction.where({ id: batchExtractionId }).update({
          executionStatus: 'QUEUED',
          failure: null,
          startedAt: null,
          finishedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        return true
      })
      return retried
        ? loadBatchExtraction(database.orm, projectContextId, batchExtractionId)
        : null
    },
    async claimBatchExtraction(owner, now, leaseExpiresAt) {
      const queued = await database.orm.public.BatchExtraction.where({
        executionStatus: 'QUEUED',
      })
        .select('id', 'leaseVersion', 'startedAt')
        .orderBy((batch) => batch.createdAt.asc())
        .first()
      const running = queued
        ? null
        : (await database.orm.public.BatchExtraction.where({
            executionStatus: 'RUNNING',
          })
            .select('id', 'leaseVersion', 'startedAt', 'leaseExpiresAt')
            .orderBy((batch) => batch.createdAt.asc())
            .all()).find(
            (batch) =>
              batch.leaseExpiresAt === null ||
              batch.leaseExpiresAt.getTime() <= now.getTime(),
          )
      const candidate = queued ?? running
      if (!candidate) return null
      const version = candidate.leaseVersion + 1
      const claimed = await database.orm.public.BatchExtraction.where({
        id: candidate.id,
        leaseVersion: candidate.leaseVersion,
      }).update({
        executionStatus: 'RUNNING',
        failure: null,
        startedAt: candidate.startedAt ?? now,
        finishedAt: null,
        leaseOwner: owner,
        leaseVersion: version,
        leaseExpiresAt,
      })
      if (!claimed) return null
      const batch = await loadBatchExtraction(
        database.orm,
        claimed.projectContextId,
        candidate.id,
      )
      if (!batch) return null
      return { ...batch, lease: { owner, version, expiresAt: leaseExpiresAt } }
    },
    async renewBatchExtractionLease(batchExtractionId, lease, leaseExpiresAt) {
      return Boolean(
        await database.orm.public.BatchExtraction.where({
          id: batchExtractionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
        }).update({ leaseExpiresAt }),
      )
    },
    async startBatchExtractionMember(
      batchExtractionId,
      sourceDocumentId,
      lease,
      startedAt,
    ) {
      return database.transaction(async ({ orm }) => {
        const owned = await orm.public.BatchExtraction.select('id').first({
          id: batchExtractionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
          executionStatus: 'RUNNING',
        })
        if (!owned) return false
        return Boolean(
          await orm.public.BatchExtractionMember.where({
            batchExtractionId,
            sourceDocumentId,
          }).update({
            executionStatus: 'RUNNING',
            failure: null,
            startedAt,
            finishedAt: null,
          }),
        )
      })
    },
    async completeBatchExtractionMember(
      batchExtractionId,
      sourceDocumentId,
      lease,
      result,
      finishedAt,
    ) {
      return database.transaction(async ({ orm }) => {
        const owned = await orm.public.BatchExtraction.select('id').first({
          id: batchExtractionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
          executionStatus: 'RUNNING',
        })
        if (!owned) return false
        const updated = await orm.public.BatchExtractionMember.where({
          batchExtractionId,
          sourceDocumentId,
        }).update(
          'completed' in result
            ? {
                executionStatus: 'COMPLETED',
                failure: null,
                finishedAt,
              }
            : {
                executionStatus: 'FAILED',
                failure: result.failure,
                finishedAt,
              },
        )
        if (!updated) return false
        const members = await orm.public.BatchExtractionMember.where({
          batchExtractionId,
        })
          .select('executionStatus')
          .all()
        if (
          members.length > 0 &&
          members.every((member) =>
            ['COMPLETED', 'FAILED'].includes(member.executionStatus),
          )
        )
          await orm.public.BatchExtraction.where({
            id: batchExtractionId,
            leaseOwner: lease.owner,
            leaseVersion: lease.version,
          }).update({
            executionStatus: 'COMPLETED',
            finishedAt,
            leaseOwner: null,
            leaseExpiresAt: null,
          })
        return true
      })
    },
    async failBatchExtraction(batchExtractionId, lease, failure, finishedAt) {
      return Boolean(
        await database.orm.public.BatchExtraction.where({
          id: batchExtractionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
        }).update({
          executionStatus: 'FAILED',
          failure,
          finishedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        }),
      )
    },
    async persistExtractionAttempt(input) {
      try {
        const created = await database.transaction(async ({ orm }) => {
          const representation =
            await orm.public.SourceRepresentationRevision.select(
              'id',
              'sourceDocumentId',
            ).first({
              id: input.sourceRepresentationRevisionId,
              sourceDocumentId: input.sourceDocumentId,
            })
          const document = representation
            ? await orm.public.SourceDocument.select('projectContextId').first({
                id: representation.sourceDocumentId,
              })
            : null
          const schema = await orm.public.SchemaRevision.select(
            'id',
            'extractionSchemaId',
          ).first({ id: input.schemaRevisionId })
          const extractionSchema = schema
            ? await orm.public.ExtractionSchema.select(
                'projectContextId',
              ).first({
                id: schema.extractionSchemaId,
              })
            : null
          if (
            !representation ||
            !document ||
            !schema ||
            !extractionSchema ||
            extractionSchema.projectContextId !== document.projectContextId
          )
            return false
          if (input.batchExtractionId) {
            const member = await orm.public.BatchExtractionMember.select(
              'batchExtractionId',
            ).first({
              batchExtractionId: input.batchExtractionId,
              sourceDocumentId: input.sourceDocumentId,
              sourceRepresentationRevisionId:
                input.sourceRepresentationRevisionId,
            })
            if (!member) return false
          }
          await orm.public.Extraction.create({
            id: input.extractionId,
            sourceDocumentId: input.sourceDocumentId,
            sourceRepresentationRevisionId:
              input.sourceRepresentationRevisionId,
            schemaRevisionId: input.schemaRevisionId,
            strategy: input.strategy,
            outcome: input.outcome,
            complete: input.complete,
            modelAttribution: input.modelAttribution,
            diagnostics: input.diagnostics,
            failure: input.failure,
            resultPayload: input.resultPayload,
            evidenceLinks: input.evidenceLinks,
            reviewable: input.reviewable,
            retryOfId: input.retryOfId,
            batchExtractionId: input.batchExtractionId,
          })
          return true
        })
        if (!created) return { status: 'invalid' }
        const attempt = await loadStoredAttempt(
          database.orm,
          input.extractionId,
        )
        if (!attempt) throw new Error('Persisted Extraction could not be read.')
        return { status: 'created', attempt }
      } catch (error) {
        if (!uniqueConstraint(error)) throw error
        const attempt = await loadStoredAttempt(
          database.orm,
          input.extractionId,
        )
        if (!attempt) throw error
        return sameAttemptIdentity(attempt, input)
          ? { status: 'replayed', attempt }
          : { status: 'conflict', attempt }
      }
    },
    async finalizeExtractionReview(extractionId, input) {
      const submitted = normalizeDecisionInput(input.reviewDecisions)
      const decisionDigest = JSON.stringify(submitted)
      if (
        submitted.length !== input.reviewDecisions.length ||
        new Set(submitted.map((decision) => decision.evidenceAnchorId)).size !==
          submitted.length
      )
        return { status: 'invalid' }

      let status: 'not-found' | 'invalid' | 'conflict' | 'replayed' | 'reviewed'
      try {
        status = await database.transaction(async ({ orm }) => {
          const attempt = await loadStoredAttempt(orm, extractionId)
          if (!attempt) return 'not-found' as const
          if (
            attempt.outcome !== 'SUCCEEDED' ||
            !attempt.reviewable ||
            !Array.isArray(attempt.evidenceLinks)
          )
            return 'invalid' as const
          const citedAnchors = new Set<string>()
          const citedPaths = new Set<string>()
          for (const link of attempt.evidenceLinks) {
            if (
              !link ||
              typeof link !== 'object' ||
              typeof (link as { evidenceAnchorId?: unknown })
                .evidenceAnchorId !== 'string' ||
              !Array.isArray((link as { resultPath?: unknown }).resultPath) ||
              !(link as { resultPath: unknown[] }).resultPath.every(
                (segment) =>
                  typeof segment === 'string' ||
                  (Number.isInteger(segment) && (segment as number) >= 0),
              )
            )
              return 'invalid' as const
            citedAnchors.add(
              (link as { evidenceAnchorId: string }).evidenceAnchorId,
            )
            const pathKey = JSON.stringify(
              (link as { resultPath: unknown[] }).resultPath,
            )
            if (citedPaths.has(pathKey)) return 'invalid' as const
            citedPaths.add(pathKey)
          }
          if (
            citedPaths.size !== input.requiredResultPathKeys.size ||
            [...input.requiredResultPathKeys].some(
              (pathKey) => !citedPaths.has(pathKey),
            ) ||
            citedAnchors.size !== submitted.length ||
            submitted.some(
              (decision) => !citedAnchors.has(decision.evidenceAnchorId),
            ) ||
            submitted.some((decision) => {
              const owned = input.occurrenceIdsByAnchor.get(
                decision.evidenceAnchorId,
              )
              return (
                !owned ||
                decision.reviewedOccurrenceIds.some((id) => !owned.has(id))
              )
            })
          )
            return 'invalid' as const

          if (attempt.reviewedAt)
            return (await storedReviewDigest(orm, extractionId)) ===
              decisionDigest
              ? 'replayed'
              : 'conflict'

          await orm.public.ExtractionReview.create({
            extractionId,
            decisionDigest,
          })
          for (const decision of submitted)
            await orm.public.ReviewDecision.create({
              extractionId,
              evidenceAnchorId: decision.evidenceAnchorId,
              reviewedOccurrenceIds: decision.reviewedOccurrenceIds,
            })
          await orm.public.Extraction.where({ id: extractionId }).update({
            reviewedAt: new Date(),
          })
          return 'reviewed' as const
        })
      } catch (error) {
        if (!uniqueConstraint(error)) throw error
        status =
          (await storedReviewDigest(database.orm, extractionId)) ===
          decisionDigest
            ? 'replayed'
            : 'conflict'
      }
      if (
        status === 'not-found' ||
        status === 'invalid' ||
        status === 'conflict'
      )
        return { status }
      const attempt = await loadStoredAttempt(database.orm, extractionId)
      if (!attempt) throw new Error('Reviewed Extraction could not be read.')
      return { status, attempt }
    },
  }
}
