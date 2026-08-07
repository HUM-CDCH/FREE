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
  reviewDecisionSchema,
} from '../shared/projectContext.contract.js'
import { z } from 'zod'

const ROUTE =
  /^\/api\/project-contexts\/([^/]+)\/source-documents\/([^/]+)\/reopen$/

// `strip` so a persisted Annotation carrying more than Studio reopens is
// projected down to the browser contract rather than rejected.
const storedAnnotationsSchema = z.array(annotationSchema.strip())
const resultPayloadSchema = z.object({
  result: z.json(),
  evidence: z.json().nullable().default(null),
})
const failureSchema = z.object({ code: z.string(), message: z.string() })

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

function extractionDto(extraction: DocumentReopenSnapshot['extraction']) {
  if (!extraction) return null
  const identity = {
    extractionId: extraction.extractionId,
    createdAt: extraction.createdAt.toISOString(),
  }
  if (extraction.outcome === 'CANCELLED')
    return { ...identity, outcome: 'cancelled' as const }
  if (extraction.outcome === 'FAILED')
    return {
      ...identity,
      outcome: 'failed' as const,
      failure: durable(failureSchema, extraction.failure),
    }
  return {
    ...identity,
    outcome: 'succeeded' as const,
    ...durable(resultPayloadSchema, extraction.resultPayload),
    reviewDecisions: extraction.reviewDecisions.map((decision) =>
      durable(reviewDecisionSchema, {
        reviewDecisionId: decision.reviewDecisionId,
        evidenceAnchorId: decision.evidenceAnchorId,
        reviewedOccurrenceIds: decision.reviewedOccurrenceIds,
      }),
    ),
  }
}

/**
 * The browser contract: public identities, RFC 3339 timestamps, and same-origin
 * resources. Artifact references, hashes, and Parsing Service identities stay
 * server-side.
 */
function reopenResponse(snapshot: DocumentReopenSnapshot) {
  const { sourceRepresentation: representation } = snapshot
  const resource = (artifact: string) =>
    `/api/source-representations/${representation.sourceRepresentationId}/${artifact}`
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
      resources: {
        sourcePdfUrl: resource('pdf'),
        markdownUrl: resource('markdown'),
        parsedDocumentUrl: resource('parsed-document'),
      },
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
        revisionNumber: snapshot.extractionSchema.revisionNumber,
        template: snapshot.extractionSchema.schemaTree,
      },
    extraction: extractionDto(snapshot.extraction),
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
      if (
        !canonicalUuidSchema.safeParse(projectContextId).success ||
        !canonicalUuidSchema.safeParse(sourceDocumentId).success
      )
        throw new ApiError(
          422,
          'invalid_request',
          'Identities must be canonical lowercase UUIDs.',
        )

      const snapshot = await store
        .getDocumentReopenSnapshot(projectContextId, sourceDocumentId)
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
      return noStoreError(error)
    }
  }
}

export const GET = createGetDocumentReopen()
