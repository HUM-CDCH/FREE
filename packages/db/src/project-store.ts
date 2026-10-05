import {
  canonicalPackageStore,
  type CanonicalPackageDescriptor,
  type CanonicalPackageStore,
} from './artifact-store.js'
import { createHash, randomUUID } from 'node:crypto'
import {
  db,
  type Database,
  type DatabaseTransaction,
} from './prisma/db.js'
import {
  executionOf,
  INTERRUPTED_FAILURE,
  LIVE_WORKFLOW_STATUSES,
  type WorkflowStatuses,
} from './execution-status.js'
import {
  isUniqueViolation,
  withPoolClientTransaction,
  type TransactionalEnqueue,
} from './pool-client-transaction.js'
import { lockSourceDocumentRow } from './row-lock.js'
import { packageIsReferenced } from './garbage-references.js'

export type SchemaRevisionOrigin =
  'suggestion' | 'researcher-edit' | 'model-edit'

/**
 * A saved definition's task scope (`SchemaRevision.recordScope`, beside the tree, never inside it): `document` is one
 * Article-level object, `records` a Catalog of record objects. Null is an undeclared legacy definition whose task
 * selection was ambiguous; it must be given a scope before it runs.
 */
export type RecordScope = 'document' | 'records'

export function isRecordScope(value: unknown): value is RecordScope {
  return value === 'document' || value === 'records'
}

function storedRecordScope(value: unknown): RecordScope | null {
  if (value === null || value === undefined) return null
  if (isRecordScope(value)) return value
  throw new Error('A stored Schema Revision declares an unknown record scope.')
}

function writtenRecordScope(value: RecordScope | null): RecordScope | null {
  if (value !== null && !isRecordScope(value)) throw new Error('A Schema Revision record scope must be document or records.')
  return value
}

export type SchemaRevisionRecord = {
  schemaRevisionId: string
  extractionSchemaId: string
  revisionNumber: number
  origin: SchemaRevisionOrigin
  schemaTree: unknown
  recordScope: RecordScope | null
  /** When the researcher stabilised this revision for collection-scale extraction; null until then. */
  stabilisedAt: Date | null
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
  recordScope?: string | null
  stabilisedAt?: Date | null
  /** Selected only where a revision's source declaration is read: the append's head and the reopened revision. */
  modelAttribution?: unknown
  createdAt: Date
}

const revisionFields = [
  'id',
  'extractionSchemaId',
  'revisionNumber',
  'origin',
  'schemaTree',
  'recordScope',
  'stabilisedAt',
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
    recordScope: storedRecordScope(row.recordScope),
    stabilisedAt: row.stabilisedAt ?? null,
    createdAt: row.createdAt,
  }
}

/**
 * A Schema Revision's `modelAttribution` records what the model behind its content declared: `{ sourceCoverage }`,
 * what the Schema Suggestion that produced the content read of its source. Studio owns the declaration's shape.
 */
function modelAttribution(sourceCoverage: unknown): { sourceCoverage: unknown } | null {
  return sourceCoverage === null || sourceCoverage === undefined ? null : { sourceCoverage }
}

function declaredSourceCoverage(attribution: unknown): unknown {
  return attribution !== null && typeof attribution === 'object' && 'sourceCoverage' in attribution
    ? (attribution.sourceCoverage ?? null)
    : null
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
      recordScope: fields.schemaRevision.recordScope,
      stabilisedAt: fields.schemaRevision.stabilisedAt,
      modelAttribution: fields.schemaRevision.modelAttribution,
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

/** The revision's package descriptor and the Source Document it belongs to, when the account owns its project. */
async function ownedSourceRepresentationDescriptor(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  projectContextId: string,
  sourceRepresentationId: string,
): Promise<(CanonicalPackageDescriptor & { sourceDocumentId: string }) | null> {
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
      sourceDocumentId: fields.sourceRepresentationRevision.sourceDocumentId,
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
  schemaStabilised: boolean
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
    schemaStabilised: false,
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

export type PersistedSourceDocument = IngestedSourceDocument & {
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
  /** The browser's reprocess request key: a repeat with the same key replays the revision it created. */
  requestKey: string
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
    recordScope: RecordScope | null
    /** What the Schema Suggestion behind this revision read of its source (Studio validates it); null when none. */
    sourceCoverage: unknown
  } | null
}

type Orm = typeof db.orm

/** Studio's `suggestSchemaBatch` workflow, by name (api/_batch_suggestion_workflow.ts SUGGEST_SCHEMA_BATCH; Studio's
 *  server/workflows.test.ts pins the two equal). */
export const SUGGEST_SCHEMA_BATCH_NAME = 'suggestSchemaBatch'
/** Studio's `suggest` queue, one global slot (server/dbos.ts SUGGEST_QUEUE; server/workflows.test.ts pins the two equal). */
export const SUGGEST_QUEUE_NAME = 'suggest'
/** A concurrent creation of the same selection: its ID derives from the selection key, so either key can fire. */
const SUGGESTION_KEYS = ['batchSchemaSuggestion_pkey', 'batchSchemaSuggestion_selectionKey_key'] as const
/** One Source Document per content in a project (contract.prisma `@@unique([projectContextId, contentSha256])`). */
const SOURCE_CONTENT_KEY = 'sourceDocument_projectContextId_contentSha256_key'

export const suggestWorkflowId = (batchSchemaSuggestionId: string, attempt: number) =>
  `suggest:${batchSchemaSuggestionId}:${attempt}`

/**
 * The durable Extractions of these Source Documents (ADR 0017): a public Extraction row with a live coordination head.
 * `finished` is a COMPLETED, FAILED or STOPPED acknowledgement; `reviewedAt` is the latest named finalization of any of
 * its result/decision cuts. A row without a live head is no Extraction these summaries count.
 */
async function durableExtractionFacts(database: Database, where: { documentIds?: readonly string[]; batchIds?: readonly string[] }) {
  const rows = where.documentIds
    ? where.documentIds.length === 0 ? [] : await database.orm.public.Extraction.where((row) => row.sourceDocumentId.in([...where.documentIds!]))
      .select('id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'batchExtractionId', 'createdAt').all()
    : (where.batchIds ?? []).length === 0 ? [] : await database.orm.public.Extraction.where((row) => row.batchExtractionId.in([...where.batchIds!]))
      .select('id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'batchExtractionId', 'createdAt').all()
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const heads = new Map((await database.orm.extraction_runtime.Head.where((head) => head.id.in(ids)).select('id', 'acknowledgement', 'deleted').all())
    .filter((head) => !head.deleted).map((head) => [head.id, head.acknowledgement]))
  const finalizations = heads.size === 0 ? [] : await database.orm.extraction_runtime.Finalization.where((row) => row.extractionId.in([...heads.keys()]))
    .select('extractionId', 'createdAt').all()
  const reviewedAt = new Map<string, Date>()
  for (const finalization of finalizations) {
    const latest = reviewedAt.get(finalization.extractionId)
    if (!latest || finalization.createdAt > latest) reviewedAt.set(finalization.extractionId, finalization.createdAt)
  }
  return rows.filter((row) => heads.has(row.id)).map((row) => {
    const acknowledgement = heads.get(row.id)!
    return { ...row, completed: acknowledgement === 'COMPLETED',
      finished: acknowledgement === 'COMPLETED' || acknowledgement === 'FAILED' || acknowledgement === 'STOPPED',
      reviewedAt: reviewedAt.get(row.id) ?? null }
  })
}

/**
 * Whether a suggestion's current attempt is active: it has no outcome and its workflow is live (DBOS ENQUEUED, DELAYED
 * or PENDING). An attempt with no outcome whose workflow ended or is gone is interrupted, and counts as terminal for
 * retry, draft edits and Run alike. Read under the suggestion's row lock the answer is exact: a publication either
 * committed before the lock was taken, so its outcome is visible, or waits behind it with its workflow still PENDING.
 */
export function suggestionAttemptActive(outcome: string | null, status: string | undefined): boolean {
  return outcome === null && status !== undefined && LIVE_WORKFLOW_STATUSES.has(status)
}

/** The statuses of attempts admitted just now: each workflow was enqueued in the transaction that committed its row. */
const JUST_ADMITTED: WorkflowStatuses = async (workflowIds) => new Map(workflowIds.map((id) => [id, 'ENQUEUED']))
const suggestionFields = [
  'id',
  'selectionKey',
  'attempt',
  'outcome',
  'failure',
  'phase',
  'sourceKind',
  'purpose',
  'columnFieldMapping',
  'projectSpreadsheetVersionId',
  'proposal',
  'coverage',
  'draft',
  'draftVersion',
  'confirmedSchemaRevisionId',
  'batchExtractionId',
  'createdAt',
] as const

type StoredSuggestion = {
  id: string
  selectionKey: string
  attempt: number
  outcome: 'SUCCEEDED' | 'FAILED' | null
  failure: unknown
  phase: BatchSchemaSuggestionPhase | null
  sourceKind: BatchSchemaSuggestionSourceKind
  purpose: BatchSchemaSuggestionPurpose | null
  columnFieldMapping: unknown
  projectSpreadsheetVersionId: string | null
  proposal: unknown
  coverage: unknown
  draft: unknown
  draftVersion: number
  confirmedSchemaRevisionId: string | null
  batchExtractionId: string | null
  createdAt: Date
}

/** The execution status and failure a researcher reads: the stored outcome, else the attempt's workflow (spec, *Status
 *  and ownership*). A row read before its workflow reported SUCCESS was re-read by the caller. */
function suggestionExecution(
  row: StoredSuggestion,
  status: string | undefined,
): Pick<BatchSchemaSuggestionRecord, 'executionStatus' | 'failure'> {
  if (row.outcome === 'SUCCEEDED') return { executionStatus: 'COMPLETED', failure: null }
  if (row.outcome === 'FAILED') return { executionStatus: 'FAILED', failure: row.failure }
  const execution = executionOf(status)
  if (execution === 'QUEUED' || execution === 'RUNNING') return { executionStatus: execution, failure: null }
  return { executionStatus: 'FAILED', failure: { ...INTERRUPTED_FAILURE } }
}

/**
 * Rebuilds the durable suggestion snapshots of `ids` in one Project Context, in the order given, with one status read
 * for every attempt that has no outcome. A suggestion missing from the project is left out.
 */
async function loadBatchSchemaSuggestions(
  orm: Orm,
  statuses: WorkflowStatuses,
  projectContextId: string,
  ids: readonly string[],
): Promise<BatchSchemaSuggestionRecord[]> {
  if (ids.length === 0) return []
  const rows = new Map(
    ((await orm.public.BatchSchemaSuggestion.where((suggestion) => suggestion.id.in([...ids]))
      .where({ projectContextId })
      .select(...suggestionFields)
      .all()) as StoredSuggestion[]).map((row) => [row.id, row]),
  )
  const unsettled = [...rows.values()].filter((row) => row.outcome === null)
  const status =
    unsettled.length === 0
      ? new Map<string, string>()
      : await statuses(unsettled.map((row) => suggestWorkflowId(row.id, row.attempt)))
  // SUCCESS without an outcome on the first read: the publication may have committed just after it.
  for (const row of unsettled)
    if (executionOf(status.get(suggestWorkflowId(row.id, row.attempt))) === 'REREAD') {
      const reread = (await orm.public.BatchSchemaSuggestion.select(...suggestionFields).first({
        id: row.id,
      })) as StoredSuggestion | null
      if (reread) rows.set(row.id, reread)
    }
  const pins = rows.size === 0
    ? []
    : await orm.public.BatchSchemaSuggestionSource.where((source) =>
        source.batchSchemaSuggestionId.in([...rows.keys()]),
      )
        .select('batchSchemaSuggestionId', 'sourceDocumentId', 'sourceRepresentationRevisionId')
        .orderBy((source) => source.sourceDocumentId.asc())
        .all()
  const revisions = new Map(
    (pins.length === 0
      ? []
      : await orm.public.SourceRepresentationRevision.where((revision) =>
          revision.id.in([...new Set(pins.map((pin) => pin.sourceRepresentationRevisionId))]),
        )
          .select('id', 'artifactReference', 'artifactSha256')
          .all()
    ).map((revision) => [revision.id, revision]),
  )
  const records: BatchSchemaSuggestionRecord[] = []
  for (const id of ids) {
    const row = rows.get(id)
    if (!row) continue
    const sources: BatchSchemaSuggestionSourceRecord[] = []
    for (const pin of pins) {
      if (pin.batchSchemaSuggestionId !== id) continue
      // The composite pin cascades with its revision, so a pin always has one.
      const revision = revisions.get(pin.sourceRepresentationRevisionId)
      if (!revision) throw new Error('Stored Batch Schema Suggestion pins are unavailable.')
      sources.push({
        sourceDocumentId: pin.sourceDocumentId,
        sourceRepresentationRevisionId: pin.sourceRepresentationRevisionId,
        descriptor: { artifactReference: revision.artifactReference, artifactSha256: revision.artifactSha256 },
      })
    }
    records.push({
      batchSchemaSuggestionId: row.id,
      projectContextId,
      selectionKey: row.selectionKey,
      attempt: row.attempt,
      ...suggestionExecution(row, status.get(suggestWorkflowId(row.id, row.attempt))),
      phase: row.phase,
      sourceKind: row.sourceKind,
      purpose: row.purpose,
      columnFieldMapping: row.columnFieldMapping ?? null,
      projectSpreadsheetVersionId: row.projectSpreadsheetVersionId,
      proposal: row.proposal,
      coverage: row.coverage,
      draft: row.draft,
      draftVersion: row.draftVersion,
      confirmedSchemaRevisionId: row.confirmedSchemaRevisionId,
      batchExtractionId: row.batchExtractionId,
      createdAt: row.createdAt,
      sources,
    })
  }
  return records
}

async function loadBatchSchemaSuggestion(
  orm: Orm,
  statuses: WorkflowStatuses,
  projectContextId: string,
  batchSchemaSuggestionId: string,
): Promise<BatchSchemaSuggestionRecord | null> {
  return (await loadBatchSchemaSuggestions(orm, statuses, projectContextId, [batchSchemaSuggestionId]))[0] ?? null
}

/**
 * Takes the suggestion's row lock for the rest of the transaction (a no-op update, as row-lock.ts does for documents):
 * a concurrent retry, draft edit, Run or attempt write waits. False when the suggestion is not in the project.
 */
async function lockSuggestionRow(orm: Orm, projectContextId: string, batchSchemaSuggestionId: string): Promise<boolean> {
  const locked = await orm.public.BatchSchemaSuggestion.where({
    id: batchSchemaSuggestionId,
    projectContextId,
  }).updateAll({ id: batchSchemaSuggestionId })
  return locked.length === 1
}

/**
 * The one predicate every attempt check and terminal write shares: `attempt` is the suggestion's current attempt and it
 * has no outcome. Evaluated by a no-op update, so it also takes the row lock: a retry that advanced the attempt, a
 * deletion that interrupted it or an earlier execution of the same step leaves nothing to match.
 */
async function lockCurrentAttempt(orm: Orm, batchSchemaSuggestionId: string, attempt: number): Promise<boolean> {
  const locked = await orm.public.BatchSchemaSuggestion.where({
    id: batchSchemaSuggestionId,
    attempt,
    outcome: null,
    confirmedSchemaRevisionId: null,
  }).updateAll({ id: batchSchemaSuggestionId })
  return locked.length === 1
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

/** One member's pin, as a suggestion attempt's workflow input carries it. */
type SuggestionMember = { sourceDocumentId: string; sourceRepresentationRevisionId: string }

/** Each selected Source Document's head revision, sorted by Source Document ID; null for an empty or foreign
 *  selection. */
async function currentBatchMembers(
  orm: Orm,
  researcherAccountId: string,
  projectContextId: string,
  sourceDocumentIds: readonly string[],
): Promise<SuggestionMember[] | null> {
  const project = await orm.public.ProjectContext.select('id').first({
    id: projectContextId,
    researcherAccountId,
  })
  if (!project || sourceDocumentIds.length === 0) return null
  const members: SuggestionMember[] = []
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

export type BatchSchemaSuggestionPhase = 'READY' | 'HETEROGENEOUS'

/** DOCUMENTS suggestions read Source Documents; SPREADSHEET ones are built from the project's spreadsheet slot. */
export type BatchSchemaSuggestionSourceKind = 'DOCUMENTS' | 'SPREADSHEET'

/** Only meaningful for a SPREADSHEET-kind suggestion: SCHEMA seeds the schema and stops there,
 *  SCHEMA_AND_VALIDATE also starts a gold-standard validation corpus once confirmed. */
export type BatchSchemaSuggestionPurpose = 'SCHEMA' | 'SCHEMA_AND_VALIDATE'

/** One immutable version of a project's single shared spreadsheet slot. */
export type ProjectSpreadsheetVersionRecord = {
  projectSpreadsheetVersionId: string
  projectContextId: string
  revisionNumber: number
  originalFilename: string
  /** `SpreadsheetColumn[]`-shaped JSON: `{ columnName, values }[]`. */
  columns: unknown
  createdAt: Date
}

/** A field the researcher flagged as problematic on a Schema Revision. */
export type SchemaIssueFlagRecord = {
  schemaIssueFlagId: string
  schemaRevisionId: string
  fieldPath: string
  note: string | null
  createdAt: Date
}

/** One member pin and its revision's canonical package. */
export type BatchSchemaSuggestionSourceRecord = {
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  descriptor: CanonicalPackageDescriptor
}

export type BatchSchemaSuggestionRecord = {
  batchSchemaSuggestionId: string
  projectContextId: string
  selectionKey: string
  /** The current attempt: 1 at creation, one more after each retry. */
  attempt: number
  /** Derived: the current attempt's outcome, else its workflow's DBOS status (FAILED `interrupted` once it stopped). */
  executionStatus: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  /** The retained proposal's meaning; null before the first proposal. */
  phase: BatchSchemaSuggestionPhase | null
  /** DOCUMENTS suggestions read Source Documents; SPREADSHEET ones are built from the project's spreadsheet slot. */
  sourceKind: BatchSchemaSuggestionSourceKind
  /** Only set for a SPREADSHEET-kind suggestion; null for DOCUMENTS. */
  purpose: BatchSchemaSuggestionPurpose | null
  /** Column name -> matching SchemaNode.id; null for a DOCUMENTS-kind suggestion. */
  columnFieldMapping: unknown | null
  /** The spreadsheet version this suggestion was built from; null for DOCUMENTS. */
  projectSpreadsheetVersionId: string | null
  proposal: unknown | null
  coverage: unknown | null
  draft: unknown | null
  draftVersion: number
  /** The current attempt's failure. */
  failure: unknown | null
  confirmedSchemaRevisionId: string | null
  batchExtractionId: string | null
  createdAt: Date
  sources: BatchSchemaSuggestionSourceRecord[]
}

/** What one successful attempt publishes (Studio's SuggestionProposal); `coverage` is Studio's declaration of what
 *  each Source Document suggestion read of its source, or null. */
export type BatchSchemaSuggestionProposal =
  | { phase: 'READY'; proposal: unknown; coverage: unknown; draft: unknown }
  | { phase: 'HETEROGENEOUS'; coverage?: unknown }

export type UpdateBatchSchemaSuggestionDraftResult =
  | { status: 'updated'; suggestion: BatchSchemaSuggestionRecord }
  | { status: 'conflict'; suggestion: BatchSchemaSuggestionRecord }
  | { status: 'invalid' }
  | null

export type RetryBatchSchemaSuggestionResult =
  | { status: 'retried' | 'replayed'; suggestion: BatchSchemaSuggestionRecord }
  | { status: 'attempt-conflict' }
  | { status: 'not-ready' }
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
  ): Promise<{ interruptedAttempts: readonly { batchSchemaSuggestionId: string; attempt: number }[] } | null>
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
  /** The revision's package descriptor with its Source Document, or null when the account does not own it. */
  getSourceRepresentation(
    projectContextId: string,
    sourceRepresentationId: string,
  ): Promise<(CanonicalPackageDescriptor & { sourceDocumentId: string }) | null>
  /**
   * Attempts reference-safe cleanup for a package produced by this request.
   * The caller learns nothing about deployment-wide package references.
   */
  discardCanonicalPackage(
    descriptor: CanonicalPackageDescriptor,
  ): Promise<void>
  /** The owned Project Context's Source Document with these bytes, as ingestion published it; null when the project
   *  is missing or foreign or holds no such content. Completed-content replay reads it before any parse. */
  findSourceDocumentByContent(
    projectContextId: string,
    contentSha256: string,
  ): Promise<PersistedSourceDocument | null>
  /** Content hash → Source Document ID for the owned Project Context's documents with any of these contents, in one
   *  read; empty when the project is missing or foreign. The Source Ingestion listing resolves failed attempts with it. */
  findSourceDocumentIdsByContent(
    projectContextId: string,
    contentSha256s: readonly string[],
  ): Promise<ReadonlyMap<string, string>>
  /**
   * Makes a retained canonical package visible as one Source Document and its
   * first representation. Content is the identity: the unique
   * (projectContextId, contentSha256) constraint is the publication backstop,
   * so a repeat or a concurrent winner returns the existing document as
   * `replayed` and never a second one.
   */
  ingestSourceDocument(
    projectContextId: string,
    input: IngestSourceDocumentInput,
  ): Promise<(PersistedSourceDocument & { disposition: 'created' | 'replayed' }) | null>
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
  /**
   * A spreadsheet-derived suggestion has no document sources to run a model
   * against: it is ready immediately, with `sourceKind: 'SPREADSHEET'` and an
   * empty `sources` list, skipping the document SOURCES/MERGING phases.
   */
  createSpreadsheetSchemaSuggestion(
    projectContextId: string,
    /** A `SchemaDefinition`-shaped JSON value; parsed and validated by the caller. */
    definition: unknown,
    /** Column name -> the definition's matching `SchemaNode.id`, computed by the caller. */
    columnFieldMapping: Record<string, string>,
    /** The project spreadsheet version this suggestion was built from. */
    projectSpreadsheetVersionId: string,
    purpose: BatchSchemaSuggestionPurpose,
  ): Promise<{ status: 'created'; suggestion: BatchSchemaSuggestionRecord } | null>
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
  /**
   * Starts the next attempt over every surviving pin, once per `expectedAttempt`: a repeat that finds exactly that
   * attempt's successor replays it, whether or not it finished; any other attempt is a conflict. Refused (`not-ready`)
   * while the current attempt is active, after confirmation, or with no surviving member.
   */
  retryBatchSchemaSuggestion(
    projectContextId: string,
    batchSchemaSuggestionId: string,
    expectedAttempt: number,
  ): Promise<RetryBatchSchemaSuggestionResult>
  /**
   * `sourceCoverage` is the declaration of the Schema Suggestion that produced the tree, when it made one. `recordScope`
   * is the definition's task scope; omitted or null, the revision declares none (a choice is required before it runs).
   */
  initializeSchemaRevision(
    projectContextId: string,
    schemaTree: unknown,
    sourceCoverage?: unknown,
    recordScope?: RecordScope | null,
  ): Promise<AppendSchemaRevisionResult | null>
  listExtractionSchemas(
    projectContextId: string,
    limit: number,
  ): Promise<ExtractionSchemaSummary[] | null>
  /**
   * With `expectedName`, the rename applies only while the schema still carries that name (trimmed, as names are
   * stored); otherwise the schema is answered as it stands. Null when the Project Context or the schema is not owned.
   */
  renameExtractionSchema(
    projectContextId: string,
    extractionSchemaId: string,
    name: string,
    expectedName?: string,
  ): Promise<ExtractionSchemaRecord | null>
  /**
   * Omitted, `sourceCoverage` is inherited from the head: an edit keeps the declaration of the suggestion it was made
   * from. A replacement names its own suggestion's declaration, or null for content no suggestion produced.
   * Omitted, `recordScope` is inherited from the head too, so a schema edit, an interaction proposal or a suggestion
   * merge never drops it; a given scope (a scope change is an explicit append) is stored as given.
   */
  appendSchemaRevision(
    projectContextId: string,
    extractionSchemaId: string,
    expectedRevisionNumber: number,
    schemaTree: unknown,
    sourceCoverage?: unknown,
    recordScope?: RecordScope | null,
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
  /** Appends a new version to the project's one shared spreadsheet slot — never replaces a prior version
   *  (mirrors `appendSchemaRevision`). Null when the account does not own the Project Context. */
  appendProjectSpreadsheetVersion(
    projectContextId: string,
    originalFilename: string,
    /** `SpreadsheetColumn[]`-shaped JSON value. */
    columns: unknown,
  ): Promise<ProjectSpreadsheetVersionRecord | null>
  /** The most recently appended spreadsheet version for this project, or null when none has been uploaded. */
  getCurrentProjectSpreadsheet(
    projectContextId: string,
  ): Promise<ProjectSpreadsheetVersionRecord | null>
  /** Refuses (`'has_extractions'`) rather than cascading through an Extraction Schema's Schema Revisions when any of
   *  them has an Extraction — the cascade would silently delete Extraction rows with the schema. `force` skips that
   *  check, for a researcher who has explicitly confirmed they want the Extractions gone too. */
  deleteExtractionSchema(
    projectContextId: string,
    extractionSchemaId: string,
    force?: boolean,
  ): Promise<{ status: 'deleted' | 'has_extractions' } | null>
  /** Idempotent per `(schemaRevisionId, fieldPath)`: re-flagging an already-open field updates it in place rather
   *  than duplicating it. Null when the Schema Revision is not in an owned Project Context. */
  flagSchemaField(
    projectContextId: string,
    schemaRevisionId: string,
    fieldPath: string,
    note?: string | null,
  ): Promise<SchemaIssueFlagRecord | null>
  listOpenSchemaIssueFlags(
    projectContextId: string,
    schemaRevisionId: string,
  ): Promise<SchemaIssueFlagRecord[] | null>
  /** Whether the account owns the Project Context and, when named, the Extraction Schema still exists in it: the
   *  scope a model-operation listing or cancel is authorized against (spec, *Status and ownership*). */
  modelOperationScopeExists(projectContextId: string, extractionSchemaId: string | null): Promise<boolean>
}

/** One page's extent in its revision's canonical Markdown: UTF-8 byte offsets, as `parsed_document.json` records them. */
export type SourcePageSpan = { pageNumber: number; start: number; end: number }

/** A revision's canonical Markdown with each page's span in it. */
export type SchemaSource = { markdown: string; pageSpans: SourcePageSpan[] }

export type InternalProjectWorkerStore = {
  /** The Researcher Account that owns the Project Context, or null when it no longer exists. Background model work
   *  resolves the owner's configuration and keys through it. */
  projectContextOwner(projectContextId: string): Promise<string | null>
  /** The revision's canonical Markdown as text, or null when the revision is gone. */
  readRevisionMarkdown(sourceRepresentationRevisionId: string): Promise<string | null>
  /** The revision's canonical Markdown with each page's span in it (a page without Markdown has none), read from the
   *  one pinned revision; null when the revision is gone. */
  readRevisionSchemaSource(sourceRepresentationRevisionId: string): Promise<SchemaSource | null>
  /** A schema revision's tree, or null when the revision is gone or belongs to another Extraction Schema. */
  readSchemaRevisionTree(extractionSchemaId: string, schemaRevisionId: string): Promise<unknown | null>
  /** 'current' while `attempt` is the suggestion's attempt and has no outcome; 'stopped' after a retry, an
   *  interruption, a publication or the suggestion's deletion. */
  suggestionAttemptState(batchSchemaSuggestionId: string, attempt: number): Promise<'current' | 'stopped'>
  /** Publishes the attempt's proposal (and a new draft version) if it is still current. */
  publishBatchSchemaSuggestion(
    batchSchemaSuggestionId: string,
    attempt: number,
    result: BatchSchemaSuggestionProposal,
  ): Promise<'published' | 'stopped'>
  /** Records the attempt's failure if it is still current; the proposal, draft and draft version stay. */
  failBatchSchemaSuggestionAttempt(
    batchSchemaSuggestionId: string,
    attempt: number,
    failure: { code: string; message: string },
  ): Promise<'published' | 'stopped'>
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

/** The Source Document of a project with these bytes and its first revision, which ingestion published. */
async function sourceDocumentByContent(
  orm: Orm,
  projectContextId: string,
  contentSha256: string,
): Promise<PersistedSourceDocument | null> {
  const document = await orm.public.SourceDocument.select(
    'id',
    'originalName',
    'contentSha256',
    'createdAt',
  ).first({ projectContextId, contentSha256 })
  if (!document) return null
  const representation = await orm.public.SourceRepresentationRevision.select(
    'id',
    'revisionNumber',
    'artifactReference',
    'artifactSha256',
  ).first({ sourceDocumentId: document.id, revisionNumber: 1 })
  return representation
    ? ingestedSourceDocument(
        document as StoredIngestedSourceDocument,
        representation as StoredSourceRepresentation,
      )
    : null
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

/** Serializes source deletion with suggestion admission before either reads current source membership. */
async function lockOwnedProjectContext(
  orm: Orm,
  researcherAccountId: string,
  projectContextId: string,
): Promise<boolean> {
  return (await orm.public.ProjectContext.where({ id: projectContextId, researcherAccountId })
    .updateAll({ id: projectContextId })).length === 1
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

export type ResearcherProjectStoreOptions = Readonly<{
  /** The DBOS status of named workflows (Studio's admission client); required when reading unsettled work. */
  workflowStatuses?: WorkflowStatuses
  /** Enqueues a Batch Schema Suggestion attempt's `suggestSchemaBatch` workflow in its admission transaction (Studio's
   *  admission client); creation and retry require it. */
  enqueue?: TransactionalEnqueue
}>

export function createResearcherProjectStore(
  researcherAccountId: string,
  database: Database = db,
  options: ResearcherProjectStoreOptions = {},
): ResearcherProjectStore {
  const statuses: WorkflowStatuses = (workflowIds) => {
    if (!options.workflowStatuses)
      throw new Error('This store cannot read unsettled workflow status: createResearcherProjectStore was given no workflowStatuses.')
    return options.workflowStatuses(workflowIds)
  }
  const admitSuggestionAttempt = async (
    client: Parameters<TransactionalEnqueue>[0],
    input: { batchSchemaSuggestionId: string; attempt: number; projectContextId: string; members: readonly SuggestionMember[] },
  ) => {
    if (!options.enqueue)
      throw new Error('This store cannot admit a Batch Schema Suggestion attempt: createResearcherProjectStore was given no enqueue.')
    await options.enqueue(client, {
      workflowName: SUGGEST_SCHEMA_BATCH_NAME,
      workflowID: suggestWorkflowId(input.batchSchemaSuggestionId, input.attempt),
      queueName: SUGGEST_QUEUE_NAME,
      authenticatedUser: researcherAccountId,
      attributes: { projectContextId: input.projectContextId, batchSchemaSuggestionId: input.batchSchemaSuggestionId },
    }, input)
  }
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
        if (!(await lockOwnedProjectContext(orm, researcherAccountId, projectContextId)))
          return null
        const document = await orm.public.SourceDocument.select('id').first({
          id: sourceDocumentId,
          projectContextId,
        })
        if (!document) return null
        // Serialize with retry, Run and publication before the pin cascade. Their writes lock the same suggestion row.
        const pins = await orm.public.BatchSchemaSuggestionSource.where({ sourceDocumentId })
          .select('batchSchemaSuggestionId').all()
        const suggestionIds = [...new Set(pins.map((pin) => pin.batchSchemaSuggestionId))].sort()
        const interruptedAttempts: { batchSchemaSuggestionId: string; attempt: number }[] = []
        for (const id of suggestionIds) {
          if (!(await lockSuggestionRow(orm, projectContextId, id))) continue
          const row = await orm.public.BatchSchemaSuggestion.select(
            'attempt', 'outcome', 'confirmedSchemaRevisionId',
          ).first({ id })
          if (!row || row.outcome !== null || row.confirmedSchemaRevisionId !== null) continue
          const interrupted = await orm.public.BatchSchemaSuggestion.where({
            id, attempt: row.attempt, outcome: null, confirmedSchemaRevisionId: null,
          }).updateAll({
            outcome: 'FAILED',
            failure: { code: 'interrupted', message: 'A selected Source Document was deleted while its fields were being suggested.' },
          })
          if (interrupted.length === 1) interruptedAttempts.push({ batchSchemaSuggestionId: id, attempt: row.attempt })
        }
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
        return {
          descriptors: representations.map((row) => ({
            artifactReference: row.artifactReference,
            artifactSha256: row.artifactSha256,
          })),
          interruptedAttempts,
        }
      })
      if (!candidates) return null
      await discardPackagesIfUnreferenced(database, candidates.descriptors)
      return { interruptedAttempts: candidates.interruptedAttempts }
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
      // A completed durable Extraction counts as extracted, and so does one with a finalization of any of its cuts,
      // whatever its processing state: finalization is independent of processing, and a stopped, failed or paused
      // Extraction keeps its reviewed result ("Latest reviewed" opens it too). Reviewed stays a subset of extracted.
      const extractions = (await durableExtractionFacts(database, { documentIds }))
        .filter((extraction) => extraction.completed || extraction.reviewedAt !== null)
      const schemas = await database.orm.public.ExtractionSchema.where(
        (schema) => schema.projectContextId.in(projectIds),
      )
        .select('id', 'projectContextId', 'createdAt')
        .orderBy([(schema) => schema.createdAt.desc(), (schema) => schema.id.desc()])
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
              .select('extractionSchemaId', 'revisionNumber', 'stabilisedAt', 'createdAt')
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
      // A batch's member Extractions are its selection; each is finished once its head acknowledges a terminal state.
      const members = await durableExtractionFacts(database, { batchIds: batches.map((batch) => batch.id) })

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
            schemaStabilised: false,
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
      const currentSchemaProjects = new Set<string>()
      for(const schema of schemas) {
        if (currentSchemaProjects.has(schema.projectContextId)) continue
        currentSchemaProjects.add(schema.projectContextId)
        const latest=schemaRevisions.filter(revision=>revision.extractionSchemaId===schema.id)
          .reduce<(typeof schemaRevisions)[number]|null>((current,revision)=>!current||revision.revisionNumber>current.revisionNumber?revision:current,null)
        const state=project.get(schema.projectContextId)
        if(state&&latest?.stabilisedAt)state.schemaStabilised=true
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
      for (const member of members) {
        const batchExtractionId = member.batchExtractionId
        if (batchExtractionId === null) continue
        totalMembers.set(
          batchExtractionId,
          (totalMembers.get(batchExtractionId) ?? 0) + 1,
        )
        if (member.finished)
          completedMembers.set(
            batchExtractionId,
            (completedMembers.get(batchExtractionId) ?? 0) + 1,
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
            schemaStabilised: state.schemaStabilised,
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
      const extractions = (await durableExtractionFacts(database, { documentIds: documents.map((document) => document.id) }))
        .filter((extraction) => extraction.completed || extraction.reviewedAt !== null)
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
                  'recordScope',
                  'modelAttribution',
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
                  recordScope: storedRecordScope(currentSchemaRevision.recordScope),
                  sourceCoverage: declaredSourceCoverage(currentSchemaRevision.modelAttribution),
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
    async findSourceDocumentByContent(projectContextId, contentSha256) {
      if (!(await ownsProjectContext(database.orm, researcherAccountId, projectContextId))) return null
      return sourceDocumentByContent(database.orm, projectContextId, contentSha256)
    },
    async findSourceDocumentIdsByContent(projectContextId, contentSha256s) {
      if (contentSha256s.length === 0) return new Map()
      if (!(await ownsProjectContext(database.orm, researcherAccountId, projectContextId))) return new Map()
      const rows = (await database.orm.public.SourceDocument
        .where((document) => document.contentSha256.in([...new Set(contentSha256s)]))
        .where({ projectContextId })
        .select('id', 'contentSha256')
        .all()) as { id: string; contentSha256: string }[]
      return new Map(rows.map((row) => [row.contentSha256, row.id]))
    },
    async ingestSourceDocument(projectContextId, input) {
      if (!(await ownsProjectContext(database.orm, researcherAccountId, projectContextId))) return null
      const replayed = async () => {
        const document = await sourceDocumentByContent(database.orm, projectContextId, input.contentSha256)
        if (!document) return null
        await input.ensureRetained(document.descriptor)
        return { ...document, disposition: 'replayed' as const }
      }
      const existing = await replayed()
      if (existing) return existing

      let createdSourceDocumentId: string | null = null
      try {
        const result = await database.transaction(async ({ orm }) => {
          if (!(await ownsProjectContext(orm, researcherAccountId, projectContextId))) return null
          const document = await orm.public.SourceDocument.create({
            projectContextId,
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
            projectContextId,
          }).delete()
          throw error
        }
        return { ...result, disposition: 'created' as const }
      } catch (error) {
        // Another publication of the same content in this project committed first: it is the document.
        if (!isUniqueViolation(error, SOURCE_CONTENT_KEY)) throw error
        const winner = await replayed()
        if (!winner) throw error
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
          input.requestKey,
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
              reprocessKey: input.requestKey,
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
          !isUniqueViolation(error) &&
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
      // The suggestion, its pins and attempt 1's workflow commit together on one pooled client, or none of them does.
      const admit = () =>
        withPoolClientTransaction(async ({ orm }, client) => {
          if (!(await lockOwnedProjectContext(orm, researcherAccountId, projectContextId)))
            return { status: 'missing' } as const
          const members = await currentBatchMembers(orm, researcherAccountId, projectContextId, sourceDocumentIds)
          if (!members || members.length === 0) return { status: 'invalid' } as const
          const selectionKey = batchSuggestionSelectionKey(projectContextId, members)
          const batchSchemaSuggestionId = stableUuid('batch-schema-suggestion', selectionKey)
          if (await orm.public.BatchSchemaSuggestion.select('id').first({ id: batchSchemaSuggestionId }))
            return { status: 'replayed', batchSchemaSuggestionId } as const
          await orm.public.BatchSchemaSuggestion.create({ id: batchSchemaSuggestionId, projectContextId, selectionKey })
          for (const member of members)
            await orm.public.BatchSchemaSuggestionSource.create({ batchSchemaSuggestionId, ...member })
          await admitSuggestionAttempt(client, { batchSchemaSuggestionId, attempt: 1, projectContextId, members })
          return { status: 'created', batchSchemaSuggestionId } as const
        })
      let admitted
      try {
        admitted = await admit()
      } catch (error) {
        // A concurrent creation of the same selection committed first: this one rolled back and reads it.
        if (!SUGGESTION_KEYS.some((key) => isUniqueViolation(error, key))) throw error
        admitted = await admit()
      }
      if (admitted.status === 'missing') return null
      if (admitted.status === 'invalid') return { status: 'invalid' as const }
      const suggestion = await loadBatchSchemaSuggestion(
        database.orm,
        admitted.status === 'created' ? JUST_ADMITTED : statuses,
        projectContextId,
        admitted.batchSchemaSuggestionId,
      )
      if (!suggestion) throw new Error('Persisted Batch Schema Suggestion could not be read.')
      return { status: admitted.status, suggestion }
    },
    async createSpreadsheetSchemaSuggestion(
      projectContextId,
      definition,
      columnFieldMapping,
      projectSpreadsheetVersionId,
      purpose,
    ) {
      const batchSchemaSuggestionId = randomUUID()
      const created = await database.transaction(async ({ orm }) => {
        if (!(await ownsProjectContext(orm, researcherAccountId, projectContextId)))
          return 'missing' as const
        await orm.public.BatchSchemaSuggestion.create({
          id: batchSchemaSuggestionId,
          projectContextId,
          selectionKey: createHash('sha256')
            .update(`spreadsheet:${batchSchemaSuggestionId}`)
            .digest('hex'),
          attempt: 1,
          outcome: 'SUCCEEDED',
          phase: 'READY',
          sourceKind: 'SPREADSHEET',
          purpose,
          columnFieldMapping,
          projectSpreadsheetVersionId,
          proposal: definition,
          draft: definition,
        })
        return { batchSchemaSuggestionId } as const
      })
      if (created === 'missing') return null
      const suggestion = await loadBatchSchemaSuggestion(
        database.orm,
        JUST_ADMITTED,
        projectContextId,
        created.batchSchemaSuggestionId,
      )
      if (!suggestion)
        throw new Error('Persisted Batch Schema Suggestion could not be read.')
      return { status: 'created' as const, suggestion }
    },
    /** Appends a new version to the project's one shared spreadsheet slot; never replaces a prior version. */
    async appendProjectSpreadsheetVersion(projectContextId, originalFilename, columns) {
      if (!(await ownsProjectContext(database.orm, researcherAccountId, projectContextId)))
        return null
      return database.transaction(async ({ orm }) => {
        const head = await orm.public.ProjectSpreadsheetVersion.where({
          projectContextId,
        })
          .select('revisionNumber')
          .orderBy((version) => version.revisionNumber.desc())
          .first()
        const revisionNumber = (head?.revisionNumber ?? 0) + 1
        const created = await orm.public.ProjectSpreadsheetVersion.create({
          projectContextId,
          revisionNumber,
          originalFilename,
          columns,
        })
        return {
          projectSpreadsheetVersionId: created.id,
          projectContextId,
          revisionNumber,
          originalFilename,
          columns,
          createdAt: created.createdAt,
        }
      })
    },
    async getCurrentProjectSpreadsheet(projectContextId) {
      if (!(await ownsProjectContext(database.orm, researcherAccountId, projectContextId)))
        return null
      const row = await database.orm.public.ProjectSpreadsheetVersion.where({
        projectContextId,
      })
        .select('id', 'revisionNumber', 'originalFilename', 'columns', 'createdAt')
        .orderBy((version) => version.revisionNumber.desc())
        .first()
      if (!row) return null
      return {
        projectSpreadsheetVersionId: row.id,
        projectContextId,
        revisionNumber: row.revisionNumber,
        originalFilename: row.originalFilename,
        columns: row.columns,
        createdAt: row.createdAt,
      }
    },
    async getBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId) {
      if (!(await ownsProjectContext(database.orm, researcherAccountId, projectContextId))) return null
      return loadBatchSchemaSuggestion(database.orm, statuses, projectContextId, batchSchemaSuggestionId)
    },
    async listBatchSchemaSuggestions(projectContextId, limit) {
      if (!(await ownsProjectContext(database.orm, researcherAccountId, projectContextId))) return null
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
      return loadBatchSchemaSuggestions(database.orm, statuses, projectContextId, rows.map((row) => row.id))
    },
    async updateBatchSchemaSuggestionDraft(
      projectContextId,
      batchSchemaSuggestionId,
      expectedDraftVersion,
      draft,
    ) {
      const result = await database.transaction(async ({ orm }) => {
        if (!(await ownsProjectContext(orm, researcherAccountId, projectContextId))) return 'missing' as const
        // Under the row lock a retry or Run cannot start between this check and the write.
        if (!(await lockSuggestionRow(orm, projectContextId, batchSchemaSuggestionId))) return 'missing' as const
        const suggestion = await orm.public.BatchSchemaSuggestion.select(
          'attempt',
          'outcome',
          'phase',
          'confirmedSchemaRevisionId',
        ).first({ id: batchSchemaSuggestionId })
        if (!suggestion) return 'missing' as const
        if (suggestion.phase !== 'READY' || suggestion.confirmedSchemaRevisionId !== null) return 'invalid' as const
        const attemptId = suggestWorkflowId(batchSchemaSuggestionId, suggestion.attempt)
        // The retained draft is read-only while an attempt runs: its result replaces it.
        if (
          suggestion.outcome === null &&
          suggestionAttemptActive(suggestion.outcome, (await statuses([attemptId])).get(attemptId))
        )
          return 'invalid' as const
        // updateAll retains these guards in the UPDATE; update selects an id first.
        const updated = await orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          draftVersion: expectedDraftVersion,
          phase: 'READY',
          confirmedSchemaRevisionId: null,
        }).updateAll({
          draft,
          draftVersion: expectedDraftVersion + 1,
        })
        return updated.length === 1 ? ('updated' as const) : ('conflict' as const)
      })
      if (result === 'missing') return null
      if (result === 'invalid') return { status: 'invalid' as const }
      const suggestion = await loadBatchSchemaSuggestion(database.orm, statuses, projectContextId, batchSchemaSuggestionId)
      if (!suggestion) return null
      return { status: result, suggestion }
    },
    async retryBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId, expectedAttempt) {
      const result = await withPoolClientTransaction(async ({ orm }, client) => {
        if (!(await ownsProjectContext(orm, researcherAccountId, projectContextId))) return 'missing' as const
        // Lock the row first: a concurrent retry, draft edit, Run or source deletion waits.
        if (!(await lockSuggestionRow(orm, projectContextId, batchSchemaSuggestionId))) return 'missing' as const
        const row = await orm.public.BatchSchemaSuggestion.select(
          'attempt',
          'outcome',
          'confirmedSchemaRevisionId',
        ).first({ id: batchSchemaSuggestionId })
        if (!row) return 'missing' as const
        // This request's successor already exists (an uncertain POST repeated): answer it, finished or not.
        if (row.attempt === expectedAttempt + 1) return 'replayed' as const
        if (row.attempt !== expectedAttempt) return 'attempt-conflict' as const
        if (row.confirmedSchemaRevisionId !== null) return 'not-ready' as const
        const current = suggestWorkflowId(batchSchemaSuggestionId, row.attempt)
        // Allowed only after a terminal attempt: an outcome, or a workflow that stopped without one (interrupted).
        if (row.outcome === null && suggestionAttemptActive(row.outcome, (await statuses([current])).get(current)))
          return 'not-ready' as const
        const members = await orm.public.BatchSchemaSuggestionSource.where({ batchSchemaSuggestionId })
          .select('sourceDocumentId', 'sourceRepresentationRevisionId')
          .orderBy((source) => source.sourceDocumentId.asc())
          .all()
        // An empty selection keeps its draft, but there is nothing to suggest from.
        if (members.length === 0) return 'not-ready' as const
        const attempt = row.attempt + 1
        await orm.public.BatchSchemaSuggestion.where({ id: batchSchemaSuggestionId }).updateAll({
          attempt,
          outcome: null,
          failure: null,
        })
        await admitSuggestionAttempt(client, { batchSchemaSuggestionId, attempt, projectContextId, members })
        return 'retried' as const
      })
      if (result === 'missing') return null
      if (result === 'attempt-conflict' || result === 'not-ready') return { status: result }
      const suggestion = await loadBatchSchemaSuggestion(
        database.orm,
        result === 'retried' ? JUST_ADMITTED : statuses,
        projectContextId,
        batchSchemaSuggestionId,
      )
      if (!suggestion) throw new Error('Retried Batch Schema Suggestion could not be read.')
      return { status: result, suggestion }
    },
    async initializeSchemaRevision(projectContextId, schemaTree, sourceCoverage, recordScope) {
      const scope = writtenRecordScope(recordScope ?? null)
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
          recordScope: scope,
          modelAttribution: modelAttribution(sourceCoverage),
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
    async renameExtractionSchema(projectContextId, extractionSchemaId, name, expectedName) {
      if (
        !(await ownsProjectContext(
          database.orm,
          researcherAccountId,
          projectContextId,
        ))
      )
        return null
      const schema = { id: extractionSchemaId, projectContextId }
      const renamed = extractionSchemaName(name)
      // A fenced rename is one `UPDATE … WHERE name = expected` (`updateAll`; `update` would select the row first, then
      // update it by its key, letting a rename committed in between be overwritten). Matching nothing, it was superseded
      // by another rename: the schema is answered as it stands.
      const row =
        expectedName === undefined
          ? await database.orm.public.ExtractionSchema.where(schema).update({ name: renamed })
          : ((
              await database.orm.public.ExtractionSchema.where({
                ...schema,
                name: expectedName.trim(),
              }).updateAll({ name: renamed })
            )[0] ??
            (await database.orm.public.ExtractionSchema.select(
              'id',
              'name',
              'createdAt',
            ).first(schema)))
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
      sourceCoverage,
      recordScope,
    ) {
      const givenScope = recordScope === undefined ? undefined : writtenRecordScope(recordScope)
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
            .select(...revisionFields, 'modelAttribution')
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
            recordScope: givenScope === undefined ? head?.recordScope ?? null : givenScope,
            modelAttribution: modelAttribution(
              sourceCoverage === undefined
                ? declaredSourceCoverage((row as StoredSchemaRevision | null)?.modelAttribution)
                : sourceCoverage,
            ),
          })
          return {
            status: 'created' as const,
            revision: schemaRevision(created as StoredSchemaRevision),
          }
        })
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
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
    async deleteExtractionSchema(projectContextId, extractionSchemaId, force) {
      return database.transaction(async (transaction) => {
        const { orm } = transaction
        if (!(await ownsProjectContext(orm, researcherAccountId, projectContextId)))
          return null
        const schema = await orm.public.ExtractionSchema.select('id').first({
          id: extractionSchemaId,
          projectContextId,
        })
        if (!schema) return null
        if (!force) {
          const revisions = await orm.public.SchemaRevision.where({
            extractionSchemaId,
          })
            .select('id')
            .all()
          if (revisions.length > 0) {
            const extraction = await orm.public.Extraction.where((row) =>
              row.schemaRevisionId.in(revisions.map((revision) => revision.id)),
            )
              .select('id')
              .first()
            if (extraction) return { status: 'has_extractions' as const }
          }
        }
        await orm.public.ExtractionSchema.where({
          id: extractionSchemaId,
          projectContextId,
        }).delete()
        return { status: 'deleted' as const }
      })
    },
    async flagSchemaField(projectContextId, schemaRevisionId, fieldPath, note) {
      return database.transaction(async (transaction) => {
        const { orm } = transaction
        if (!(await ownsProjectContext(orm, researcherAccountId, projectContextId)))
          return null
        if (
          !(await ownedSchemaRevision(
            transaction,
            researcherAccountId,
            projectContextId,
            schemaRevisionId,
          ))
        )
          return null
        const resolvedNote = note ?? null
        const existing = await orm.public.SchemaIssueFlag.select('id').first({
          schemaRevisionId,
          fieldPath,
          resolvedAt: null,
        })
        if (existing) {
          const createdAt = new Date()
          await orm.public.SchemaIssueFlag.where({ id: existing.id }).updateAll({
            note: resolvedNote,
            createdAt,
          })
          return {
            schemaIssueFlagId: existing.id,
            schemaRevisionId,
            fieldPath,
            note: resolvedNote,
            createdAt,
          }
        }
        const created = await orm.public.SchemaIssueFlag.create({
          schemaRevisionId,
          fieldPath,
          note: resolvedNote,
        })
        return {
          schemaIssueFlagId: created.id,
          schemaRevisionId,
          fieldPath,
          note: resolvedNote,
          createdAt: created.createdAt,
        }
      })
    },
    async listOpenSchemaIssueFlags(projectContextId, schemaRevisionId) {
      return database.transaction(async (transaction) => {
        const { orm } = transaction
        if (!(await ownsProjectContext(orm, researcherAccountId, projectContextId)))
          return null
        if (
          !(await ownedSchemaRevision(
            transaction,
            researcherAccountId,
            projectContextId,
            schemaRevisionId,
          ))
        )
          return null
        const rows = await orm.public.SchemaIssueFlag.where({
          schemaRevisionId,
          resolvedAt: null,
        })
          .select('id', 'schemaRevisionId', 'fieldPath', 'note', 'createdAt')
          .orderBy((flag) => flag.createdAt.asc())
          .all()
        return rows.map((row) => ({
          schemaIssueFlagId: row.id,
          schemaRevisionId: row.schemaRevisionId,
          fieldPath: row.fieldPath,
          note: row.note,
          createdAt: row.createdAt,
        }))
      })
    },
    async modelOperationScopeExists(projectContextId, extractionSchemaId) {
      return database.transaction(async ({ orm }) => {
        if (!(await ownsProjectContext(orm, researcherAccountId, projectContextId))) return false
        if (extractionSchemaId === null) return true
        return Boolean(
          await orm.public.ExtractionSchema.select('id').first({ id: extractionSchemaId, projectContextId }),
        )
      })
    },
  }
}

export function createInternalProjectWorkerStore(
  database: Database = db,
  infrastructure: Readonly<{ packages?: CanonicalPackageStore }> = {},
): InternalProjectWorkerStore {
  const packages = infrastructure.packages ?? canonicalPackageStore
  return {
    async projectContextOwner(projectContextId) {
      const project = await database.orm.public.ProjectContext.select('researcherAccountId').first({ id: projectContextId })
      return project?.researcherAccountId ?? null
    },
    async readRevisionMarkdown(sourceRepresentationRevisionId) {
      const revision = await database.orm.public.SourceRepresentationRevision.select(
        'artifactReference',
        'artifactSha256',
      ).first({ id: sourceRepresentationRevisionId })
      if (!revision) return null
      return new TextDecoder().decode((await packages.read(revision, 'markdown')).bytes)
    },
    async readRevisionSchemaSource(sourceRepresentationRevisionId) {
      const revision = await database.orm.public.SourceRepresentationRevision.select(
        'artifactReference',
        'artifactSha256',
      ).first({ id: sourceRepresentationRevisionId })
      if (!revision) return null
      const decoder = new TextDecoder()
      const [markdown, source] = await Promise.all([packages.read(revision, 'markdown'), packages.read(revision, 'source')])
      // A package without `pages` has no spans: its excerpts are unnumbered, and the declaration says so.
      const { pages = [] } = JSON.parse(decoder.decode(source.bytes)) as {
        pages?: { page_number: number; markdown_span: { start: number; end: number } | null }[]
      }
      return {
        markdown: decoder.decode(markdown.bytes),
        pageSpans: pages.flatMap(({ page_number, markdown_span }) =>
          markdown_span ? [{ pageNumber: page_number, start: markdown_span.start, end: markdown_span.end }] : []),
      }
    },
    async readSchemaRevisionTree(extractionSchemaId, schemaRevisionId) {
      const row = await database.orm.public.SchemaRevision.select('schemaTree').first({ id: schemaRevisionId, extractionSchemaId })
      return row?.schemaTree ?? null
    },
    async suggestionAttemptState(batchSchemaSuggestionId, attempt) {
      return (await database.transaction(({ orm }) => lockCurrentAttempt(orm, batchSchemaSuggestionId, attempt)))
        ? 'current'
        : 'stopped'
    },
    async publishBatchSchemaSuggestion(batchSchemaSuggestionId, attempt, result) {
      return database.transaction(async ({ orm }) => {
        if (!(await lockCurrentAttempt(orm, batchSchemaSuggestionId, attempt))) return 'stopped' as const
        const row = await orm.public.BatchSchemaSuggestion.select('draftVersion').first({ id: batchSchemaSuggestionId })
        if (!row) return 'stopped' as const
        // The read and this write share the lock, and the write repeats the predicate: a second execution of the
        // publication step finds the outcome and increments nothing.
        const written = await orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          attempt,
          outcome: null,
        }).updateAll(
          result.phase === 'READY'
            ? {
                outcome: 'SUCCEEDED',
                failure: null,
                phase: 'READY',
                proposal: result.proposal,
                coverage: result.coverage,
                draft: result.draft,
                draftVersion: row.draftVersion + 1,
              }
            : {
                outcome: 'SUCCEEDED',
                failure: null,
                phase: 'HETEROGENEOUS',
                proposal: null,
                coverage: result.coverage ?? null,
                draft: null,
                draftVersion: row.draftVersion + 1,
              },
        )
        return written.length === 1 ? ('published' as const) : ('stopped' as const)
      })
    },
    async failBatchSchemaSuggestionAttempt(batchSchemaSuggestionId, attempt, failure) {
      return database.transaction(async ({ orm }) => {
        if (!(await lockCurrentAttempt(orm, batchSchemaSuggestionId, attempt))) return 'stopped' as const
        // The proposal, draft and draft version stay: a failed attempt replaces nothing.
        const written = await orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
          attempt,
          outcome: null,
        }).updateAll({ outcome: 'FAILED', failure })
        return written.length === 1 ? ('published' as const) : ('stopped' as const)
      })
    },
  }
}
