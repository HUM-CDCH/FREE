import { createHash } from 'node:crypto'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { keiConvertWorkflowId, type ConversionLane } from 'extraction/kei-handoff'
import { ARTIFACT_READ_RETRY } from 'extraction/workflow-steps'
import { ReprocessConflictError, type ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { discardPublishedPackage, sameDescriptor, type ConvertedPackage } from './_kei_conversion.js'
import { reprocessSourcePath, reprocessWorkflowId, stageSource } from './_source_inbox.js'
import { convertStagedSource, removeStaged, withKeiChild, type SourceConversionPorts } from './_source_conversion.js'

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

export type ReprocessWorkflowPorts = SourceConversionPorts & Readonly<{ storeFor(owner: string): ReprocessStore }>

async function publishRevision(
  store: ReprocessStore,
  input: ReprocessInput,
  contentSha256: string,
  converted: ConvertedPackage,
  packageStore: ReprocessWorkflowPorts['packageStore'],
): Promise<ReprocessOutcome> {
  try {
    const revision = await store.reprocessSourceDocument(input.projectContextId, input.sourceDocumentId, {
      contentSha256, mediaType: 'application/pdf', originalName: input.originalName,
      ...converted.descriptor, ...converted.provenance, requestKey: input.requestKey,
      requestFingerprint: input.requestFingerprint, expectedRepresentationId: input.expectedRepresentationId,
      ensureRetained: async (descriptor) => {
        if (!(await packageStore.available(descriptor))) throw new Error('The published canonical package is unavailable.')
      },
    })
    if (!revision) {
      await discardPublishedPackage(converted, store)
      return { ok: false, status: 404, code: 'not_found', message: 'Source Document was not found.' }
    }
    if (!sameDescriptor(revision.descriptor, converted.descriptor)) await discardPublishedPackage(converted, store)
    return { ok: true, revision: {
      sourceDocumentId: revision.sourceDocumentId, name: revision.name,
      createdAt: new Date(revision.createdAt).toISOString(),
      sourceRepresentationId: revision.sourceRepresentationId, revisionNumber: revision.revisionNumber,
    }, pageCount: converted.pageCount }
  } catch (error) {
    if (!(error instanceof ReprocessConflictError)) throw error
    await discardPublishedPackage(converted, store)
    return { ok: false, status: 409, code: 'invalid_request', message: error.message }
  }
}

export async function reprocessSourceWorkflow(input: ReprocessInput, ports: ReprocessWorkflowPorts): Promise<ReprocessOutcome> {
  const { steps } = ports
  const store = ports.storeFor(input.owner)
  const source = reprocessSourcePath(input.projectContextId, input.sourceDocumentId, input.requestKey)
  const staged = await steps.step('stageReprocessSource', async () => {
    const descriptor = await store.getSourceRepresentation(input.projectContextId, input.expectedRepresentationId)
    if (!descriptor) return null
    const pdf = (await ports.packageStore.read(descriptor, 'pdf')).bytes
    await stageSource(ports.inboxRoot, source, pdf)
    return createHash('sha256').update(pdf).digest('hex')
  }, ARTIFACT_READ_RETRY)
  if (!staged) return { ok: false, status: 404, code: 'not_found', message: 'Source Document was not found.' }

  const child = keiConvertWorkflowId(reprocessWorkflowId(input.sourceDocumentId, input.requestKey))
  const outcome = await withKeiChild(ports, child, async () => {
    const converted = await convertStagedSource(ports, child, {
      ...input, source, sourceSha256: staged,
      attributes: { projectContextId: input.projectContextId, sourceDocumentId: input.sourceDocumentId,
        sourceRepresentationRevisionId: input.expectedRepresentationId },
    })
    if ('ok' in converted) return converted
    return steps.step('publishRevision', () => publishRevision(store, input, staged, converted, ports.packageStore))
  })
  await removeStaged(ports, source)
  return outcome
}

export function registerReprocessWorkflow(ports: () => ReprocessWorkflowPorts): void {
  DBOS.registerWorkflow(async (input: ReprocessInput) => reprocessSourceWorkflow(input, ports()), { name: REPROCESS_SOURCE })
}
