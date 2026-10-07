/**
 * `ingestSource` (spec, *Background work*): one upload attempt of a PDF a request staged in the source inbox. It
 * rechecks completed content, hands the staged file to kei's `convert` on the lane fixed at admission with the models
 * frozen at admission, accepts and packages kei's result, and publishes it through the owner's store, whose
 * (project, content) constraint makes every repeat return the one Source Document.
 */
import { DBOS } from '@dbos-inc/dbos-sdk'
import { keiConvertWorkflowId, type ConversionLane } from 'extraction/kei-handoff'
import type { PersistedSourceDocument, ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { discardPublishedPackage, packagePageCount, sameDescriptor, type ConvertedPackage } from './_kei_conversion.js'
import { ingestWorkflowId } from './_source_inbox.js'
import { convertStagedSource, removeStaged, withKeiChild, type SourceConversionPorts } from './_source_conversion.js'

// Built beside the staged file's name, so garbage collection maps a file back to this ID with the same builder.
export { ingestWorkflowId }

export const INGEST_SOURCE = 'ingestSource'

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

export type IngestionWorkflowPorts = SourceConversionPorts & Readonly<{ storeFor(owner: string): IngestionStore }>

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

async function publish(
  store: IngestionStore,
  input: IngestionInput,
  converted: ConvertedPackage,
  packageStore: IngestionWorkflowPorts['packageStore'],
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
  const { steps } = ports
  const store = ports.storeFor(input.owner)
  // Active deduplication is not permanent replay: content published after the request's precheck replays here.
  const replay = await steps.step('replayCompletedContent', () => completed(store, input, ports))
  if (replay) {
    await removeStaged(ports, input.source)
    return replay
  }
  const child = keiConvertWorkflowId(ingestWorkflowId(input.projectContextId, input.attemptId))
  const outcome = await withKeiChild(ports, child, async () => {
    const converted = await convertStagedSource(ports, child, { ...input, attributes: { projectContextId: input.projectContextId } })
    if ('ok' in converted) return converted
    return steps.step('publishSourceDocument', () => publish(store, input, converted, ports.packageStore))
  })
  await removeStaged(ports, input.source)
  return outcome
}

/** Registers `ingestSource` under its fixed name; only registerStudioWorkflows() calls it, before DBOS.launch(). */
export function registerIngestionWorkflow(ports: () => IngestionWorkflowPorts): void {
  DBOS.registerWorkflow(async (input: IngestionInput) => ingestSourceWorkflow(input, ports()), { name: INGEST_SOURCE })
}
