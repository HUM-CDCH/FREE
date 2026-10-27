import { DBOS } from '@dbos-inc/dbos-sdk'
import type { SchemaSource } from 'db'
import { parseSchemaDefinition } from 'extraction/schema'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import type { SchemaEditResponse } from '../shared/schemaEdit.contract.js'
import { persistenceUnavailable } from './_http.js'
import { MODEL_OPERATION_TIMEOUT_MS, operationFailureOf, type OperationResult } from './_model_operation.js'
import type { proposeSchemaEdit } from './_schema_edit.js'
import type { generateSchemaWithModel } from './_schema_suggestion.js'

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
}>

/** `proposeSchemaEdit(input)`: one step wraps proposeSchemaEdit's Schema Suggestion call; its typed result — the proposal
 *  and its base revision — is the outcome. Nothing is saved until the researcher applies it (spec, *Edit proposals*). */
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
  return ports.steps.step('proposeSchemaEdit', async (): Promise<OperationResult<SchemaEditProposed>> => {
    try {
      const response = await ports.propose(parseSchemaDefinition(tree), input.instruction, source, {
        caller,
        ...(input.temperature === null ? {} : { temperature: input.temperature }),
        // The model boundary adds the step's cancel signal (Task 2).
        signal: AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS),
        generate: ports.generate,
      })
      return { ok: true, baseSchemaRevisionId: input.baseSchemaRevisionId, response }
    } catch (error) {
      return { ok: false, ...operationFailureOf(error) }
    }
  })
}

export function registerSchemaEditWorkflow(ports: () => SchemaEditPorts): void {
  DBOS.registerWorkflow(async (input: SchemaEditInput) => proposeSchemaEditWorkflow(input, ports()), { name: PROPOSE_SCHEMA_EDIT })
}
