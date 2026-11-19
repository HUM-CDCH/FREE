import { createDurableRepository, DurableNotFound } from 'extraction/durable'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { studioDbos } from '../server/dbos.js'
import { ApiError, apiErrorResponse, assertFormFields, json, parseFormRequest, parseTemperature } from './_http.js'
import { awaitOperation, startOrJoinOperation, type ModelOperationClient } from './_model_operation.js'
import { PROPOSE_RESULT_CORRECTIONS, type ResultCorrectionInput, type ResultCorrectionProposed } from './_result_correction_workflow.js'
import { formChatHistory, formContextIdentity } from './_schema_edit.js'

const FIELDS = ['extraction_id', 'snapshot_version', 'operation_id', 'message', 'history', 'temperature'] as const

type ResultHead = Readonly<{ projectId: string; snapshotVersion: number; feedbackVersion: number }>

/** The snapshot named, or the latest one; refused while there is none. */
function snapshotOf(form: FormData, head: ResultHead): number {
  const named = form.get('snapshot_version')
  if (named === null || named === '') {
    if (head.snapshotVersion === 0) throw new ApiError(409, 'no_results', 'This Extraction has no saved values to change yet.')
    return head.snapshotVersion
  }
  const version = typeof named === 'string' && /^\d+$/.test(named) ? Number(named) : NaN
  if (!Number.isSafeInteger(version) || version < 1 || version > head.snapshotVersion)
    throw new ApiError(422, 'invalid_request', 'snapshot_version must name a saved result snapshot.')
  return version
}

/**
 * A chat message that corrects particular values of a result, as a durable operation (ADR 0035): ownership is checked
 * here, the snapshot and decision versions pinned, and the model call runs in the `proposeResultCorrections` workflow
 * under the client-minted operation ID, so a repeated POST joins it. The reply is the proposal; nothing is saved.
 */
export function createPostResultChat(
  owner: string,
  readHead: (extractionId: string) => Promise<ResultHead> = (id) => createDurableRepository(owner).read(id),
  operations: () => ModelOperationClient = () => studioDbos().admission,
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const form = await parseFormRequest(request)
      assertFormFields(form, FIELDS)
      const message = form.get('message')
      if (typeof message !== 'string' || !message.trim())
        throw new ApiError(400, 'invalid_request', 'message is required')
      const extractionId = formContextIdentity(form, 'extraction_id')
      const operationId = formContextIdentity(form, 'operation_id')
      const head = await readHead(extractionId).catch((error: unknown) => {
        if (error instanceof DurableNotFound) throw new ApiError(404, 'not_found', 'That Extraction was not found.')
        throw error
      })
      const input: ResultCorrectionInput = {
        operationId,
        owner,
        extractionId,
        snapshotVersion: snapshotOf(form, head),
        feedbackVersion: head.feedbackVersion,
        message: message.trim(),
        history: formChatHistory(form),
        temperature: parseTemperature(form.get('temperature')) ?? null,
      }
      const workflowID = `correct:${operationId}`
      await startOrJoinOperation(operations(), {
        workflowName: PROPOSE_RESULT_CORRECTIONS,
        workflowID,
        owner,
        input,
        attributes: { projectContextId: head.projectId, extractionId },
      })
      const result = await awaitOperation<ResultCorrectionProposed>(operations(), workflowID, request.signal)
      if (!result.ok) throw new ApiError(result.status, result.code, result.message)
      return json(result.proposal)
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<Record<string, (request: Request) => Response | Promise<Response>>> {
  return { POST: createPostResultChat(store.researcherAccountId) }
}
