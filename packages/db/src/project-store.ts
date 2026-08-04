import { db } from './prisma/db.js'

type Database = Pick<typeof db, 'orm' | 'transaction'>

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

/**
 * One Source Document's complete durable research state: the head Source
 * Representation Revision, the Annotation Set pinned to exactly that
 * representation, the Project Context's shared Extraction Schema head, and the
 * newest Extraction pinned to that exact representation/Schema Revision pair.
 * Absent optional research state is `null`, not a reason to refuse reopening.
 */
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
    revisionNumber: number
    schemaTree: unknown
  } | null
  extraction: {
    extractionId: string
    createdAt: Date
    outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
    resultPayload: unknown
    failure: unknown
  } | null
}

/** Server-only artifact descriptor; it never reaches browser code. */
export type SourceRepresentationArtifacts = {
  artifactReference: string
  artifactSha256: string
}

/** Read-only Project Context and reopening seam; writes stay out of it. */
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
  ): Promise<SourceRepresentationArtifacts | null>
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
      // One transaction: a head advancing mid-read must not mix a new
      // representation with annotations or an Extraction from the old one.
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

        const representation =
          await orm.public.SourceRepresentationRevision.where({
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

        // Every Source Document in a Project Context shares its Extraction Schema.
        const extractionSchema = await orm.public.ExtractionSchema.where({
          projectContextId,
        })
          .select('id')
          .orderBy([(schema) => schema.createdAt.desc(), (schema) => schema.id.desc()])
          .first()
        const schemaRevision = extractionSchema
          ? await orm.public.SchemaRevision.where({
              extractionSchemaId: extractionSchema.id,
            })
              .select('id', 'revisionNumber', 'schemaTree')
              .orderBy((revision) => revision.revisionNumber.desc())
              .first()
          : null

        const extraction = schemaRevision
          ? await orm.public.Extraction.where({
              sourceRepresentationRevisionId: representation.id,
              schemaRevisionId: schemaRevision.id,
            })
              .select('id', 'createdAt', 'outcome', 'resultPayload', 'failure')
              .orderBy([
                (attempt) => attempt.createdAt.desc(),
                (attempt) => attempt.id.desc(),
              ])
              .first()
          : null

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
                  revisionNumber: schemaRevision.revisionNumber,
                  schemaTree: schemaRevision.schemaTree,
                }
              : null,
          extraction: extraction && {
            extractionId: extraction.id,
            createdAt: extraction.createdAt,
            outcome: extraction.outcome,
            resultPayload: extraction.resultPayload,
            failure: extraction.failure,
          },
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
  }
}
