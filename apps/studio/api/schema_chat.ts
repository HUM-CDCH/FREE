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
import { formContextIdentity, ownedSourceScope } from './_schema_edit.js'
import { ANSWER_SCHEMA_CHAT, type SchemaChatAnswered, type SchemaChatInput } from './_schema_chat_workflow.js'

const FIELDS = [
  'project_context_id',
  'source_representation_revision_id',
  'operation_id',
  'message',
  'temperature',
] as const

type SchemaChatStore = Pick<ResearcherProjectStore, 'researcherAccountId' | 'getSourceRepresentation'>

/**
 * A chat message before the first schema as a durable operation: ownership is checked here, in PostgreSQL; the model
 * calls run in the `answerSchemaChat` workflow under the client-minted operation ID, so a repeated POST joins it. The
 * answer is the reply: a question's answer, or `instruction` for a message the page keeps for generation.
 */
export function createPostSchemaChat(
  store: SchemaChatStore,
  operations: () => ModelOperationClient = () => studioDbos().admission,
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const form = await parseFormRequest(request)
      assertFormFields(form, FIELDS)
      const message = form.get('message')
      if (typeof message !== 'string' || !message.trim())
        throw new ApiError(400, 'invalid_request', 'message is required')
      const projectContextId = formContextIdentity(form, 'project_context_id')
      const sourceRepresentationRevisionId = formContextIdentity(form, 'source_representation_revision_id')
      const operationId = formContextIdentity(form, 'operation_id')
      const temperature = parseTemperature(form.get('temperature')) ?? null
      const { sourceDocumentId } = await ownedSourceScope(store, projectContextId, sourceRepresentationRevisionId)
      const input: SchemaChatInput = {
        operationId,
        owner: store.researcherAccountId,
        projectContextId,
        sourceRepresentationRevisionId,
        message: message.trim(),
        temperature,
      }
      const workflowID = `chat:${operationId}`
      await startOrJoinOperation(operations(), {
        workflowName: ANSWER_SCHEMA_CHAT,
        workflowID,
        owner: input.owner,
        input,
        attributes: { projectContextId, sourceDocumentId, sourceRepresentationRevisionId },
      })
      const result = await awaitOperation<SchemaChatAnswered>(operations(), workflowID, request.signal)
      if (!result.ok) throw new ApiError(result.status, result.code, result.message)
      return json(result.reply)
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
  return { POST: createPostSchemaChat(store) }
}
