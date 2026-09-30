import { DBOS } from '@dbos-inc/dbos-sdk'
import type { SchemaSource } from 'db'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import type { generateSchemaWithModel } from './_schema_suggestion.js'
import { persistenceUnavailable } from './_http.js'
import { MODEL_OPERATION_TIMEOUT_MS, operationFailureOf, type OperationResult } from './_model_operation.js'
import type { SourceCoverage } from '../shared/schemaSuggestionSource.contract.js'

export const SUGGEST_SCHEMA = 'suggestSchema'

/** IDs, the instruction and the temperature only: never the document, never a key (spec, *What DBOS history holds*). */
export type SchemaGenerationInput = Readonly<{
  operationId: string
  owner: string
  projectContextId: string
  sourceRepresentationRevisionId: string
  /** Null before the Project Context has an Extraction Schema (a first generation). */
  extractionSchemaId: string | null
  /** The acknowledged revision the tab generated from; a reloaded page saves only onto it (spec, *Generation*). */
  baseSchemaRevisionId: string | null
  instruction: string
  temperature: number | null
}>
export type SchemaGenerated = {
  template: Record<string, unknown>
  raw: string
  pages: number | null
  /** What the model received of the source; absent from an outcome recorded before the declaration existed. */
  sourceCoverage?: SourceCoverage
  baseSchemaRevisionId: string | null
}
export type SchemaGenerationPorts = Readonly<{
  steps: WorkflowSteps
  readSource(sourceRepresentationRevisionId: string): Promise<SchemaSource | null>
  generate: typeof generateSchemaWithModel
}>

/** `suggestSchema(input)`: one step wraps Schema Suggestion; its typed result is the operation's outcome. */
export async function suggestSchemaWorkflow(
  input: SchemaGenerationInput,
  ports: SchemaGenerationPorts,
): Promise<OperationResult<SchemaGenerated>> {
  // Read at workflow scope from the immutable revision: a replay reads it again, and neither the input nor any step's
  // output holds it. A storage failure is the typed 503 the handler always answered, never a workflow error.
  let source: SchemaSource | null
  try {
    source = await ports.readSource(input.sourceRepresentationRevisionId)
  } catch (cause) {
    return { ok: false, ...operationFailureOf(persistenceUnavailable(cause, 'Project model context storage is unavailable.')) }
  }
  if (source === null) return { ok: false, status: 404, code: 'not_found', message: 'Project model context was not found.' }
  return ports.steps.step('generateSchema', async (): Promise<OperationResult<SchemaGenerated>> => {
    try {
      const generated = await ports.generate({ researcherAccountId: input.owner }, {
        document: { file: null, pages: null, markdown: source.markdown, pageSpans: source.pageSpans },
        instruction: input.instruction,
        ...(input.temperature === null ? {} : { temperature: input.temperature }),
        // The model boundary adds the step's cancel signal (Task 2).
        signal: AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS),
      })
      // Only the model's text, the source declaration and the base: never the provider's response, headers or metadata.
      return {
        ok: true, template: generated.template, raw: generated.raw, pages: generated.pages,
        sourceCoverage: generated.sourceCoverage?.complete === false
          ? { ...generated.sourceCoverage, sourceRepresentationRevisionId: input.sourceRepresentationRevisionId }
          : generated.sourceCoverage,
        baseSchemaRevisionId: input.baseSchemaRevisionId,
      }
    } catch (error) {
      return { ok: false, ...operationFailureOf(error) }
    }
  })
}

export function registerSchemaGenerationWorkflow(ports: () => SchemaGenerationPorts): void {
  DBOS.registerWorkflow(async (input: SchemaGenerationInput) => suggestSchemaWorkflow(input, ports()), { name: SUGGEST_SCHEMA })
}
