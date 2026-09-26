import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ReprocessConflictError } from '../../../packages/db/src/project-store.js'
import type { ReprocessInput, ReprocessOutcome } from './_reprocess_workflow.js'
import { createSourceDocumentReprocessing } from './source_reprocess.js'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const DOCUMENT = '22222222-2222-4222-8222-222222222222'
const KEY = '33333333-3333-4333-8333-333333333333'
const HEAD = '44444444-4444-4444-8444-444444444444'
const OWNER = '55555555-5555-4555-8555-555555555555'
const DESCRIPTOR = { artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64) }
const BODY = { requestKey: KEY, expectedRepresentationId: HEAD, layout: 'pages' }
const fingerprint = createHash('sha256').update(JSON.stringify([DOCUMENT, HEAD, 'pages'])).digest('hex')
const published = { sourceDocumentId: DOCUMENT, name: 'report.pdf', createdAt: new Date('2026-09-26T10:00:00Z'),
  sourceRepresentationId: '66666666-6666-4666-8666-666666666666', revisionNumber: 2, descriptor: DESCRIPTOR }
const outcome: ReprocessOutcome = { ok: true, revision: {
  sourceDocumentId: DOCUMENT, name: 'report.pdf', createdAt: published.createdAt.toISOString(),
  sourceRepresentationId: published.sourceRepresentationId, revisionNumber: 2,
}, pageCount: 3 }

function request(body: object = BODY) {
  return new Request(`http://test/api/project-contexts/${PROJECT}/source-documents/${DOCUMENT}/reprocess`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

function harness(options: {
  replay?: boolean
  known?: string
  head?: string
  outcome?: ReprocessOutcome
  pending?: boolean
  timeout?: boolean
} = {}) {
  let recorded = options.known
  let reads = 0
  const admission = {
    enqueue: vi.fn(async (enqueued: { workflowID: string }, input: ReprocessInput) => {
      recorded = input.requestFingerprint
      return { workflowID: enqueued.workflowID }
    }),
    listWorkflows: vi.fn(async (query: { loadInput?: boolean }) => {
      reads += 1
      if (!recorded) return []
      return [{ status: options.pending || options.timeout ? 'PENDING' : 'SUCCESS',
        input: query.loadInput ? [{ requestFingerprint: recorded }] : undefined,
        output: query.loadInput ? undefined : options.outcome ?? outcome }]
    }),
  }
  const store = {
    researcherAccountId: OWNER,
    findReprocessedSourceDocument: vi.fn(async () => options.replay ? published : null),
    getDocumentReopenSnapshot: vi.fn(async () => ({ sourceDocument: { name: 'report.pdf' },
      sourceRepresentation: { sourceRepresentationId: options.head ?? HEAD } })),
    getSourceRepresentation: vi.fn(async () => DESCRIPTOR),
  }
  const readPackage = vi.fn(async () => ({ bytes: new TextEncoder().encode(JSON.stringify({ page_count: 3 })), mediaType: 'application/json' }))
  const ingestionModels = vi.fn(async () => ({ ocr: 'surya', layout: 'layout_heron_101' }))
  const handler = createSourceDocumentReprocessing(store as never, {
    admission: admission as never, readPackage, ingestionModels,
    resultTimeoutMs: options.timeout ? 0 : 100, resultPollIntervalMs: 1,
  })
  return { admission, store, readPackage, ingestionModels, handler, reads: () => reads }
}

describe('Source Document reprocess admission', () => {
  it('replays a published request key without starting or reading a workflow', async () => {
    const h = harness({ replay: true })
    const response = await h.handler(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sourceRepresentationId: published.sourceRepresentationId, revisionNumber: 2, pageCount: 3 })
    expect(h.reads()).toBe(0)
    expect(h.admission.enqueue).not.toHaveBeenCalled()
  })

  it('joins a running request key without resolving the current choice again', async () => {
    const h = harness({ known: fingerprint })
    const response = await h.handler(request())
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ revisionNumber: 2 })
    expect(h.admission.enqueue).not.toHaveBeenCalled()
    expect(h.ingestionModels).not.toHaveBeenCalled()
  })

  it('rejects a key reused with another fingerprint and a new key against a stale head', async () => {
    const reused = harness({ known: 'another fingerprint' })
    expect((await reused.handler(request())).status).toBe(409)
    expect(reused.admission.enqueue).not.toHaveBeenCalled()
    const stale = harness({ head: published.sourceRepresentationId })
    expect((await stale.handler(request())).status).toBe(409)
    expect(stale.admission.enqueue).not.toHaveBeenCalled()
  })

  it('enqueues on studio with the stored page count lane, owner and current models', async () => {
    const h = harness()
    const response = await h.handler(request())
    expect(response.status).toBe(201)
    expect(h.admission.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      workflowName: 'reprocessSource', queueName: 'studio', workflowID: `reprocess:${DOCUMENT}:${KEY}`,
      authenticatedUser: OWNER,
      attributes: { projectContextId: PROJECT, sourceDocumentId: DOCUMENT, sourceRepresentationRevisionId: HEAD },
    }), expect.objectContaining({ pageCount: 3, lane: 'kei-convert-small',
      models: { ocr: 'surya', layout: 'layout_heron_101' }, requestFingerprint: fingerprint }))
  })

  it('a 504 detaches without cancelling its workflow', async () => {
    const h = harness({ known: fingerprint, pending: true, timeout: true })
    const response = await h.handler(request())
    expect(response.status).toBe(504)
    expect(h.admission.enqueue).not.toHaveBeenCalled()
  })

  it('maps an owner-store key conflict to 409', async () => {
    const h = harness({ replay: true })
    h.store.findReprocessedSourceDocument.mockRejectedValueOnce(new ReprocessConflictError())
    expect((await h.handler(request())).status).toBe(409)
  })
})
