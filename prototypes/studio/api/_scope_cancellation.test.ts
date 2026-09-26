import { describe, expect, it, vi } from 'vitest'
import { cancelScopeWork } from './_scope_cancellation.js'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const SOURCE = '22222222-2222-4222-8222-222222222222'
const EXTRACTION = '33333333-3333-4333-8333-333333333333'
const KEY = '44444444-4444-4444-8444-444444444444'
const SUGGESTION = '55555555-5555-4555-8555-555555555555'
const extract = `extract:${EXTRACTION}`
const reprocess = `reprocess:${SOURCE}:${KEY}`
const suggest = `suggest:${SUGGESTION}:2`

function clients(live: string[], stopped: string[] = [], liveKei: string[] = []) {
  const admission = {
    listWorkflows: vi.fn(async (query: { workflowIDs?: string[] }) => {
      if (!query.workflowIDs) return live.map((workflowID) => ({ workflowID, status: 'PENDING' }))
      return query.workflowIDs.map((workflowID) => ({ workflowID,
        status: stopped.includes(workflowID) ? 'CANCELLED' : 'PENDING' }))
    }),
    cancelWorkflow: vi.fn<(id: string) => Promise<void>>(async () => {}),
  }
  const kei = {
    listWorkflows: vi.fn(async (query: { workflowIDs?: string[] }) =>
      (query.workflowIDs ?? liveKei).map((workflowID) => ({ workflowID, status: 'PENDING' }))),
    cancelWorkflow: vi.fn<(id: string) => Promise<void>>(async () => {}), enqueuePortable: vi.fn(async () => {}),
  }
  return { admission, kei }
}

describe('scope cancellation after deletion', () => {
  it('cancels live source work and the interrupted suggestion, then their live kei children', async () => {
    const dbos = clients([extract, reprocess])
    await cancelScopeWork({ projectContextId: PROJECT, sourceDocumentId: SOURCE },
      [{ batchSchemaSuggestionId: SUGGESTION, attempt: 2 }], dbos as never)
    expect(dbos.admission.listWorkflows).toHaveBeenCalledWith({
      attributes: { sourceDocumentId: SOURCE }, status: ['ENQUEUED', 'DELAYED', 'PENDING'],
      loadInput: false, loadOutput: false,
    })
    expect(dbos.admission.cancelWorkflow.mock.calls.map(([id]) => id)).toEqual([extract, reprocess, suggest])
    expect(dbos.kei.cancelWorkflow.mock.calls.map(([id]) => id)).toEqual([
      `kei-extract:${EXTRACTION}`, `kei-convert:${reprocess}`,
    ])
  })

  it('a project deletion includes ingestions, but terminal Studio and kei work is not cancelled again', async () => {
    const ingest = `ingest:${PROJECT}:${KEY}`
    const dbos = clients([extract, ingest], [extract])
    dbos.kei.listWorkflows.mockImplementation(async (query) =>
      query.workflowIDs?.map((workflowID) => ({ workflowID,
        status: workflowID.startsWith('kei-extract:') ? 'CANCELLED' : 'PENDING' })) ?? [])
    await cancelScopeWork({ projectContextId: PROJECT }, [], dbos as never)
    expect(dbos.admission.cancelWorkflow.mock.calls.map(([id]) => id)).toEqual([ingest])
    expect(dbos.kei.cancelWorkflow.mock.calls.map(([id]) => id)).toEqual([`kei-convert:${ingest}`])
  })

  it('one failed cancel is logged while later workflows are still stopped', async () => {
    const dbos = clients([extract, reprocess])
    dbos.admission.cancelWorkflow.mockRejectedValueOnce(new Error('temporarily unavailable'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(cancelScopeWork({ projectContextId: PROJECT, sourceDocumentId: SOURCE }, [], dbos as never)).resolves.toBeUndefined()
      expect(dbos.admission.cancelWorkflow.mock.calls.map(([id]) => id)).toEqual([extract, reprocess])
      expect(dbos.kei.cancelWorkflow).toHaveBeenCalledTimes(2)
      expect(warning).toHaveBeenCalled()
    } finally { warning.mockRestore() }
  })

  it('finds a live kei child even when its Studio parent is terminal', async () => {
    const orphan = `kei-extract:${EXTRACTION}`
    const dbos = clients([], [], [orphan])
    await cancelScopeWork({ projectContextId: PROJECT, sourceDocumentId: SOURCE }, [], dbos as never)
    expect(dbos.admission.cancelWorkflow).not.toHaveBeenCalled()
    expect(dbos.kei.listWorkflows).toHaveBeenCalledWith({
      attributes: { sourceDocumentId: SOURCE }, workflowName: ['convert', 'extract'],
      status: ['ENQUEUED', 'DELAYED', 'PENDING'], loadInput: false, loadOutput: false,
    })
    expect(dbos.kei.cancelWorkflow).toHaveBeenCalledWith(orphan)
  })
})
