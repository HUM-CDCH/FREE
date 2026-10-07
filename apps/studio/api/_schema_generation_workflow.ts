import { DBOS } from '@dbos-inc/dbos-sdk'
import type { SchemaSource } from 'db'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import { combineSchemas, type generateSchemaWithModel } from './_schema_suggestion.js'
import { ApiError, persistenceUnavailable } from './_http.js'
import { MODEL_OPERATION_TIMEOUT_MS, operationFailureOf, type OperationFailure, type OperationResult } from './_model_operation.js'
import { schemaSourceWindows } from './_schema.js'
import { reduceSchemas } from './_schema_reduction.js'
import type { SourceCoverage } from '../shared/schemaSuggestionSource.contract.js'

export const SUGGEST_SCHEMA = 'suggestSchema'
/** DBOS patch: a run past it suggests from every window of the source and combines them (a run before it excerpts). */
export const WINDOWED_SUGGESTION = 'schema-suggestion-windows'

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
  /** `DBOS.patch`: whether this run takes the patched step sequence; absent, it never does. */
  patched?(name: string): Promise<boolean>
}>

class StepFailure extends Error {
  readonly failure: OperationFailure
  constructor(failure: OperationFailure) {
    super(failure.message)
    this.failure = failure
  }
}

/** One model call in its own step with its own ten-minute signal; a failure is checkpointed as a typed result. */
async function modelStep<T>(steps: WorkflowSteps, name: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const result = await steps.step(name, async (): Promise<OperationResult<{ value: T }>> => {
    try {
      return { ok: true, value: await run(AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS)) }
    } catch (error) {
      return { ok: false, ...operationFailureOf(error) }
    }
  })
  if (!result.ok) throw new StepFailure({ status: result.status, code: result.code, message: result.message })
  return result.value
}

/** Every window suggested in its own step, then the window suggestions combined (their union) level by level. */
async function suggestFromWindows(
  input: SchemaGenerationInput,
  ports: SchemaGenerationPorts,
  markdown: string,
): Promise<OperationResult<SchemaGenerated>> {
  const caller = { researcherAccountId: input.owner }
  try {
    const suggestions: { template: Record<string, unknown>; raw: string; pages: number | null }[] = []
    for (const [index, window] of schemaSourceWindows(markdown).entries()) {
      suggestions.push(await modelStep(ports.steps, `suggestWindow:${index + 1}`, async (signal) => {
        const generated = await ports.generate(caller, {
          document: { file: null, pages: null, markdown: window },
          instruction: input.instruction,
          window: true,
          ...(input.temperature === null ? {} : { temperature: input.temperature }),
          signal,
        })
        // Only the model's text: never the provider's response, headers or metadata.
        return { template: generated.template, raw: generated.raw, pages: generated.pages }
      }))
    }
    const template = await reduceSchemas(
      suggestions.map((suggestion, index) => ({ label: `WINDOW ${index + 1}`, schema: suggestion.template })),
      (text, step) => modelStep(ports.steps, step, (signal) =>
        combineSchemas(caller, 'union', text, signal, ports.generate, input.temperature ?? undefined)),
    )
    return {
      ok: true, template, raw: suggestions.length === 1 ? suggestions[0]!.raw : JSON.stringify(template),
      pages: suggestions[0]!.pages, sourceCoverage: { complete: true }, baseSchemaRevisionId: input.baseSchemaRevisionId,
    }
  } catch (error) {
    // A failed step, or a combination that cannot fit (`reduceSchemas`); anything else (cancellation) is DBOS's.
    if (error instanceof StepFailure) return { ok: false, ...error.failure }
    if (error instanceof ApiError) return { ok: false, ...operationFailureOf(error) }
    throw error
  }
}

/** `suggestSchema(input)`: Schema Suggestion in steps (one before `WINDOWED_SUGGESTION`); its typed result is the operation's outcome. */
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
  if (await ports.patched?.(WINDOWED_SUGGESTION)) return suggestFromWindows(input, ports, source.markdown)
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
