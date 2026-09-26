import {
  canonicalPackageStore,
  type CanonicalPackageStore,
} from '../../../packages/db/src/artifact-store.js'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { parseSchemaDefinition } from 'extraction/schema'
import {
  ApiError,
  apiErrorResponse,
  assertFormFields,
  parseFormRequest,
} from './_http.js'
import { json, parseTemperature } from './_model.js'
import {
  formContextIdentity,
  loadOwnedSchemaModelContext,
  loadOwnedSchemaRevision,
  proposeSchemaEdit,
} from './_schema_edit.js'

const FIELDS = [
  'project_context_id',
  'source_representation_revision_id',
  'extraction_schema_id',
  'schema_revision_id',
  'instruction',
  'temperature',
] as const

type EditSchemaStore = Pick<
  ResearcherProjectStore,
  'researcherAccountId' | 'getSourceRepresentation' | 'getSchemaRevision'
>

type ProposeSchemaEdit = typeof proposeSchemaEdit

export function createPostEditSchema(
  store: EditSchemaStore,
  reader: Pick<CanonicalPackageStore, 'read'> = canonicalPackageStore,
  propose: ProposeSchemaEdit = proposeSchemaEdit,
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const form = await parseFormRequest(request)
      assertFormFields(form, FIELDS)
      const instruction = form.get('instruction')
      if (typeof instruction !== 'string' || !instruction.trim())
        throw new ApiError(400, 'invalid_request', 'instruction is required')
      const projectContextId = formContextIdentity(form, 'project_context_id')
      const extractionSchemaId = formContextIdentity(
        form,
        'extraction_schema_id',
      )
      const schemaRevisionId = formContextIdentity(form, 'schema_revision_id')
      const temperature = parseTemperature(form.get('temperature'))
      const context =
        form.get('source_representation_revision_id') === null
          ? {
              revision: await loadOwnedSchemaRevision(
                store,
                projectContextId,
                extractionSchemaId,
                schemaRevisionId,
              ),
              documentMarkdown: null,
            }
          : await loadOwnedSchemaModelContext(store, reader, {
              projectContextId,
              sourceRepresentationRevisionId: formContextIdentity(
                form,
                'source_representation_revision_id',
              ),
              extractionSchemaId,
              schemaRevisionId,
            })
      const definition = parseSchemaDefinition(context.revision.schemaTree)
      return json(
        await propose(
          definition.schemaNodes,
          instruction.trim(),
          context.documentMarkdown,
          {
            temperature,
            caller: { researcherAccountId: store.researcherAccountId },
            signal: request.signal,
          },
        ),
      )
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  return { POST: createPostEditSchema(store) }
}
