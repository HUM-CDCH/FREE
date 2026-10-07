/**
 * Converting a staged Source Document PDF with kei, shared by ingestion and reprocessing. convertStagedSource() submits
 * kei's `convert`, polls it, settles its outcome and verifies and packages its result; withKeiChild() cancels the child
 * when anything after submission throws; removeStaged() drops the staged file once an outcome is decided. Publication
 * stays with each workflow. Step names, their order and their stored results are part of each workflow's DBOS history.
 */
import {
  CONVERSION_PRIORITY, conversionTimeoutMs, keiConvertOkSchema, settleKei, SUBMIT_TO_KEI_RETRY,
  type ConversionLane, type KeiConvertOk, type KeiHandoff, type KeiPoll,
} from 'extraction/kei-handoff'
import { ARTIFACT_READ_RETRY, isWorkflowCancellation, type WorkflowSteps } from 'extraction/workflow-steps'
import { ApiError } from './_http.js'
import { conversionFailure, packageConversion, type ConvertedPackage, type PackageStore } from './_kei_conversion.js'
import { readStagedSource, removeStagedSource } from './_source_inbox.js'

export type SourceConversionPorts = Readonly<{
  steps: WorkflowSteps
  kei: KeiHandoff
  /** kei's read API (KEI_EXP_URL), which serves a converted run's manifest and page files. */
  readBase: string
  inboxRoot: string
  packageStore: PackageStore
  /** Reads kei's API; the global fetch unless a test supplies one. */
  fetcher?: typeof fetch
}>

/** What one conversion needs. Both workflow inputs carry these fields, so a spread of the input supplies them. */
export type SourceConversionRequest = Readonly<{
  /** The Project Context's owner: the kei child's authenticated user. */
  owner: string
  /** The staged PDF, relative to the source inbox. */
  source: string
  sourceSha256: string
  originalName: string
  pageSource: 'pdf' | 'ingest'
  pageCount: number | null
  lane: ConversionLane
  models: Readonly<{ ocr: string | null; layout: string | null }>
  /** The parent's attributes, so a scope's kei work is found like its Studio work. */
  attributes: Readonly<Record<string, unknown>>
}>

export type ConversionFailure = { ok: false; status: 422 | 502 | 504; code: string; message: string }

/**
 * Studio's own refusal of kei's answer (a partial parse, another generation, bytes or layout, an unprovable page, a
 * result that cannot be translated or packaged) as a typed outcome: deterministic, so the workflow ends in SUCCESS and
 * releases deduplication. A transient failure (kei's read API unreachable or restarting) is thrown on for the step's
 * retries. Only plain values are returned: an error instance would not survive DBOS's serialization of the step.
 */
function refusal(error: unknown): ConversionFailure {
  if (!(error instanceof ApiError) || (error as { transient?: unknown }).transient === true) throw error
  return { ok: false, status: error.status === 422 ? 422 : 502, code: error.code, message: error.message }
}

/** kei's output must name the bytes and the page layout it was given before its result is read. */
function reportedFor(ok: KeiConvertOk, request: SourceConversionRequest): void {
  if (ok.source_sha256 !== request.sourceSha256)
    throw new ApiError(502, 'source_ingestion_failed', 'The Parsing Service converted another Source Document.')
  if (ok.page_source !== request.pageSource)
    throw new ApiError(502, 'source_ingestion_failed', 'The Parsing Service converted another page layout.')
}

/**
 * Submits kei's `convert` as `child`, polls it to its end and accepts its result as a package, or answers kei's failure
 * or Studio's refusal as a typed outcome. Runs inside withKeiChild(): a throw after submission must cancel the child.
 */
export async function convertStagedSource(
  ports: SourceConversionPorts,
  child: string,
  request: SourceConversionRequest,
): Promise<ConvertedPackage | ConversionFailure> {
  const { steps, kei } = ports
  await steps.step('submitToKei', () => kei.submit({
    workflow: 'convert',
    workflowId: child,
    queueName: request.lane,
    priority: CONVERSION_PRIORITY,
    timeoutMs: conversionTimeoutMs(request.pageCount),
    authenticatedUser: request.owner,
    attributes: request.attributes,
    request: {
      source: request.source, source_sha256: request.sourceSha256, source_name: request.originalName,
      page_source: request.pageSource, ingest: null, model: request.models.ocr, layout_model: request.models.layout,
      cut: 'auto', debug: false,
    },
  }), SUBMIT_TO_KEI_RETRY)
  let polled: KeiPoll
  do polled = await steps.step('pollKei', () => kei.poll(child, steps.cancelSignal()))
  while (polled.state === 'live')
  const settled = settleKei(polled, keiConvertOkSchema)
  if (!settled.ok) return { ok: false, ...conversionFailure(settled) }
  // No bytes enter DBOS history: the step reads the staged file itself and returns a package descriptor.
  return steps.step('acceptConversion', async (): Promise<ConvertedPackage | ConversionFailure> => {
    try {
      reportedFor(settled.value, request)
      return await packageConversion({
        readBase: ports.readBase, runId: settled.value.run_id, generation: settled.value.generation,
        pdf: await readStagedSource(ports.inboxRoot, request.source), originalName: request.originalName,
        signal: steps.cancelSignal(), fetcher: ports.fetcher, packageStore: ports.packageStore,
      })
    } catch (error) {
      return refusal(error)
    }
  }, ARTIFACT_READ_RETRY)
}

/**
 * Runs `body` over kei child `child`. A throw other than the workflow's own cancellation cancels the child before it is
 * rethrown: a submission may have committed even when its acknowledgement was lost. A cancel that fails too is logged;
 * the original failure is the one the workflow records.
 */
export async function withKeiChild<T>(ports: SourceConversionPorts, child: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
    if (isWorkflowCancellation(error)) throw error
    await ports.steps.step('cancelKeiChild', () => ports.kei.cancel(child)).catch((cancelError: unknown) => {
      if (isWorkflowCancellation(cancelError)) throw cancelError
      console.warn(`Could not cancel kei conversion ${child} of a failed Source Document.`)
    })
    throw error
  }
}

/** Removes a staged file once the outcome is decided. One that cannot be removed is left to garbage collection (the
 *  workflow is terminal) rather than turning that outcome into a failure. */
export function removeStaged(ports: SourceConversionPorts, source: string): Promise<void> {
  return ports.steps.step('removeStagedSource', () => removeStagedSource(ports.inboxRoot, source)).catch((error: unknown) => {
    if (isWorkflowCancellation(error)) throw error
    console.warn(`Could not remove staged Source Document ${source}; garbage collection will.`)
  })
}
