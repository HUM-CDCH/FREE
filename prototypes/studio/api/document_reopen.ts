import type {
  ExtractionAttemptSnapshot,
  ExtractionModule,
} from 'extraction'
import type {
  DocumentReopenSnapshot,
  ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import {
  annotationSchema,
  canonicalUuidSchema,
  documentReopenResponseSchema,
} from '../shared/projectContext.contract.js'
import { schemaDefinitionSchema } from 'extraction/schema'
import { z } from 'zod'
import {
  createResearcherExtractions,
  extractionAttemptDto,
} from './_extractions.js'
import {
  ApiError,
  json,
  noStore,
  noStoreError,
  persistenceUnavailable,
} from './_http.js'

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

function representationResources(
  projectContextId: string,
  sourceRepresentationId: string,
  version: string,
) {
  const resource = (artifact: string) =>
    `/api/project-contexts/${projectContextId}/source-representations/${sourceRepresentationId}/${artifact}?v=${version}`
  return {
    sourcePdfUrl: resource('pdf'),
    markdownUrl: resource('markdown'),
    parsedDocumentUrl: resource('source'),
  }
}

function extractionDto(
  extraction: ExtractionAttemptSnapshot | null,
  projectContextId: string,
  resourceVersion: string,
  schema: DocumentReopenSnapshot['extractionSchema'],
) {
  if (!extraction) return null
  if (
    !schema ||
    schema.schemaRevisionId !== extraction.schemaRevisionId ||
    schema.extractionSchemaId !== extraction.extractionSchemaId
  )
    throw persistenceUnavailable(
      new Error('The stored Extraction Schema Revision could not be read.'),
      'Stored research state could not be read.',
    )
  const definition = durable(schemaDefinitionSchema, schema.schemaTree)
  return {
    ...extractionAttemptDto(extraction),
    sourceRepresentation: {
      revisionNumber: extraction.sourceRepresentationRevisionNumber,
      resources: representationResources(
        projectContextId,
        extraction.sourceRepresentationRevisionId,
        resourceVersion,
      ),
    },
    extractionSchema: {
      extractionSchemaId: extraction.extractionSchemaId,
      revisionNumber: extraction.schemaRevisionNumber,
      ...definition,
    },
  }
}

async function reopenResponse(
  snapshot: DocumentReopenSnapshot,
  documentExtractions: {
    latestAttempt: ExtractionAttemptSnapshot | null
    latestReviewed: ExtractionAttemptSnapshot | null
  },
  schemaFor: (
    extraction: ExtractionAttemptSnapshot | null,
  ) => Promise<DocumentReopenSnapshot['extractionSchema']>,
  currentSourceRepresentationId: string,
) {
  const { sourceRepresentation: representation } = snapshot
  // A local reset can recreate a seeded representation ID with new artifacts.
  const resourceVersion = encodeURIComponent(
    representation.createdAt.toISOString(),
  )
  const currentSchema = snapshot.extractionSchema
    ? durable(schemaDefinitionSchema, snapshot.extractionSchema.schemaTree)
    : null
  const [attemptSchema, reviewedSchema] = await Promise.all([
    schemaFor(documentExtractions.latestAttempt),
    schemaFor(documentExtractions.latestReviewed),
  ])
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
      current:
        representation.sourceRepresentationId === currentSourceRepresentationId,
      resources: representationResources(
        snapshot.projectContext.projectContextId,
        representation.sourceRepresentationId,
        resourceVersion,
      ),
    },
    annotationSet: snapshot.annotationSet && {
      annotationSetId: snapshot.annotationSet.annotationSetId,
      revisionNumber: snapshot.annotationSet.revisionNumber,
      annotations: durable(
        storedAnnotationsSchema,
        snapshot.annotationSet.snapshot,
      ),
    },
    extractionSchema: snapshot.extractionSchema && {
      extractionSchemaId: snapshot.extractionSchema.extractionSchemaId,
      name: snapshot.extractionSchema.name,
      schemaRevisionId: snapshot.extractionSchema.schemaRevisionId,
      revisionNumber: snapshot.extractionSchema.revisionNumber,
      ...currentSchema!,
    },
    latestAttempt: extractionDto(
      documentExtractions.latestAttempt,
      snapshot.projectContext.projectContextId,
      resourceVersion,
      attemptSchema,
    ),
    latestReviewed: extractionDto(
      documentExtractions.latestReviewed,
      snapshot.projectContext.projectContextId,
      resourceVersion,
      reviewedSchema,
    ),
  })
}

export function createGetDocumentReopen(
  store: Pick<ResearcherProjectStore, 'getDocumentReopenSnapshot'>,
  module: Pick<ExtractionModule, 'readDocumentExtractions'>,
) {
  return async function getDocumentReopen(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const match = ROUTE.exec(url.pathname)
      if (!match)
        throw new ApiError(404, 'not_found', 'API route not found.')
      const [, projectContextId, sourceDocumentId] = match
      const extractionId = url.searchParams.get('extractionId')
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

      const readExtractions = () =>
        module
          .readDocumentExtractions({
            sourceDocumentId,
            ...(extractionId ? { extractionId } : {}),
          })
          .catch((cause) => {
            throw persistenceUnavailable(cause)
          })
      const readSnapshot = (
        pins?: Parameters<
          ResearcherProjectStore['getDocumentReopenSnapshot']
        >[2],
      ) =>
        store
          .getDocumentReopenSnapshot(
            projectContextId,
            sourceDocumentId,
            pins,
          )
          .catch((cause) => {
            throw persistenceUnavailable(cause)
          })

      const currentSnapshot = await readSnapshot()
      if (!currentSnapshot)
        throw new ApiError(
          404,
          'not_found',
          'That Source Document has no durable snapshot in this Project Context.',
        )
      const selected = await readExtractions()
      if (extractionId && !selected?.latestAttempt)
        throw new ApiError(
          404,
          'not_found',
          'That Source Document has no durable snapshot in this Project Context.',
        )
      const selectedAttempt = selected?.latestAttempt ?? null
      const snapshot = selectedAttempt
        ? await readSnapshot({
            sourceRepresentationRevisionId:
              selectedAttempt.sourceRepresentationRevisionId,
            schemaRevisionId: selectedAttempt.schemaRevisionId,
          })
        : currentSnapshot
      if (!snapshot)
        throw new ApiError(
          404,
          'not_found',
          'That Source Document has no durable snapshot in this Project Context.',
        )
      const documentExtractions =
        selected ??
        (await readExtractions()) ?? {
          sourceRepresentationRevisionId:
            snapshot.sourceRepresentation.sourceRepresentationId,
          latestAttempt: null,
          latestReviewed: null,
        }
      if (
        documentExtractions.sourceRepresentationRevisionId !==
        snapshot.sourceRepresentation.sourceRepresentationId
      )
        throw persistenceUnavailable(
          new Error('The reopened Extraction pins changed during the read.'),
          'Stored research state could not be read.',
        )

      const schemas = new Map<
        string,
        Promise<DocumentReopenSnapshot['extractionSchema']>
      >()
      const schemaFor = (
        extraction: ExtractionAttemptSnapshot | null,
      ) => {
        if (!extraction) return Promise.resolve(null)
        if (
          snapshot.sourceRepresentation.sourceRepresentationId ===
            extraction.sourceRepresentationRevisionId &&
          snapshot.extractionSchema?.schemaRevisionId ===
            extraction.schemaRevisionId
        )
          return Promise.resolve(snapshot.extractionSchema)
        const existing = schemas.get(extraction.schemaRevisionId)
        if (existing) return existing
        const pending = readSnapshot({
          sourceRepresentationRevisionId:
            extraction.sourceRepresentationRevisionId,
          schemaRevisionId: extraction.schemaRevisionId,
        }).then((pinned) => pinned?.extractionSchema ?? null)
        schemas.set(extraction.schemaRevisionId, pending)
        return pending
      }

      return json(
        await reopenResponse(
          { ...snapshot, extractionSchema: currentSnapshot.extractionSchema },
          documentExtractions,
          schemaFor,
          // The unpinned read names the document's current revision.
          currentSnapshot.sourceRepresentation.sourceRepresentationId,
        ),
        { headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  return {
    GET: createGetDocumentReopen(
      store,
      createResearcherExtractions(store.researcherAccountId),
    ),
  }
}
