import type { WorkflowStatus } from '@dbos-inc/dbos-sdk'
import { INTERRUPTED_FAILURE } from 'db'
import { describe, expect, it } from 'vitest'
import { attemptOf, classifyOutcome, isQuiescent } from './_source_ingestion_outcome.js'

const PROJECT = '52000000-0000-4000-8000-000000000001'
const DOC = '52000000-0000-4000-8002-000000000001'
const BOOT = 1_700_000_000_000
const status = (overrides: Partial<WorkflowStatus>): WorkflowStatus => ({
  workflowID: `ingest:${PROJECT}:a`, status: 'SUCCESS', workflowName: 'ingestSource', workflowClassName: '',
  createdAt: BOOT - 10, priority: 0, attributes: { projectContextId: PROJECT },
  input: [{ projectContextId: PROJECT, originalName: 'a.pdf', sourceSha256: 'sha' }], ...overrides,
})

describe('classifyOutcome', () => {
  it('reads live statuses, a validated success and a typed refusal', () => {
    expect(classifyOutcome(status({ status: 'ENQUEUED' }))).toEqual({ kind: 'live', status: 'queued' })
    expect(classifyOutcome(status({ status: 'DELAYED' }))).toEqual({ kind: 'live', status: 'queued' })
    expect(classifyOutcome(status({ status: 'PENDING' }))).toEqual({ kind: 'live', status: 'parsing' })
    expect(classifyOutcome(status({ output: { ok: true, pageCount: 1, sourceDocument: { sourceDocumentId: DOC } } }))).toEqual({ kind: 'succeeded', sourceDocumentId: DOC })
    expect(classifyOutcome(status({ output: { ok: false, status: 422, code: 'source_ingestion_failed', message: 'No.' } })))
      .toEqual({ kind: 'failed', failure: { code: 'source_ingestion_failed', message: 'No.' } })
  })

  it('treats stopped executions and any output that does not validate as interrupted', () => {
    for (const recorded of [
      status({ status: 'ERROR' }), status({ status: 'CANCELLED' }), status({ status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' }),
      status({ output: { ok: true } }), status({ output: { ok: true, sourceDocument: { sourceDocumentId: 'nope' } } }),
      status({ output: { ok: false, code: 1 } }), status({ output: undefined }),
    ])
      expect(classifyOutcome(recorded)).toEqual({ kind: 'failed', failure: { ...INTERRUPTED_FAILURE } })
  })

  it('bounds a typed failure to 128 and 512 characters', () => {
    const long = classifyOutcome(status({ output: { ok: false, status: 422, code: 'c'.repeat(200), message: 'm'.repeat(900) } }))
    expect(long).toEqual({ kind: 'failed', failure: { code: 'c'.repeat(128), message: 'm'.repeat(512) } })
  })
})

describe('attemptOf', () => {
  it("accepts only this project's ingestSource records with a readable input", () => {
    expect(attemptOf(status({}), PROJECT)?.input.sourceSha256).toBe('sha')
    for (const recorded of [
      status({ workflowName: 'reprocessSource' }), status({ attributes: { projectContextId: 'other' } }),
      status({ input: undefined }), status({ input: [{ originalName: 'a.pdf' }] }),
    ]) expect(attemptOf(recorded, PROJECT)).toBeNull()
  })
})

describe('isQuiescent (M6: history may go)', () => {
  it('lets SUCCESS and ERROR go, and stopped rows only when updated before this boot', () => {
    expect(isQuiescent(status({ status: 'SUCCESS' }), BOOT)).toBe(true)
    expect(isQuiescent(status({ status: 'ERROR' }), BOOT)).toBe(true)
    for (const stopped of ['CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED']) {
      expect(isQuiescent(status({ status: stopped, updatedAt: BOOT - 1 }), BOOT)).toBe(true)
      expect(isQuiescent(status({ status: stopped, updatedAt: BOOT }), BOOT)).toBe(false)
      expect(isQuiescent(status({ status: stopped, updatedAt: undefined }), BOOT)).toBe(false)
    }
    expect(isQuiescent(status({ status: 'PENDING' }), BOOT)).toBe(false)
  })
})
