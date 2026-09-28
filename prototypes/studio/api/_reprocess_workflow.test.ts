import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversionTimeoutMs, type KeiPoll } from 'extraction/kei-handoff'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import { ReprocessConflictError } from '../../../packages/db/src/project-store.js'
import { keiReadApi } from '../test/support/keiReadApi.js'
import { readStagedSource, reprocessSourcePath } from './_source_inbox.js'
import { reprocessSourceWorkflow, type ReprocessInput, type ReprocessWorkflowPorts } from './_reprocess_workflow.js'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const DOCUMENT = '22222222-2222-4222-8222-222222222222'
const KEY = '33333333-3333-4333-8333-333333333333'
const REPRESENTATION = '44444444-4444-4444-8444-444444444444'
const OWNER = '55555555-5555-4555-8555-555555555555'
const PDF = new TextEncoder().encode('%PDF-1.7\n')
const SHA = createHash('sha256').update(PDF).digest('hex')
const DESCRIPTOR = { artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64) }
const CHILD = `kei-convert:reprocess:${DOCUMENT}:${KEY}`
const SOURCE = reprocessSourcePath(PROJECT, DOCUMENT, KEY)
const admitted: ReprocessInput = {
  projectContextId: PROJECT, sourceDocumentId: DOCUMENT, requestKey: KEY, requestFingerprint: 'fingerprint',
  expectedRepresentationId: REPRESENTATION, owner: OWNER, originalName: 'report.pdf', pageSource: 'pdf',
  pageCount: 3, lane: 'kei-convert-small', models: { ocr: 'surya', layout: 'layout_heron_101' },
}
const ok: KeiPoll = { state: 'SUCCESS', output: {
  ok: true, run_id: 'run-1', generation: 'gen-1', page_count: 1, source_sha256: SHA, page_source: 'pdf',
} }

let inbox: string
beforeEach(async () => { inbox = await mkdtemp(join(tmpdir(), 'free-reprocess-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(inbox, { recursive: true, force: true }) })

function harness(options: { poll?: KeiPoll; publish?: () => unknown; beforeStep?: (name: string) => void;
  submit?: () => Promise<void> } = {}) {
  const names: string[] = []
  const steps: WorkflowSteps = {
    async step(name, run) { names.push(name); options.beforeStep?.(name); return run() },
    cancelSignal: () => undefined,
  }
  const kei = {
    submit: vi.fn(options.submit ?? (async () => {})), poll: vi.fn(async () => options.poll ?? ok), cancel: vi.fn(async () => {}),
    requestDeleteRuns: vi.fn(async () => {}),
  }
  const store = {
    getSourceRepresentation: vi.fn(async () => DESCRIPTOR),
    reprocessSourceDocument: vi.fn(async (_project: string, _document: string, input: { ensureRetained(descriptor: typeof DESCRIPTOR): Promise<void> }) => {
      if (options.publish) return options.publish()
      await input.ensureRetained(DESCRIPTOR)
      return { sourceDocumentId: DOCUMENT, name: 'report.pdf', createdAt: new Date('2026-09-26T10:00:00Z'),
        sourceRepresentationId: '66666666-6666-4666-8666-666666666666', revisionNumber: 2, descriptor: DESCRIPTOR }
    }),
    discardCanonicalPackage: vi.fn(async () => {}),
  }
  const packageStore = {
    read: vi.fn(async (_descriptor: typeof DESCRIPTOR, entry: string) => ({
      bytes: entry === 'pdf' ? PDF : new TextEncoder().encode(JSON.stringify({ page_count: 3 })),
      mediaType: entry === 'pdf' ? 'application/pdf' : 'application/json',
    })),
    save: vi.fn(async () => ({ ...DESCRIPTOR, document: {}, manifest: {} as never, published: true })),
    available: vi.fn(async () => true),
  }
  const ports: ReprocessWorkflowPorts = { steps, kei, readBase: 'http://kei.test', inboxRoot: inbox,
    packageStore, storeFor: () => store as never, fetcher: keiReadApi({ pdf: PDF }) }
  return { names, kei, store, packageStore, run: () => reprocessSourceWorkflow(admitted, ports) }
}

describe('reprocessSource', () => {
  it("stages the expected revision's canonical PDF under its reprocess name and submits on its admitted lane", async () => {
    const h = harness()
    await expect(h.run()).resolves.toMatchObject({ ok: true, pageCount: 1 })
    expect(h.packageStore.read).toHaveBeenCalledWith(DESCRIPTOR, 'pdf')
    expect(h.kei.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      workflow: 'convert', workflowId: CHILD, queueName: 'kei-convert-small', priority: 1,
      timeoutMs: conversionTimeoutMs(3), authenticatedUser: OWNER,
      request: expect.objectContaining({ source: SOURCE, source_sha256: SHA, model: 'surya', layout_model: 'layout_heron_101' }),
    }))
    expect(h.names).toEqual(['stageReprocessSource', 'submitToKei', 'pollKei', 'acceptConversion', 'publishRevision', 'removeStagedSource'])
    expect(await readdir(join(inbox, PROJECT))).toEqual([])
  })

  it('publishes with the key, fingerprint and expected head, and a moved head answers 409', async () => {
    const h = harness()
    await h.run()
    expect(h.store.reprocessSourceDocument).toHaveBeenCalledWith(PROJECT, DOCUMENT, expect.objectContaining({
      requestKey: KEY, requestFingerprint: 'fingerprint', expectedRepresentationId: REPRESENTATION, contentSha256: SHA,
    }))
    const moved = harness({ publish: () => { throw new ReprocessConflictError() } })
    await expect(moved.run()).resolves.toMatchObject({ ok: false, status: 409, code: 'invalid_request' })
    expect(moved.store.discardCanonicalPackage).toHaveBeenCalledOnce()
    expect(await readdir(join(inbox, PROJECT))).toEqual([])
  })

  it('removes its staged file after a typed kei failure', async () => {
    const h = harness({ poll: { state: 'SUCCESS', output: {
      ok: false, code: 'source_unreadable', reason: 'PDFium could not open it', retryable: false,
    } } })
    await expect(h.run()).resolves.toMatchObject({ ok: false, status: 422 })
    expect(h.store.reprocessSourceDocument).not.toHaveBeenCalled()
    expect(await readdir(join(inbox, PROJECT))).toEqual([])
  })

  it('cancels the kei child before rethrowing an unexpected failure after submission', async () => {
    const h = harness({ beforeStep: (name) => { if (name === 'pollKei') throw new Error('database unavailable') } })
    await expect(h.run()).rejects.toThrow('database unavailable')
    expect(h.kei.cancel).toHaveBeenCalledWith(CHILD)
    expect(await readStagedSource(inbox, SOURCE)).toEqual(PDF)
  })

  it('cancels a child whose submission committed but lost its acknowledgement', async () => {
    let admitted = false
    const h = harness({ submit: async () => { admitted = true; throw new Error('acknowledgement lost') } })
    await expect(h.run()).rejects.toThrow('acknowledgement lost')
    expect(admitted).toBe(true)
    expect(h.kei.cancel).toHaveBeenCalledWith(CHILD)
  })
})
