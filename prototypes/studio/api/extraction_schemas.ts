import {
  createProjectStore,
  type ProjectStore,
} from '../../../packages/db/src/project-store.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import {
  ApiError,
  boundedLimit,
  json,
  noStore,
  noStoreError,
  persistenceUnavailable,
} from './_http.js'

export function createGetExtractionSchemas(
  store: Pick<ProjectStore, 'listExtractionSchemas'> = createProjectStore(),
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

export const GET = createGetExtractionSchemas()
