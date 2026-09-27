import type { DBOSClient } from '@dbos-inc/dbos-sdk'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { studioDbos } from '../server/dbos.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { MAX_NAMED_INGESTIONS, type SourceIngestion } from '../shared/sourceDocumentIngestion.contract.js'
import { ApiError, json, noStore, noStoreError, persistenceUnavailable } from './_http.js'
import { INGEST_SOURCE } from './_ingestion_workflow.js'
import { attemptOf, classifyOutcome, isQuiescent, type IngestionAttempt } from './_source_ingestion_outcome.js'

export const RECENT_SUCCESS_MS = 15 * 60 * 1000
export const FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const LIVE = ['ENQUEUED', 'DELAYED', 'PENDING'] as const
const TERMINAL = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const

type SourceIngestionStore = Pick<
  ResearcherProjectStore,
  'researcherAccountId' | 'modelOperationScopeExists' | 'findSourceDocumentIdsByContent'
>

const notFound = () => new ApiError(404, 'not_found', 'Source Ingestion was not found.')

/** The route's project and, under it, the decoded workflow ID (null for the collection). */
function route(pathname: string): { projectId: string; workflowId: string | null } {
  const match = /^\/api\/project-contexts\/([^/]+)\/source-ingestions(?:\/([^/]+))?$/.exec(pathname)
  if (!match) throw notFound()
  if (!canonicalUuidSchema.safeParse(match[1]).success)
    throw new ApiError(422, 'invalid_request', 'projectContextId must be a canonical lowercase UUID.')
  if (match[2] === undefined) return { projectId: match[1], workflowId: null }
  try {
    return { projectId: match[1], workflowId: decodeURIComponent(match[2]) }
  } catch {
    throw notFound()
  }
}

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
  nowMs: number
}): SourceIngestion[] {
  const attempts = [...input.attempts].sort((a, b) =>
    a.status.createdAt - b.status.createdAt || a.status.workflowID.localeCompare(b.status.workflowID))
  const newestOfContent = new Map<string, string>()
  for (const attempt of attempts) newestOfContent.set(attempt.input.sourceSha256, attempt.status.workflowID)
  return attempts.flatMap(({ status, input: recorded }): SourceIngestion[] => {
    const common = { workflowId: status.workflowID, name: recorded.originalName, createdAt: new Date(status.createdAt).toISOString() }
    const outcome = classifyOutcome(status)
    if (outcome.kind === 'live') return [{ ...common, status: outcome.status }]
    const completedMs = status.completedAt ?? status.updatedAt ?? status.createdAt
    const completedAt = new Date(completedMs).toISOString()
    const named = input.named.has(status.workflowID)
    // A stopped attempt whose content is a Source Document (a crash after publication) is the success it was.
    const published = outcome.kind === 'succeeded' ? outcome.sourceDocumentId : input.published.get(recorded.sourceSha256)
    if (published)
      return named || input.nowMs - completedMs <= RECENT_SUCCESS_MS
        ? [{ ...common, status: 'succeeded', completedAt, sourceDocumentId: published }]
        : []
    if (outcome.kind !== 'failed') return []
    if (!named && newestOfContent.get(recorded.sourceSha256) !== status.workflowID) return []
    return [{ ...common, status: 'failed', completedAt, failure: outcome.failure }]
  })
}

/**
 * `GET …/source-ingestions[?workflowId=…]`: the project's Source Ingestions. The browser's queue only sends files, so
 * this is how an upload stays on the page after a reload or in another tab; named IDs are answered whatever their
 * age, so a tab never loses one it is waiting on.
 */
export function createSourceIngestionListing(
  store: SourceIngestionStore,
  admission: () => Pick<DBOSClient, 'listWorkflows'> = () => studioDbos().admission,
  now: () => number = Date.now,
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
      const failedContent = [...byId.values()]
        .filter((attempt) => classifyOutcome(attempt.status).kind === 'failed')
        .map((attempt) => attempt.input.sourceSha256)
      const published = await store.findSourceDocumentIdsByContent(projectId, failedContent)
        .catch((cause) => { throw unavailable(cause) })
      const ingestions = projectIngestions({
        projectContextId: projectId, attempts: [...byId.values()], named: new Set(named), published, nowMs: now(),
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
) {
  const unavailable = (cause: unknown) => persistenceUnavailable(cause, 'Source Document ingestion status is unavailable.')
  const done = () => new Response(null, { status: 204, headers: noStore })
  return async function dismissSourceIngestion(request: Request): Promise<Response> {
    try {
      const { projectId, workflowId } = route(new URL(request.url).pathname)
      if (workflowId === null) throw notFound()
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
      return done()
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export function createResearcherApiHandlers(store: ResearcherProjectStore) {
  return { GET: createSourceIngestionListing(store), DELETE: createSourceIngestionDismissal(store) }
}
