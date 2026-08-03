import { ApiError, apiErrorResponse, json } from './_http.js'
import {
  createProjectStore,
  type ProjectStore,
} from '../../../packages/db/src/project-store.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'

const noStore = { 'Cache-Control': 'no-store' }

function unavailable(cause: unknown): ApiError {
  return new ApiError(
    503,
    'persistence_unavailable',
    'Project Context storage is unavailable.',
    { cause },
  )
}

function limit(url: URL): number {
  const value = url.searchParams.get('limit') ?? '20'
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value))
    throw new ApiError(
      422,
      'invalid_request',
      'limit must be an integer from 1 to 50.',
    )
  return Number(value)
}

function projectId(pathname: string): string | null {
  const match = /^\/api\/project-contexts\/([^/]+)$/.exec(pathname)
  return match?.[1] ?? null
}

export function createGetProjectContexts(
  store: ProjectStore = createProjectStore(),
) {
  return async function getProjectContexts(
    request: Request,
  ): Promise<Response> {
    try {
      const url = new URL(request.url)
      const id = projectId(url.pathname)
      if (id === null) {
        const projectContexts = await store
          .listProjectContexts(limit(url))
          .catch((cause) => {
            throw unavailable(cause)
          })
        return json({ projectContexts }, { headers: noStore })
      }
      if (!canonicalUuidSchema.safeParse(id).success)
        throw new ApiError(
          422,
          'invalid_request',
          'projectContextId must be a canonical lowercase UUID.',
        )
      const projectContext = await store
        .getProjectContextWithDocuments(id)
        .catch((cause) => {
          throw unavailable(cause)
        })
      if (!projectContext)
        throw new ApiError(404, 'not_found', 'Project Context was not found.')
      return json(projectContext, { headers: noStore })
    } catch (error) {
      const response = apiErrorResponse(error)
      response.headers.set('Cache-Control', 'no-store')
      return response
    }
  }
}

export const GET = createGetProjectContexts()
