import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { studioDbos } from '../server/dbos.js'
import {
  ApiError,
  apiErrorResponse,
  assertFormFields,
  parseFormRequest,
} from './_http.js'
import { json, parseTemperature } from './_http.js'
import { awaitOperation, startOrJoinOperation, type ModelOperationClient } from './_model_operation.js'
import {
  formContextIdentity,
  loadOwnedSchemaRevision,
  ownedSourceScope,
} from './_schema_edit.js'
import { PROPOSE_SCHEMA_EDIT, type SchemaEditInput, type SchemaEditProposed } from './_schema_edit_workflow.js'

const FIELDS = [
  'project_context_id',
  'source_representation_revision_id',
  'extraction_schema_id',
  'schema_revision_id',
  'operation_id',
  'instruction',
  'temperature',
] as const

type EditSchemaStore = Pick<
  ResearcherProjectStore,
  'researcherAccountId' | 'getSourceRepresentation' | 'getSchemaRevision'
>

/**
 * A schema edit proposal as a durable operation: ownership is checked here, in PostgreSQL; the model calls run in the
 * `proposeSchemaEdit` workflow under the client-minted operation ID, so a repeated POST joins it and a reloaded page
 * reopens the proposal. The answer is today's SchemaEditResponse.
 */
export function createPostEditSchema(
  store: EditSchemaStore,
  operations: () => ModelOperationClient = () => studioDbos().admission,
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const form = await parseFormRequest(request)
      assertFormFields(form, FIELDS)
      const instruction = form.get('instruction')
      if (typeof instruction !== 'string' || !instruction.trim())
        throw new ApiError(400, 'invalid_request', 'instruction is required')
      const projectContextId = formContextIdentity(form, 'project_context_id')
      const extractionSchemaId = formContextIdentity(form, 'extraction_schema_id')
      const schemaRevisionId = formContextIdentity(form, 'schema_revision_id')
      const operationId = formContextIdentity(form, 'operation_id')
      const temperature = parseTemperature(form.get('temperature')) ?? null
      const sourceRepresentationRevisionId =
        form.get('source_representation_revision_id') === null ? null : formContextIdentity(form, 'source_representation_revision_id')
      await loadOwnedSchemaRevision(store, projectContextId, extractionSchemaId, schemaRevisionId)
      // A document-grounded edit also names its source; the workflow reads both outside history.
      const source = sourceRepresentationRevisionId === null
        ? null
        : { sourceRepresentationRevisionId, ...(await ownedSourceScope(store, projectContextId, sourceRepresentationRevisionId)) }
      const input: SchemaEditInput = {
        operationId,
        owner: store.researcherAccountId,
        projectContextId,
        extractionSchemaId,
        baseSchemaRevisionId: schemaRevisionId,
        sourceRepresentationRevisionId,
        instruction: instruction.trim(),
        temperature,
      }
      const workflowID = `edit:${operationId}`
      await startOrJoinOperation(operations(), {
        workflowName: PROPOSE_SCHEMA_EDIT,
        workflowID,
        owner: input.owner,
        input,
        attributes: { projectContextId, extractionSchemaId, ...(source ?? {}) },
      })
      const result = await awaitOperation<SchemaEditProposed>(operations(), workflowID, request.signal)
      if (!result.ok) throw new ApiError(result.status, result.code, result.message)
      return json(result.response)
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
