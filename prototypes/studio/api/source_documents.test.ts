import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestionInput, IngestionOutcome } from './_ingestion_workflow.js'
import {
  createSourceDocumentDeletion,
  createSourceDocumentIngestion,
  type Dependencies,
} from './source_documents.js'

const ids = {
  project: '11111111-1111-4111-8111-111111111111',
  owner: '22222222-2222-4222-8222-222222222222',
  source: '33333333-3333-4333-8333-333333333333',
  representation: '44444444-4444-4444-8444-444444444444',
}
const PDF = '%PDF-1.7\n'
const PDF_SHA256 = createHash('sha256').update(PDF).digest('hex')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const encoder = new TextEncoder()

const published = {
  sourceDocumentId: ids.source,
  name: 'report.pdf',
  createdAt: '2026-08-12T10:00:00.000Z',
  sourceRepresentationId: ids.representation,
  revisionNumber: 1 as const,
}
const succeeded: IngestionOutcome = { ok: true, sourceDocument: published, pageCount: 12 }

function request(
  fields: Array<[string, string | File]> = [['file', new File([PDF], 'report.pdf', { type: 'application/pdf' })]],
  projectContextId = ids.project,
) {
  const form = new FormData()
  for (const [key, value] of fields) form.append(key, value)
  return new Request(`http://test/api/project-contexts/${projectContextId}/source-documents`, { method: 'POST', body: form })
}

const pdfFile = (name = 'report.pdf', bytes: BlobPart = PDF) => new File([bytes], name, { type: 'application/pdf' })

type Enqueue = (options: { workflowID: string } & Record<string, unknown>, input: IngestionInput) => Promise<{ workflowID: string }>

let inbox: string
beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), 'free-source-documents-'))
})
afterEach(async () => {
  await rm(inbox, { recursive: true, force: true })
})

/** The handler over fakes: the admission client answers `statuses` in turn for every read of the workflow. */
function dependencies(options: {
  statuses?: Array<{ status: string; output?: unknown } | undefined>
  enqueue?: Enqueue
  existing?: boolean
  overrides?: Partial<Dependencies>
} = {}) {
  const statuses = [...(options.statuses ?? [{ status: 'SUCCESS', output: succeeded }])]
  const admission = {
    enqueue: vi.fn<Enqueue>(options.enqueue ?? (async (enqueued) => ({ workflowID: enqueued.workflowID }))),
    listWorkflows: vi.fn(async () => {
      const next = statuses.length > 1 ? statuses.shift() : statuses[0]
      return next ? [next] : []
    }),
  }
  const store = {
    researcherAccountId: ids.owner,
    getProjectContextWithDocuments: vi.fn(async () => ({ projectContext: {}, sourceDocuments: [] }) as never),
    findSourceDocumentByContent: vi.fn(async () =>
      options.existing
        ? { ...published, createdAt: new Date(published.createdAt), descriptor: { artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64) } }
        : null),
  }
  const countPages = vi.fn(async () => 12 as number | null)
  const ingestionModels = vi.fn(async () => ({ ocr: 'surya', layout: null }))
  const packageStore = {
    read: vi.fn(async () => ({ bytes: encoder.encode(JSON.stringify({ page_count: 7 })), mediaType: 'application/json' })),
  }
  const handler = createSourceDocumentIngestion(store, {
    admission: admission as never, inboxRoot: inbox, countPages, ingestionModels, packageStore, ...options.overrides,
  })
  return { admission, store, countPages, ingestionModels, packageStore, handler }
}

const staged = async () => {
  const projects = await readdir(inbox)
  return projects.length === 0 ? [] : readdir(join(inbox, ids.project))
}
const enqueued = (admission: ReturnType<typeof dependencies>['admission']) => admission.enqueue.mock.calls[0]!

describe('Source Document deletion', () => {
  it('delegates authorized reference-safe deletion to the researcher store', async () => {
    const deleteSourceDocument = vi.fn().mockResolvedValue({ interruptedAttempts: [{ batchSchemaSuggestionId: ids.source, attempt: 2 }] })
    const cancelWork = vi.fn(async () => {})
    const DELETE = createSourceDocumentDeletion({ deleteSourceDocument }, cancelWork)

    const response = await DELETE(
      new Request(`http://test/api/project-contexts/${ids.project}/source-documents/${ids.source}`, { method: 'DELETE' }),
    )

    expect(response.status).toBe(204)
    expect(deleteSourceDocument).toHaveBeenCalledWith(ids.project, ids.source)
    expect(cancelWork).toHaveBeenCalledWith(
      { projectContextId: ids.project, sourceDocumentId: ids.source },
      [{ batchSchemaSuggestionId: ids.source, attempt: 2 }],
    )
  })

  it('uses the existing not-found shape for a missing or cross-owner document', async () => {
    const DELETE = createSourceDocumentDeletion({ deleteSourceDocument: vi.fn().mockResolvedValue(null) })

    const response = await DELETE(
      new Request(`http://test/api/project-contexts/${ids.project}/source-documents/${ids.source}`, { method: 'DELETE' }),
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'not_found' } })
  })

  it('answers 204 after a committed deletion even when cancellation fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const DELETE = createSourceDocumentDeletion(
        { deleteSourceDocument: vi.fn().mockResolvedValue({ interruptedAttempts: [] }) },
        vi.fn(async () => { throw new Error('kei unavailable') }),
      )
      const response = await DELETE(new Request(
        `http://test/api/project-contexts/${ids.project}/source-documents/${ids.source}`, { method: 'DELETE' }))
      expect(response.status).toBe(204)
      expect(warning).toHaveBeenCalled()
    } finally { warning.mockRestore() }
  })
})

describe('POST /api/project-contexts/:id/source-documents', () => {
  it('rejects malformed multipart input before staging anything', async () => {
    const { handler, admission } = dependencies()
    const invalid = await handler(new Request('http://test/api/project-contexts/not-a-uuid/source-documents', {
      method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
    }))
    expect(invalid.status).toBe(422)

    const inaccessible = dependencies()
    inaccessible.store.getProjectContextWithDocuments.mockResolvedValueOnce(null as never)
    expect((await inaccessible.handler(request())).status).toBe(404)
    expect(inaccessible.store.findSourceDocumentByContent).not.toHaveBeenCalled()

    expect((await handler(request([]))).status).toBe(400)
    expect((await handler(request([['file', pdfFile()], ['file', pdfFile()]]))).status).toBe(400)
    expect((await handler(request([['file', new File(['%PDF-'], 'report.pdf', { type: 'text/plain' })]]))).status).toBe(400)
    expect((await handler(request([['file', pdfFile('report.pdf', 'not a pdf')]]))).status).toBe(400)
    expect((await handler(request([['file', pdfFile('report.txt')]]))).status).toBe(400)
    const oversized = await handler(request([['file', pdfFile('large.pdf', new Uint8Array(100 * 1024 * 1024 + 1))]]))
    expect(oversized.status).toBe(413)

    expect(admission.enqueue).not.toHaveBeenCalled()
    expect(await staged()).toEqual([])
  })

  it('refuses a form that still sends an ingestionKey', async () => {
    const { handler, admission, store } = dependencies()
    const response = await handler(request([['file', pdfFile()], ['ingestionKey', ids.source]]))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: { code: 'invalid_request', message: 'Unknown form field: ingestionKey' } })
    expect(store.findSourceDocumentByContent).not.toHaveBeenCalled()
    expect(admission.enqueue).not.toHaveBeenCalled()
  })

  it('refuses an unknown page layout before staging', async () => {
    const { handler, admission } = dependencies()
    expect((await handler(request([['file', pdfFile()], ['layout', 'triptych']]))).status).toBe(400)
    expect(admission.enqueue).not.toHaveBeenCalled()
    expect(await staged()).toEqual([])
  })

  it('accepts exactly 180 Unicode scalars and rejects 181 before staging', async () => {
    const accepted = dependencies()
    const acceptedName = `${'😀'.repeat(176)}.pdf`
    expect(Array.from(acceptedName)).toHaveLength(180)
    expect((await accepted.handler(request([['file', pdfFile(acceptedName)]]))).status).toBe(201)
    expect(accepted.admission.enqueue).toHaveBeenCalledOnce()

    const rejected = dependencies()
    const rejectedName = `${'😀'.repeat(177)}.pdf`
    const response = await rejected.handler(request([['file', pdfFile(rejectedName)]]))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_request', message: 'The Source Document filename must contain at most 180 Unicode characters.' },
    })
    expect(rejected.admission.enqueue).not.toHaveBeenCalled()
  })

  it('replays completed content before parsing: no staged file, no workflow', async () => {
    const { handler, store, admission, countPages, packageStore } = dependencies({ existing: true })

    const response = await handler(request())

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ ...published, pageCount: 7 })
    expect(store.findSourceDocumentByContent).toHaveBeenCalledWith(ids.project, PDF_SHA256)
    expect(packageStore.read).toHaveBeenCalledWith({ artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64) }, 'source')
    expect(countPages).not.toHaveBeenCalled()
    expect(admission.enqueue).not.toHaveBeenCalled()
    expect(await staged()).toEqual([])
  })

  it('stages the upload, counts its pages and enqueues ingestSource on the studio queue with its dedup ID, owner, lane and models', async () => {
    let stagedBytes: Uint8Array | undefined
    const { handler, admission, countPages, ingestionModels } = dependencies({
      enqueue: async (options, input) => {
        stagedBytes = new Uint8Array(await readFile(join(inbox, input.source)))
        return { workflowID: options.workflowID }
      },
    })

    const response = await handler(request([
      ['file', new File([PDF], 'C:\\unsafe\\report draft.pdf', { type: 'application/pdf' })],
      ['layout', 'spreads'],
    ]))

    expect(response.status).toBe(201)
    const [options, input] = enqueued(admission)
    expect(input.attemptId).toMatch(UUID)
    expect(options).toEqual({
      workflowName: 'ingestSource',
      queueName: 'studio',
      workflowID: `ingest:${ids.project}:${input.attemptId}`,
      deduplicationID: `ingest:${ids.project}:${PDF_SHA256}`,
      duplicationPolicy: 'return-existing',
      authenticatedUser: ids.owner,
      attributes: { projectContextId: ids.project },
    })
    expect(input).toEqual({
      projectContextId: ids.project,
      attemptId: input.attemptId,
      owner: ids.owner,
      source: `${ids.project}/${input.attemptId}.pdf`,
      sourceSha256: PDF_SHA256,
      originalName: 'report draft.pdf',
      byteSize: 9,
      pageSource: 'ingest',
      pageCount: 12,
      lane: 'kei-convert-small',
      models: { ocr: 'surya', layout: null },
    } satisfies IngestionInput)
    expect(new TextDecoder().decode(stagedBytes)).toBe(PDF)
    expect(countPages).toHaveBeenCalledOnce()
    expect(ingestionModels).toHaveBeenCalledWith(ids.owner)
  })

  it('admits a PDF of more than 30 pages or of no count to the large lane', async () => {
    for (const pages of [31, null]) {
      const { handler, admission, countPages } = dependencies()
      countPages.mockResolvedValueOnce(pages)
      expect((await handler(request())).status).toBe(201)
      expect(enqueued(admission)[1]).toMatchObject({ pageCount: pages, lane: 'kei-convert-large' })
    }
  })

  it('ingests a scanned catalogue larger than 50 MiB without truncating it', async () => {
    const bytes = new Uint8Array(65 * 1024 * 1024)
    bytes.set(encoder.encode('%PDF-1.7\n'))
    let stagedSize = 0
    const { handler, admission } = dependencies({
      enqueue: async (options, input) => {
        stagedSize = (await readFile(join(inbox, input.source))).byteLength
        return { workflowID: options.workflowID }
      },
    })
    expect((await handler(request([['file', pdfFile('catalogue.pdf', bytes)]]))).status).toBe(201)
    expect(stagedSize).toBe(bytes.byteLength)
    expect(enqueued(admission)[1]).toMatchObject({
      byteSize: bytes.byteLength, sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    })
  })

  it("a joined attempt removes this request's unused staged file", async () => {
    const active = `ingest:${ids.project}:99999999-9999-4999-8999-999999999999`
    const { handler, admission } = dependencies({ enqueue: async () => ({ workflowID: active }) })

    expect((await handler(request())).status).toBe(201)
    expect(await staged()).toEqual([])
    expect(admission.listWorkflows).toHaveBeenCalledWith(expect.objectContaining({ workflowIDs: [active] }))
  })

  it('an uncertain enqueue keeps its staged file and answers 503', async () => {
    const { handler, admission } = dependencies({ enqueue: async () => { throw new Error('connection reset') } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await handler(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'persistence_unavailable', message: 'Source Document ingestion could not be started.' },
    })
    const [, input] = enqueued(admission)
    expect(await staged()).toEqual([`${input.attemptId}.pdf`])
    expect(admission.listWorkflows).not.toHaveBeenCalled()
  })

  it('a failure before the enqueue removes the staged file it made', async () => {
    const { handler, admission, ingestionModels } = dependencies()
    ingestionModels.mockRejectedValueOnce(new Error('configuration store unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect((await handler(request())).status).toBe(503)
    expect(admission.enqueue).not.toHaveBeenCalled()
    expect(await staged()).toEqual([])
  })

  it('an admission client that cannot be resolved stages nothing', async () => {
    // DBOS is not launched in this process, so the default admission client cannot be resolved.
    const { handler, countPages } = dependencies({ overrides: { admission: undefined } })

    const response = await handler(request())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'unexpected_failure', message: 'An unexpected failure occurred.' },
    })
    expect(countPages).not.toHaveBeenCalled()
    expect(await staged()).toEqual([])
  })

  it('waits for the workflow and answers 201 with the document and page count', async () => {
    const { handler, admission } = dependencies({
      statuses: [{ status: 'ENQUEUED' }, { status: 'PENDING' }, { status: 'SUCCESS', output: succeeded }],
      overrides: { resultPollIntervalMs: 1 },
    })

    const response = await handler(request())

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ ...published, pageCount: 12 })
    expect(admission.listWorkflows).toHaveBeenCalledTimes(3)
  })

  it("answers a typed workflow failure with its own status, code and message", async () => {
    const failed: IngestionOutcome = { ok: false, status: 422, code: 'source_ingestion_failed', message: 'The Source Document could not be parsed: unreadable' }
    const { handler } = dependencies({ statuses: [{ status: 'SUCCESS', output: failed }] })

    const response = await handler(request())

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: { code: failed.code, message: failed.message } })
  })

  it('a 504 detaches without cancelling the workflow', async () => {
    const { handler, admission } = dependencies({ statuses: [{ status: 'PENDING' }], overrides: { resultTimeoutMs: 0 } })
    const cancelWorkflow = vi.fn()
    Object.assign(admission, { cancelWorkflow })

    const response = await handler(request())

    expect(response.status).toBe(504)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'source_ingestion_timeout', message: 'Source Document parsing did not finish within thirty minutes.' },
    })
    expect(cancelWorkflow).not.toHaveBeenCalled()
    // The workflow still owns its staged file.
    const [, input] = enqueued(admission)
    expect(await staged()).toEqual([`${input.attemptId}.pdf`])
  })

  it('a DBOS status-read outage after admission answers 503 and leaves the workflow staged', async () => {
    const { handler, admission } = dependencies()
    admission.listWorkflows.mockRejectedValueOnce(new Error('DBOS is unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await handler(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'persistence_unavailable', message: 'Source Document ingestion status is unavailable.' },
    })
    expect(admission.enqueue).toHaveBeenCalledOnce()
    const [, input] = enqueued(admission)
    expect(await staged()).toEqual([`${input.attemptId}.pdf`])
  })

  it('a workflow that vanished answers 502, not a hang', async () => {
    const { handler, admission } = dependencies({ statuses: [undefined] })

    const response = await handler(request())

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'source_ingestion_failed', message: 'Source Document parsing stopped before it finished.' },
    })
    expect(admission.listWorkflows).toHaveBeenCalledOnce()
  })

  it('a workflow that stopped with an error answers 502', async () => {
    for (const status of ['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED']) {
      const { handler } = dependencies({ statuses: [{ status }] })
      expect((await handler(request())).status).toBe(502)
    }
  })
})
