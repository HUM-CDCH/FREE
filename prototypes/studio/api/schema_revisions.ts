import type {
  ResearcherProjectStore,
  SchemaRevisionRecord,
} from '../../../packages/db/src/project-store.js'
import { schemaRevisionWriteRequestSchema } from '../shared/schemaRevision.contract.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { savedSchemaDefinition } from 'extraction/schema'
import { summarizeSchemaRevision } from '../shared/schemaChanges.js'
import {
  ApiError,
  boundedLimit,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'

function revisionId(pathname: string): string | null {
  return /^\/api\/schema-revisions\/([^/]+)$/.exec(pathname)?.[1] ?? null
}

function identity(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (!value || !canonicalUuidSchema.safeParse(value).success)
    throw new ApiError(
      422,
      'invalid_request',
      `${name} must be a canonical lowercase UUID.`,
    )
  return value
}

function revisionDto(revision: SchemaRevisionRecord) {
  // The stored tree with its revision's record scope beside it: the definition as every boundary reads it.
  const definition = savedSchemaDefinition(revision.schemaTree, revision.recordScope)
  return {
    schemaRevisionId: revision.schemaRevisionId,
    extractionSchemaId: revision.extractionSchemaId,
    revisionNumber: revision.revisionNumber,
    origin: revision.origin,
    createdAt: revision.createdAt.toISOString(),
    ...definition,
  }
}

export function createSchemaRevisionHandlers(
  store: Pick<
    ResearcherProjectStore,
    | 'initializeSchemaRevision'
    | 'appendSchemaRevision'
    | 'listSchemaRevisions'
    | 'getSchemaRevision'
  >,
) {
  const GET = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      const projectContextId = identity(url, 'projectContextId')
      const extractionSchemaId = identity(url, 'extractionSchemaId')
      const selectedRevisionId = revisionId(url.pathname)
      if (selectedRevisionId) {
        if (!canonicalUuidSchema.safeParse(selectedRevisionId).success)
          throw new ApiError(
            422,
            'invalid_request',
            'schemaRevisionId must be a canonical lowercase UUID.',
          )
        const revision = await store
          .getSchemaRevision(
            projectContextId,
            extractionSchemaId,
            selectedRevisionId,
          )
          .catch((cause) => {
            throw persistenceUnavailable(cause)
          })
        if (!revision)
          throw new ApiError(
            404,
            'not_found',
            'Schema Revision was not found.',
          )
        return json({ revision: revisionDto(revision) }, { headers: noStore })
      }
      if (url.pathname !== '/api/schema-revisions')
        throw new ApiError(404, 'not_found', 'Schema Revision route was not found.')
      const requestedLimit = boundedLimit(url)
      const revisions = await store
        .listSchemaRevisions(
          projectContextId,
          extractionSchemaId,
          requestedLimit + 1,
        )
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!revisions)
        throw new ApiError(
          404,
          'not_found',
          'Extraction Schema was not found.',
        )
      return json(
        {
          revisions: revisions.slice(0, requestedLimit).map((revision, index) => {
            const previous = revisions[index + 1]
            return {
              schemaRevisionId: revision.schemaRevisionId,
              extractionSchemaId: revision.extractionSchemaId,
              revisionNumber: revision.revisionNumber,
              origin: revision.origin,
              createdAt: revision.createdAt.toISOString(),
              recordScope: revision.recordScope,
              summary: summarizeSchemaRevision(
                previous ? savedSchemaDefinition(previous.schemaTree, previous.recordScope) : null,
                savedSchemaDefinition(revision.schemaTree, revision.recordScope),
              ),
            }
          }),
        },
        { headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }

  const POST = async (request: Request): Promise<Response> => {
    try {
      if (new URL(request.url).pathname !== '/api/schema-revisions')
        throw new ApiError(404, 'not_found', 'Schema Revision route was not found.')
      const parsed = schemaRevisionWriteRequestSchema.safeParse(
        await parseJsonRequest(request),
      )
      if (!parsed.success)
        throw new ApiError(
          422,
          'invalid_request',
          'Schema Revision request is invalid.',
        )
      const input = parsed.data
      // Omitted, an append inherits its head's record scope and an initialization declares none.
      const recordScope = input.recordScope === undefined ? [] : [input.recordScope] as const
      const result = await ('extractionSchemaId' in input
        ? store.appendSchemaRevision(
            input.projectContextId,
            input.extractionSchemaId,
            input.expectedRevisionNumber,
            {
              recordDescription: input.recordDescription,
              schemaNodes: input.schemaNodes,
            },
            input.sourceCoverage,
            ...recordScope,
          )
        : store.initializeSchemaRevision(
            input.projectContextId,
            {
              recordDescription: input.recordDescription,
              schemaNodes: input.schemaNodes,
            },
            input.sourceCoverage ?? null,
            ...recordScope,
          ))
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!result)
        throw new ApiError(
          404,
          'not_found',
          'Project Context or Extraction Schema was not found.',
        )
      if (result.status === 'conflict')
        throw new ApiError(
          409,
          'revision_conflict',
          'The Current Schema Revision has changed.',
          { details: { currentRevision: revisionDto(result.currentRevision) } },
        )
      return json(
        { revision: revisionDto(result.revision) },
        { status: 201, headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }

  return { GET, POST }
}

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  return createSchemaRevisionHandlers(store)
}
