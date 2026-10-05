import { Error as DBOSErrors } from '@dbos-inc/dbos-sdk'
import { describe, expect, it, vi } from 'vitest'
import { GC_POLICY, type WorkflowRow } from './_garbage_plan.js'
import {
  collectGarbageWorkflow, repairCancellations, collectStudioHistory, collectKei, type GarbagePorts,
} from './_garbage_workflow.js'

const NOW = Date.parse('2026-09-26T12:00:00Z')
const SCHEDULED = new Date(NOW)
const emptyScopes = {
  projectContexts: new Set<string>(), sourceDocuments: new Set<string>(),
  sourceRepresentationRevisions: new Set<string>(), extractionSchemas: new Set<string>(),
  suggestions: new Map(),
}

function fakePorts(studioRows: WorkflowRow[] = [], keiRows: WorkflowRow[] = []) {
  const calls: string[] = []
  const steps: string[] = []
  const logs: string[] = []
  const listed = (kind: string, source: WorkflowRow[], query: Record<string, unknown>) => {
    calls.push(`${kind}:list`)
    const ids = query.workflowIDs as string[] | undefined
    const prefixes = query.workflow_id_prefix as string | string[] | undefined
    const statuses = query.status as string[] | undefined
    return source.filter((row) =>
      (!ids || ids.includes(row.workflowID)) &&
      (!prefixes || [prefixes].flat().some((prefix) => row.workflowID.startsWith(prefix))) &&
      (!statuses || statuses.includes(row.status)))
  }
  const studio = {
    listWorkflows: vi.fn(async (query: Record<string, unknown>) => listed('studio', studioRows, query)),
    cancelWorkflow: vi.fn(async (id: string) => { calls.push(`studio:cancel:${id}`) }),
    deleteWorkflows: vi.fn(async (ids: string[]) => { calls.push(`studio:delete:${ids.length}`) }),
  }
  const kei = {
    listWorkflows: vi.fn(async (query: Record<string, unknown>) => listed('kei', keiRows, query)),
    cancelWorkflow: vi.fn(async (id: string) => { calls.push(`kei:cancel:${id}`) }),
  }
  const references = {
    scopes: vi.fn(async () => { calls.push('references:scopes'); return emptyScopes }),
    referencedPreprocessIds: vi.fn(async () => { calls.push('references:preprocess'); return new Set<string>() }),
    referencedPackages: vi.fn(async () => { calls.push('references:packages'); return new Set<string>() }),
    packageIsReferenced: vi.fn(async () => { calls.push('references:package'); return false }),
  }
  const keiHandoff = {
    requestDeleteRuns: vi.fn(async () => { calls.push('kei:deleteRuns') }),
  }
  const packages = {
    list: vi.fn(async () => { calls.push('packages:list'); return [] }),
    leftovers: vi.fn(async () => { calls.push('packages:leftovers'); return [] }),
    remove: vi.fn(async () => { calls.push('packages:remove'); return true }),
    removeLeftover: vi.fn(async () => { calls.push('packages:removeLeftover') }),
  }
  const inbox = {
    root: '/test/inbox',
    list: vi.fn(async () => { calls.push('inbox:list'); return [] }),
    remove: vi.fn(async () => { calls.push('inbox:remove') }),
  }
  const ports = {
    steps: { step: async (name: string, run: () => Promise<unknown>) => { steps.push(name); return run() } },
    bootTimestampMs: () => NOW - 1000,
    clock: vi.fn(async () => NOW),
    studio, kei, keiHandoff, references, packages, inbox,
    policy: GC_POLICY,
    log: (line: string) => logs.push(line),
  } as unknown as GarbagePorts
  return { ports, calls, steps, logs, studio, kei, references, keiHandoff, packages, inbox }
}

describe('collectGarbage', () => {
  it('reads the clock once and runs the five named phases in order', async () => {
    const fake = fakePorts()
    const result = await collectGarbageWorkflow(SCHEDULED, fake.ports)
    expect(fake.steps).toEqual([
      'clock', 'repairCancellations', 'studioHistory', 'keiRunsAndHistory', 'stagedSources', 'packages',
    ])
    expect(fake.ports.clock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      cancelledStudio: [], cancelledKei: [], deletedStudioHistory: 0, keiRequest: null,
      removedStagedSources: 0, removedPackages: 0, removedLeftovers: 0, failedPhases: [],
    })
    expect(fake.keiHandoff.requestDeleteRuns).not.toHaveBeenCalled()
  })

  it('fails closed on reference errors, logs only the error class, and continues file phases', async () => {
    const fake = fakePorts()
    fake.references.scopes.mockRejectedValue(new Error('postgresql://u:secret@h/db'))
    fake.references.referencedPreprocessIds.mockRejectedValue(new Error('postgresql://u:secret@h/db'))
    const result = await collectGarbageWorkflow(SCHEDULED, fake.ports)
    expect(result.failedPhases).toEqual(['repairCancellations', 'studioHistory', 'keiRunsAndHistory'])
    expect(fake.studio.cancelWorkflow).not.toHaveBeenCalled()
    expect(fake.studio.deleteWorkflows).not.toHaveBeenCalled()
    expect(fake.keiHandoff.requestDeleteRuns).not.toHaveBeenCalled()
    expect(fake.inbox.list).toHaveBeenCalledOnce()
    expect(fake.packages.list).toHaveBeenCalledOnce()
    expect(fake.logs.join(' ')).toContain('Error')
    expect(fake.logs.join(' ')).not.toContain('secret')
  })

  it('propagates workflow cancellation rather than continuing a cancelled sweep', async () => {
    const fake = fakePorts()
    const cancellation = new DBOSErrors.DBOSWorkflowCancelledError('sched-collectGarbage-test')
    fake.references.scopes.mockRejectedValue(cancellation)
    await expect(collectGarbageWorkflow(SCHEDULED, fake.ports)).rejects.toBe(cancellation)
    expect(fake.steps).toEqual(['clock', 'repairCancellations'])
  })

  it('reads the kei parent and run references before requesting one deleteRuns workflow', async () => {
    const parentId = 'ingest:51000000-0000-4000-8000-000000000001:52000000-0000-4000-8000-000000000001'
    const conversionId = `kei-convert:${parentId}`
    const old = NOW - 31 * 24 * 3600_000
    const fake = fakePorts(
      [{ workflowID: parentId, status: 'SUCCESS', updatedAt: old, completedAt: old }],
      [{ workflowID: conversionId, status: 'SUCCESS', updatedAt: old, completedAt: old,
        output: { ok: true, run_id: 'run1', generation: 'g1', page_count: 1,
          source_sha256: 'a'.repeat(64), page_source: 'pdf' } }],
    )
    const request = await collectKei(fake.ports, NOW, 'kei-gc:2026-09-26T12:00:00.000Z')
    expect(request).toEqual({ conversions: [conversionId], history: [] })
    expect(fake.keiHandoff.requestDeleteRuns).toHaveBeenCalledOnce()
    expect(fake.calls).toEqual(['kei:list', 'studio:list', 'references:preprocess', 'kei:deleteRuns'])
    // Durable Extraction workflows are collected with their graph, never listed here.
    expect(fake.kei.listWorkflows).toHaveBeenCalledWith({
      workflowName: ['convert', 'deleteRuns', 'deleteDurableHistoryV1'], loadInput: false, loadOutput: true,
    })
  })

  it('reads every repair dependency before cancelling and rechecks a planned cancellation', async () => {
    const id = 'suggest:51000000-0000-4000-8000-000000000001:1'
    const fake = fakePorts([{ workflowID: id, status: 'PENDING' }])
    fake.studio.listWorkflows.mockImplementation(async (query: Record<string, unknown>) => {
      fake.calls.push('studio:list')
      return query.workflowIDs ? [{ workflowID: id, status: 'CANCELLED' }] : [{ workflowID: id, status: 'PENDING' }]
    })
    const result = await repairCancellations(fake.ports)
    expect(result).toEqual({ studio: [], kei: [] })
    expect(fake.studio.cancelWorkflow).not.toHaveBeenCalled()
    expect(fake.calls.indexOf('references:scopes')).toBeLessThan(fake.calls.lastIndexOf('studio:list'))
    expect(fake.kei.listWorkflows).toHaveBeenCalledWith({
      workflowName: ['convert'], status: ['ENQUEUED', 'DELAYED', 'PENDING'], loadInput: false, loadOutput: false,
    })
  })

  it('deletes at most 100 Studio histories per database call', async () => {
    const old = NOW - 31 * 24 * 3600_000
    const rows = Array.from({ length: 205 }, (_, i) => ({
      workflowID: `ingest:51000000-0000-4000-8000-000000000001:${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`,
      status: 'SUCCESS', completedAt: old, updatedAt: old,
    }))
    const fake = fakePorts(rows)
    expect(await collectStudioHistory(fake.ports, NOW)).toBe(205)
    expect(fake.studio.deleteWorkflows.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 5])
    expect(fake.calls.indexOf('references:scopes')).toBeLessThan(fake.calls.indexOf('studio:delete:100'))
  })
})
