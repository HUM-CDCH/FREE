import { DBOS, type StepConfig } from '@dbos-inc/dbos-sdk'
import { MODEL_OPERATION_TIMEOUT_MS } from './_model_operation.js'
import type { InternalProjectWorkerStore, SchemaSource } from 'db'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import type { SchemaDefinition } from 'extraction/schema'
import { sourceSuggestionFailure } from './_batch_schema_suggestions.js'
import { combineBatchSchemas, suggestBatchSource, type generateSchemaWithModel } from './_schema_suggestion.js'
import { ApiError } from './_http.js'
import { schemaSourceWindows } from './_schema.js'
import { reduceSchemas } from './_schema_reduction.js'
import type { BatchSourceCoverage } from '../shared/schemaSuggestionSource.contract.js'

export const SUGGEST_SCHEMA_BATCH = 'suggestSchemaBatch'

export type SuggestionMember = Readonly<{ sourceDocumentId: string; sourceRepresentationRevisionId: string }>
/** Admission's snapshot: every current member pin, sorted by sourceDocumentId (spec, *suggestSchemaBatch*). */
export type SuggestionAttemptInput = Readonly<{
  batchSchemaSuggestionId: string
  attempt: number
  projectContextId: string
  members: readonly SuggestionMember[]
}>
/** Either phase declares, per Source Document, what its suggestion read of the source and whether the merge read the
 *  suggestion. */
export type SuggestionProposal =
  | { phase: 'READY'; proposal: SchemaDefinition; sourceCoverage: BatchSourceCoverage; draft: SchemaDefinition }
  | { phase: 'HETEROGENEOUS'; sourceCoverage: BatchSourceCoverage }
export type SuggestionFailure = { code: string; message: string }
export type SuggestionStore = Readonly<{
  /** 'current' while this attempt is the suggestion's attempt and has no outcome; 'stopped' after an interruption, a later attempt or deletion. */
  attemptState(batchSchemaSuggestionId: string, attempt: number): Promise<'current' | 'stopped'>
  projectContextOwner(projectContextId: string): Promise<string | null>
  /** The pinned revision's canonical Markdown with its page spans, or null when the revision is gone. */
  readSource(sourceRepresentationRevisionId: string): Promise<SchemaSource | null>
  publish(batchSchemaSuggestionId: string, attempt: number, result: SuggestionProposal): Promise<'published' | 'stopped'>
  fail(batchSchemaSuggestionId: string, attempt: number, failure: SuggestionFailure): Promise<'published' | 'stopped'>
}>
export type SuggestionWorkflowPorts = Readonly<{
  steps: WorkflowSteps
  store: SuggestionStore
  generate: typeof generateSchemaWithModel
}>

/** The workflow's store over packages/db's worker store: every check and terminal write shares its one predicate (the
 *  current attempt, without an outcome) under the suggestion's row lock. */
export function workerSuggestionStore(worker: InternalProjectWorkerStore): SuggestionStore {
  return {
    attemptState: (id, attempt) => worker.suggestionAttemptState(id, attempt),
    projectContextOwner: (projectContextId) => worker.projectContextOwner(projectContextId),
    readSource: (revisionId) => worker.readRevisionSchemaSource(revisionId),
    // The suggestion's `coverage` column holds the source declaration.
    publish: (id, attempt, result) => worker.publishBatchSchemaSuggestion(id, attempt, result.phase === 'READY'
      ? { phase: 'READY', proposal: result.proposal, coverage: result.sourceCoverage, draft: result.draft }
      : { phase: 'HETEROGENEOUS', coverage: result.sourceCoverage }),
    fail: (id, attempt, failure) => worker.failBatchSchemaSuggestionAttempt(id, attempt, failure),
  }
}

/** PostgreSQL failures another try of the same step can get past: a connection dropped, refused or timed out
 *  (SQLSTATE class 08, pg's uncoded "Connection terminated"), a server restarting (57P01-57P03), a serialization failure
 *  or deadlock. Anything else, such as a missing canonical package, fails the step at once. The walk is bounded. */
const TRANSIENT_CODES = new Set(['57P01', '57P02', '57P03', '40001', '40P01', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'])
const TRANSIENT_MESSAGE = /^(Connection terminated\b|timeout exceeded when trying to connect)/

export function transientStoreError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const { code, sqlState, message, cause } = current as { code?: unknown; sqlState?: unknown; message?: unknown; cause?: unknown }
    for (const value of [code, sqlState])
      if (typeof value === 'string' && (TRANSIENT_CODES.has(value) || /^08[0-9A-Z]{3}$/.test(value))) return true
    if (typeof message === 'string' && TRANSIENT_MESSAGE.test(message)) return true
    current = cause
  }
  return false
}

/** Every step here reads or writes the store; a model call's own failure is caught and returned, never thrown, so a
 *  retry repeats only store work. One database blip then costs a few seconds, not the attempt (which would read
 *  `interrupted`). The terminal writes are conditional, so repeating one writes nothing twice. */
export const STORE_STEP_RETRY: StepConfig = {
  retriesAllowed: true,
  intervalSeconds: 1,
  backoffRate: 2,
  maxAttempts: 4,
  shouldRetry: transientStoreError,
}

/** The model call's signal: the step's cancellation (DBOS.stepStatus.cancelSignal, ~1 s after a cancel) and the
 *  ten-minute call limit. The key wrapper reads keys with it, so a cancel also ends the 60 s key wait (M2 ruling). */
function modelSignal(cancel: AbortSignal | undefined): AbortSignal {
  return AbortSignal.any([...(cancel ? [cancel] : []), AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS)])
}

/** What a step checkpoints for a failed model call: a stable code and FREE's own copy, never the provider's error,
 *  its cause, body or headers (secrets never enter DBOS). */
function durableFailure(error: unknown): SuggestionFailure {
  const code = sourceSuggestionFailure(error).code
  const message = code === 'unexpected_failure' || !(error instanceof Error) ? 'The operation failed unexpectedly.' : error.message
  return { code, message: message.slice(0, 512) }
}

type SourceResult =
  | { kind: 'definition'; sourceDocumentId: string; definition: SchemaDefinition }
  | { kind: 'failure'; sourceDocumentId: string; failure: SuggestionFailure }
  | { kind: 'stopped' }
type MergeResult =
  | { kind: 'proposal'; result: SuggestionProposal }
  | { kind: 'failure'; failure: SuggestionFailure }
  | { kind: 'stopped' }

class MemberHalt extends Error {
  readonly result: Exclude<SourceResult, { kind: 'definition' }>
  constructor(result: Exclude<SourceResult, { kind: 'definition' }>) {
    super(result.kind)
    this.result = result
  }
}

/**
 * One source: a step per window of its source, then its window suggestions combined
 * (their union) a step per request. Every step first asks whether its attempt is still current and re-reads the pinned
 * source it needs, so DBOS holds only window counts and suggestions, never the source.
 */
async function suggestMemberFromWindows(
  input: SuggestionAttemptInput,
  { steps, store, generate }: SuggestionWorkflowPorts,
  member: SuggestionMember,
): Promise<SourceResult> {
  const { batchSchemaSuggestionId: id, attempt } = input
  const { sourceDocumentId } = member
  const modelStep = async <T>(
    name: string,
    call: (caller: { researcherAccountId: string }, markdown: string | null, signal: AbortSignal) => Promise<T>,
    readsSource: boolean,
  ): Promise<T> => {
    const result = await steps.step(name, async (): Promise<{ kind: 'value'; value: T } | Exclude<SourceResult, { kind: 'definition' }>> => {
      if ((await store.attemptState(id, attempt)) !== 'current') return { kind: 'stopped' }
      const owner = await store.projectContextOwner(input.projectContextId)
      const source = owner === null || !readsSource ? null : await store.readSource(member.sourceRepresentationRevisionId)
      if (owner === null || (readsSource && source === null)) return { kind: 'stopped' }
      try {
        return { kind: 'value', value: await call({ researcherAccountId: owner }, source?.markdown ?? null, modelSignal(steps.cancelSignal())) }
      } catch (error) {
        return { kind: 'failure', sourceDocumentId, failure: durableFailure(error) }
      }
    }, STORE_STEP_RETRY)
    if (result.kind !== 'value') throw new MemberHalt(result)
    return result.value
  }
  try {
    const suggestions: SchemaDefinition[] = []
    for (let index = 0, count = 1; index < count; index += 1) {
      const window = await modelStep(`suggestSource:${sourceDocumentId}:window:${index + 1}`, async (caller, markdown, signal) => {
        const windows = schemaSourceWindows(markdown!)
        const definition = await suggestBatchSource(caller, windows[index]!, signal, generate)
        return { count: windows.length, definition }
      }, true)
      count = window.count
      suggestions.push(window.definition)
    }
    const definition = await reduceSchemas(
      suggestions.map((schema, index) => ({ label: `WINDOW ${index + 1}`, schema })),
      (text, step) => modelStep(`suggestSource:${sourceDocumentId}:${step}`,
        (caller, _markdown, signal) => combineBatchSchemas(caller, 'union', text, signal, generate), false),
    )
    return { kind: 'definition', sourceDocumentId, definition }
  } catch (error) {
    if (error instanceof MemberHalt) return error.result
    // Window suggestions that cannot be combined within one request's limit (`reduceSchemas`).
    if (error instanceof ApiError) return { kind: 'failure', sourceDocumentId, failure: durableFailure(error) }
    throw error
  }
}

/**
 * The merge: the sources' suggestions intersected level by level, a step per request,
 * so every suggestion is read; a group holding a suggestion without fields stays without fields, with no call.
 */
async function mergeLevels(
  input: SuggestionAttemptInput,
  { steps, store, generate }: SuggestionWorkflowPorts,
  definitions: readonly Extract<SourceResult, { kind: 'definition' }>[],
): Promise<MergeResult> {
  const { batchSchemaSuggestionId: id, attempt } = input
  try {
    const definition = await reduceSchemas(
      definitions.map(({ sourceDocumentId, definition }) => ({ label: `SOURCE DOCUMENT ${sourceDocumentId}`, schema: definition })),
      async (text, step, group) => {
        const empty = group.find((schema) => schema.schemaNodes.length === 0)
        if (empty) return empty
        const result = await steps.step(`merge:${step}`, async (): Promise<{ kind: 'value'; value: SchemaDefinition } | MergeResult> => {
          if ((await store.attemptState(id, attempt)) !== 'current') return { kind: 'stopped' }
          const owner = await store.projectContextOwner(input.projectContextId)
          if (owner === null) return { kind: 'stopped' }
          try {
            return { kind: 'value', value: await combineBatchSchemas(
              { researcherAccountId: owner }, 'intersection', text, modelSignal(steps.cancelSignal()), generate) }
          } catch (error) {
            return { kind: 'failure', failure: durableFailure(error) }
          }
        }, STORE_STEP_RETRY)
        if (result.kind !== 'value') throw new MergeHalt(result)
        return result.value
      },
    )
    const sourceCoverage = declaredSourceCoverage(definitions)
    return {
      kind: 'proposal',
      result: definition.schemaNodes.length > 0
        ? { phase: 'READY', proposal: definition, sourceCoverage, draft: definition }
        : { phase: 'HETEROGENEOUS', sourceCoverage },
    }
  } catch (error) {
    if (error instanceof MergeHalt) return error.result
    // A suggestion that cannot fit one request, or a level where no two fit together (`reduceSchemas`).
    if (error instanceof ApiError) return { kind: 'failure', failure: durableFailure(error) }
    throw error
  }
}

class MergeHalt extends Error {
  readonly result: MergeResult
  constructor(result: MergeResult) {
    super(result.kind)
    this.result = result
  }
}

const SOURCES_FAILED: SuggestionFailure = {
  code: 'source_suggestion_failed',
  message: 'Fields could not be suggested for every selected Source Document.',
}

/** Every source's declaration, in member order: its suggestion read every window of the source whole, and the merge
 *  reads every suggestion. */
function declaredSourceCoverage(definitions: readonly Extract<SourceResult, { kind: 'definition' }>[]): BatchSourceCoverage {
  return definitions.map(({ sourceDocumentId }) => ({ sourceDocumentId, sourceCoverage: { complete: true }, combined: true }))
}

/**
 * One attempt of a Batch Schema Suggestion: a step per window and per combination request of each pinned source, a step
 * per merge request and one conditional publication. Every step first asks whether its attempt is still current (not interrupted, superseded or deleted),
 * and every terminal write is conditional on the attempt, so a replay or a late finish writes nothing.
 */
export async function suggestSchemaBatchWorkflow(input: SuggestionAttemptInput, ports: SuggestionWorkflowPorts): Promise<void> {
  const { steps, store } = ports
  const { batchSchemaSuggestionId: id, attempt } = input
  const definitions: Array<Extract<SourceResult, { kind: 'definition' }>> = []
  for (const member of input.members) {
    // Named steps per source: recovery of this attempt reuses finished sources; a new attempt reruns them all.
    const result = await suggestMemberFromWindows(input, ports, member)
    if (result.kind === 'stopped') return
    if (result.kind === 'failure') {
      // The first failure ends the attempt (controller ruling): failures block the merge, and a retry reruns every
      // surviving source, so later sources would only spend calls (and, without a key, a 60 s key wait each).
      // A missing key is its own outcome, so the page resends keys and the researcher retries.
      const failure = result.failure.code === 'model_key_required' ? result.failure : SOURCES_FAILED
      await steps.step('publishFailure', () => store.fail(id, attempt, failure), STORE_STEP_RETRY)
      return
    }
    definitions.push(result)
  }
  const merged = await mergeLevels(input, ports, definitions)
  if (merged.kind === 'stopped') return
  await steps.step('publish', () =>
    merged.kind === 'proposal' ? store.publish(id, attempt, merged.result) : store.fail(id, attempt, merged.failure),
  STORE_STEP_RETRY)
}

/** Registers `suggestSchemaBatch`; only registerStudioWorkflows calls it. Ports are built per run. */
export function registerBatchSuggestionWorkflow(ports: () => SuggestionWorkflowPorts): void {
  DBOS.registerWorkflow(async (input: SuggestionAttemptInput) => suggestSchemaBatchWorkflow(input, ports()), { name: SUGGEST_SCHEMA_BATCH })
}
