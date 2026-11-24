import { DBOS } from '@dbos-inc/dbos-sdk'
import { createInternalProjectWorkerStore } from 'db'
import { createDurableRepository, DurableInvalid, DurableNotFound } from 'extraction/durable'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import { persistenceUnavailable } from './_http.js'
import { operationFailureOf, type OperationResult } from './_model_operation.js'
import type { CorrectableValue, proposeResultCorrections, ResultToCorrect } from './_result_correction.js'
import { modelStep, StepFailure } from './_schema_generation_workflow.js'
import type { ResultCorrectionProposal } from '../shared/resultCorrection.contract.js'
import type { ChatHistory } from '../shared/schemaChat.contract.js'

export const PROPOSE_RESULT_CORRECTIONS = 'proposeResultCorrections'

/** IDs, the pinned versions, the message and the temperature only: never the document or the values (spec, *What DBOS
 *  history holds*). The snapshot and decision versions are pinned when the operation starts, so a replay reads the
 *  values the first run read. */
export type ResultCorrectionInput = Readonly<{
  operationId: string
  owner: string
  extractionId: string
  snapshotVersion: number
  feedbackVersion: number
  message: string
  history: ChatHistory
  temperature: number | null
}>
export type ResultCorrectionProposed = { proposal: ResultCorrectionProposal }

export type ResultCorrectionPorts = Readonly<{
  steps: WorkflowSteps
  readResult(input: ResultCorrectionInput): Promise<ResultToCorrect>
  propose: typeof proposeResultCorrections
}>

/** The pinned result's values, every page of them, and its pinned source's Markdown. */
export async function readResultToCorrect({ owner, extractionId, snapshotVersion, feedbackVersion }: ResultCorrectionInput): Promise<ResultToCorrect> {
  const repository = createDurableRepository(owner)
  const head = await repository.read(extractionId)
  const values: CorrectableValue[] = []
  let page = await repository.page(extractionId, { snapshotVersion, feedbackVersion, offset: 0, limit: 500 })
  values.push(...page.values)
  while (page.next) {
    page = await repository.page(extractionId, page.next)
    values.push(...page.values)
  }
  const markdown = await createInternalProjectWorkerStore().readRevisionMarkdown(head.sourceRevisionId)
  if (markdown === null) throw new DurableInvalid('The pinned source is unavailable.')
  return { extractionId, snapshotVersion, values, markdown }
}

/**
 * `proposeResultCorrections(input)`: a chat message that corrects particular values of a result (ADR 0035). The values
 * are read outside any step, at the pinned versions; one step asks the model for the changes. Nothing is saved: the
 * researcher applies the proposal through Results' own correction save.
 */
export async function proposeResultCorrectionsWorkflow(
  input: ResultCorrectionInput,
  ports: ResultCorrectionPorts,
): Promise<OperationResult<ResultCorrectionProposed>> {
  let result: ResultToCorrect
  try {
    result = await ports.readResult(input)
  } catch (cause) {
    if (cause instanceof DurableNotFound) return { ok: false, status: 404, code: 'not_found', message: cause.message }
    if (cause instanceof DurableInvalid) return { ok: false, status: 422, code: 'invalid_request', message: cause.message }
    return { ok: false, ...operationFailureOf(persistenceUnavailable(cause, 'The results are unavailable.')) }
  }
  try {
    const proposal = await modelStep(ports.steps, 'proposeCorrections', (signal) =>
      ports.propose({ researcherAccountId: input.owner }, result, { message: input.message, history: input.history },
        { ...(input.temperature === null ? {} : { temperature: input.temperature }), signal }))
    return { ok: true, proposal }
  } catch (error) {
    if (error instanceof StepFailure) return { ok: false, ...error.failure }
    throw error
  }
}

export function registerResultCorrectionWorkflow(ports: () => ResultCorrectionPorts): void {
  DBOS.registerWorkflow(async (input: ResultCorrectionInput) => proposeResultCorrectionsWorkflow(input, ports()),
    { name: PROPOSE_RESULT_CORRECTIONS })
}
