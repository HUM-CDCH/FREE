import {
  ApiError,
  noStoreError,
  json,
  noStore,
  persistenceUnavailable,
} from './_http.js'
import {
  createProjectStore,
  type DocumentReopenSnapshot,
  type ProjectStore,
} from '../../../packages/db/src/project-store.js'
import {
  annotationSchema,
  canonicalUuidSchema,
  documentReopenResponseSchema,
} from '../shared/projectContext.contract.js'
import {
  evidenceLinksHaveUniqueScalarPaths,
} from '../shared/groundedExtraction.js'
import { extractionAttemptSchema } from '../shared/extraction.contract.js'
import { schemaDefinitionSchema } from '../shared/schemaNode.js'
import { z } from 'zod'

const ROUTE =
  /^\/api\/project-contexts\/([^/]+)\/source-documents\/([^/]+)\/reopen$/

// `strip` so a persisted Annotation carrying more than Studio reopens is
// projected down to the browser contract rather than rejected.
const storedAnnotationsSchema = z.array(annotationSchema.strip())

/** Durable state that cannot be projected is unreadable, not silently rewritten. */
function durable<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw persistenceUnavailable(
      parsed.error,
      'Stored research state could not be read.',
    )
  return parsed.data
}

function extractionDto(
  extraction: DocumentReopenSnapshot['latestAttempt'],
  resourceVersion: string,
) {
  if (!extraction) return null
  const attempt = durable(extractionAttemptSchema, {
    extractionId: extraction.extractionId,
    sourceDocumentId: extraction.sourceDocumentId,
    sourceRepresentationRevisionId:
      extraction.sourceRepresentationRevisionId,
    schemaRevisionId: extraction.schemaRevisionId,
    strategy: extraction.strategy,
    outcome: extraction.outcome,
    complete: extraction.complete,
    modelAttribution: extraction.modelAttribution,
    diagnostics: extraction.diagnostics,
    failure: extraction.failure,
    resultPayload: extraction.resultPayload,
    evidenceLinks: extraction.evidenceLinks,
    reviewable: extraction.reviewable,
    retryOfId: extraction.retryOfId,
    batchExtractionId: extraction.batchExtractionId,
    createdAt: extraction.createdAt.toISOString(),
    reviewedAt: extraction.reviewedAt?.toISOString() ?? null,
    reviewDecisions: extraction.reviewDecisions.map((decision) => ({
      reviewDecisionId: decision.reviewDecisionId,
      evidenceAnchorId: decision.evidenceAnchorId,
      reviewedOccurrenceIds: decision.reviewedOccurrenceIds,
    })),
  })
  if (
    attempt.resultPayload &&
    attempt.evidenceLinks &&
    !evidenceLinksHaveUniqueScalarPaths(
      attempt.resultPayload,
      attempt.evidenceLinks,
    )
  )
    throw persistenceUnavailable(
      new Error('The stored Extraction has invalid Evidence link paths.'),
      'Stored research state could not be read.',
    )
  const linkedAnchors = new Set(
    attempt.evidenceLinks?.map((link) => link.evidenceAnchorId) ?? [],
  )
  const reviewedAnchors = new Set(
    attempt.reviewDecisions.map((decision) => decision.evidenceAnchorId),
  )
  if (
    reviewedAnchors.size !== attempt.reviewDecisions.length ||
    (attempt.reviewedAt === null && reviewedAnchors.size > 0) ||
    (attempt.reviewedAt !== null &&
      (linkedAnchors.size !== reviewedAnchors.size ||
        [...linkedAnchors].some((anchorId) => !reviewedAnchors.has(anchorId))))
  )
    throw persistenceUnavailable(
      new Error('The stored Extraction has incomplete Review Decisions.'),
      'Stored research state could not be read.',
    )
  const schema = durable(schemaDefinitionSchema, extraction.schemaTree)
  return {
    ...attempt,
    sourceRepresentation: {
      revisionNumber: extraction.sourceRepresentationRevisionNumber,
      resources: representationResources(
        extraction.sourceRepresentationRevisionId,
        resourceVersion,
      ),
    },
    extractionSchema: {
      extractionSchemaId: extraction.extractionSchemaId,
      revisionNumber: extraction.schemaRevisionNumber,
      ...schema,
    },
  }
}

function representationResources(
  sourceRepresentationId: string,
  version: string,
) {
  const resource = (artifact: string) =>
    `/api/source-representations/${sourceRepresentationId}/${artifact}?v=${version}`
  return {
    sourcePdfUrl: resource('pdf'),
    markdownUrl: resource('markdown'),
    parsedDocumentUrl: resource('source'),
  }
}

/**
 * The browser contract: public identities, RFC 3339 timestamps, and same-origin
 * resources. Artifact references, hashes, and Parsing Service identities stay
 * server-side.
 */
function reopenResponse(snapshot: DocumentReopenSnapshot) {
  const { sourceRepresentation: representation } = snapshot
  // A local reset can recreate a seeded representation ID with new artifacts.
  const resourceVersion = encodeURIComponent(representation.createdAt.toISOString())
  const currentSchema = snapshot.extractionSchema
    ? durable(schemaDefinitionSchema, snapshot.extractionSchema.schemaTree)
    : null
  return documentReopenResponseSchema.parse({
    projectContext: {
      ...snapshot.projectContext,
      createdAt: snapshot.projectContext.createdAt.toISOString(),
    },
    sourceDocument: {
      ...snapshot.sourceDocument,
      createdAt: snapshot.sourceDocument.createdAt.toISOString(),
    },
    sourceRepresentation: {
      sourceRepresentationId: representation.sourceRepresentationId,
      revisionNumber: representation.revisionNumber,
      resources: representationResources(
        representation.sourceRepresentationId,
        resourceVersion,
      ),
    },
    annotationSet:
      snapshot.annotationSet &&
      {
        annotationSetId: snapshot.annotationSet.annotationSetId,
        revisionNumber: snapshot.annotationSet.revisionNumber,
        annotations: durable(
          storedAnnotationsSchema,
          snapshot.annotationSet.snapshot,
        ),
      },
    extractionSchema:
      snapshot.extractionSchema &&
      {
        extractionSchemaId: snapshot.extractionSchema.extractionSchemaId,
        schemaRevisionId: snapshot.extractionSchema.schemaRevisionId,
        revisionNumber: snapshot.extractionSchema.revisionNumber,
        ...currentSchema!,
      },
    latestAttempt: extractionDto(snapshot.latestAttempt, resourceVersion),
    latestReviewed: extractionDto(snapshot.latestReviewed, resourceVersion),
  })
}

export function createGetDocumentReopen(
  store: Pick<ProjectStore, 'getDocumentReopenSnapshot'> = createProjectStore(),
) {
  return async function getDocumentReopen(request: Request): Promise<Response> {
    try {
      const match = ROUTE.exec(new URL(request.url).pathname)
      if (!match)
        throw new ApiError(404, 'not_found', 'API route not found.')
      const [, projectContextId, sourceDocumentId] = match
      const extractionId = new URL(request.url).searchParams.get('extractionId')
      if (
        !canonicalUuidSchema.safeParse(projectContextId).success ||
        !canonicalUuidSchema.safeParse(sourceDocumentId).success ||
        (extractionId !== null &&
          !canonicalUuidSchema.safeParse(extractionId).success)
      )
        throw new ApiError(
          422,
          'invalid_request',
          'Identities must be canonical lowercase UUIDs.',
        )

      const snapshot = await store
        .getDocumentReopenSnapshot(
          projectContextId,
          sourceDocumentId,
          extractionId ?? undefined,
        )
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!snapshot)
        throw new ApiError(
          404,
          'not_found',
          'That Source Document has no durable snapshot in this Project Context.',
        )
      return json(reopenResponse(snapshot), { headers: noStore })
    } catch (error) {
      console.error('DEBUG document_reopen error', error)
      return noStoreError(error)
    }
  }
}

export const GET = createGetDocumentReopen()
