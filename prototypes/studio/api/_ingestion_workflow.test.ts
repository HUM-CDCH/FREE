import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Error as DBOSErrors } from '@dbos-inc/dbos-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  conversionTimeoutMs, keiConvertWorkflowId, type KeiPoll, type KeiSubmission,
} from 'extraction/kei-handoff'
import type { WorkflowSteps } from 'extraction/workflows'
import { keiReadApi } from '../test/support/keiReadApi.js'
import { stageSource, uploadSourcePath } from './_source_inbox.js'
import {
  ingestDeduplicationId, ingestSourceWorkflow, ingestWorkflowId,
  type IngestionInput, type IngestionStore, type IngestionWorkflowPorts,
} from './_ingestion_workflow.js'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const ATTEMPT = '22222222-2222-4222-8222-222222222222'
const OWNER = '33333333-3333-4333-8333-333333333333'
const DOCUMENT = '44444444-4444-4444-8444-444444444444'
const REPRESENTATION = '55555555-5555-4555-8555-555555555555'
const PDF = new TextEncoder().encode('%PDF-1.7\n')
const PDF_SHA256 = '0716f9264c9fe19f5d7455276107f3ddcc1d3497f63d60689a73558ae8a1bf5e'
const SOURCE = uploadSourcePath(PROJECT, ATTEMPT)
const WORKFLOW = `ingest:${PROJECT}:${ATTEMPT}`
const CHILD = keiConvertWorkflowId(WORKFLOW)
const NEW_PACKAGE = { artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64) }
const OTHER_PACKAGE = { artifactReference: 'b'.repeat(64), artifactSha256: 'b'.repeat(64) }
const CREATED_AT = new Date('2026-09-26T10:00:00.000Z')

function input(overrides: Partial<IngestionInput> = {}): IngestionInput {
  return {
    projectContextId: PROJECT, attemptId: ATTEMPT, owner: OWNER, source: SOURCE, sourceSha256: PDF_SHA256,
    originalName: 'report.pdf', byteSize: PDF.byteLength, pageSource: 'pdf', pageCount: 12,
    lane: 'kei-convert-small', models: { ocr: 'surya', layout: 'layout_heron_101' }, ...overrides,
  }
}

const convertOk = (overrides: Record<string, unknown> = {}): KeiPoll => ({
  state: 'SUCCESS',
  output: { ok: true, run_id: 'run-1', generation: 'gen-1', page_count: 1, source_sha256: PDF_SHA256, page_source: 'pdf', ...overrides },
})

function persisted(descriptor = NEW_PACKAGE) {
  return {
    sourceDocumentId: DOCUMENT, name: 'report.pdf', createdAt: CREATED_AT, sourceRepresentationId: REPRESENTATION,
    revisionNumber: 1 as const, descriptor,
  }
}

let inbox: string
beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), 'free-ingestion-workflow-'))
  await stageSource(inbox, SOURCE, PDF)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(inbox, { recursive: true, force: true })
})

/** The workflow over fake ports: steps run in order and are named, kei answers `polls` in turn. */
function harness(scenario: {
  existing?: ReturnType<typeof persisted> | null
  polls?: KeiPoll[]
  publication?: () => ReturnType<IngestionStore['ingestSourceDocument']>
  beforeStep?: (name: string) => void
  fetcher?: typeof fetch
} = {}) {
  const names: string[] = []
  const steps: WorkflowSteps = {
    async step(name, run) {
      names.push(name)
      scenario.beforeStep?.(name)
      return run()
    },
    cancelSignal: () => undefined,
  }
  const polls = [...(scenario.polls ?? [convertOk()])]
  const kei = {
    submit: vi.fn<(submission: KeiSubmission) => Promise<void>>(async () => {}),
    poll: vi.fn(async () => polls.length > 1 ? polls.shift()! : polls[0]!),
    cancel: vi.fn(async () => {}),
  }
  const store = {
    findSourceDocumentByContent: vi.fn(async () => scenario.existing ?? null),
    ingestSourceDocument: vi.fn(async (_project: string, ingested: { ensureRetained(descriptor: unknown): Promise<void> }) => {
      if (scenario.publication) return scenario.publication()
      await ingested.ensureRetained(NEW_PACKAGE)
      return { ...persisted(), disposition: 'created' as const }
    }),
    discardCanonicalPackage: vi.fn(async () => {}),
  }
  const packageStore = {
    save: vi.fn(async () => ({ ...NEW_PACKAGE, document: {}, manifest: {} as never, published: true })),
    available: vi.fn(async () => true),
    read: vi.fn(async () => ({ bytes: new TextEncoder().encode(JSON.stringify({ page_count: 12 })), mediaType: 'application/json' })),
  }
  const storeFor = vi.fn(() => store)
  const ports: IngestionWorkflowPorts = {
    steps, kei, readBase: 'http://kei.test', inboxRoot: inbox, packageStore, storeFor,
    fetcher: scenario.fetcher ?? keiReadApi({ pdf: PDF }),
  }
  return { names, kei, store, storeFor, packageStore, ports, run: (admitted = input()) => ingestSourceWorkflow(admitted, ports) }
}

const staged = async () => readdir(join(inbox, PROJECT))

describe('ingestSource', () => {
  it("completed content returns the existing document without converting, and removes this attempt's staged file", async () => {
    const h = harness({ existing: persisted(OTHER_PACKAGE) })

    await expect(h.run()).resolves.toEqual({
      ok: true,
      sourceDocument: {
        sourceDocumentId: DOCUMENT, name: 'report.pdf', createdAt: CREATED_AT.toISOString(),
        sourceRepresentationId: REPRESENTATION, revisionNumber: 1,
      },
      pageCount: 12,
    })
    expect(h.names).toEqual(['replayCompletedContent', 'removeStagedSource'])
    expect(h.storeFor).toHaveBeenCalledWith(OWNER)
    expect(h.store.findSourceDocumentByContent).toHaveBeenCalledWith(PROJECT, PDF_SHA256)
    expect(h.packageStore.read).toHaveBeenCalledWith(OTHER_PACKAGE, 'source')
    expect(h.kei.submit).not.toHaveBeenCalled()
    expect(await staged()).toEqual([])
  })

  it('submits the staged source to its admitted lane with the admitted models, one priority and the page budget', async () => {
    const h = harness()

    await h.run()
    expect(h.kei.submit).toHaveBeenCalledExactlyOnceWith({
      workflow: 'convert',
      workflowId: CHILD,
      queueName: 'kei-convert-small',
      priority: 1,
      timeoutMs: conversionTimeoutMs(12),
      authenticatedUser: OWNER,
      attributes: { projectContextId: PROJECT },
      request: {
        source: `${PROJECT}/${ATTEMPT}.pdf`, source_sha256: PDF_SHA256, source_name: 'report.pdf', page_source: 'pdf',
        ingest: null, model: 'surya', layout_model: 'layout_heron_101', cut: 'auto', debug: false,
      },
    })
    expect(CHILD).toBe(`kei-convert:ingest:${PROJECT}:${ATTEMPT}`)
  })

  it('a recovered or replayed ingestion keeps its admitted lane', async () => {
    const h = harness()
    // Three pages admitted as large (a count that was unknown or timed out at admission): never recounted.
    await h.run(input({ pageCount: 3, lane: 'kei-convert-large', models: { ocr: null, layout: null } }))
    expect(h.kei.submit.mock.calls[0]![0]).toMatchObject({
      queueName: 'kei-convert-large', timeoutMs: conversionTimeoutMs(3), request: { model: null, layout_model: null },
    })

    await stageSource(inbox, SOURCE, PDF)
    const uncounted = harness()
    await uncounted.run(input({ pageCount: null, lane: 'kei-convert-large' }))
    expect(uncounted.kei.submit.mock.calls[0]![0]).toMatchObject({ queueName: 'kei-convert-large', timeoutMs: conversionTimeoutMs(null) })
  })

  it('polls kei until its child settles, then packages and publishes', async () => {
    const h = harness({ polls: [{ state: 'live' }, { state: 'live' }, convertOk()] })

    await expect(h.run()).resolves.toMatchObject({ ok: true, pageCount: 1 })
    expect(h.names).toEqual([
      'replayCompletedContent', 'submitToKei', 'pollKei', 'pollKei', 'pollKei', 'acceptConversion',
      'publishSourceDocument', 'removeStagedSource',
    ])
    expect(h.kei.poll).toHaveBeenCalledWith(CHILD, undefined)
    expect(await staged()).toEqual([])
  })

  it("a kei failure is 422 with kei's reason, a kei deadline is 504, and both remove the staged file", async () => {
    const failed = harness({
      polls: [{ state: 'SUCCESS', output: { ok: false, code: 'source_unreadable', reason: 'PDFium could not open it', retryable: false } }],
    })
    await expect(failed.run()).resolves.toEqual({
      ok: false, status: 422, code: 'source_ingestion_failed', message: 'The Source Document could not be parsed: PDFium could not open it',
    })
    expect(failed.names.at(-1)).toBe('removeStagedSource')
    expect(failed.store.ingestSourceDocument).not.toHaveBeenCalled()
    expect(await staged()).toEqual([])

    await stageSource(inbox, SOURCE, PDF)
    const late = harness({ polls: [{ state: 'CANCELLED', deadlinePassed: true }] })
    await expect(late.run()).resolves.toEqual({
      ok: false, status: 504, code: 'source_ingestion_timeout', message: 'Source Document parsing did not finish within its time limit.',
    })
    expect(late.packageStore.save).not.toHaveBeenCalled()
    expect(await staged()).toEqual([])
  })

  it('refuses a conversion kei reports for other bytes or another page layout, before reading its result', async () => {
    for (const [reported, message] of [
      [{ source_sha256: '0'.repeat(64) }, 'The Parsing Service converted another Source Document.'],
      [{ page_source: 'ingest' }, 'The Parsing Service converted another page layout.'],
    ] as const) {
      await stageSource(inbox, SOURCE, PDF)
      const h = harness({ polls: [convertOk(reported)] })
      // Studio's own refusal of kei's answer is a typed outcome: the workflow succeeds, releasing deduplication.
      await expect(h.run()).resolves.toEqual({ ok: false, status: 502, code: 'source_ingestion_failed', message })
      expect(h.ports.fetcher).not.toHaveBeenCalled()
      expect(h.store.ingestSourceDocument).not.toHaveBeenCalled()
      expect(h.kei.cancel).not.toHaveBeenCalled()
      expect(h.names.at(-1)).toBe('removeStagedSource')
      expect(await staged()).toEqual([])
    }
  })

  it("a partial parse answers 422, as before, and removes the staged file", async () => {
    const h = harness({ fetcher: keiReadApi({ pdf: PDF, manifest: { status: 'incomplete', incomplete: 'page 1 stopped at its token cap' } }) })

    await expect(h.run()).resolves.toEqual({
      ok: false, status: 422, code: 'source_ingestion_failed', message: 'The Source Document was only partially parsed.',
    })
    expect(h.names).toEqual(['replayCompletedContent', 'submitToKei', 'pollKei', 'acceptConversion', 'removeStagedSource'])
    expect(h.store.ingestSourceDocument).not.toHaveBeenCalled()
    expect(h.kei.cancel).not.toHaveBeenCalled()
    expect(await staged()).toEqual([])
  })

  it('a manifest of another generation is a typed 502, while packaging I/O is retried', async () => {
    const otherParse = harness({ fetcher: keiReadApi({ pdf: PDF, manifest: { generation: 'gen-2' } }) })
    await expect(otherParse.run()).resolves.toEqual({
      ok: false, status: 502, code: 'source_ingestion_failed',
      message: 'The Parsing Service published another parse than the one it reported.',
    })
    expect(await staged()).toEqual([])

    await stageSource(inbox, SOURCE, PDF)
    const unsaved = harness()
    unsaved.packageStore.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(unsaved.run()).rejects.toMatchObject({
      status: 502, code: 'source_artifact_unavailable', transient: true,
    })
    expect(unsaved.store.ingestSourceDocument).not.toHaveBeenCalled()
    expect(unsaved.kei.cancel).toHaveBeenCalledWith(CHILD)
    expect(await staged()).toEqual([`${ATTEMPT}.pdf`])
  })

  it("a transient read failure is thrown for the step's retries and still cancels the kei child", async () => {
    const h = harness({ fetcher: keiReadApi({ pdf: PDF, respond: () => new Response('restarting', { status: 503 }) }) })

    await expect(h.run()).rejects.toMatchObject({ status: 502, transient: true })
    expect(h.names.slice(-2)).toEqual(['acceptConversion', 'cancelKeiChild'])
    expect(h.kei.cancel).toHaveBeenCalledExactlyOnceWith(CHILD)
    // An ERROR leaves the staged file to garbage collection.
    expect(await staged()).toEqual([`${ATTEMPT}.pdf`])
  })

  it("a replay whose package cannot be read answers 502 and still removes the staged file", async () => {
    const h = harness({ existing: persisted(OTHER_PACKAGE) })
    h.packageStore.read.mockRejectedValueOnce(new Error('package missing'))

    await expect(h.run()).resolves.toEqual({
      ok: false, status: 502, code: 'source_artifact_unavailable', message: 'The retained canonical package is unavailable.',
    })
    expect(h.names).toEqual(['replayCompletedContent', 'removeStagedSource'])
    expect(h.kei.submit).not.toHaveBeenCalled()
    expect(await staged()).toEqual([])
  })

  it('publishes the converted package once; a publication that finds the content already published returns that document and discards this package', async () => {
    const h = harness()
    await expect(h.run()).resolves.toMatchObject({ ok: true, sourceDocument: { sourceDocumentId: DOCUMENT } })
    expect(h.store.ingestSourceDocument).toHaveBeenCalledExactlyOnceWith(PROJECT, expect.objectContaining({
      contentSha256: PDF_SHA256, mediaType: 'application/pdf', originalName: 'report.pdf', ...NEW_PACKAGE,
      contractVersion: 'parsed_document.v2', preprocessId: 'kei-exp:run-1:gen-1', parserName: 'kei-exp',
      parserVersion: 'docling 2.127.0',
    }))
    expect(h.store.discardCanonicalPackage).not.toHaveBeenCalled()

    await stageSource(inbox, SOURCE, PDF)
    const replayed = harness({
      publication: async () => ({ ...persisted(OTHER_PACKAGE), sourceDocumentId: 'winner', disposition: 'replayed' as const }),
    })
    await expect(replayed.run()).resolves.toMatchObject({ ok: true, sourceDocument: { sourceDocumentId: 'winner' }, pageCount: 1 })
    expect(replayed.store.discardCanonicalPackage).toHaveBeenCalledExactlyOnceWith(NEW_PACKAGE)
    expect(await staged()).toEqual([])
  })

  it('verifies, never re-saves, the package a publication keeps', async () => {
    const h = harness({
      publication: async () => {
        const [, ingested] = h.store.ingestSourceDocument.mock.calls[0]!
        await ingested.ensureRetained(OTHER_PACKAGE)
        return { ...persisted(OTHER_PACKAGE), disposition: 'replayed' as const }
      },
    })
    h.packageStore.available.mockResolvedValueOnce(false)
    await expect(h.run()).rejects.toThrow('The published canonical package is unavailable.')
    expect(h.packageStore.available).toHaveBeenCalledWith(OTHER_PACKAGE)
    expect(h.packageStore.save).toHaveBeenCalledOnce()
  })

  it('a project deleted before publication answers 404 and discards the new package', async () => {
    const h = harness({ publication: async () => null })
    await expect(h.run()).resolves.toEqual({ ok: false, status: 404, code: 'not_found', message: 'Project Context was not found.' })
    expect(h.store.discardCanonicalPackage).toHaveBeenCalledExactlyOnceWith(NEW_PACKAGE)
    expect(await staged()).toEqual([])
  })

  it('an unexpected failure after submission cancels the kei child before rethrowing', async () => {
    const h = harness({ publication: async () => { throw new Error('the store is unavailable') } })
    await expect(h.run()).rejects.toThrow('the store is unavailable')
    expect(h.names.slice(-2)).toEqual(['publishSourceDocument', 'cancelKeiChild'])
    expect(h.kei.cancel).toHaveBeenCalledExactlyOnceWith(CHILD)

    const cancelled = new DBOSErrors.DBOSWorkflowCancelledError(WORKFLOW)
    const stopped = harness({ beforeStep: (name) => { if (name === 'pollKei') throw cancelled } })
    await expect(stopped.run()).rejects.toBe(cancelled)
    expect(stopped.kei.cancel).not.toHaveBeenCalled()
  })

  it('an uncertain submission cancels the same child and retains its staged source', async () => {
    const h = harness()
    const lost = new Error('kei committed but the acknowledgement was lost')
    h.kei.submit.mockRejectedValueOnce(lost)

    await expect(h.run()).rejects.toBe(lost)
    expect(h.names).toEqual(['replayCompletedContent', 'submitToKei', 'cancelKeiChild'])
    expect(h.kei.cancel).toHaveBeenCalledExactlyOnceWith(CHILD)
    expect(h.store.ingestSourceDocument).not.toHaveBeenCalled()
    expect(await staged()).toEqual([`${ATTEMPT}.pdf`])
  })

  it('a cancel of the kei child that fails does not replace the original failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = harness({ publication: async () => { throw new Error('the store is unavailable') } })
    h.kei.cancel.mockRejectedValueOnce(new Error('kei is unreachable'))

    await expect(h.run()).rejects.toThrow('the store is unavailable')
    expect(h.kei.cancel).toHaveBeenCalledExactlyOnceWith(CHILD)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('a staged file that cannot be removed after publication does not fail the published ingestion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = harness({ beforeStep: (name) => { if (name === 'removeStagedSource') throw new Error('permission denied') } })

    await expect(h.run()).resolves.toMatchObject({ ok: true, sourceDocument: { sourceDocumentId: DOCUMENT } })
    expect(h.kei.cancel).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    // Left for garbage collection.
    expect(await staged()).toEqual([`${ATTEMPT}.pdf`])
  })

  it('one helper names the workflow and its deduplication ID', () => {
    expect(ingestWorkflowId(PROJECT, ATTEMPT)).toBe(WORKFLOW)
    expect(WORKFLOW).toBe(`ingest:${PROJECT}:${ATTEMPT}`)
    expect(ingestDeduplicationId(PROJECT, PDF_SHA256)).toBe(`ingest:${PROJECT}:${PDF_SHA256}`)
  })
})
