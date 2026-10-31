import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowStatus } from '@dbos-inc/dbos-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stageSource, uploadSourcePath } from './_source_inbox.js'
import {
  createSourceIngestionDismissal, createSourceIngestionListing, createSourceIngestionRetry,
} from './source_ingestions.js'

const ACCOUNT = '53000000-0000-4000-8009-000000000001'
const PROJECT = '53000000-0000-4000-8000-000000000001'
const FAILED = '53000000-0000-4000-8001-000000000001'
const NOW = Date.parse('2026-10-19T12:00:00.000Z')
const BOOT = NOW - 3_600_000
const PDF = new TextEncoder().encode('%PDF-1.7\nretry')
const SHA = createHash('sha256').update(PDF).digest('hex')
const SOURCE = uploadSourcePath(PROJECT, FAILED)
const WORKFLOW = `ingest:${PROJECT}:${FAILED}`
const refused = { ok: false, status: 422, code: 'source_ingestion_failed', message: 'kei refused the PDF.' }

function failedRow(overrides: Partial<WorkflowStatus> = {}): WorkflowStatus {
  return {
    workflowID: WORKFLOW, status: 'SUCCESS', workflowName: 'ingestSource', workflowClassName: '', authenticatedUser: ACCOUNT,
    input: [{
      projectContextId: PROJECT, attemptId: FAILED, owner: ACCOUNT, source: SOURCE, sourceSha256: SHA,
      originalName: 'scan.pdf', pageSource: 'ingest',
    }],
    output: refused, createdAt: NOW - 120_000, completedAt: NOW - 60_000, priority: 0,
    attributes: { projectContextId: PROJECT }, ...overrides,
  }
}

let inbox: string
beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), 'free-ingestion-retry-'))
  await stageSource(inbox, SOURCE, PDF)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(inbox, { recursive: true, force: true })
})
const staged = async () => (await readdir(join(inbox, PROJECT))).sort()

describe('POST /api/project-contexts/:id/source-ingestions/:workflowId/retry', () => {
  function retry(recorded: WorkflowStatus | undefined, options: { existing?: boolean; owns?: boolean; joined?: string } = {}) {
    const admission = { enqueue: vi.fn(async (config: { workflowID: string }) => ({ workflowID: options.joined ?? config.workflowID })) }
    const store = {
      researcherAccountId: ACCOUNT,
      modelOperationScopeExists: vi.fn(async () => options.owns ?? true),
      findSourceDocumentByContent: vi.fn(async () => null),
    }
    const POST = createSourceIngestionRetry(store, () => ({ getWorkflow: vi.fn(async () => recorded) }) as never, () => BOOT, {
      admission: admission as never, inboxRoot: inbox,
      countPages: async () => 4, ingestionModels: async () => ({ ocr: 'surya', layout: null }),
    })
    return { POST, admission, store }
  }
  const post = (workflowId = WORKFLOW) => new Request(
    `http://local.test/api/project-contexts/${PROJECT}/source-ingestions/${encodeURIComponent(workflowId)}/retry`, { method: 'POST' })

  it("admits the failed attempt's retained PDF as a new attempt with its name and layout, then drops the old copy", async () => {
    const { POST, admission } = retry(failedRow())
    const response = await POST(post())
    expect(response.status).toBe(202)
    const [config, input] = admission.enqueue.mock.calls[0]! as unknown as [{ workflowID: string; deduplicationID: string }, Record<string, unknown>]
    expect((await response.json()).workflowId).toBe(config.workflowID)
    expect(config.workflowID).not.toBe(WORKFLOW)
    expect(config.deduplicationID).toBe(`ingest:${PROJECT}:${SHA}`)
    expect(input).toMatchObject({ sourceSha256: SHA, originalName: 'scan.pdf', pageSource: 'ingest', pageCount: 4, models: { ocr: 'surya', layout: null } })
    expect(await staged()).toEqual([`${input.attemptId as string}.pdf`])
  })

  it('also retries a crashed attempt, and joins a same-content attempt already running', async () => {
    const running = `ingest:${PROJECT}:53000000-0000-4000-8001-000000000002`
    const { POST } = retry(failedRow({ status: 'ERROR', output: undefined }), { joined: running })
    const response = await POST(post())
    expect(await response.json()).toEqual({ workflowId: running })
    expect(await staged()).toEqual([])
  })

  it('answers 410 once Studio no longer holds the PDF, or holds other bytes under its name', async () => {
    await rm(join(inbox, SOURCE))
    expect((await retry(failedRow()).POST(post())).status).toBe(410)
    await stageSource(inbox, SOURCE, new TextEncoder().encode('%PDF-other'))
    const { POST, admission } = retry(failedRow())
    const response = await POST(post())
    expect(response.status).toBe(410)
    expect((await response.json()).error.code).toBe('source_not_retained')
    expect(admission.enqueue).not.toHaveBeenCalled()
  })

  it('refuses live, succeeded, stopping, foreign and cross-project attempts, admitting nothing', async () => {
    const cases: [WorkflowStatus | undefined, number, { owns?: boolean }?][] = [
      [failedRow({ status: 'PENDING', output: undefined }), 409],
      [failedRow({ output: { ok: true, sourceDocument: { sourceDocumentId: '53000000-0000-4000-8002-000000000001' } } }), 409],
      [failedRow({ status: 'CANCELLED', output: undefined, updatedAt: BOOT + 1 }), 409],
      [failedRow({ authenticatedUser: 'someone-else' }), 404],
      [failedRow({ attributes: { projectContextId: '53000000-0000-4000-8000-000000000002' } }), 404],
      [undefined, 404],
      [failedRow(), 404, { owns: false }],
    ]
    for (const [recorded, status, options] of cases) {
      const { POST, admission } = retry(recorded, options)
      expect((await POST(post())).status).toBe(status)
      expect(admission.enqueue).not.toHaveBeenCalled()
    }
    expect(await staged()).toEqual([`${FAILED}.pdf`])
  })
})

describe('the retained PDF in the listing and on dismissal', () => {
  it('marks a failure retryable only while its PDF is staged', async () => {
    const listing = (exists: boolean) => createSourceIngestionListing(
      { researcherAccountId: ACCOUNT, modelOperationScopeExists: async () => true, findSourceDocumentIdsByContent: async () => new Map() },
      () => ({ listWorkflows: async (input: { status?: unknown }) => Array.isArray(input.status) && input.status.includes('ERROR') ? [failedRow()] : [] }) as never,
      () => NOW,
      async () => { throw new Error('no lanes') },
      async (relative) => exists && relative === SOURCE,
    )
    const read = async (exists: boolean) =>
      (await (await listing(exists)(new Request(`http://local.test/api/project-contexts/${PROJECT}/source-ingestions`))).json()).ingestions[0]
    expect(await read(true)).toMatchObject({ status: 'failed', retryable: true })
    expect(await read(false)).not.toHaveProperty('retryable')
  })

  it("dismissal removes the chain's retained PDFs along with its history", async () => {
    const client = { getWorkflow: vi.fn(async () => failedRow()), listWorkflows: vi.fn(async () => [failedRow()]), deleteWorkflows: vi.fn(async () => {}) }
    const DELETE = createSourceIngestionDismissal(
      { researcherAccountId: ACCOUNT, modelOperationScopeExists: async () => true }, () => client as never, () => BOOT, () => inbox)
    const response = await DELETE(new Request(
      `http://local.test/api/project-contexts/${PROJECT}/source-ingestions/${encodeURIComponent(WORKFLOW)}`, { method: 'DELETE' }))
    expect(response.status).toBe(204)
    expect(await staged()).toEqual([])
  })
})
