import type { WorkflowStatus } from '@dbos-inc/dbos-sdk'
import { describe, expect, it, vi } from 'vitest'
import { sourceIngestionListingSchema } from '../shared/sourceDocumentIngestion.contract'
import { attemptOf, type IngestionAttempt } from './_source_ingestion_outcome.js'
import {
  createSourceIngestionListing,
  FAILURE_RETENTION_MS,
  projectIngestions,
  RECENT_SUCCESS_MS,
} from './source_ingestions.js'

const ACCOUNT = '52000000-0000-4000-8009-000000000001'
const PROJECT = '52000000-0000-4000-8000-000000000001'
const NOW = Date.parse('2026-09-27T12:00:00.000Z')
const attempt = (n: number) => `52000000-0000-4000-8001-0000000000${n.toString(16).padStart(2, '0')}`

/** One `ingestSource` workflow as DBOS lists it. */
function row(n: number, status: string, overrides: Partial<WorkflowStatus> & { sha?: string } = {}): WorkflowStatus {
  const { sha, ...rest } = overrides
  return {
    workflowID: `ingest:${PROJECT}:${attempt(n)}`,
    status,
    workflowName: 'ingestSource',
    workflowClassName: '',
    authenticatedUser: ACCOUNT,
    input: [{ projectContextId: PROJECT, attemptId: attempt(n), owner: ACCOUNT, originalName: `paper-${n}.pdf`, sourceSha256: sha ?? `sha-${n}` }],
    createdAt: NOW - 60_000 + n,
    priority: 0,
    attributes: { projectContextId: PROJECT },
    ...rest,
  }
}
const doc = (n: number) => `52000000-0000-4000-8002-0000000000${String(n).padStart(2, '0')}`
const ok = (n: number) => ({
  ok: true, pageCount: 3,
  sourceDocument: { sourceDocumentId: doc(n), name: `paper-${n}.pdf`, createdAt: '2026-09-27T11:59:00.000Z', sourceRepresentationId: '52000000-0000-4000-8003-000000000001', revisionNumber: 1 },
})
const refused = { ok: false, status: 422, code: 'source_ingestion_failed', message: 'kei refused the PDF.' }
const attempts = (...statuses: WorkflowStatus[]): IngestionAttempt[] => statuses.map((status) => attemptOf(status, PROJECT)!)
const project = (input: Partial<Parameters<typeof projectIngestions>[0]> & { attempts: IngestionAttempt[] }) =>
  projectIngestions({ projectContextId: PROJECT, named: new Set(), published: new Map(), nowMs: NOW, ...input })

type Reads = { live?: WorkflowStatus[]; terminal?: WorkflowStatus[]; named?: WorkflowStatus[]; published?: Map<string, string> }
function handlers(reads: Reads = {}, owns: () => Promise<boolean> = async () => true) {
  const calls: string[] = []
  const client = {
    listWorkflows: vi.fn(async (input: { status?: unknown; workflowIDs?: unknown }) => {
      const which = input.workflowIDs ? 'named' : Array.isArray(input.status) && input.status.includes('PENDING') ? 'live' : 'terminal'
      calls.push(which)
      return reads[which as 'live' | 'terminal' | 'named'] ?? []
    }),
  }
  const store = {
    researcherAccountId: ACCOUNT,
    modelOperationScopeExists: vi.fn(owns),
    findSourceDocumentIdsByContent: vi.fn(async () => reads.published ?? new Map<string, string>()),
  }
  return { client, store, calls, GET: createSourceIngestionListing(store, () => client as never, () => NOW) }
}
const get = (projectContextId: string, named: string[] = []) =>
  new Request(`http://local.test/api/project-contexts/${projectContextId}/source-ingestions${named.length ? `?${named.map((id) => `workflowId=${encodeURIComponent(id)}`).join('&')}` : ''}`)

describe('GET /api/project-contexts/:id/source-ingestions', () => {
  it('reads live work, then terminal work of the last thirty days, then the named IDs, in that order', async () => {
    const named = `ingest:${PROJECT}:${attempt(9)}`
    const { GET, client, calls } = handlers({ live: [row(1, 'PENDING')] })
    const response = await GET(get(PROJECT, [named]))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const scope = { workflowName: 'ingestSource', attributes: { projectContextId: PROJECT }, authenticatedUser: ACCOUNT, loadInput: true }
    expect(calls).toEqual(['live', 'terminal', 'named'])
    expect(client.listWorkflows).toHaveBeenNthCalledWith(1, { ...scope, status: ['ENQUEUED', 'DELAYED', 'PENDING'], loadOutput: false })
    expect(client.listWorkflows).toHaveBeenNthCalledWith(2, {
      ...scope, status: ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'], loadOutput: true,
      completedAfter: new Date(NOW - FAILURE_RETENTION_MS).toISOString(),
    })
    expect(client.listWorkflows).toHaveBeenNthCalledWith(3, { workflowIDs: [named], loadInput: true, loadOutput: true })
  })

  it('a workflow that completes between the live and terminal reads is still listed once, as its terminal record', async () => {
    const { GET } = handlers({ live: [], terminal: [row(1, 'SUCCESS', { output: ok(1), completedAt: NOW - 10 })] })
    const body = sourceIngestionListingSchema.parse(await (await GET(get(PROJECT))).json())
    expect(body.ingestions.map((ingestion) => ingestion.status)).toEqual(['succeeded'])
  })

  it('answers a named ID at any age, and names absent or foreign IDs in absent', async () => {
    const old = row(1, 'SUCCESS', { output: ok(1), completedAt: NOW - 40 * 24 * 3600_000 })
    const foreign = row(2, 'ERROR', { authenticatedUser: 'someone-else' })
    const { GET } = handlers({ named: [old, foreign] })
    const gone = `ingest:${PROJECT}:${attempt(3)}`
    const body = sourceIngestionListingSchema.parse(await (await GET(get(PROJECT, [old.workflowID, foreign.workflowID, gone]))).json())
    expect(body.ingestions).toEqual([expect.objectContaining({ workflowId: old.workflowID, status: 'succeeded' })])
    expect(body.absent.sort()).toEqual([foreign.workflowID, gone].sort())
  })

  it('refuses more than fifty named IDs with 422', async () => {
    const ids = Array.from({ length: 51 }, (_, n) => `ingest:${PROJECT}:${n}`)
    expect((await handlers().GET(get(PROJECT, ids))).status).toBe(422)
  })

  it('resolves failed attempts against published content in one store read', async () => {
    const { GET, store } = handlers({ terminal: [row(1, 'ERROR', { completedAt: NOW - 10, sha: 'published' }), row(2, 'PENDING')] })
    await GET(get(PROJECT))
    expect(store.findSourceDocumentIdsByContent).toHaveBeenCalledExactlyOnceWith(PROJECT, ['published'])
  })

  it('answers 404 without reading DBOS or documents when the account does not own the project', async () => {
    const { GET, client, store } = handlers({ live: [row(1, 'PENDING')] }, async () => false)
    expect((await GET(get(PROJECT))).status).toBe(404)
    expect(client.listWorkflows).not.toHaveBeenCalled()
    expect(store.findSourceDocumentIdsByContent).not.toHaveBeenCalled()
  })

  it('answers 422 for a non-canonical project ID and 503 when DBOS is unavailable', async () => {
    expect((await handlers().GET(get('not-a-uuid'))).status).toBe(422)
    const { GET, client } = handlers()
    client.listWorkflows.mockRejectedValueOnce(new Error('connection refused'))
    expect((await GET(get(PROJECT))).status).toBe(503)
  })

  it('skips an unreadable record and warns once per read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { GET } = handlers({ live: [row(1, 'PENDING', { input: undefined }), row(2, 'PENDING', { workflowName: 'reprocessSource' }), row(4, 'PENDING')] })
    const body = sourceIngestionListingSchema.parse(await (await GET(get(PROJECT))).json())
    expect(body.ingestions.map((ingestion) => ingestion.name)).toEqual(['paper-4.pdf'])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('projectIngestions', () => {
  it('maps each DBOS record to one listed state, oldest first', () => {
    const at = NOW - 1000
    const listed = project({ attempts: attempts(
      row(1, 'ENQUEUED'), row(2, 'DELAYED'), row(3, 'PENDING'),
      row(4, 'SUCCESS', { output: ok(4), completedAt: at }),
      row(5, 'SUCCESS', { output: refused, completedAt: at }),
      row(6, 'ERROR', { completedAt: at }),
      row(7, 'CANCELLED', { completedAt: at }),
      row(8, 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', { completedAt: at }),
    ) })
    expect(listed.map((ingestion) => [ingestion.name, ingestion.status])).toEqual([
      ['paper-1.pdf', 'queued'], ['paper-2.pdf', 'queued'], ['paper-3.pdf', 'parsing'], ['paper-4.pdf', 'succeeded'],
      ['paper-5.pdf', 'failed'], ['paper-6.pdf', 'failed'], ['paper-7.pdf', 'failed'], ['paper-8.pdf', 'failed'],
    ])
    expect(listed[3]).toMatchObject({ sourceDocumentId: doc(4), completedAt: new Date(at).toISOString() })
    expect(listed[4]).toMatchObject({ failure: { code: 'source_ingestion_failed', message: 'kei refused the PDF.' } })
  })

  it('drops an unnamed success older than fifteen minutes but keeps an old failure and old live work', () => {
    const listed = project({ attempts: attempts(
      row(1, 'PENDING', { createdAt: NOW - 40 * 24 * 3600_000 }),
      row(2, 'SUCCESS', { output: ok(2), completedAt: NOW - RECENT_SUCCESS_MS - 1 }),
      row(3, 'SUCCESS', { output: refused, completedAt: NOW - 29 * 24 * 3600_000 }),
    ) })
    expect(listed.map((ingestion) => ingestion.name)).toEqual(['paper-1.pdf', 'paper-3.pdf'])
  })

  it('a newer attempt of the same content supersedes a failure', () => {
    const listed = project({ attempts: attempts(
      row(1, 'SUCCESS', { output: refused, completedAt: NOW - 5000, sha: 'same' }),
      row(2, 'ERROR', { completedAt: NOW - 4000, sha: 'other' }),
      row(3, 'PENDING', { sha: 'same' }),
    ) })
    expect(listed.map((ingestion) => ingestion.name)).toEqual(['paper-2.pdf', 'paper-3.pdf'])
  })

  it('a stopped attempt whose content was published is listed as the success it was', () => {
    const listed = project({
      attempts: attempts(row(1, 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', { completedAt: NOW - 1000, sha: 'published' })),
      published: new Map([['published', doc(7)]]),
    })
    expect(listed).toEqual([expect.objectContaining({ status: 'succeeded', sourceDocumentId: doc(7) })])
  })
})
