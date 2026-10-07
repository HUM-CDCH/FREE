import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { studioDbos } from '../server/dbos.js'
import {
  ApiError,
  apiErrorResponse,
  assertFormFields,
  parseFormRequest,
} from './_http.js'
import { parseInstruction } from './_document.js'
import { json, parseTemperature } from './_http.js'
import { awaitOperation, startOrJoinOperation, type ModelOperationClient } from './_model_operation.js'
import {
  formContextIdentity,
  loadOwnedSchemaRevision,
  optionalSchemaBase,
  ownedSourceScope,
} from './_schema_edit.js'
import { SUGGEST_SCHEMA, type SchemaGenerated, type SchemaGenerationInput } from './_schema_generation_workflow.js'

const FIELDS = [
  'project_context_id',
  'source_representation_revision_id',
  'extraction_schema_id',
  'base_schema_revision_id',
  'operation_id',
  'instruction',
  'temperature',
] as const

type GenerateSchemaStore = Pick<
  ResearcherProjectStore,
  'researcherAccountId' | 'getSourceRepresentation' | 'getSchemaRevision'
>

/**
 * Schema Suggestion as a durable operation: the owner check runs here, in PostgreSQL; the model call runs in the
 * `suggestSchema` workflow under the client-minted operation ID, so a repeated POST joins it and a reloaded page finds
 * it. The answer is today's body.
 */
export function createPostGenerateSchema(
  store: GenerateSchemaStore,
  operations: () => ModelOperationClient = () => studioDbos().admission,
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const form = await parseFormRequest(request)
      assertFormFields(form, FIELDS)
      const projectContextId = formContextIdentity(form, 'project_context_id')
      const sourceRepresentationRevisionId = formContextIdentity(form, 'source_representation_revision_id')
      const operationId = formContextIdentity(form, 'operation_id')
      const base = optionalSchemaBase(form)
      const instruction = parseInstruction(form.get('instruction'))
      const temperature = parseTemperature(form.get('temperature')) ?? null
      const { sourceDocumentId } = await ownedSourceScope(store, projectContextId, sourceRepresentationRevisionId)
      if (base) await loadOwnedSchemaRevision(store, projectContextId, base.extractionSchemaId, base.schemaRevisionId)
      const input: SchemaGenerationInput = {
        operationId,
        owner: store.researcherAccountId,
        projectContextId,
        sourceRepresentationRevisionId,
        extractionSchemaId: base?.extractionSchemaId ?? null,
        baseSchemaRevisionId: base?.schemaRevisionId ?? null,
        instruction,
        temperature,
      }
      const workflowID = `suggestion:${operationId}`
      await startOrJoinOperation(operations(), {
        workflowName: SUGGEST_SCHEMA,
        workflowID,
        owner: input.owner,
        input,
        // extractionSchemaId is recorded even when null, so the listing finds a first generation (JSONB containment).
        attributes: { projectContextId, sourceDocumentId, sourceRepresentationRevisionId, extractionSchemaId: input.extractionSchemaId },
      })
      const result = await awaitOperation<SchemaGenerated>(operations(), workflowID, request.signal)
      if (!result.ok) throw new ApiError(result.status, result.code, result.message)
      return json({ template: result.template, raw: result.raw, pages: result.pages, sourceCoverage: result.sourceCoverage ?? null })
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
  return { POST: createPostGenerateSchema(store) }
}
