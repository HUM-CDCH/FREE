import type { CanonicalPackageDescriptor } from './artifact-store.js'
import { randomUUID } from 'node:crypto'
import { db } from './prisma/db.js'

type Database = Pick<typeof db, 'orm' | 'transaction'>

export type SchemaRevisionOrigin =
  | 'suggestion'
  | 'researcher-edit'
  | 'model-edit'

export type SchemaRevisionRecord = {
  schemaRevisionId: string
  extractionSchemaId: string
  revisionNumber: number
  origin: SchemaRevisionOrigin
  schemaTree: unknown
  createdAt: Date
}

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

const revisionOrigins: Record<StoredSchemaRevision['origin'], SchemaRevisionOrigin> = {
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

/** One Source Document's heads plus independent latest-attempt/review snapshots. */
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
    'createdAt',
    'reviewedAt',
  ).first({ id: extractionId })
  if (!attempt) return null
  const representation =
    await orm.public.SourceRepresentationRevision.select(
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
    reviewDecisions: decisions.map((decision) => ({
      reviewDecisionId: decision.id,
      evidenceAnchorId: decision.evidenceAnchorId,
      reviewedOccurrenceIds: decision.reviewedOccurrenceIds,
    })),
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
    attempt.strategy === input.strategy
  )
}

function normalizeDecisionInput(
  decisions: readonly FinalizeExtractionReviewInput['reviewDecisions'][number][],
) {
  return decisions
    .map((decision) => ({
      evidenceAnchorId: decision.evidenceAnchorId,
      reviewedOccurrenceIds: [...new Set(decision.reviewedOccurrenceIds)].sort(),
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
    strategy: 'ARTICLE'
    outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
    complete: boolean | null
    modelAttribution: unknown | null
    diagnostics: unknown
    resultPayload: unknown | null
    evidenceLinks: unknown | null
    failure: unknown | null
    reviewable: boolean
    retryOfId: string | null
    reviewDecisions: Array<{
      reviewDecisionId: string
      evidenceAnchorId: string
      reviewedOccurrenceIds: unknown
    }>
}

export type ArticleExtractionInputs = {
  sourceDocumentId: string
  projectContextId: string
  originalFilename: string | null
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
  strategy: 'ARTICLE'
  outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  complete: boolean | null
  modelAttribution: unknown | null
  diagnostics: unknown
  failure: unknown | null
  resultPayload: unknown | null
  evidenceLinks: unknown | null
  reviewable: boolean
  retryOfId: string | null
}

export type FinalizeExtractionReviewInput = {
  reviewDecisions: Array<{
    evidenceAnchorId: string
    reviewedOccurrenceIds: string[]
  }>
  occurrenceIdsByAnchor: ReadonlyMap<string, ReadonlySet<string>>
  requiredResultPathKeys: ReadonlySet<string>
}

export type ProjectStore = {
  listProjectContexts(limit: number): Promise<ProjectContextSummary[]>
  getProjectContextWithDocuments(projectContextId: string): Promise<{
    projectContext: ProjectContextSummary
    sourceDocuments: SourceDocumentSummary[]
  } | null>
  getDocumentReopenSnapshot(
    projectContextId: string,
    sourceDocumentId: string,
  ): Promise<DocumentReopenSnapshot | null>
  getSourceRepresentation(
    sourceRepresentationId: string,
  ): Promise<CanonicalPackageDescriptor | null>
  getArticleExtractionInputs(
    sourceRepresentationRevisionId: string,
    schemaRevisionId: string,
  ): Promise<ArticleExtractionInputs | null>
  getExtractionAttempt(
    extractionId: string,
  ): Promise<StoredExtractionAttempt | null>
  initializeSchemaRevision(
    projectContextId: string,
    schemaTree: unknown,
  ): Promise<AppendSchemaRevisionResult | null>
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
  persistExtractionAttempt(input: TerminalExtractionInput): Promise<
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

export function createProjectStore(database: Database = db): ProjectStore {
  return {
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
    async getDocumentReopenSnapshot(projectContextId, sourceDocumentId) {
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

        const representations =
          await orm.public.SourceRepresentationRevision.where({
            sourceDocumentId,
          })
            .select('id', 'revisionNumber', 'createdAt')
            .orderBy((revision) => revision.revisionNumber.desc())
            .all()
        if (!representations.length) return null

        const representation = representations[0]

        const annotationSet = await orm.public.AnnotationSetRevision.where({
          sourceDocumentId,
          sourceRepresentationRevisionId: representation.id,
        })
          .select('id', 'revisionNumber', 'snapshot')
          .orderBy((revision) => revision.revisionNumber.desc())
          .first()

        // Every Source Document in a Project Context shares its Extraction Schema.
        const extractionSchema = await orm.public.ExtractionSchema.where({
          projectContextId,
        })
          .select('id')
          .orderBy([
            (schema) => schema.createdAt.desc(),
            (schema) => schema.id.desc(),
          ])
          .first()
        const schemaRevision = extractionSchema
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

        const attempts = await orm.public.Extraction.where({ sourceDocumentId })
          .select(
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
            'createdAt',
            'reviewedAt',
          )
          .orderBy([
            (attempt) => attempt.createdAt.desc(),
            (attempt) => attempt.id.desc(),
          ])
          .all()
        const materialize = async (
          attempt: (typeof attempts)[number] | undefined,
        ): Promise<StoredExtractionAttempt | null> => {
          if (!attempt) return null
          const pinnedRepresentation = representations.find(
            (candidate) => candidate.id === attempt.sourceRepresentationRevisionId,
          )
          const pinnedSchema = await orm.public.SchemaRevision.select(
            'id',
            'extractionSchemaId',
            'revisionNumber',
            'schemaTree',
          ).first({ id: attempt.schemaRevisionId })
          if (!pinnedRepresentation || !pinnedSchema)
            throw new Error('Stored Extraction pins are unavailable.')
          const decisions = await orm.public.ReviewDecision.where({
            extractionId: attempt.id,
          })
            .select('id', 'evidenceAnchorId', 'reviewedOccurrenceIds')
            .orderBy((decision) => decision.evidenceAnchorId.asc())
            .all()
          return {
            extractionId: attempt.id,
            sourceDocumentId: attempt.sourceDocumentId,
            sourceRepresentationRevisionId:
              attempt.sourceRepresentationRevisionId,
            sourceRepresentationRevisionNumber:
              pinnedRepresentation.revisionNumber,
            schemaRevisionId: attempt.schemaRevisionId,
            extractionSchemaId: pinnedSchema.extractionSchemaId,
            schemaRevisionNumber: pinnedSchema.revisionNumber,
            schemaTree: pinnedSchema.schemaTree,
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
            reviewDecisions: decisions.map((decision) => ({
              reviewDecisionId: decision.id,
              evidenceAnchorId: decision.evidenceAnchorId,
              reviewedOccurrenceIds: decision.reviewedOccurrenceIds,
            })),
          }
        }
        const latestReviewedRow = attempts
          .filter((attempt) => attempt.reviewedAt !== null)
          .sort(
            (left, right) =>
              right.reviewedAt!.getTime() - left.reviewedAt!.getTime() ||
              right.createdAt.getTime() - left.createdAt.getTime() ||
              right.id.localeCompare(left.id),
          )[0]

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
                  schemaRevisionId: schemaRevision.id,
                  revisionNumber: schemaRevision.revisionNumber,
                  schemaTree: schemaRevision.schemaTree,
                }
              : null,
          latestAttempt: await materialize(attempts[0]),
          latestReviewed: await materialize(latestReviewedRow),
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
    async getArticleExtractionInputs(
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
          'originalName',
        ).first({ id: representation.sourceDocumentId })
        const schema = await orm.public.SchemaRevision.select(
          'id',
          'extractionSchemaId',
          'schemaTree',
        ).first({ id: schemaRevisionId })
        if (!document || !schema) return null
        const extractionSchema =
          await orm.public.ExtractionSchema.select('projectContextId').first({
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
          originalFilename: document.originalName,
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
      const owner = await database.orm.public.ExtractionSchema.select('id').first({
        id: extractionSchemaId,
        projectContextId,
      })
      if (!owner) return null

      try {
        return await database.transaction(async ({ orm }) => {
          const row = await orm.public.SchemaRevision.where({ extractionSchemaId })
            .select(...revisionFields)
            .orderBy((revision) => revision.revisionNumber.desc())
            .first()
          const head = row ? schemaRevision(row as StoredSchemaRevision) : null
          if ((head?.revisionNumber ?? 0) !== expectedRevisionNumber) {
            return head ? { status: 'conflict' as const, currentRevision: head } : null
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
      const owner = await database.orm.public.ExtractionSchema.select('id').first({
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
      const owner = await database.orm.public.ExtractionSchema.select('id').first({
        id: extractionSchemaId,
        projectContextId,
      })
      if (!owner) return null
      const row = await database.orm.public.SchemaRevision.select(
        ...revisionFields,
      ).first({ id: schemaRevisionId, extractionSchemaId })
      return row ? schemaRevision(row as StoredSchemaRevision) : null
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
            ? await orm.public.ExtractionSchema.select('projectContextId').first({
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
          })
          return true
        })
        if (!created) return { status: 'invalid' }
        const attempt = await loadStoredAttempt(database.orm, input.extractionId)
        if (!attempt) throw new Error('Persisted Extraction could not be read.')
        return { status: 'created', attempt }
      } catch (error) {
        if (!uniqueConstraint(error)) throw error
        const attempt = await loadStoredAttempt(database.orm, input.extractionId)
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

      let status:
        | 'not-found'
        | 'invalid'
        | 'conflict'
        | 'replayed'
        | 'reviewed'
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
      if (status === 'not-found' || status === 'invalid' || status === 'conflict')
        return { status }
      const attempt = await loadStoredAttempt(database.orm, extractionId)
      if (!attempt) throw new Error('Reviewed Extraction could not be read.')
      return { status, attempt }
    },
  }
}
