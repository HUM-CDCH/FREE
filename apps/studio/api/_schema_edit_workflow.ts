import { DBOS } from '@dbos-inc/dbos-sdk'
import type { SchemaSource } from 'db'
import { parseSchemaDefinition } from 'extraction/schema'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import type { SchemaEditResponse } from '../shared/schemaEdit.contract.js'
import { persistenceUnavailable } from './_http.js'
import { MODEL_OPERATION_TIMEOUT_MS, operationFailureOf, type OperationResult } from './_model_operation.js'
import { schemaChatContext, type proposeSchemaEdit } from './_schema_edit.js'
import type { generateSchemaWithModel } from './_schema_suggestion.js'
import type { respondToSchemaEdit } from './_schema_chat.js'
import { answeredFromExcerpts, answerFromWindows, SCHEMA_CHAT_ANSWERS, type WindowAnswerPorts } from './_schema_chat_workflow.js'
import { StepFailure } from './_schema_generation_workflow.js'

export const PROPOSE_SCHEMA_EDIT = 'proposeSchemaEdit'

/** IDs, the instruction and the temperature only: never the schema tree, the document or a key. */
export type SchemaEditInput = Readonly<{
  operationId: string
  owner: string
  projectContextId: string
  extractionSchemaId: string
  /** The revision the proposal applies to; a reloaded page reopens it only onto this revision (spec, *Edit proposals*). */
  baseSchemaRevisionId: string
  /** Null for a schema-only edit. */
  sourceRepresentationRevisionId: string | null
  instruction: string
  temperature: number | null
}>
export type SchemaEditProposed = { baseSchemaRevisionId: string; response: SchemaEditResponse }
export type SchemaEditPorts = Readonly<{
  steps: WorkflowSteps
  readSchemaTree(extractionSchemaId: string, schemaRevisionId: string): Promise<unknown | null>
  readSource(sourceRepresentationRevisionId: string): Promise<SchemaSource | null>
  propose: typeof proposeSchemaEdit
  generate: typeof generateSchemaWithModel
  /** Past `SCHEMA_CHAT_ANSWERS`: the chat reply that may answer a question, and the window answers of a long source. */
  respond?: typeof respondToSchemaEdit
  answerWindow?: WindowAnswerPorts['answerWindow']
  combineAnswers?: WindowAnswerPorts['combineAnswers']
  /** `DBOS.patch`: whether this run takes the patched step sequence; absent, it never does. */
  patched?(name: string): Promise<boolean>
}>

/** `proposeSchemaEdit(input)`: one step wraps proposeSchemaEdit's Schema Suggestion call; its typed result — the proposal
 *  and its base revision — is the outcome. Nothing is saved until the researcher applies it (spec, *Edit proposals*).
 *  Past `SCHEMA_CHAT_ANSWERS` the message may ask a question instead: its answer is the outcome, and a long source's
 *  question, first answered from excerpts, is answered again across its windows (`answerFromWindows`). */
export async function proposeSchemaEditWorkflow(
  input: SchemaEditInput,
  ports: SchemaEditPorts,
): Promise<OperationResult<SchemaEditProposed>> {
  // The base revision and the document are immutable; both are read at workflow scope, outside history. A storage
  // failure is the typed 503 the handler always answered, never a workflow error.
  let tree: unknown | null
  let source: SchemaSource | null
  try {
    tree = await ports.readSchemaTree(input.extractionSchemaId, input.baseSchemaRevisionId)
    source = input.sourceRepresentationRevisionId === null ? null : await ports.readSource(input.sourceRepresentationRevisionId)
  } catch (cause) {
    return { ok: false, ...operationFailureOf(persistenceUnavailable(cause, 'Project model context storage is unavailable.')) }
  }
  if (tree === null || (input.sourceRepresentationRevisionId !== null && source === null))
    return { ok: false, status: 404, code: 'not_found', message: 'Project model context was not found.' }
  const caller = { researcherAccountId: input.owner }
  let definition: ReturnType<typeof parseSchemaDefinition>
  try {
    definition = parseSchemaDefinition(tree)
  } catch (error) {
    return { ok: false, ...operationFailureOf(error) }
  }
  const answerable = (await ports.patched?.(SCHEMA_CHAT_ANSWERS)) ?? false
  const proposed = await ports.steps.step('proposeSchemaEdit', async (): Promise<OperationResult<SchemaEditProposed>> => {
    try {
      const response = await ports.propose(definition, input.instruction, source, {
        caller,
        ...(input.temperature === null ? {} : { temperature: input.temperature }),
        // The model boundary adds the step's cancel signal (Task 2).
        signal: AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS),
        generate: ports.generate,
        ...(answerable ? { answerable, respond: ports.respond } : {}),
      })
      return { ok: true, baseSchemaRevisionId: input.baseSchemaRevisionId, response }
    } catch (error) {
      return { ok: false, ...operationFailureOf(error) }
    }
  })
  if (!proposed.ok || proposed.response.status !== 'answered' || !answeredFromExcerpts(source)) return proposed
  const { answerWindow, combineAnswers } = ports
  if (!answerWindow || !combineAnswers) return proposed
  try {
    const answer = await answerFromWindows({ steps: ports.steps, answerWindow, combineAnswers }, caller, source!.markdown,
      { message: input.instruction, context: schemaChatContext(definition) }, input.temperature)
    return { ok: true, baseSchemaRevisionId: input.baseSchemaRevisionId, response: { status: 'answered', answer } }
  } catch (error) {
    if (error instanceof StepFailure) return { ok: false, ...error.failure }
    throw error
  }
}

export function registerSchemaEditWorkflow(ports: () => SchemaEditPorts): void {
  DBOS.registerWorkflow(async (input: SchemaEditInput) => proposeSchemaEditWorkflow(input, ports()), { name: PROPOSE_SCHEMA_EDIT })
}
