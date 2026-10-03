import { createHash } from 'node:crypto'
import { DBOS } from '@dbos-inc/dbos-sdk'
import type { TerminalExtraction } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { acceptKeiArtifact } from './kei-artifact.js'
import {
  EXTRACTION_TIMEOUT_MS, KEI_PRIORITY, KEI_QUEUE, keiExtractOkSchema, keiExtractWorkflowId, keiRunOf, settleKei,
  SUBMIT_TO_KEI_RETRY, type KeiExtractInput, type KeiHandoff, type KeiOutcome, type KeiPoll,
} from './kei-handoff.js'
import { extractionMethod, keiMethodOptions, type ExtractionMethod } from './extraction-method.js'
import { decodePinnedDocument } from './parsed-document.js'
import { parseExtractionSchema, recordScopeOf, type RecordScope } from './schema.js'
import type { ExtractionFailure, ExtractionModelChoice, ExtractionStrategy } from './types.js'
import { ARTIFACT_READ_RETRY, isWorkflowCancellation, type WorkflowSteps } from './workflow-steps.js'

export const RUN_EXTRACTION = 'runExtraction'
/** Studio's unrestricted `studio` queue (server/dbos.ts STUDIO_QUEUE; server/workflows.test.ts pins the two equal). */
export const EXTRACTION_QUEUE = 'studio'

/** What admission committed for one Extraction: its pins, its choices and the scope it belongs to. */
export type AdmittedExtraction = Readonly<{
  extractionId: string
  owner: string
  projectContextId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  extractionSchemaId: string
  strategy: ExtractionStrategy
  catalogRecipe: string | null
  requestedModels: ExtractionModelChoice | null
  /** The settings admission pinned (`Extraction.requestedSettings`); never today's account configuration. Absent in a
   *  `loadAdmitted` checkpoint written before settings were recorded, which ran on service defaults. */
  requestedSettings?: unknown
  batchExtractionId: string | null
  /** The pinned revision's `preprocessId`: `kei-exp:<run>:<generation>` for a representation kei made. */
  preprocessId: string
  schemaTree: unknown
  /** The pinned revision's declared record scope (`SchemaRevision.recordScope`); null for a legacy revision that
   *  declares none, absent in a `loadAdmitted` checkpoint written before scopes were declared. */
  recordScope?: RecordScope | null
  /** The start page admission stored (`Extraction.startPage`); null when none was named, absent in a `loadAdmitted`
   *  checkpoint written before the column existed. Both ask kei for its source order. */
  startPage?: number | null
}>
export type SettledExtraction =
  | { outcome: 'SUCCEEDED'; extraction: TerminalExtraction }
  | { outcome: 'FAILED' | 'CANCELLED'; failure: ExtractionFailure }
export type ExtractionStore = Readonly<{
  /** The Extraction while it has no outcome; null once it is settled or deleted. */
  loadAdmitted(extractionId: string): Promise<AdmittedExtraction | null>
  readPinnedDocument(sourceRepresentationRevisionId: string): Promise<unknown | null>
  /** Locks the Extraction and writes the outcome only while it has none. */
  settle(extractionId: string, settled: SettledExtraction): Promise<'settled' | 'already-settled' | 'missing'>
}>
export type ExtractionWorkflowPorts = Readonly<{
  steps: WorkflowSteps
  store: ExtractionStore
  kei: KeiHandoff
  /** The bytes of kei's published artifact (`GET /api/runs/{run}/extractions/{extraction}`). */
  readArtifact(runId: string, extractionId: string, signal?: AbortSignal): Promise<Uint8Array>
}>

export function extractionAttributes(admitted: Pick<AdmittedExtraction,
  'projectContextId' | 'sourceDocumentId' | 'sourceRepresentationRevisionId' | 'extractionSchemaId' | 'batchExtractionId' | 'preprocessId'>,
): Record<string, string> {
  const run = keiRunOf(admitted.preprocessId)
  return {
    projectContextId: admitted.projectContextId,
    sourceDocumentId: admitted.sourceDocumentId,
    sourceRepresentationRevisionId: admitted.sourceRepresentationRevisionId,
    extractionSchemaId: admitted.extractionSchemaId,
    ...(admitted.batchExtractionId === null ? {} : { batchExtractionId: admitted.batchExtractionId }),
    // The run this Extraction hands to kei: M6's collectGarbage protects it while this workflow lives (*Late handoffs*).
    ...(run === null ? {} : { keiRunId: run.runId }),
  }
}

function keiExtractRequest(admitted: AdmittedExtraction): KeiExtractInput | ExtractionFailure {
  const run = keiRunOf(admitted.preprocessId)
  if (run === null)
    return { code: 'invalid_source_representation', message: 'The pinned Source Representation does not name a kei-exp parse generation.', phase: 'loading' }
  // The admitted strategy is the run's snapshot; admission refused any revision whose declared scope names another. A
  // revision without one was admitted before scopes were declared, and runs the scope its admitted strategy names.
  const recordScope = recordScopeOf(admitted.strategy)
  if ((admitted.recordScope ?? recordScope) !== recordScope)
    return { code: 'invalid_extraction_pins', message: 'The pinned Schema Revision declares another record scope than the admitted Extraction Strategy.', phase: 'loading' }
  let schema: KeiExtractInput['request']['schema']
  // Admission validated the tree; a pinned tree that no longer parses fails this Extraction rather than its workflow.
  try { schema = { ...parseExtractionSchema(admitted.schemaTree), recordScope } }
  catch { return { code: 'invalid_schema_revision', message: 'The pinned Schema Revision is invalid.', phase: 'loading' } }
  let method: ExtractionMethod
  // Admission validated the method; one that no longer reads fails this Extraction rather than its workflow.
  try { method = extractionMethod(admitted.strategy, admitted.catalogRecipe, admitted.requestedModels, admitted.requestedSettings) }
  catch { return { code: 'invalid_extraction_method', message: 'The admitted extraction method is invalid.', phase: 'loading' } }
  return {
    run_id: run.runId,
    generation: run.generation,
    request: {
      schema,
      // The start page orders kei's work and is outside the artifact and its fingerprint (`Options.dumped()`).
      options: {
        ...keiMethodOptions(method),
        ...(typeof admitted.startPage === 'number' ? { start_page: admitted.startPage } : {}),
      },
    },
  }
}

/** The Parsing Service's refusal of a result its record scope does not allow (contract `record-scope.json` `violation`). */
const RECORD_SCOPE_VIOLATION = 'record_scope_violation:'

export function extractionFailureOf(outcome: Extract<KeiOutcome<unknown>, { ok: false }>, strategy: ExtractionStrategy): ExtractionFailure {
  const phase = 'extracting' as const
  if (outcome.code === 'extraction_failed' && outcome.reason.startsWith(RECORD_SCOPE_VIOLATION)) {
    const detail = outcome.reason.slice(RECORD_SCOPE_VIOLATION.length).trim()
    return {
      code: 'invalid_model_output',
      message: `The extraction result did not fit the schema's record scope (${recordScopeOf(strategy) === 'document'
        ? 'Article: exactly one document-level record' : 'Catalog: a collection of records'})${detail ? `: ${detail}` : '.'}`.slice(0, 512),
      phase,
    }
  }
  switch (outcome.code) {
    case 'invalid_request': return { code: 'invalid_request', message: `The Parsing Service refused the Extraction request: ${outcome.reason}`.slice(0, 512), phase }
    case 'stale_generation': return { code: 'invalid_source_representation', message: outcome.reason.slice(0, 512), phase }
    case 'model_unavailable': return { code: 'model_unavailable', message: outcome.reason.slice(0, 512), phase }
    // The unified Catalog's pinned budgets do not fit what is served now, or no minimum request fits them.
    case 'budget_refused': return { code: 'budget_refused', message: outcome.reason.slice(0, 512), phase }
    case 'cancelled': return { code: 'cancelled', message: 'The Extraction was cancelled.', phase }
    case 'deadline_exceeded':
      return { code: 'extraction_failed', message: `The Extraction did not finish within its time limit (${EXTRACTION_TIMEOUT_MS[strategy] / 3_600_000} hours).`, phase }
    case 'stopped': return { code: 'extraction_failed', message: 'The Parsing Service stopped this Extraction.', phase }
    case 'invalid_output': return { code: 'invalid_model_output', message: outcome.reason.slice(0, 512), phase }
    default: return { code: 'extraction_failed', message: `kei-exp could not complete the Extraction: ${outcome.reason}`.slice(0, 512), phase }
  }
}

/**
 * `runExtraction(extractionId)` (spec, *Background work*): load the admitted pins, submit to kei-extract, poll in
 * bounded steps, then fetch, validate and publish the artifact in one step. Every terminal write is `store.settle`,
 * which writes only while the row has no outcome: a replayed step, a cancel that won, or a deleted row makes it a
 * no-op, never a second result and never a failure of surviving batch members. It runs the method admission pinned on
 * the row; it never reads the account's saved settings, on recovery or for batch members.
 */
export async function runExtractionWorkflow(extractionId: string, ports: ExtractionWorkflowPorts): Promise<void> {
  const { steps, store, kei } = ports
  const admitted = await steps.step('loadAdmitted', () => store.loadAdmitted(extractionId))
  if (admitted === null) return
  const request = keiExtractRequest(admitted)
  if ('code' in request) {
    await steps.step('publishFailure', () => store.settle(extractionId, { outcome: 'FAILED', failure: request }))
    return
  }
  const child = keiExtractWorkflowId(extractionId)
  try {
    await steps.step('submitToKei', () => kei.submit({
      workflow: 'extract',
      workflowId: child,
      queueName: KEI_QUEUE.extract,
      priority: admitted.batchExtractionId === null ? KEI_PRIORITY.interactive : KEI_PRIORITY.batch,
      timeoutMs: EXTRACTION_TIMEOUT_MS[admitted.strategy],
      request,
      authenticatedUser: admitted.owner,
      attributes: extractionAttributes(admitted),
    }), SUBMIT_TO_KEI_RETRY)
    const pollKei = () => steps.step('pollKei', () => kei.poll(child, steps.cancelSignal()))
    let polled: KeiPoll = await pollKei()
    while (polled.state === 'live') polled = await pollKei()
    const settled = settleKei(polled, keiExtractOkSchema)
    if (!settled.ok) {
      const failure = extractionFailureOf(settled, admitted.strategy)
      await steps.step('publishFailure', () => store.settle(extractionId, { outcome: 'FAILED', failure }))
      return
    }
    await steps.step('publishResult', async () => {
      const ok = settled.value
      const fail = (code: string, message: string) => store.settle(extractionId, {
        outcome: 'FAILED', failure: { code, message: message.slice(0, 512), phase: 'persisting' },
      })
      if (ok.extraction_id !== extractionId || ok.run_id !== request.run_id || ok.generation !== request.generation)
        return fail('invalid_model_output', 'kei-exp reported an extraction of other inputs.')
      let extraction: TerminalExtraction
      try {
        // A transient read failure (kei's API restarting) is thrown on, for ARTIFACT_READ_RETRY to read again.
        const bytes = await ports.readArtifact(ok.run_id, extractionId, steps.cancelSignal())
        if (createHash('sha256').update(bytes).digest('hex') !== ok.artifact_sha256)
          return fail('invalid_model_output', 'The published extraction artifact does not match the one kei-exp reported.')
        const raw = await store.readPinnedDocument(admitted.sourceRepresentationRevisionId)
        if (raw === null) return 'missing' as const // the revision was deleted: nothing to publish into
        extraction = acceptKeiArtifact(admitted, decodePinnedDocument(raw), JSON.parse(new TextDecoder().decode(bytes)), request)
      } catch (error) {
        // The parser's own text never reaches a researcher.
        if (error instanceof SyntaxError) return fail('invalid_model_output', 'kei-exp returned invalid JSON.')
        if (!(error instanceof ExtractionError)) throw error
        return fail(error.code, error.message)
      }
      return store.settle(extractionId, { outcome: 'SUCCEEDED', extraction })
    }, ARTIFACT_READ_RETRY)
  } catch (error) {
    if (isWorkflowCancellation(error)) throw error
    // Submission may have committed even when its acknowledgement was lost. Preserve the first error if cancellation
    // also fails; M6 repair can revisit an uncertain child.
    await steps.step('cancelKeiChild', () => kei.cancel(child)).catch((cancelError: unknown) => {
      if (isWorkflowCancellation(cancelError)) throw cancelError
      console.warn('Could not cancel the kei child of a failed Extraction.')
    })
    throw error
  }
}

/** Registers `runExtraction` under its fixed name; only registerStudioWorkflows() calls it, before DBOS.launch(). */
export function registerExtractionWorkflow(ports: () => ExtractionWorkflowPorts): void {
  DBOS.registerWorkflow(async (extractionId: string) => runExtractionWorkflow(extractionId, ports()), { name: RUN_EXTRACTION })
}
