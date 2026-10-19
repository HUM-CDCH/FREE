import { createHash } from 'node:crypto'
import type { DBOSClient } from '@dbos-inc/dbos-sdk'
import { CONVERSION_OVERHEAD_MS, expectedConversionMs, keiConvertWorkflowId, SMALL_DOCUMENT_PAGES } from 'extraction/kei-handoff'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { studioDbos } from '../server/dbos.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { MAX_NAMED_INGESTIONS, type SourceIngestion } from '../shared/sourceDocumentIngestion.contract.js'
import { ApiError, json, noStore, noStoreError, persistenceUnavailable } from './_http.js'
import { createConversionQueueReader, type ConversionQueue } from './_conversion_queue.js'
import { INGEST_SOURCE } from './_ingestion_workflow.js'
import { readStagedSource, removeStagedSource, sourceInboxRoot, stagedSourceExists } from './_source_inbox.js'
import { attemptOf, classifyOutcome, isQuiescent, type IngestionAttempt } from './_source_ingestion_outcome.js'
import { admitUpload, type Dependencies as AdmissionDependencies } from './source_documents.js'

export const RECENT_SUCCESS_MS = 15 * 60 * 1000
export const FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const LIVE = ['ENQUEUED', 'DELAYED', 'PENDING'] as const
const TERMINAL = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const

type SourceIngestionStore = Pick<
  ResearcherProjectStore,
  'researcherAccountId' | 'modelOperationScopeExists' | 'findSourceDocumentIdsByContent'
>

const notFound = () => new ApiError(404, 'not_found', 'Source Ingestion was not found.')

/** The route's project and, under it, the decoded workflow ID (null for the collection) and whether it names Retry. */
function route(pathname: string): { projectId: string; workflowId: string | null; retry: boolean } {
  const match = /^\/api\/project-contexts\/([^/]+)\/source-ingestions(?:\/([^/]+)(\/retry)?)?$/.exec(pathname)
  if (!match) throw notFound()
  if (!canonicalUuidSchema.safeParse(match[1]).success)
    throw new ApiError(422, 'invalid_request', 'projectContextId must be a canonical lowercase UUID.')
  if (match[2] === undefined) return { projectId: match[1], workflowId: null, retry: false }
  try {
    return { projectId: match[1], workflowId: decodeURIComponent(match[2]), retry: match[3] !== undefined }
  } catch {
    throw notFound()
  }
}

/** The staged PDF an attempt's input names, when the record carries one. */
const stagedOf = (attempt: IngestionAttempt): string | null =>
  typeof attempt.input.source === 'string' ? attempt.input.source : null

/**
 * Live attempts at any age, successes of the last fifteen minutes, failures of the last thirty days that neither a
 * published document nor a newer attempt of the same content resolved, and every named attempt whatever its age.
 * Oldest first.
 */
export function projectIngestions(input: {
  projectContextId: string
  attempts: readonly IngestionAttempt[]
  named: ReadonlySet<string>
  /** Content hash → Source Document ID for the failures' contents. */
  published: ReadonlyMap<string, string>
  /** The failed attempts whose staged PDF Studio still holds, so Retry needs no new upload. */
  retained?: ReadonlySet<string>
  nowMs: number
  /** Every project's live conversions and kei's calibration; null estimates from this project alone. */
  queue?: ConversionQueue | null
}): SourceIngestion[] {
  const attempts = [...input.attempts].sort((a, b) =>
    a.status.createdAt - b.status.createdAt || a.status.workflowID.localeCompare(b.status.workflowID))
  const newestOfContent = new Map<string, string>()
  for (const attempt of attempts) newestOfContent.set(attempt.input.sourceSha256, attempt.status.workflowID)
  const estimates = liveEstimates(attempts, input.nowMs, input.queue ?? null)
  return attempts.flatMap(({ status, input: recorded }): SourceIngestion[] => {
    const common = { workflowId: status.workflowID, name: recorded.originalName, createdAt: new Date(status.createdAt).toISOString() }
    const outcome = classifyOutcome(status)
    if (outcome.kind === 'live') return [{ ...common, ...estimates.get(status.workflowID), status: outcome.status }]
    const completedMs = status.completedAt ?? status.updatedAt ?? status.createdAt
    const completedAt = new Date(completedMs).toISOString()
    const named = input.named.has(status.workflowID)
    // A failure a newer attempt of the same content superseded is that attempt's to report.
    if (outcome.kind === 'failed' && !named && newestOfContent.get(recorded.sourceSha256) !== status.workflowID) return []
    // A stopped attempt whose content is a Source Document (a crash after publication) is the success it was.
    const published = outcome.kind === 'succeeded' ? outcome.sourceDocumentId : input.published.get(recorded.sourceSha256)
    if (published)
      return named || input.nowMs - completedMs <= RECENT_SUCCESS_MS
        ? [{ ...common, status: 'succeeded', completedAt, sourceDocumentId: published }]
        : []
    if (outcome.kind !== 'failed') return []
    const retryable = input.retained?.has(status.workflowID) ? { retryable: true as const } : {}
    return [{ ...common, status: 'failed', completedAt, failure: outcome.failure, ...retryable }]
  })
}

type LiveEstimate = { pageCount?: number; estimatedCompletionAt?: string }

/**
 * Each live attempt's page count and expected completion. A lane converts one document at a time, so a conversion
 * starts when the one before it finishes, and an overdue one holds back those behind it until now. With `queue`, the
 * lanes are every project's live conversions, costed from kei's calibrated history (a job of unknown size as the
 * lane's typical one), and an attempt not yet on its lane waits behind all of them. Without it, only this project's
 * attempts are seen, at kei's measured cost. This project's attempt of unknown size has no estimate; without `queue`,
 * neither do those behind it.
 */
export function liveEstimates(
  attempts: readonly IngestionAttempt[], nowMs: number, queue: ConversionQueue | null = null,
): Map<string, LiveEstimate> {
  const cost = (pages: number) => expectedConversionMs(pages, queue?.msPerPage ?? undefined)
  const onLane = new Map<string, number>()
  const laneFree = new Map<string, number | null>()
  for (const [lane, jobs] of queue?.lanes ?? []) {
    let free = nowMs
    for (const job of jobs) {
      const completion = (job.startedAt ?? free) + cost(job.pages ?? queue!.typicalPages.get(lane) ?? SMALL_DOCUMENT_PAGES)
      onLane.set(job.conversionId, completion)
      free = Math.max(completion, nowMs)
    }
    laneFree.set(lane, free)
  }
  const estimates = new Map<string, LiveEstimate>()
  for (const { status, input } of attempts) {
    if (classifyOutcome(status).kind !== 'live') continue
    const pages = Number.isInteger(input.pageCount) && input.pageCount! > 0 ? input.pageCount! : null
    const lane = typeof input.lane === 'string' ? input.lane : null
    const converting = onLane.get(keiConvertWorkflowId(status.workflowID))
    if (converting !== undefined || pages === null || lane === null) {
      estimates.set(status.workflowID, pages === null ? {} : {
        pageCount: pages, ...converting !== undefined && { estimatedCompletionAt: new Date(converting).toISOString() },
      })
      if (converting === undefined && lane !== null && pages === null) laneFree.set(lane, null)
      continue
    }
    const free = laneFree.has(lane) ? laneFree.get(lane)! : status.createdAt
    if (free === null) {
      estimates.set(status.workflowID, { pageCount: pages })
      continue
    }
    const completion = Math.max(free, status.createdAt) + cost(pages)
    estimates.set(status.workflowID, { pageCount: pages, estimatedCompletionAt: new Date(completion).toISOString() })
    laneFree.set(lane, Math.max(completion, nowMs))
  }
  return estimates
}

/** The lanes as the listing reads them, one reader per process so its calibration is shared. */
const conversionQueue = createConversionQueueReader({
  kei: () => studioDbos().kei, admission: () => studioDbos().admission, overheadMs: CONVERSION_OVERHEAD_MS,
})

/**
 * `GET …/source-ingestions[?workflowId=…]`: the project's Source Ingestions. The browser's queue only sends files, so
 * this is how an upload stays on the page after a reload or in another tab; named IDs are answered whatever their
 * age, so a tab never loses one it is waiting on.
 */
export function createSourceIngestionListing(
  store: SourceIngestionStore,
  admission: () => Pick<DBOSClient, 'listWorkflows'> = () => studioDbos().admission,
  now: () => number = Date.now,
  readConversionQueue: () => Promise<ConversionQueue> = conversionQueue,
  isStaged: (relative: string) => Promise<boolean> = (relative) => stagedSourceExists(sourceInboxRoot(), relative),
) {
  const unavailable = (cause: unknown) => persistenceUnavailable(cause, 'Source Document ingestion status is unavailable.')
  return async function getSourceIngestions(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const { projectId, workflowId } = route(url.pathname)
      if (workflowId !== null) throw notFound()
      const named = [...new Set(url.searchParams.getAll('workflowId'))]
      if (named.length > MAX_NAMED_INGESTIONS)
        throw new ApiError(422, 'invalid_request', `Name at most ${MAX_NAMED_INGESTIONS} Source Ingestions.`)
      // Only PostgreSQL authorizes: the workflow's user and attributes locate the scope, they never grant it.
      const owned = await store.modelOperationScopeExists(projectId, null).catch((cause) => { throw unavailable(cause) })
      if (!owned) throw new ApiError(404, 'not_found', 'Project Context was not found.')
      const client = admission()
      const scope = {
        workflowName: INGEST_SOURCE,
        attributes: { projectContextId: projectId },
        authenticatedUser: store.researcherAccountId,
        loadInput: true,
      }
      const read = <T>(promise: Promise<T>) => promise.catch((cause) => { throw unavailable(cause) })
      // Sequential on purpose: a workflow that settles between two reads is caught by the later one.
      const live = await read(client.listWorkflows({ ...scope, status: [...LIVE], loadOutput: false }))
      const terminal = await read(client.listWorkflows({
        ...scope, status: [...TERMINAL], loadOutput: true, completedAfter: new Date(now() - FAILURE_RETENTION_MS).toISOString(),
      }))
      const namedStatuses = named.length
        ? await read(client.listWorkflows({ workflowIDs: named, loadInput: true, loadOutput: true }))
        : []
      const byId = new Map<string, IngestionAttempt>()
      let skipped = 0
      for (const status of [...live, ...terminal, ...namedStatuses]) {
        // A named record is checked like any other: this account's, this project's, an ingestSource attempt.
        const attempt = status.authenticatedUser === store.researcherAccountId ? attemptOf(status, projectId) : null
        if (attempt) byId.set(status.workflowID, attempt) // later reads win: they are newer
        else if (!named.includes(status.workflowID)) skipped += 1
      }
      if (skipped) console.warn(`Skipped ${skipped} unreadable Source Ingestion record(s).`)
      const failed = [...byId.values()].filter((attempt) => classifyOutcome(attempt.status).kind === 'failed')
      const failedContent = failed.map((attempt) => attempt.input.sourceSha256)
      // Retry is offered only while the PDF is still staged; an unreadable inbox offers Upload again instead.
      const retained = new Set((await Promise.all(failed.map(async (attempt) => {
        const staged = stagedOf(attempt)
        return staged && await isStaged(staged).catch(() => false) ? [attempt.status.workflowID] : []
      }))).flat())
      const published = await store.findSourceDocumentIdsByContent(projectId, failedContent)
        .catch((cause) => { throw unavailable(cause) })
      const attemptList = [...byId.values()]
      // The lanes only refine an estimate: unreadable, the listing still answers, from this project alone.
      const queue = attemptList.some((attempt) => classifyOutcome(attempt.status).kind === 'live')
        ? await readConversionQueue().catch((cause: unknown) => {
          console.warn('Conversion lanes are unreadable; estimating from this project alone.', cause)
          return null
        })
        : null
      const ingestions = projectIngestions({
        projectContextId: projectId, attempts: attemptList, named: new Set(named), published, retained, nowMs: now(), queue,
      })
      return json({ ingestions, absent: named.filter((id) => !byId.has(id)) }, { headers: noStore })
    } catch (error) {
      return noStoreError(error)
    }
  }
}

/**
 * `DELETE …/source-ingestions/<workflowId>`: dismisses a failed Source Ingestion by deleting its history and that of
 * every older failed attempt of the same content (which it superseded), all or nothing under M6's quiescence rule.
 */
export function createSourceIngestionDismissal(
  store: Pick<ResearcherProjectStore, 'researcherAccountId' | 'modelOperationScopeExists'>,
  admission: () => Pick<DBOSClient, 'getWorkflow' | 'listWorkflows' | 'deleteWorkflows'> = () => studioDbos().admission,
  bootTimestampMs: () => number = () => studioDbos().bootTimestampMs,
  inboxRoot: () => string = sourceInboxRoot,
) {
  const unavailable = (cause: unknown) => persistenceUnavailable(cause, 'Source Document ingestion status is unavailable.')
  const done = () => new Response(null, { status: 204, headers: noStore })
  return async function dismissSourceIngestion(request: Request): Promise<Response> {
    try {
      const { projectId, workflowId, retry } = route(new URL(request.url).pathname)
      if (workflowId === null || retry) throw notFound()
      const owned = await store.modelOperationScopeExists(projectId, null).catch((cause) => { throw unavailable(cause) })
      if (!owned) throw notFound()
      const client = admission()
      const recorded = await client.getWorkflow(workflowId).catch((cause) => { throw unavailable(cause) })
      if (!recorded) return done()
      const attempt = recorded.authenticatedUser === store.researcherAccountId ? attemptOf(recorded, projectId) : null
      if (!attempt) throw notFound()
      if (classifyOutcome(recorded).kind !== 'failed')
        throw new ApiError(409, 'ingestion_not_dismissible', 'Only a failed Source Ingestion can be dismissed.')
      // The failures this row superseded go with it, or the next read would show the older one again.
      const terminal = await client.listWorkflows({
        workflowName: INGEST_SOURCE,
        attributes: { projectContextId: projectId },
        authenticatedUser: store.researcherAccountId,
        status: [...TERMINAL],
        loadInput: true,
        loadOutput: true,
      }).catch((cause) => { throw unavailable(cause) })
      const chain = [recorded, ...terminal.filter((status) => status.workflowID !== workflowId)]
        .filter((status) => attemptOf(status, projectId)?.input.sourceSha256 === attempt.input.sourceSha256)
        .filter((status) => classifyOutcome(status).kind === 'failed')
      // M6: a stopped attempt's history goes only once nothing in this process can still write it.
      const boot = bootTimestampMs()
      if (chain.some((status) => !isQuiescent(status, boot)))
        throw new ApiError(409, 'ingestion_stopping', 'This Source Ingestion is still stopping. Try again shortly.')
      await client.deleteWorkflows(chain.map((status) => status.workflowID).sort())
        .catch((cause) => { throw unavailable(cause) })
      // The chain is quiescent, so no step reads its PDFs; one left behind goes with garbage collection.
      for (const status of chain) {
        const staged = stagedOf(attemptOf(status, projectId)!)
        if (staged) await removeStagedSource(inboxRoot(), staged).catch(() => undefined)
      }
      return done()
    } catch (error) {
      return noStoreError(error)
    }
  }
}

/**
 * `POST …/source-ingestions/<workflowId>/retry`: admits a failed upload again from the PDF its attempt kept (ADR 0014,
 * 4), with the owner's current models, as a new upload of the same bytes would be. The failed attempt's file goes once
 * the new attempt is admitted; its history stays, superseded in the listing by the newer attempt. 410 when Studio no
 * longer holds the PDF: the researcher uploads it again.
 */
export function createSourceIngestionRetry(
  store: Pick<ResearcherProjectStore, 'researcherAccountId' | 'modelOperationScopeExists' | 'findSourceDocumentByContent'>,
  admission: () => Pick<DBOSClient, 'getWorkflow'> = () => studioDbos().admission,
  bootTimestampMs: () => number = () => studioDbos().bootTimestampMs,
  dependencies: AdmissionDependencies = {},
) {
  const unavailable = (cause: unknown) => persistenceUnavailable(cause, 'Source Document ingestion status is unavailable.')
  return async function retrySourceIngestion(request: Request): Promise<Response> {
    try {
      const { projectId, workflowId, retry } = route(new URL(request.url).pathname)
      if (workflowId === null || !retry) throw notFound()
      const owned = await store.modelOperationScopeExists(projectId, null).catch((cause) => { throw unavailable(cause) })
      if (!owned) throw notFound()
      const recorded = await admission().getWorkflow(workflowId).catch((cause) => { throw unavailable(cause) })
      const attempt = recorded && recorded.authenticatedUser === store.researcherAccountId ? attemptOf(recorded, projectId) : null
      if (!recorded || !attempt) throw notFound()
      if (classifyOutcome(recorded).kind !== 'failed')
        throw new ApiError(409, 'ingestion_not_retryable', 'Only a failed Source Ingestion can be retried.')
      // As for dismissal (M6): a stopping attempt may still remove the file this retry would read.
      if (!isQuiescent(recorded, bootTimestampMs()))
        throw new ApiError(409, 'ingestion_stopping', 'This Source Ingestion is still stopping. Try again shortly.')
      const root = dependencies.inboxRoot ?? sourceInboxRoot()
      const gone = () => new ApiError(410, 'source_not_retained', 'Studio no longer holds this PDF. Upload it again.')
      const staged = stagedOf(attempt)
      if (!staged) throw gone()
      const pdf = await readStagedSource(root, staged).catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw gone()
        throw persistenceUnavailable(cause, 'Source Document storage is unavailable.')
      })
      if (createHash('sha256').update(pdf).digest('hex') !== attempt.input.sourceSha256) throw gone()
      const admitted = await admitUpload(store, dependencies, projectId, {
        pdf, originalName: attempt.input.originalName, pageSource: attempt.input.pageSource === 'ingest' ? 'ingest' : 'pdf',
      })
      // Admitted again, or already a Source Document: this attempt's copy is no longer anyone's input.
      if (admitted.ok) await removeStagedSource(root, staged).catch(() => undefined)
      return admitted
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export function createResearcherApiHandlers(store: ResearcherProjectStore) {
  return {
    GET: createSourceIngestionListing(store),
    DELETE: createSourceIngestionDismissal(store),
    POST: createSourceIngestionRetry(store),
  }
}
