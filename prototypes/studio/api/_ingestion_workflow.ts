/**
 * `ingestSource` (spec, *Background work*): one upload attempt of a PDF a request staged in the source inbox. It
 * rechecks completed content, hands the staged file to kei's `convert` on the lane fixed at admission with the models
 * frozen at admission, accepts and packages kei's result, and publishes it through the owner's store, whose
 * (project, content) constraint makes every repeat return the one Source Document.
 */
import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  CONVERSION_PRIORITY, conversionTimeoutMs, keiConvertOkSchema, keiConvertWorkflowId, settleKei, SUBMIT_TO_KEI_RETRY,
  type ConversionLane, type KeiConvertOk, type KeiHandoff, type KeiPoll,
} from 'extraction/kei-handoff'
import { ARTIFACT_READ_RETRY, isWorkflowCancellation, type WorkflowSteps } from 'extraction/workflows'
import type { PersistedSourceDocument, ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { ApiError } from './_http.js'
import {
  conversionFailure, discardPublishedPackage, packageConversion, packagePageCount, sameDescriptor,
  type ConvertedPackage, type PackageStore,
} from './_kei_conversion.js'
import { readStagedSource, removeStagedSource } from './_source_inbox.js'

export const INGEST_SOURCE = 'ingestSource'

/** One upload attempt's workflow ID: the handler enqueues it, the workflow names its kei child after it. */
export function ingestWorkflowId(projectContextId: string, attemptId: string): string {
  return `ingest:${projectContextId}:${attemptId}`
}

/** Active deduplication: one running attempt per project and content, released when it ends. */
export function ingestDeduplicationId(projectContextId: string, contentSha256: string): string {
  return `ingest:${projectContextId}:${contentSha256}`
}

/** What admission froze for one attempt. IDs, the staged file's name and the admitted choices only: no bytes. */
export type IngestionInput = Readonly<{
  projectContextId: string
  attemptId: string
  /** The Project Context's owner: the store the attempt publishes through and the kei child's authenticated user. */
  owner: string
  /** The staged PDF, relative to the source inbox (`<projectContextId>/<attemptId>.pdf`). */
  source: string
  sourceSha256: string
  originalName: string
  byteSize: number
  pageSource: 'pdf' | 'ingest'
  /** pdf.js's count at admission; null when it could not count in time (budgeted as kei's page limit). */
  pageCount: number | null
  /** Fixed at admission from `pageCount`, so recovery and replay keep it. */
  lane: ConversionLane
  /** The owner's Ingestion Model Choice at admission; null leaves the role to kei's default. */
  models: Readonly<{ ocr: string | null; layout: string | null }>
}>

export type IngestedSourceDocumentOutput = {
  sourceDocumentId: string
  name: string
  createdAt: string
  sourceRepresentationId: string
  revisionNumber: 1
}

export type IngestionFailure = { ok: false; status: 404 | 422 | 502 | 504; code: string; message: string }

export type IngestionOutcome =
  | { ok: true; sourceDocument: IngestedSourceDocumentOutput; pageCount: number }
  | IngestionFailure

export type IngestionStore = Pick<ResearcherProjectStore, 'findSourceDocumentByContent' | 'ingestSourceDocument' | 'discardCanonicalPackage'>

export type IngestionWorkflowPorts = Readonly<{
  steps: WorkflowSteps
  kei: KeiHandoff
  /** kei's read API (KEI_EXP_URL), which serves a converted run's manifest and page files. */
  readBase: string
  inboxRoot: string
  packageStore: PackageStore
  storeFor(owner: string): IngestionStore
  /** Reads kei's API; the global fetch unless a test supplies one. */
  fetcher?: typeof fetch
}>

/** The ok outcome for a Source Document already in the store. */
export function ingestedOutput(document: Omit<PersistedSourceDocument, 'descriptor'>): IngestedSourceDocumentOutput {
  return {
    sourceDocumentId: document.sourceDocumentId,
    name: document.name,
    createdAt: new Date(document.createdAt).toISOString(),
    sourceRepresentationId: document.sourceRepresentationId,
    revisionNumber: 1,
  }
}

async function completed(store: IngestionStore, input: IngestionInput, ports: IngestionWorkflowPorts): Promise<IngestionOutcome | null> {
  const existing = await store.findSourceDocumentByContent(input.projectContextId, input.sourceSha256)
  if (!existing) return null
  let pageCount: number
  try {
    pageCount = await packagePageCount(existing.descriptor, ports.packageStore)
  } catch {
    // As the request's own precheck answers it: the attempt still ends, and removes its staged file.
    return { ok: false, status: 502, code: 'source_artifact_unavailable', message: 'The retained canonical package is unavailable.' }
  }
  return { ok: true, sourceDocument: ingestedOutput(existing), pageCount }
}

/**
 * Studio's own refusal of kei's answer (a partial parse, another generation, bytes or layout, an unprovable page, a
 * result that cannot be translated or packaged) as a typed outcome: deterministic, so the workflow ends in SUCCESS and
 * releases deduplication. A transient failure (kei's read API unreachable or restarting) is thrown on for the step's
 * retries. Only plain values are returned: an error instance would not survive DBOS's serialization of the step.
 */
function refusal(error: unknown): IngestionFailure {
  if (!(error instanceof ApiError) || (error as { transient?: unknown }).transient === true) throw error
  const status = error.status === 422 ? 422 : 502
  return { ok: false, status, code: error.code, message: error.message }
}

/** kei's output must name the bytes and the page layout it was given before its result is read. */
function reportedForInput(ok: KeiConvertOk, input: IngestionInput): void {
  if (ok.source_sha256 !== input.sourceSha256)
    throw new ApiError(502, 'source_ingestion_failed', 'The Parsing Service converted another Source Document.')
  if (ok.page_source !== input.pageSource)
    throw new ApiError(502, 'source_ingestion_failed', 'The Parsing Service converted another page layout.')
}

async function publish(
  store: IngestionStore,
  input: IngestionInput,
  converted: ConvertedPackage,
  packageStore: PackageStore,
): Promise<IngestionOutcome> {
  // The Studio acceptance boundary: the owner-checked transaction and the (project, content) constraint.
  const published = await store.ingestSourceDocument(input.projectContextId, {
    contentSha256: input.sourceSha256,
    mediaType: 'application/pdf',
    originalName: input.originalName,
    ...converted.descriptor,
    ...converted.provenance,
    // The package's bytes are not in this step (nor in DBOS history): a package that vanished is refused, not re-saved.
    ensureRetained: async (descriptor) => {
      if (!(await packageStore.available(descriptor))) throw new Error('The published canonical package is unavailable.')
    },
  })
  if (!published) {
    await discardPublishedPackage(converted, store)
    return { ok: false, status: 404, code: 'not_found', message: 'Project Context was not found.' }
  }
  // Another publication of this content won (or this one replays): keep its package and drop this attempt's.
  if (!sameDescriptor(published.descriptor, converted.descriptor)) await discardPublishedPackage(converted, store)
  return { ok: true, sourceDocument: ingestedOutput(published), pageCount: converted.pageCount }
}

export async function ingestSourceWorkflow(input: IngestionInput, ports: IngestionWorkflowPorts): Promise<IngestionOutcome> {
  const { steps, kei } = ports
  const store = ports.storeFor(input.owner)
  const workflowId = ingestWorkflowId(input.projectContextId, input.attemptId)
  // Once the outcome is decided, a staged file that cannot be removed is left for garbage collection (the workflow
  // is terminal) rather than turning that outcome into a failure.
  const removeStaged = () => steps.step('removeStagedSource', () => removeStagedSource(ports.inboxRoot, input.source))
    .catch((error: unknown) => {
      if (isWorkflowCancellation(error)) throw error
      console.warn('Could not remove a staged Source Document upload; garbage collection will.')
    })
  // Active deduplication is not permanent replay: content published after the request's precheck replays here.
  const replay = await steps.step('replayCompletedContent', () => completed(store, input, ports))
  if (replay) {
    await removeStaged()
    return replay
  }
  const child = keiConvertWorkflowId(workflowId)
  await steps.step('submitToKei', () => kei.submit({
    workflow: 'convert',
    workflowId: child,
    queueName: input.lane,
    priority: CONVERSION_PRIORITY,
    timeoutMs: conversionTimeoutMs(input.pageCount),
    authenticatedUser: input.owner,
    attributes: { projectContextId: input.projectContextId },
    request: {
      source: input.source, source_sha256: input.sourceSha256, source_name: input.originalName,
      page_source: input.pageSource, ingest: null, model: input.models.ocr, layout_model: input.models.layout,
      cut: 'auto', debug: false,
    },
  }), SUBMIT_TO_KEI_RETRY)
  let outcome: IngestionOutcome
  try {
    let polled: KeiPoll
    do polled = await steps.step('pollKei', () => kei.poll(child, steps.cancelSignal()))
    while (polled.state === 'live')
    const settled = settleKei(polled, keiConvertOkSchema)
    if (!settled.ok) {
      await removeStaged()
      return { ok: false, ...conversionFailure(settled) }
    }
    // No bytes enter DBOS history: the step reads the staged file itself and returns a package descriptor.
    const accepted = await steps.step('acceptConversion', async (): Promise<ConvertedPackage | IngestionFailure> => {
      try {
        reportedForInput(settled.value, input)
        return await packageConversion({
          readBase: ports.readBase, runId: settled.value.run_id, generation: settled.value.generation,
          pdf: await readStagedSource(ports.inboxRoot, input.source), originalName: input.originalName,
          signal: steps.cancelSignal(), fetcher: ports.fetcher, packageStore: ports.packageStore,
        })
      } catch (error) {
        return refusal(error)
      }
    }, ARTIFACT_READ_RETRY)
    if ('ok' in accepted) {
      await removeStaged()
      return accepted
    }
    outcome = await steps.step('publishSourceDocument', () => publish(store, input, accepted, ports.packageStore))
  } catch (error) {
    if (isWorkflowCancellation(error)) throw error
    // A parent that fails unexpectedly after submitToKei cancels its kei child before rethrowing (spec, *Studio → kei*).
    // A cancel that fails too is logged: the original failure is the one the workflow records.
    await steps.step('cancelKeiChild', () => kei.cancel(child)).catch((cancelError: unknown) => {
      if (isWorkflowCancellation(cancelError)) throw cancelError
      console.warn('Could not cancel the kei conversion of a failed Source Document ingestion.')
    })
    throw error
  }
  await removeStaged()
  return outcome
}

/** Registers `ingestSource` under its fixed name; only registerStudioWorkflows() calls it, before DBOS.launch(). */
export function registerIngestionWorkflow(ports: () => IngestionWorkflowPorts): void {
  DBOS.registerWorkflow(async (input: IngestionInput) => ingestSourceWorkflow(input, ports()), { name: INGEST_SOURCE })
}
