import type { ResearcherProjectStore, SchemaIssueFlagRecord } from '../../../packages/db/src/project-store.js'
import {
  schemaIssueFlagListResponseSchema,
  schemaIssueFlagRequestSchema,
  schemaIssueFlagResponseSchema,
} from '../shared/schemaIssueFlag.contract.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import {
  ApiError,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'

function flagDto(flag: SchemaIssueFlagRecord) {
  return {
    schemaIssueFlagId: flag.schemaIssueFlagId,
    schemaRevisionId: flag.schemaRevisionId,
    fieldPath: flag.fieldPath,
    note: flag.note,
    createdAt: flag.createdAt.toISOString(),
  }
}

export function createSchemaIssueFlagHandlers(
  store: Pick<ResearcherProjectStore, 'flagSchemaField' | 'listOpenSchemaIssueFlags'>,
) {
  const GET = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      if (url.pathname !== '/api/schema_issue_flags')
        throw new ApiError(404, 'not_found', 'Route was not found.')
      const projectContextId = url.searchParams.get('projectContextId')
      const schemaRevisionId = url.searchParams.get('schemaRevisionId')
      if (
        !projectContextId ||
        !schemaRevisionId ||
        !canonicalUuidSchema.safeParse(projectContextId).success ||
        !canonicalUuidSchema.safeParse(schemaRevisionId).success
      )
        throw new ApiError(
          422,
          'invalid_request',
          'projectContextId and schemaRevisionId must be canonical lowercase UUIDs.',
        )
      const flags = await store
        .listOpenSchemaIssueFlags(projectContextId, schemaRevisionId)
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!flags)
        throw new ApiError(404, 'not_found', 'Schema Revision was not found.')
      return json(
        schemaIssueFlagListResponseSchema.parse({ flags: flags.map(flagDto) }),
        { headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }

  const POST = async (request: Request): Promise<Response> => {
    try {
      if (new URL(request.url).pathname !== '/api/schema_issue_flags')
        throw new ApiError(404, 'not_found', 'Route was not found.')
      const parsed = schemaIssueFlagRequestSchema.safeParse(
        await parseJsonRequest(request),
      )
      if (!parsed.success)
        throw new ApiError(422, 'invalid_request', 'The flag request is invalid.')
      const { projectContextId, schemaRevisionId, fieldPath, note } = parsed.data
      const flag = await store
        .flagSchemaField(projectContextId, schemaRevisionId, fieldPath, note)
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!flag)
        throw new ApiError(404, 'not_found', 'Schema Revision was not found.')
      return json(
        schemaIssueFlagResponseSchema.parse({ flag: flagDto(flag) }),
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
): Readonly<Record<string, (request: Request) => Response | Promise<Response>>> {
  return createSchemaIssueFlagHandlers(store)
}
