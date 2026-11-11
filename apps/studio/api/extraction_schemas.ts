import {
  EXTRACTION_SCHEMA_INITIAL_NAME,
  EXTRACTION_SCHEMA_NAME_LIMIT,
  type ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import {
  extractionSchemaCreateRequestSchema,
  extractionSchemaInitialName,
  extractionSchemaNameLimit,
  extractionSchemaResponseSchema,
  extractionSchemaWriteRequestSchema,
} from '../shared/schemaRevision.contract.js'
import { revisionDto } from './schema_revisions.js'
import {
  ApiError,
  boundedLimit,
  json,
  noStore,
  noStoreError,
  persistenceUnavailable,
  parseJsonRequest,
} from './_http.js'
import type { ModelOperationClient } from './_model_operation.js'
import { studioDbos } from '../server/dbos.js'

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
          `projectContextId and extractionSchemaId must be canonical lowercase UUIDs, and name, and expectedName when given, must be 1 to ${extractionSchemaNameLimit} characters after trimming.`,
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

/**
 * The project's finished first generations: they were recorded on no schema, so they outlive every schema they made,
 * and the schema panel saves the newest one again whenever the project has no schema. Once a schema has existed each
 * has been saved or dropped, so deleting a schema deletes them, and opening a document does not bring the deleted
 * schema back. A first generation still running is left to finish.
 */
async function deleteFinishedFirstGenerations(
  client: ModelOperationClient,
  researcherAccountId: string,
  projectContextId: string,
): Promise<void> {
  const finished = await client.listWorkflows({
    workflow_id_prefix: 'suggestion:',
    // An explicit null matches only a first generation's recorded null (JSONB containment).
    attributes: { projectContextId, extractionSchemaId: null },
    authenticatedUser: researcherAccountId,
    status: 'SUCCESS',
    loadInput: false,
    loadOutput: false,
  })
  if (finished.length > 0)
    await client.deleteWorkflows(finished.map((status) => status.workflowID))
}

export function createDeleteExtractionSchema(
  store: Pick<
    ResearcherProjectStore,
    'researcherAccountId' | 'deleteExtractionSchema' | 'modelOperationScopeExists'
  >,
  operations: () => ModelOperationClient = () => studioDbos().admission,
) {
  return async function DELETE(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const match = ITEM_ROUTE.exec(url.pathname)
      const projectContextId = url.searchParams.get('projectContextId')
      if (
        !match ||
        !canonicalUuidSchema.safeParse(match[1]).success ||
        !projectContextId ||
        !canonicalUuidSchema.safeParse(projectContextId).success
      )
        throw new ApiError(
          422,
          'invalid_request',
          'projectContextId and extractionSchemaId must be canonical lowercase UUIDs.',
        )
      const force = url.searchParams.get('force') === 'true'
      // Only an owned schema clears the project's workflows; they go first, so a schema is never deleted with them left.
      const owned = await store
        .modelOperationScopeExists(projectContextId, match[1])
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!owned)
        throw new ApiError(404, 'not_found', 'Extraction Schema was not found.')
      await deleteFinishedFirstGenerations(
        operations(),
        store.researcherAccountId,
        projectContextId,
      ).catch((cause) => {
        throw persistenceUnavailable(cause, 'Model operations are unavailable.')
      })
      const result = await store
        .deleteExtractionSchema(projectContextId, match[1], force)
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!result)
        throw new ApiError(404, 'not_found', 'Extraction Schema was not found.')
      if (result.status === 'has_extractions')
        throw new ApiError(
          409,
          'extraction_schema_has_extractions',
          'Delete every Extraction run against this Extraction Schema before deleting it.',
        )
      return new Response(null, { status: 204, headers: noStore })
    } catch (error) {
      return noStoreError(error)
    }
  }
}

if (extractionSchemaNameLimit !== EXTRACTION_SCHEMA_NAME_LIMIT)
  throw new Error('Extraction Schema name limits must match.')
if (extractionSchemaInitialName !== EXTRACTION_SCHEMA_INITIAL_NAME)
  throw new Error('Extraction Schema initial names must match.')

/** Creates an Extraction Schema beside the project's others, as an import starts one. */
export function createPostExtractionSchema(
  store: Pick<ResearcherProjectStore, 'createExtractionSchema'>,
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname !== '/api/extraction-schemas')
        throw new ApiError(404, 'not_found', 'Extraction Schema route was not found.')
      const parsed = extractionSchemaCreateRequestSchema.safeParse(await parseJsonRequest(request))
      if (!parsed.success)
        throw new ApiError(422, 'invalid_request', 'Extraction Schema request is invalid.')
      const { projectContextId, name, ...definition } = parsed.data
      const revision = await store
        .createExtractionSchema(projectContextId, definition, name)
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!revision) throw new ApiError(404, 'not_found', 'Project Context was not found.')
      return json({ revision: revisionDto(revision) }, { status: 201, headers: noStore })
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
    GET: createGetExtractionSchemas(store),
    POST: createPostExtractionSchema(store),
    PATCH: createPatchExtractionSchema(store),
    DELETE: createDeleteExtractionSchema(store),
  }
}
