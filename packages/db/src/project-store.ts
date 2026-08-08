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
 * One Source Document's complete durable research state: the Source
 * Representation Revision owning its newest accepted Extraction (or the head
 * when none exists), the Annotation Set pinned to exactly that representation,
 * and that Extraction's pinned Schema Revision (or the shared Schema head when
 * no accepted Extraction exists).
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
    schemaRevisionId: string
    revisionNumber: number
    schemaTree: unknown
  } | null
  extraction: {
    extractionId: string
    createdAt: Date
    outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
    modelAttribution: unknown
    resultPayload: unknown
    failure: unknown
    reviewDecisions: Array<{
      reviewDecisionId: string
      evidenceAnchorId: string
      reviewedOccurrenceIds: unknown
    }>
  } | null
}

export type ReviewedExtractionInput = {
  /** The exact Schema Revision the accepted Extraction was produced with. */
  schemaRevisionId: string
  resultPayload: unknown
  modelAttribution: unknown
  reviewDecisions: Array<{
    evidenceAnchorId: string
    reviewedOccurrenceIds: string[]
  }>
}

/** Server-only artifact descriptor; it never reaches browser code. */
export type SourceRepresentationArtifacts = {
  artifactReference: string
  artifactSha256: string
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
  ): Promise<SourceRepresentationArtifacts | null>
  persistReviewedExtraction(
    sourceRepresentationId: string,
    input: ReviewedExtractionInput,
  ): Promise<{ extractionId: string; createdAt: Date } | null>
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

        const representations =
          await orm.public.SourceRepresentationRevision.where({
            sourceDocumentId,
          })
            .select('id', 'revisionNumber', 'createdAt')
            .orderBy((revision) => revision.revisionNumber.desc())
            .all()
        if (!representations.length) return null

        let representation = representations[0]
        let extraction: {
          id: string
          createdAt: Date
          outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
          schemaRevisionId: string
          modelAttribution: unknown
          resultPayload: unknown
          failure: unknown
        } | null = null
        for (const candidate of representations) {
          const candidateExtraction = await orm.public.Extraction.where({
            sourceRepresentationRevisionId: candidate.id,
            outcome: 'SUCCEEDED',
          })
            .select(
              'id',
              'createdAt',
              'outcome',
              'schemaRevisionId',
              'modelAttribution',
              'resultPayload',
              'failure',
            )
            .orderBy([
              (attempt) => attempt.createdAt.desc(),
              (attempt) => attempt.id.desc(),
            ])
            .first()
          if (
            candidateExtraction &&
            (!extraction ||
              candidateExtraction.createdAt > extraction.createdAt ||
              (candidateExtraction.createdAt.getTime() ===
                extraction.createdAt.getTime() &&
                candidateExtraction.id > extraction.id))
          ) {
            representation = candidate
            extraction = candidateExtraction
          }
        }

        const annotationSet = await orm.public.AnnotationSetRevision.where({
          sourceDocumentId,
          sourceRepresentationRevisionId: representation.id,
        })
          .select('id', 'revisionNumber', 'snapshot')
          .orderBy((revision) => revision.revisionNumber.desc())
          .first()

        let extractionSchema: { id: string } | null
        let schemaRevision: {
          id: string
          extractionSchemaId: string
          revisionNumber: number
          schemaTree: unknown
        } | null
        if (extraction) {
          schemaRevision = await orm.public.SchemaRevision.select(
            'id',
            'extractionSchemaId',
            'revisionNumber',
            'schemaTree',
          ).first({ id: extraction.schemaRevisionId })
          extractionSchema = schemaRevision
            ? await orm.public.ExtractionSchema.select('id').first({
                id: schemaRevision.extractionSchemaId,
                projectContextId,
              })
            : null
        } else {
          // Every Source Document in a Project Context shares its Extraction Schema.
          extractionSchema = await orm.public.ExtractionSchema.where({
            projectContextId,
          })
            .select('id')
            .orderBy([
              (schema) => schema.createdAt.desc(),
              (schema) => schema.id.desc(),
            ])
            .first()
          schemaRevision = extractionSchema
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
        }

        const reviewDecisions = extraction
          ? await orm.public.ReviewDecision.where({ extractionId: extraction.id })
              .select(
                'id',
                'evidenceAnchorId',
                'reviewedOccurrenceIds',
              )
              .orderBy((decision) => decision.id.asc())
              .all()
          : []

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
          extraction: extraction && {
            extractionId: extraction.id,
            createdAt: extraction.createdAt,
            outcome: extraction.outcome,
            modelAttribution: extraction.modelAttribution,
            resultPayload: extraction.resultPayload,
            failure: extraction.failure,
            reviewDecisions: reviewDecisions.map((decision) => ({
              reviewDecisionId: decision.id,
              evidenceAnchorId: decision.evidenceAnchorId,
              reviewedOccurrenceIds: decision.reviewedOccurrenceIds,
            })),
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
    async persistReviewedExtraction(sourceRepresentationId, input) {
      return database.transaction(async ({ orm }) => {
        const representation =
          await orm.public.SourceRepresentationRevision.select(
            'id',
            'sourceDocumentId',
          ).first({ id: sourceRepresentationId })
        if (!representation) return null
        const sourceDocument = await orm.public.SourceDocument.select(
          'projectContextId',
        ).first({ id: representation.sourceDocumentId })
        if (!sourceDocument) return null
        // The write pins the Schema Revision the Extraction actually used; the
        // head may already have advanced past it.
        const schemaRevision = await orm.public.SchemaRevision.select(
          'id',
          'extractionSchemaId',
        ).first({ id: input.schemaRevisionId })
        if (!schemaRevision) return null
        const extractionSchema = await orm.public.ExtractionSchema.select(
          'projectContextId',
        ).first({ id: schemaRevision.extractionSchemaId })
        if (
          !extractionSchema ||
          extractionSchema.projectContextId !== sourceDocument.projectContextId
        )
          return null

        const extraction = await orm.public.Extraction.create({
          schemaRevisionId: schemaRevision.id,
          sourceRepresentationRevisionId: representation.id,
          outcome: 'SUCCEEDED',
          modelAttribution: input.modelAttribution,
          resultPayload: input.resultPayload,
        })
        for (const decision of input.reviewDecisions)
          await orm.public.ReviewDecision.create({
            extractionId: extraction.id,
            evidenceAnchorId: decision.evidenceAnchorId,
            reviewedOccurrenceIds: decision.reviewedOccurrenceIds,
          })
        return { extractionId: extraction.id, createdAt: extraction.createdAt }
      })
    },
  }
}
