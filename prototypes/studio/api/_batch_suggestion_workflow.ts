import { DBOS, type StepConfig } from '@dbos-inc/dbos-sdk'
import type { InternalProjectWorkerStore } from 'db'
import type { WorkflowSteps } from 'extraction/workflows'
import type { SchemaDefinition } from 'extraction/schema'
import {
  modelSuggestedDefinition,
  sourceSuggestionFailure,
  verifiedCommonSuggestion,
  type FieldCoverage,
} from './_batch_schema_suggestions.js'
import type { generateSchemaWithModel } from './_model.js'

export const SUGGEST_SCHEMA_BATCH = 'suggestSchemaBatch'
const MODEL_OPERATION_TIMEOUT_MS = 10 * 60 * 1000
const SOURCE_SUGGESTION_INSTRUCTION =
  'Suggest reusable extraction fields for this Source Document. Never include canonical Evidence fields: _evidence, snippets, pages, bboxes, occurrence IDs, or fuzzy matches.'
const MERGE_INSTRUCTION =
  'Return one compact Extraction Schema containing only fields present in every supplied Source Document suggestion. Do not include extracted values, alternatives, merge notes, or canonical Evidence fields (_evidence, snippets, pages, bboxes, occurrence IDs, fuzzy matches).'

export type SuggestionMember = Readonly<{ sourceDocumentId: string; sourceRepresentationRevisionId: string }>
/** Admission's snapshot: every current member pin, sorted by sourceDocumentId (spec, *suggestSchemaBatch*). */
export type SuggestionAttemptInput = Readonly<{
  batchSchemaSuggestionId: string
  attempt: number
  projectContextId: string
  members: readonly SuggestionMember[]
}>
export type SuggestionProposal =
  | { phase: 'READY'; proposal: SchemaDefinition; coverage: FieldCoverage[]; draft: SchemaDefinition }
  | { phase: 'HETEROGENEOUS' }
export type SuggestionFailure = { code: string; message: string }
export type SuggestionStore = Readonly<{
  /** 'current' while this attempt is the suggestion's attempt and has no outcome; 'stopped' after an interruption, a later attempt or deletion. */
  attemptState(batchSchemaSuggestionId: string, attempt: number): Promise<'current' | 'stopped'>
  projectContextOwner(projectContextId: string): Promise<string | null>
  /** The pinned revision's canonical Markdown, or null when the revision is gone. */
  readMarkdown(sourceRepresentationRevisionId: string): Promise<string | null>
  publish(batchSchemaSuggestionId: string, attempt: number, result: SuggestionProposal): Promise<'published' | 'stopped'>
  fail(batchSchemaSuggestionId: string, attempt: number, failure: SuggestionFailure): Promise<'published' | 'stopped'>
}>
export type SuggestionWorkflowPorts = Readonly<{ steps: WorkflowSteps; store: SuggestionStore; generate: typeof generateSchemaWithModel }>

/** The workflow's store over packages/db's worker store: every check and terminal write shares its one predicate (the
 *  current attempt, without an outcome) under the suggestion's row lock. */
export function workerSuggestionStore(worker: InternalProjectWorkerStore): SuggestionStore {
  return {
    attemptState: (id, attempt) => worker.suggestionAttemptState(id, attempt),
    projectContextOwner: (projectContextId) => worker.projectContextOwner(projectContextId),
    readMarkdown: (revisionId) => worker.readRevisionMarkdown(revisionId),
    publish: (id, attempt, result) => worker.publishBatchSchemaSuggestion(id, attempt, result),
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

const SOURCES_FAILED: SuggestionFailure = {
  code: 'source_suggestion_failed',
  message: 'Fields could not be suggested for every selected Source Document.',
}

/**
 * One attempt of a Batch Schema Suggestion: one named step per pinned source, one merge step and one conditional
 * publication. Every step first asks whether its attempt is still current (not interrupted, superseded or deleted),
 * and every terminal write is conditional on the attempt, so a replay or a late finish writes nothing.
 */
export async function suggestSchemaBatchWorkflow(input: SuggestionAttemptInput, ports: SuggestionWorkflowPorts): Promise<void> {
  const { steps, store, generate } = ports
  const { batchSchemaSuggestionId: id, attempt } = input
  const definitions: Array<Extract<SourceResult, { kind: 'definition' }>> = []
  for (const member of input.members) {
    // One named step per source: recovery of this attempt reuses finished sources; a new attempt reruns them all.
    const result = await steps.step(`suggestSource:${member.sourceDocumentId}`, async (): Promise<SourceResult> => {
      if ((await store.attemptState(id, attempt)) !== 'current') return { kind: 'stopped' }
      const owner = await store.projectContextOwner(input.projectContextId)
      const markdown = owner === null ? null : await store.readMarkdown(member.sourceRepresentationRevisionId)
      if (owner === null || markdown === null) return { kind: 'stopped' }
      try {
        // The Project Context owner's configuration and keys, resolved when the call runs; DBOS holds only the ID.
        const generated = await generate({ researcherAccountId: owner }, {
          document: { file: null, markdown, pages: null },
          instruction: SOURCE_SUGGESTION_INSTRUCTION,
          signal: modelSignal(steps.cancelSignal()),
        })
        return { kind: 'definition', sourceDocumentId: member.sourceDocumentId, definition: modelSuggestedDefinition(generated.template) }
      } catch (error) {
        return { kind: 'failure', sourceDocumentId: member.sourceDocumentId, failure: durableFailure(error) }
      }
    }, STORE_STEP_RETRY)
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
  const merged = await steps.step('merge', async (): Promise<MergeResult> => {
    if ((await store.attemptState(id, attempt)) !== 'current') return { kind: 'stopped' }
    const owner = await store.projectContextOwner(input.projectContextId)
    if (owner === null) return { kind: 'stopped' }
    try {
      const generated = await generate({ researcherAccountId: owner }, {
        document: {
          file: null,
          markdown: definitions
            .map((source) => `SOURCE DOCUMENT ${source.sourceDocumentId} SUGGESTION:\n${JSON.stringify(source.definition)}`)
            .join('\n\n'),
          pages: null,
        },
        instruction: MERGE_INSTRUCTION,
        signal: modelSignal(steps.cancelSignal()),
      })
      const common = verifiedCommonSuggestion(generated.template, definitions.map((source) => source.definition))
      return {
        kind: 'proposal',
        result: common
          ? { phase: 'READY', proposal: common.definition, coverage: common.coverage, draft: common.definition }
          : { phase: 'HETEROGENEOUS' },
      }
    } catch (error) {
      return { kind: 'failure', failure: durableFailure(error) }
    }
  }, STORE_STEP_RETRY)
  if (merged.kind === 'stopped') return
  await steps.step('publish', () =>
    merged.kind === 'proposal' ? store.publish(id, attempt, merged.result) : store.fail(id, attempt, merged.failure),
  STORE_STEP_RETRY)
}

/** Registers `suggestSchemaBatch`; only registerStudioWorkflows calls it (plan decision 1). Ports are built per run. */
export function registerBatchSuggestionWorkflow(ports: () => SuggestionWorkflowPorts): void {
  DBOS.registerWorkflow(async (input: SuggestionAttemptInput) => suggestSchemaBatchWorkflow(input, ports()), { name: SUGGEST_SCHEMA_BATCH })
}
