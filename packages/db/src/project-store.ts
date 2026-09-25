import {
  canonicalPackageStore,
  type CanonicalPackageDescriptor,
} from './artifact-store.js'
import { createHash, randomUUID } from 'node:crypto'
import {
  db,
  type Database,
  type DatabaseTransaction,
} from './prisma/db.js'
import { lockSourceDocumentRow } from './row-lock.js'

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

async function ownedSchemaRevision(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  projectContextId: string,
  schemaRevisionId: string,
): Promise<StoredSchemaRevision | null> {
  const { sql } = transaction
  const query = sql.public.schemaRevision
    .innerJoin(sql.public.extractionSchema, (fields, functions) =>
      functions.eq(
        fields.schemaRevision.extractionSchemaId,
        fields.extractionSchema.id,
      ),
    )
    .innerJoin(sql.public.projectContext, (fields, functions) =>
      functions.eq(
        fields.extractionSchema.projectContextId,
        fields.projectContext.id,
      ),
    )
    .select((fields) => ({
      id: fields.schemaRevision.id,
      extractionSchemaId: fields.schemaRevision.extractionSchemaId,
      revisionNumber: fields.schemaRevision.revisionNumber,
      origin: fields.schemaRevision.origin,
      schemaTree: fields.schemaRevision.schemaTree,
      createdAt: fields.schemaRevision.createdAt,
    }))
    .where((fields, functions) =>
      functions.and(
        functions.eq(fields.schemaRevision.id, schemaRevisionId),
        functions.eq(fields.projectContext.id, projectContextId),
        functions.eq(
          fields.projectContext.researcherAccountId,
          researcherAccountId,
        ),
      ),
    )
  return (await transaction.execute(query.build()).first()) as
    | StoredSchemaRevision
    | null
}

async function ownedSourceRepresentationDescriptor(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  projectContextId: string,
  sourceRepresentationId: string,
): Promise<CanonicalPackageDescriptor | null> {
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
          sourceRepresentationId,
        ),
        functions.eq(fields.projectContext.id, projectContextId),
        functions.eq(
          fields.projectContext.researcherAccountId,
          researcherAccountId,
        ),
      ),
    )
  return await transaction.execute(query.build()).first()
}

export function uniqueConstraint(error: unknown): boolean {
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
export type ProjectContextWorkflowPhase =
  | 'ingest'
  | 'chat'
  | 'approve'
  | 'extract'
  | 'validate'

/**
 * Persisted per-project workflow state, computed inside the store so listing
 * never fans out per-project reads. A Source Document is stale exactly when
 * its current Source Representation Revision differs from the one pinned by
 * its latest Extraction.
 */
export type ProjectContextActivitySummary = {
  phase: ProjectContextWorkflowPhase
  extractionCount: number
  extractedSourceDocumentCount: number
  reviewedSourceDocumentCount: number
  staleSourceDocumentCount: number
  schemaDraftCount: number
  lastActivityAt: Date
  runningBatch: { completedMemberCount: number; memberCount: number } | null
}

export type ProjectContextListItem = ProjectContextSummary & {
  sourceDocumentCount: number
  summary: ProjectContextActivitySummary
}

/**
 * One persisted event across the researcher's Project Contexts, for the home
 * page's recent-activity read. Derived only from stored rows, never from what
 * a browser expects.
 */
export type ProjectContextActivityEvent = {
  kind:
    | 'extraction_appended'
    | 'review_decisions_stored'
    | 'schema_revision_appended'
    | 'batch_extraction_opened'
  projectContextId: string
  projectContextName: string
  occurredAt: Date
}

/** The summary of a Project Context with no persisted research activity yet. */
export function emptyProjectContextActivitySummary(
  lastActivityAt: Date,
): ProjectContextActivitySummary {
  return {
    phase: 'ingest',
    extractionCount: 0,
    extractedSourceDocumentCount: 0,
    reviewedSourceDocumentCount: 0,
    staleSourceDocumentCount: 0,
    schemaDraftCount: 0,
    lastActivityAt,
    runningBatch: null,
  }
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

export type ReprocessedSourceDocument = Omit<
  IngestedSourceDocument,
  'revisionNumber'
> & {
  revisionNumber: number
  descriptor: CanonicalPackageDescriptor
}

export type ReprocessSourceDocumentInput = IngestSourceDocumentInput & {
  expectedRepresentationId: string
  requestFingerprint: string
}

export class ReprocessConflictError extends Error {
  constructor() {
    super(
      'The Source Document changed or the reprocessing key was reused with different options. Reload before reprocessing.',
    )
    this.name = 'ReprocessConflictError'
  }
}

export class IngestionKeyConflictError extends Error {
  constructor() {
    super('The ingestion key already belongs to another Source Document.')
    this.name = 'IngestionKeyConflictError'
  }
}

/** One Source Document's head plus its current annotation and Schema snapshots. */
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
}

type Orm = typeof db.orm

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

function canonicalSourceDocumentIds(ids: readonly string[]): string[] {
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

async function currentBatchMembers(
  orm: Orm,
  researcherAccountId: string,
  projectContextId: string,
  sourceDocumentIds: readonly string[],
): Promise<
  { sourceDocumentId: string; sourceRepresentationRevisionId: string }[] | null
> {
  const project = await orm.public.ProjectContext.select('id').first({
    id: projectContextId,
    researcherAccountId,
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

export type ResearcherProjectStore = {
  readonly researcherAccountId: string
  createProjectContext(name: string): Promise<ProjectContextSummary>
  renameProjectContext(
    projectContextId: string,
    name: string,
  ): Promise<ProjectContextSummary | null>
  /**
   * Deletes only an owned Project Context. Canonical package cleanup remains
   * deployment-wide and reference-safe, but no reference state leaves the store.
   */
  deleteProjectContext(projectContextId: string): Promise<boolean>
  deleteSourceDocument(
    projectContextId: string,
    sourceDocumentId: string,
  ): Promise<boolean>
  listProjectContexts(limit: number): Promise<ProjectContextListItem[]>
  /** Newest-first persisted events across every owned Project Context. */
  listRecentActivity(limit: number): Promise<ProjectContextActivityEvent[]>
  getProjectContextWithDocuments(projectContextId: string): Promise<{
    projectContext: ProjectContextSummary
    sourceDocuments: SourceDocumentSummary[]
  } | null>
  /** Reads no Extraction state; callers may supply Extraction-owned pins. */
  getDocumentReopenSnapshot(
    projectContextId: string,
    sourceDocumentId: string,
    pins?: {
      sourceRepresentationRevisionId: string
      schemaRevisionId: string
    },
  ): Promise<DocumentReopenSnapshot | null>
  getSourceRepresentation(
    projectContextId: string,
    sourceRepresentationId: string,
  ): Promise<CanonicalPackageDescriptor | null>
  /**
   * Attempts reference-safe cleanup for a package produced by this request.
   * The caller learns nothing about deployment-wide package references.
   */
  discardCanonicalPackage(
    descriptor: CanonicalPackageDescriptor,
  ): Promise<void>
  /**
   * Makes a retained canonical package visible as one Source Document and its
   * first representation. The unique ingestion key is the retry authority.
   */
  ingestSourceDocument(
    projectContextId: string,
    input: IngestSourceDocumentInput,
  ): Promise<PersistedSourceDocument | null>
  findReprocessedSourceDocument(
    projectContextId: string,
    sourceDocumentId: string,
    requestKey: string,
    requestFingerprint: string,
  ): Promise<ReprocessedSourceDocument | null>
  reprocessSourceDocument(
    projectContextId: string,
    sourceDocumentId: string,
    input: ReprocessSourceDocumentInput,
  ): Promise<ReprocessedSourceDocument | null>
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
}

export type InternalProjectWorkerStore = {
  /** Whether any surviving Source Representation Revision pins this package. */
  isPackageReferenced(artifactReference: string): Promise<boolean>
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

async function ownsProjectContext(
  orm: Orm,
  researcherAccountId: string,
  projectContextId: string,
): Promise<boolean> {
  return Boolean(
    await orm.public.ProjectContext.select('id').first({
      id: projectContextId,
      researcherAccountId,
    }),
  )
}

async function packageIsReferenced(
  database: Database,
  artifactReference: string,
): Promise<boolean> {
  return Boolean(
    await database.orm.public.SourceRepresentationRevision.select('id').first({
      artifactReference,
    }),
  )
}

async function discardPackageIfUnreferenced(
  database: Database,
  descriptor: CanonicalPackageDescriptor,
): Promise<void> {
  try {
    await canonicalPackageStore.remove(descriptor, () =>
      packageIsReferenced(database, descriptor.artifactReference),
    )
  } catch (error) {
    console.warn(
      `Could not clean up canonical package ${descriptor.artifactReference}; retaining it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function discardPackagesIfUnreferenced(
  database: Database,
  descriptors: readonly CanonicalPackageDescriptor[],
): Promise<void> {
  const attempted = new Set<string>()
  for (const descriptor of descriptors) {
    if (attempted.has(descriptor.artifactReference)) continue
    attempted.add(descriptor.artifactReference)
    await discardPackageIfUnreferenced(database, descriptor)
  }
}

export function createResearcherProjectStore(
  researcherAccountId: string,
  database: Database = db,
): ResearcherProjectStore {
  return {
    researcherAccountId,
    async createProjectContext(name) {
      return projectContextSummary(
        (await database.orm.public.ProjectContext.create({
          researcherAccountId,
          name: projectContextName(name),
        })) as StoredProjectContext,
      )
    },
    async renameProjectContext(projectContextId, name) {
      const row = (await database.orm.public.ProjectContext.where({
        id: projectContextId,
        researcherAccountId,
      }).update({
        name: projectContextName(name),
      })) as StoredProjectContext | null
      return row && projectContextSummary(row)
    },
    async deleteProjectContext(projectContextId) {
      const candidates = await database.transaction(async ({ orm }) => {
        const project = await orm.public.ProjectContext.select('id').first({
          id: projectContextId,
          researcherAccountId,
        })
        if (!project) return null

        const documents = await orm.public.SourceDocument.where({
          projectContextId,
        })
          .select('id')
          .all()
        const descriptors: CanonicalPackageDescriptor[] = []
        for (const document of documents) {
          const representations =
            await orm.public.SourceRepresentationRevision.where({
              sourceDocumentId: document.id,
            })
              .select('artifactReference', 'artifactSha256')
              .all()
          for (const row of representations)
            descriptors.push({
              artifactReference: row.artifactReference,
              artifactSha256: row.artifactSha256,
            })
        }

        await orm.public.ProjectContext.where({
          id: projectContextId,
          researcherAccountId,
        }).delete()
        return descriptors
      })
      if (!candidates) return false
      await discardPackagesIfUnreferenced(database, candidates)
      return true
    },
    async deleteSourceDocument(projectContextId, sourceDocumentId) {
      const candidates = await database.transaction(async ({ orm }) => {
        if (!(await ownsProjectContext(orm, researcherAccountId, projectContextId)))
          return null
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
        await orm.public.SourceDocument.where({
          id: sourceDocumentId,
          projectContextId,
        }).delete()
        return representations.map((row) => ({
          artifactReference: row.artifactReference,
          artifactSha256: row.artifactSha256,
        }))
      })
      if (!candidates) return false
      await discardPackagesIfUnreferenced(database, candidates)
      return true
    },
    async listProjectContexts(limit) {
      const rows = await database.orm.public.ProjectContext.where({
        researcherAccountId,
      })
        .select('id', 'name', 'createdAt')
        .orderBy([
          (project) => project.createdAt.desc(),
          (project) => project.id.desc(),
        ])
        .take(limit)
        .all()
      if (rows.length === 0) return []
      const projectIds = rows.map((row) => row.id)

      // Everything the summary needs, read as one bounded set of grouped
      // queries over the owned, limited result set — never per project.
      const documents = await database.orm.public.SourceDocument.where(
        (document) => document.projectContextId.in(projectIds),
      )
        .select('id', 'projectContextId', 'createdAt')
        .all()
      const documentIds = documents.map((document) => document.id)
      const projectByDocument = new Map(
        documents.map((document) => [document.id, document.projectContextId]),
      )
      const representations =
        documentIds.length === 0
          ? []
          : await database.orm.public.SourceRepresentationRevision.where(
              (revision) => revision.sourceDocumentId.in(documentIds),
            )
              .select('id', 'sourceDocumentId', 'revisionNumber')
              .all()
      const extractions =
        documentIds.length === 0
          ? []
          : await database.orm.public.Extraction.where((extraction) =>
              extraction.sourceDocumentId.in(documentIds),
            )
              .select(
                'sourceDocumentId',
                'sourceRepresentationRevisionId',
                'createdAt',
                'reviewedAt',
              )
              .all()
      const schemas = await database.orm.public.ExtractionSchema.where(
        (schema) => schema.projectContextId.in(projectIds),
      )
        .select('id', 'projectContextId')
        .all()
      const projectBySchema = new Map(
        schemas.map((schema) => [schema.id, schema.projectContextId]),
      )
      const schemaRevisions =
        schemas.length === 0
          ? []
          : await database.orm.public.SchemaRevision.where((revision) =>
              revision.extractionSchemaId.in(schemas.map((schema) => schema.id)),
            )
              .select('extractionSchemaId', 'createdAt')
              .all()
      const suggestions = await database.orm.public.BatchSchemaSuggestion.where(
        (suggestion) => suggestion.projectContextId.in(projectIds),
      )
        .select('projectContextId', 'phase', 'confirmedSchemaRevisionId', 'createdAt')
        .all()
      const batches = await database.orm.public.BatchExtraction.where((batch) =>
        batch.projectContextId.in(projectIds),
      )
        .select('id', 'projectContextId', 'createdAt')
        .all()
      const members =
        batches.length === 0
          ? []
          : await database.orm.public.BatchExtractionMember.where((member) =>
              member.batchExtractionId.in(batches.map((batch) => batch.id)),
            )
              .select('batchExtractionId', 'initialExtractionJobId')
              .all()
      const jobs =
        members.length === 0
          ? []
          : await database.orm.public.ExtractionJob.where((job) =>
              job.id.in(members.map((member) => member.initialExtractionJobId)),
            )
              .select('id', 'executionStatus')
              .all()

      // The current representation of each Source Document is its highest
      // revision; its latest Extraction is the most recently created one.
      const currentRepresentation = new Map<
        string,
        { id: string; revisionNumber: number }
      >()
      for (const revision of representations) {
        const current = currentRepresentation.get(revision.sourceDocumentId)
        if (!current || revision.revisionNumber > current.revisionNumber)
          currentRepresentation.set(revision.sourceDocumentId, revision)
      }
      const latestExtraction = new Map<
        string,
        { sourceRepresentationRevisionId: string; createdAt: Date }
      >()
      const project = new Map(
        rows.map((row) => [
          row.id,
          {
            sourceDocumentCount: 0,
            extractionCount: 0,
            extractedDocuments: new Set<string>(),
            reviewedDocuments: new Set<string>(),
            staleSourceDocumentCount: 0,
            schemaDraftCount: 0,
            hasSchemaRevision: false,
            hasReadySuggestion: false,
            lastActivityAt: row.createdAt,
            runningBatch: null as {
              id: string
              createdAt: Date
              completedMemberCount: number
              memberCount: number
            } | null,
          },
        ]),
      )
      const bump = (projectContextId: string, at: Date | null | undefined) => {
        const state = project.get(projectContextId)
        if (state && at && at > state.lastActivityAt) state.lastActivityAt = at
      }
      for (const document of documents) {
        const state = project.get(document.projectContextId)
        if (!state) continue
        state.sourceDocumentCount += 1
        bump(document.projectContextId, document.createdAt)
      }
      for (const extraction of extractions) {
        const projectContextId = projectByDocument.get(
          extraction.sourceDocumentId,
        )
        const state = projectContextId && project.get(projectContextId)
        if (!projectContextId || !state) continue
        state.extractionCount += 1
        state.extractedDocuments.add(extraction.sourceDocumentId)
        if (extraction.reviewedAt)
          state.reviewedDocuments.add(extraction.sourceDocumentId)
        bump(projectContextId, extraction.createdAt)
        bump(projectContextId, extraction.reviewedAt)
        const latest = latestExtraction.get(extraction.sourceDocumentId)
        if (!latest || extraction.createdAt >= latest.createdAt)
          latestExtraction.set(extraction.sourceDocumentId, extraction)
      }
      for (const [sourceDocumentId, latest] of latestExtraction) {
        const projectContextId = projectByDocument.get(sourceDocumentId)
        const state = projectContextId && project.get(projectContextId)
        if (!state) continue
        const current = currentRepresentation.get(sourceDocumentId)
        if (current && current.id !== latest.sourceRepresentationRevisionId)
          state.staleSourceDocumentCount += 1
      }
      for (const revision of schemaRevisions) {
        const projectContextId = projectBySchema.get(revision.extractionSchemaId)
        const state = projectContextId && project.get(projectContextId)
        if (!projectContextId || !state) continue
        state.hasSchemaRevision = true
        bump(projectContextId, revision.createdAt)
      }
      for (const suggestion of suggestions) {
        const state = project.get(suggestion.projectContextId)
        if (!state) continue
        if (suggestion.confirmedSchemaRevisionId == null) {
          state.schemaDraftCount += 1
          if (suggestion.phase === 'READY') state.hasReadySuggestion = true
        }
        bump(suggestion.projectContextId, suggestion.createdAt)
      }
      const completedMembers = new Map<string, number>()
      const totalMembers = new Map<string, number>()
      const jobById = new Map(jobs.map((job) => [job.id, job]))
      for (const member of members) {
        const job = jobById.get(member.initialExtractionJobId)
        if (!job) continue
        totalMembers.set(
          member.batchExtractionId,
          (totalMembers.get(member.batchExtractionId) ?? 0) + 1,
        )
        if (
          job.executionStatus === 'COMPLETED' ||
          job.executionStatus === 'FAILED'
        )
          completedMembers.set(
            member.batchExtractionId,
            (completedMembers.get(member.batchExtractionId) ?? 0) + 1,
          )
      }
      for (const batch of batches) {
        const state = project.get(batch.projectContextId)
        if (!state) continue
        bump(batch.projectContextId, batch.createdAt)
        const memberCount = totalMembers.get(batch.id) ?? 0
        if (memberCount === 0 || completedMembers.get(batch.id) === memberCount)
          continue
        if (!state.runningBatch || batch.createdAt > state.runningBatch.createdAt)
          state.runningBatch = {
            id: batch.id,
            createdAt: batch.createdAt,
            completedMemberCount: completedMembers.get(batch.id) ?? 0,
            memberCount,
          }
      }

      return rows.map(({ id, name, createdAt }) => {
        const state = project.get(id)!
        const phase: ProjectContextWorkflowPhase =
          state.sourceDocumentCount === 0
            ? 'ingest'
            : state.hasSchemaRevision
              ? state.reviewedDocuments.size > 0
                ? 'validate'
                : 'extract'
              : state.hasReadySuggestion
                ? 'approve'
                : 'chat'
        return {
          projectContextId: id,
          name,
          createdAt,
          sourceDocumentCount: state.sourceDocumentCount,
          summary: {
            phase,
            extractionCount: state.extractionCount,
            extractedSourceDocumentCount: state.extractedDocuments.size,
            reviewedSourceDocumentCount: state.reviewedDocuments.size,
            staleSourceDocumentCount: state.staleSourceDocumentCount,
            schemaDraftCount: state.schemaDraftCount,
            lastActivityAt: state.lastActivityAt,
            runningBatch: state.runningBatch && {
              completedMemberCount: state.runningBatch.completedMemberCount,
              memberCount: state.runningBatch.memberCount,
            },
          },
        }
      })
    },
    async listRecentActivity(limit) {
      const projects = await database.orm.public.ProjectContext.where({
        researcherAccountId,
      })
        .select('id', 'name')
        .all()
      if (projects.length === 0) return []
      const projectIds = projects.map((row) => row.id)
      const nameByProject = new Map(projects.map((row) => [row.id, row.name]))

      const documents = await database.orm.public.SourceDocument.where(
        (document) => document.projectContextId.in(projectIds),
      )
        .select('id', 'projectContextId')
        .all()
      const projectByDocument = new Map(
        documents.map((document) => [document.id, document.projectContextId]),
      )
      const extractions =
        documents.length === 0
          ? []
          : await database.orm.public.Extraction.where((extraction) =>
              extraction.sourceDocumentId.in(documents.map((d) => d.id)),
            )
              .select('sourceDocumentId', 'createdAt', 'reviewedAt')
              .all()
      const schemas = await database.orm.public.ExtractionSchema.where(
        (schema) => schema.projectContextId.in(projectIds),
      )
        .select('id', 'projectContextId')
        .all()
      const projectBySchema = new Map(
        schemas.map((schema) => [schema.id, schema.projectContextId]),
      )
      const schemaRevisions =
        schemas.length === 0
          ? []
          : await database.orm.public.SchemaRevision.where((revision) =>
              revision.extractionSchemaId.in(schemas.map((s) => s.id)),
            )
              .select('extractionSchemaId', 'createdAt')
              .all()
      const batches = await database.orm.public.BatchExtraction.where((batch) =>
        batch.projectContextId.in(projectIds),
      )
        .select('projectContextId', 'createdAt')
        .all()

      const events: ProjectContextActivityEvent[] = []
      const push = (
        kind: ProjectContextActivityEvent['kind'],
        projectContextId: string | undefined,
        occurredAt: Date | null | undefined,
      ) => {
        const projectContextName =
          projectContextId && nameByProject.get(projectContextId)
        if (!projectContextId || projectContextName == null || !occurredAt)
          return
        events.push({ kind, projectContextId, projectContextName, occurredAt })
      }
      for (const extraction of extractions) {
        const projectContextId = projectByDocument.get(
          extraction.sourceDocumentId,
        )
        push('extraction_appended', projectContextId, extraction.createdAt)
        push('review_decisions_stored', projectContextId, extraction.reviewedAt)
      }
      for (const revision of schemaRevisions)
        push(
          'schema_revision_appended',
          projectBySchema.get(revision.extractionSchemaId),
          revision.createdAt,
        )
      for (const batch of batches)
        push('batch_extraction_opened', batch.projectContextId, batch.createdAt)

      return events
        .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
        .slice(0, limit)
    },
    async getProjectContextWithDocuments(projectContextId) {
      const row = await database.orm.public.ProjectContext.select(
        'id',
        'name',
        'createdAt',
      ).first({ id: projectContextId, researcherAccountId })
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
      pins,
    ) {
      return database.transaction(async (transaction) => {
        const { orm } = transaction
        const project = await orm.public.ProjectContext.select(
          'id',
          'name',
          'createdAt',
        ).first({ id: projectContextId, researcherAccountId })
        if (!project) return null

        const document = await orm.public.SourceDocument.select(
          'id',
          'originalName',
          'createdAt',
        ).first({ id: sourceDocumentId, projectContextId })
        if (!document) return null

        const representation = pins
          ? await orm.public.SourceRepresentationRevision.select(
              'id',
              'revisionNumber',
              'createdAt',
            ).first({
              id: pins.sourceRepresentationRevisionId,
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

        const schemaRevision = pins
          ? await ownedSchemaRevision(
              transaction,
              researcherAccountId,
              projectContextId,
              pins.schemaRevisionId,
            )
          : null
        const extractionSchema = schemaRevision
          ? await orm.public.ExtractionSchema.select('id', 'name').first({
              id: schemaRevision.extractionSchemaId,
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
        const currentSchemaRevision =
          schemaRevision ??
          (extractionSchema
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
            : null)

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
            extractionSchema && currentSchemaRevision
              ? {
                  extractionSchemaId: extractionSchema.id,
                  name: extractionSchema.name,
                  schemaRevisionId: currentSchemaRevision.id,
                  revisionNumber: currentSchemaRevision.revisionNumber,
                  schemaTree: currentSchemaRevision.schemaTree,
                }
              : null,
        }
      })
    },
    async getSourceRepresentation(projectContextId, sourceRepresentationId) {
      return database.transaction((transaction) =>
        ownedSourceRepresentationDescriptor(
          transaction,
          researcherAccountId,
          projectContextId,
          sourceRepresentationId,
        ),
      )
    },
    discardCanonicalPackage(descriptor) {
      return discardPackageIfUnreferenced(database, descriptor)
    },
    async ingestSourceDocument(projectContextId, input) {
      const project = await database.orm.public.ProjectContext.select(
        'id',
      ).first({
        id: projectContextId,
        researcherAccountId,
      })
      if (!project) return null

      const persistedDocument = async (
        document: StoredIngestedSourceDocument | null,
      ): Promise<PersistedSourceDocument | null> => {
        if (!document) return null
        const representation =
          await database.orm.public.SourceRepresentationRevision.select(
            'id',
            'revisionNumber',
            'artifactReference',
            'artifactSha256',
          ).first({ sourceDocumentId: document.id, revisionNumber: 1 })
        return representation
          ? ingestedSourceDocument(
              document,
              representation as StoredSourceRepresentation,
            )
          : null
      }
      const existingByIngestionKey = async (): Promise<PersistedSourceDocument | null> => {
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
        // Parser-run metadata may change package identity; uploaded content is
        // the stable identity for a retry using the same ingestion key.
        if (document.contentSha256 !== input.contentSha256)
          throw new IngestionKeyConflictError()
        return persistedDocument(document as StoredIngestedSourceDocument)
      }
      const existingByContent = async (): Promise<PersistedSourceDocument | null> => {
        const document = await database.orm.public.SourceDocument.select(
          'id',
          'originalName',
          'contentSha256',
          'createdAt',
        ).first({ projectContextId, contentSha256: input.contentSha256 })
        return persistedDocument(document as StoredIngestedSourceDocument | null)
      }

      const persisted =
        (await existingByIngestionKey()) ?? (await existingByContent())
      if (persisted) {
        await input.ensureRetained(persisted.descriptor)
        return persisted
      }

      let createdSourceDocumentId: string | null = null
      try {
        const result = await database.transaction(async ({ orm }) => {
          const project = await orm.public.ProjectContext.select('id').first({
            id: projectContextId,
            researcherAccountId,
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
        const winner =
          (await existingByIngestionKey()) ?? (await existingByContent())
        if (winner) await input.ensureRetained(winner.descriptor)
        if (!winner) throw new IngestionKeyConflictError()
        return winner
      }
    },
    async findReprocessedSourceDocument(
      projectContextId,
      sourceDocumentId,
      requestKey,
      requestFingerprint,
    ) {
      if (
        !(await ownsProjectContext(
          database.orm,
          researcherAccountId,
          projectContextId,
        ))
      )
        return null
      const document = await database.orm.public.SourceDocument.select(
        'id',
        'originalName',
        'createdAt',
      ).first({ id: sourceDocumentId, projectContextId })
      if (!document) return null
      const revision =
        await database.orm.public.SourceRepresentationRevision.select(
          'id',
          'revisionNumber',
          'artifactReference',
          'artifactSha256',
          'reprocessFingerprint',
        ).first({ sourceDocumentId, reprocessKey: requestKey })
      if (!revision) return null
      if (revision.reprocessFingerprint !== requestFingerprint)
        throw new ReprocessConflictError()
      return {
        ...ingestedSourceDocument(
          document as StoredIngestedSourceDocument,
          revision as StoredSourceRepresentation,
        ),
        revisionNumber: revision.revisionNumber,
      }
    },
    async reprocessSourceDocument(projectContextId, sourceDocumentId, input) {
      const replay = () =>
        this.findReprocessedSourceDocument(
          projectContextId,
          sourceDocumentId,
          input.ingestionKey,
          input.requestFingerprint,
        )
      const previous = await replay()
      if (previous) {
        await input.ensureRetained(previous.descriptor)
        return previous
      }
      await input.ensureRetained(input)
      try {
        return await database.transaction(async (transaction) => {
          const { orm } = transaction
          if (
            !(await ownsProjectContext(
              orm,
              researcherAccountId,
              projectContextId,
            ))
          )
            return null
          // Serialize with run admission: both decide on the latest revision under this lock.
          if (!(await lockSourceDocumentRow(transaction, sourceDocumentId)))
            return null
          const document = await orm.public.SourceDocument.select(
            'id',
            'originalName',
            'createdAt',
            'contentSha256',
          ).first({ id: sourceDocumentId, projectContextId })
          if (!document) return null
          if (document.contentSha256 !== input.contentSha256)
            throw new ReprocessConflictError()
          const current = await orm.public.SourceRepresentationRevision.where({
            sourceDocumentId,
          })
            .select('id', 'revisionNumber')
            .orderBy((revision) => revision.revisionNumber.desc())
            .first()
          if (!current || current.id !== input.expectedRepresentationId)
            throw new ReprocessConflictError()
          const revision = await orm.public.SourceRepresentationRevision.create(
            {
              sourceDocumentId,
              revisionNumber: current.revisionNumber + 1,
              artifactReference: input.artifactReference,
              artifactSha256: input.artifactSha256,
              contractVersion: input.contractVersion,
              preprocessId: input.preprocessId,
              parserName: input.parserName,
              parserVersion: input.parserVersion,
              reprocessKey: input.ingestionKey,
              reprocessFingerprint: input.requestFingerprint,
            },
          )
          return {
            ...ingestedSourceDocument(
              document as StoredIngestedSourceDocument,
              revision as StoredSourceRepresentation,
            ),
            revisionNumber: revision.revisionNumber,
          }
        })
      } catch (error) {
        if (
          !uniqueConstraint(error) &&
          !(error instanceof ReprocessConflictError)
        )
          throw error
        const winner = await replay()
        if (winner) {
          await input.ensureRetained(winner.descriptor)
          return winner
        }
        throw new ReprocessConflictError()
      }
    },
    async createBatchSchemaSuggestion(projectContextId, sourceDocumentIds) {
      const create = async () =>
        database.transaction(async ({ orm }) => {
          const project = await orm.public.ProjectContext.select('id').first({
            id: projectContextId,
            researcherAccountId,
          })
          if (!project) return 'missing' as const
          const members = await currentBatchMembers(
            orm,
            researcherAccountId,
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
          currentBatchMembers(
            orm,
            researcherAccountId,
            projectContextId,
            sourceDocumentIds,
          ),
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
      if (
        !(await ownsProjectContext(
          database.orm,
          researcherAccountId,
          projectContextId,
        ))
      )
        return null
      return loadBatchSchemaSuggestion(
        database.orm,
        projectContextId,
        batchSchemaSuggestionId,
      )
    },
    async listBatchSchemaSuggestions(projectContextId, limit) {
      const project = await database.orm.public.ProjectContext.select(
        'id',
      ).first({ id: projectContextId, researcherAccountId })
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
        if (
          !(await ownsProjectContext(
            orm,
            researcherAccountId,
            projectContextId,
          ))
        )
          return 'missing' as const
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
        // updateAll retains these guards in the UPDATE; update selects an id first.
        const updated = await orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          draftVersion: expectedDraftVersion,
          executionStatus: 'COMPLETED',
          phase: 'READY',
          confirmedSchemaRevisionId: null,
        }).updateAll({
          draft,
          draftVersion: expectedDraftVersion + 1,
        })
        return updated.length === 1 ? ('updated' as const) : ('conflict' as const)
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
        if (
          !(await ownsProjectContext(
            orm,
            researcherAccountId,
            projectContextId,
          ))
        )
          return 'missing' as const
        // Lock the parent before touching sources, as the worker does.
        const [suggestion] = await orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          projectContextId,
        }).updateAll({ id: batchSchemaSuggestionId })
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
    async initializeSchemaRevision(projectContextId, schemaTree) {
      return database.transaction(async ({ orm }) => {
        const project = await orm.public.ProjectContext.select('id').first({
          id: projectContextId,
          researcherAccountId,
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
          researcherAccountId,
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
      if (
        !(await ownsProjectContext(
          database.orm,
          researcherAccountId,
          projectContextId,
        ))
      )
        return null
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
      if (
        !(await ownsProjectContext(
          database.orm,
          researcherAccountId,
          projectContextId,
        ))
      )
        return null
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
      if (
        !(await ownsProjectContext(
          database.orm,
          researcherAccountId,
          projectContextId,
        ))
      )
        return null
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
      if (
        !(await ownsProjectContext(
          database.orm,
          researcherAccountId,
          projectContextId,
        ))
      )
        return null
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
  }
}

export function createInternalProjectWorkerStore(
  database: Database = db,
): InternalProjectWorkerStore {
  return {
    isPackageReferenced(artifactReference) {
      return packageIsReferenced(database, artifactReference)
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
      const [claimed] = await database.orm.public.BatchSchemaSuggestion.where({
        id: candidate.id,
        leaseVersion: candidate.leaseVersion,
        executionStatus: queued ? 'QUEUED' : 'RUNNING',
        ...(running ? { leaseExpiresAt: running.leaseExpiresAt } : {}),
      }).updateAll({
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
      const updated = await database.orm.public.BatchSchemaSuggestion.where({
        id: batchSchemaSuggestionId,
        leaseOwner: lease.owner,
        leaseVersion: lease.version,
        executionStatus: 'RUNNING',
      }).updateAll({ leaseExpiresAt })
      return updated.length === 1
    },
    async startBatchSchemaSuggestionSource(
      batchSchemaSuggestionId,
      sourceDocumentId,
      lease,
      startedAt,
    ) {
      return database.transaction(async ({ orm }) => {
        // Keep ownership locked until the source write commits.
        const owned = await orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
          executionStatus: 'RUNNING',
        }).updateAll({ leaseVersion: lease.version })
        if (owned.length !== 1) return false
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
        const owned = await orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          leaseOwner: lease.owner,
          leaseVersion: lease.version,
          executionStatus: 'RUNNING',
        }).updateAll({ leaseVersion: lease.version })
        if (owned.length !== 1) return false
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
      const updated = await database.orm.public.BatchSchemaSuggestion.where({
        id: batchSchemaSuggestionId,
        leaseOwner: lease.owner,
        leaseVersion: lease.version,
        executionStatus: 'RUNNING',
      }).updateAll({ phase: 'MERGING' })
      return updated.length === 1
    },
    async completeBatchSchemaSuggestionMerge(
      batchSchemaSuggestionId,
      lease,
      result,
      finishedAt,
    ) {
      const updated = await database.orm.public.BatchSchemaSuggestion.where({
        id: batchSchemaSuggestionId,
        leaseOwner: lease.owner,
        leaseVersion: lease.version,
        executionStatus: 'RUNNING',
      }).updateAll(
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
      )
      return updated.length === 1
    },
    async failBatchSchemaSuggestion(
      batchSchemaSuggestionId,
      lease,
      failure,
      finishedAt,
    ) {
      const updated = await database.orm.public.BatchSchemaSuggestion.where({
        id: batchSchemaSuggestionId,
        leaseOwner: lease.owner,
        leaseVersion: lease.version,
        executionStatus: 'RUNNING',
      }).updateAll({
        executionStatus: 'FAILED',
        failure,
        finishedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      return updated.length === 1
    },
  }
}
