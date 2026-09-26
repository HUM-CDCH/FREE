import { createHash } from 'node:crypto'
import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  CONVERSION_PRIORITY, conversionTimeoutMs, keiConvertOkSchema, keiConvertWorkflowId, settleKei, SUBMIT_TO_KEI_RETRY,
  type ConversionLane, type KeiHandoff, type KeiPoll,
} from 'extraction/kei-handoff'
import { ARTIFACT_READ_RETRY, isWorkflowCancellation, type WorkflowSteps } from 'extraction/workflows'
import { ReprocessConflictError, type ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { ApiError } from './_http.js'
import { conversionFailure, discardPublishedPackage, packageConversion, sameDescriptor, type ConvertedPackage, type PackageStore } from './_kei_conversion.js'
import { readStagedSource, removeStagedSource, reprocessSourcePath, stageSource } from './_source_inbox.js'

export const REPROCESS_SOURCE = 'reprocessSource'

export type ReprocessInput = Readonly<{
  projectContextId: string
  sourceDocumentId: string
  requestKey: string
  requestFingerprint: string
  expectedRepresentationId: string
  owner: string
  originalName: string
  pageSource: 'pdf' | 'ingest'
  pageCount: number
  lane: ConversionLane
  models: Readonly<{ ocr: string | null; layout: string | null }>
}>

export type ReprocessOutcome =
  | { ok: true; revision: { sourceDocumentId: string; name: string; createdAt: string; sourceRepresentationId: string; revisionNumber: number }; pageCount: number }
  | { ok: false; status: 404 | 409 | 422 | 502 | 504; code: string; message: string }

type ReprocessStore = Pick<ResearcherProjectStore,
  'getSourceRepresentation' | 'reprocessSourceDocument' | 'discardCanonicalPackage'>

export type ReprocessWorkflowPorts = Readonly<{
  steps: WorkflowSteps
  kei: KeiHandoff
  readBase: string
  inboxRoot: string
  packageStore: PackageStore
  storeFor(owner: string): ReprocessStore
  fetcher?: typeof fetch
}>

function refusal(error: unknown): Extract<ReprocessOutcome, { ok: false }> {
  if (!(error instanceof ApiError) || (error as { transient?: unknown }).transient === true) throw error
  return { ok: false, status: error.status === 422 ? 422 : 502, code: error.code, message: error.message }
}

export async function reprocessSourceWorkflow(input: ReprocessInput, ports: ReprocessWorkflowPorts): Promise<ReprocessOutcome> {
  const { steps, kei } = ports
  const store = ports.storeFor(input.owner)
  const source = reprocessSourcePath(input.projectContextId, input.sourceDocumentId, input.requestKey)
  const removeStaged = () => steps.step('removeStagedSource', () => removeStagedSource(ports.inboxRoot, source))
    .catch((error: unknown) => {
      if (isWorkflowCancellation(error)) throw error
      console.warn('Could not remove a staged Source Document reprocess; garbage collection will.')
    })
  const staged = await steps.step('stageReprocessSource', async () => {
    const descriptor = await store.getSourceRepresentation(input.projectContextId, input.expectedRepresentationId)
    if (!descriptor) return null
    const pdf = (await ports.packageStore.read(descriptor, 'pdf')).bytes
    await stageSource(ports.inboxRoot, source, pdf)
    return createHash('sha256').update(pdf).digest('hex')
  }, ARTIFACT_READ_RETRY)
  if (!staged) return { ok: false, status: 404, code: 'not_found', message: 'Source Document was not found.' }

  const child = keiConvertWorkflowId(`reprocess:${input.sourceDocumentId}:${input.requestKey}`)
  await steps.step('submitToKei', () => kei.submit({
    workflow: 'convert', workflowId: child, queueName: input.lane, priority: CONVERSION_PRIORITY,
    timeoutMs: conversionTimeoutMs(input.pageCount), authenticatedUser: input.owner,
    attributes: { projectContextId: input.projectContextId, sourceDocumentId: input.sourceDocumentId,
      sourceRepresentationRevisionId: input.expectedRepresentationId },
    request: { source, source_sha256: staged, source_name: input.originalName,
      page_source: input.pageSource, ingest: null, model: input.models.ocr, layout_model: input.models.layout,
      cut: 'auto', debug: false },
  }), SUBMIT_TO_KEI_RETRY)
  let outcome: ReprocessOutcome
  try {
    let polled: KeiPoll
    do polled = await steps.step('pollKei', () => kei.poll(child, steps.cancelSignal()))
    while (polled.state === 'live')
    const settled = settleKei(polled, keiConvertOkSchema)
    if (!settled.ok) {
      await removeStaged()
      return { ok: false, ...conversionFailure(settled) }
    }
    const accepted = await steps.step('acceptConversion', async (): Promise<ConvertedPackage | Extract<ReprocessOutcome, { ok: false }>> => {
      try {
        if (settled.value.source_sha256 !== staged || settled.value.page_source !== input.pageSource)
          throw new ApiError(502, 'source_ingestion_failed', 'The Parsing Service converted another Source Document.')
        return await packageConversion({
          readBase: ports.readBase, runId: settled.value.run_id, generation: settled.value.generation,
          pdf: await readStagedSource(ports.inboxRoot, source), originalName: input.originalName,
          signal: steps.cancelSignal(), fetcher: ports.fetcher, packageStore: ports.packageStore,
        })
      } catch (error) { return refusal(error) }
    }, ARTIFACT_READ_RETRY)
    if ('ok' in accepted) {
      await removeStaged()
      return accepted
    }
    outcome = await steps.step('publishRevision', async (): Promise<ReprocessOutcome> => {
      try {
        const revision = await store.reprocessSourceDocument(input.projectContextId, input.sourceDocumentId, {
          contentSha256: staged, mediaType: 'application/pdf', originalName: input.originalName,
          ...accepted.descriptor, ...accepted.provenance, requestKey: input.requestKey,
          requestFingerprint: input.requestFingerprint, expectedRepresentationId: input.expectedRepresentationId,
          ensureRetained: async (descriptor) => {
            if (!(await ports.packageStore.available(descriptor))) throw new Error('The published canonical package is unavailable.')
          },
        })
        if (!revision) {
          await discardPublishedPackage(accepted, store)
          return { ok: false, status: 404, code: 'not_found', message: 'Source Document was not found.' }
        }
        if (!sameDescriptor(revision.descriptor, accepted.descriptor)) await discardPublishedPackage(accepted, store)
        return { ok: true, revision: {
          sourceDocumentId: revision.sourceDocumentId, name: revision.name,
          createdAt: new Date(revision.createdAt).toISOString(),
          sourceRepresentationId: revision.sourceRepresentationId, revisionNumber: revision.revisionNumber,
        }, pageCount: accepted.pageCount }
      } catch (error) {
        if (!(error instanceof ReprocessConflictError)) throw error
        await discardPublishedPackage(accepted, store)
        return { ok: false, status: 409, code: 'invalid_request', message: error.message }
      }
    })
  } catch (error) {
    if (isWorkflowCancellation(error)) throw error
    await steps.step('cancelKeiChild', () => kei.cancel(child)).catch((cancelError: unknown) => {
      if (isWorkflowCancellation(cancelError)) throw cancelError
      console.warn('Could not cancel the kei conversion of a failed Source Document reprocess.')
    })
    throw error
  }
  await removeStaged()
  return outcome
}

export function registerReprocessWorkflow(ports: () => ReprocessWorkflowPorts): void {
  DBOS.registerWorkflow(async (input: ReprocessInput) => reprocessSourceWorkflow(input, ports()), { name: REPROCESS_SOURCE })
}
