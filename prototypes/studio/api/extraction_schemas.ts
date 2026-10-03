import {
  EXTRACTION_SCHEMA_NAME_LIMIT,
  type ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import {
  extractionSchemaNameLimit,
  extractionSchemaResponseSchema,
  extractionSchemaWriteRequestSchema,
} from '../shared/schemaRevision.contract.js'
import {
  ApiError,
  boundedLimit,
  json,
  noStore,
  noStoreError,
  persistenceUnavailable,
  parseJsonRequest,
} from './_http.js'

const ITEM_ROUTE = /^\/api\/extraction-schemas\/([^/]+)$/

export function createGetExtractionSchemas(
  store: Pick<ResearcherProjectStore, 'listExtractionSchemas'>,
) {
  return async function GET(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.pathname !== '/api/extraction-schemas')
        throw new ApiError(
          404,
          'not_found',
          'Extraction Schema route was not found.',
        )
      const projectContextId = url.searchParams.get('projectContextId')
      if (!projectContextId || !canonicalUuidSchema.safeParse(projectContextId).success)
        throw new ApiError(
          422,
          'invalid_request',
          'projectContextId must be a canonical lowercase UUID.',
        )
      const extractionSchemas = await store
        .listExtractionSchemas(projectContextId, boundedLimit(url))
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!extractionSchemas)
        throw new ApiError(404, 'not_found', 'Project Context was not found.')
      return json(
        {
          extractionSchemas: extractionSchemas.map((schema) => ({
            ...schema,
            createdAt: schema.createdAt.toISOString(),
            currentRevision: schema.currentRevision && {
              ...schema.currentRevision,
              createdAt: schema.currentRevision.createdAt.toISOString(),
            },
          })),
        },
        { headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export function createPatchExtractionSchema(
  store: Pick<ResearcherProjectStore, 'renameExtractionSchema'>,
) {
  return async function PATCH(request: Request): Promise<Response> {
    try {
      const match = ITEM_ROUTE.exec(new URL(request.url).pathname)
      if (!match)
        throw new ApiError(404, 'not_found', 'Extraction Schema route was not found.')
      const parsed = extractionSchemaWriteRequestSchema.safeParse(
        await parseJsonRequest(request),
      )
      if (
        !canonicalUuidSchema.safeParse(match[1]).success ||
        !parsed.success
      )
        throw new ApiError(
          422,
          'invalid_request',
          `projectContextId and extractionSchemaId must be canonical lowercase UUIDs, and name must be 1 to ${extractionSchemaNameLimit} characters after trimming.`,
        )
      const schema = await store
        .renameExtractionSchema(
          parsed.data.projectContextId,
          match[1],
          parsed.data.name,
          parsed.data.expectedName,
        )
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!schema)
        throw new ApiError(404, 'not_found', 'Extraction Schema was not found.')
      return json(
        extractionSchemaResponseSchema.parse({
          extractionSchema: {
            ...schema,
            createdAt: schema.createdAt.toISOString(),
          },
        }),
        { headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
}

if (extractionSchemaNameLimit !== EXTRACTION_SCHEMA_NAME_LIMIT)
  throw new Error('Extraction Schema name limits must match.')

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  return {
    GET: createGetExtractionSchemas(store),
    PATCH: createPatchExtractionSchema(store),
  }
}
