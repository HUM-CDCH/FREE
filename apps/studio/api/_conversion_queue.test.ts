import type { WorkflowStatus } from '@dbos-inc/dbos-sdk'
import { describe, expect, it, vi } from 'vitest'
import { calibrate, CALIBRATION_TTL_MS, createConversionQueueReader, sampleOf } from './_conversion_queue.js'

const NOW = Date.parse('2026-10-19T12:00:00.000Z')
const SHA = 'a'.repeat(64)
const status = (overrides: Partial<WorkflowStatus>): WorkflowStatus => ({
  workflowID: 'kei-convert:ingest:p:a', status: 'SUCCESS', workflowName: 'convert', workflowClassName: '',
  queueName: 'kei-convert-small', createdAt: NOW - 600_000, priority: 1, ...overrides,
})
const converted = (pages: number, ms: number, lane = 'kei-convert-small') => status({
  queueName: lane, dequeuedAt: NOW - ms, completedAt: NOW,
  output: { ok: true, run_id: 'r', generation: 'g', page_count: pages, source_sha256: SHA, page_source: 'pdf' },
})

describe('sampleOf', () => {
  it('times a conversion from dequeue to completion, so its wait does not count', () => {
    expect(sampleOf(converted(10, 120_000))).toEqual({ lane: 'kei-convert-small', pages: 10, ms: 120_000 })
  })

  it('skips a conversion without a start, an end or a readable output', () => {
    expect(sampleOf(status({ completedAt: NOW, output: converted(1, 1).output }))).toBeNull()
    expect(sampleOf(status({ dequeuedAt: NOW - 1, completedAt: NOW, output: { ok: false } }))).toBeNull()
  })
})

describe('calibrate', () => {
  const sample = (pages: number, ms: number) => ({ lane: 'kei-convert-small', pages, ms })

  it('says nothing from fewer than three conversions', () => {
    expect(calibrate([sample(1, 30_000), sample(2, 40_000)], 20_000)).toBeNull()
  })

  it('takes the median cost per page beyond the overhead, which reused results do not drag', () => {
    expect(calibrate([sample(10, 120_000), sample(5, 70_000), sample(20, 1_000), sample(4, 60_000)], 20_000)).toBe(10_000)
  })

  it('never promises an instant conversion', () => {
    expect(calibrate([sample(10, 1_000), sample(10, 2_000), sample(10, 3_000)], 20_000)).toBe(500)
  })
})

describe('createConversionQueueReader', () => {
  function reader(live: WorkflowStatus[], history: WorkflowStatus[], parents: WorkflowStatus[]) {
    let now = NOW
    const kei = { listWorkflows: vi.fn(async (input: { status?: unknown }) => input.status === 'SUCCESS' ? history : live) }
    const admission = { listWorkflows: vi.fn(async () => parents) }
    const read = createConversionQueueReader({ kei: () => kei as never, admission: () => admission as never, overheadMs: 20_000, now: () => now })
    return { read, kei, admission, advance: (ms: number) => { now += ms } }
  }
  const history = [converted(10, 120_000), converted(4, 60_000), converted(6, 80_000, 'kei-convert-large')]

  it('lists each lane oldest first, with the parent\'s admitted size and the running job\'s start', async () => {
    const { read, admission } = reader(
      [
        status({ workflowID: 'kei-convert:b', status: 'ENQUEUED', createdAt: NOW - 1_000 }),
        status({ workflowID: 'kei-convert:a', status: 'PENDING', createdAt: NOW - 9_000, dequeuedAt: NOW - 5_000 }),
        status({ workflowID: 'gc', status: 'ENQUEUED', queueName: 'kei-convert-large', createdAt: NOW }),
      ],
      history,
      [status({ workflowID: 'a', input: [{ pageCount: 12 }] }), status({ workflowID: 'b', input: [{ pageCount: null }] })],
    )
    const queue = await read()
    expect(admission.listWorkflows).toHaveBeenCalledWith({ workflowIDs: ['b', 'a'], loadInput: true, loadOutput: false })
    expect(queue.lanes.get('kei-convert-small')).toEqual([
      { conversionId: 'kei-convert:a', createdAt: NOW - 9_000, startedAt: NOW - 5_000, pages: 12 },
      { conversionId: 'kei-convert:b', createdAt: NOW - 1_000, startedAt: null, pages: null },
    ])
    expect(queue.lanes.get('kei-convert-large')).toEqual([{ conversionId: 'gc', createdAt: NOW, startedAt: null, pages: null }])
    expect(queue.msPerPage).toBe(10_000)
    expect(queue.typicalPages).toEqual(new Map([['kei-convert-small', 7], ['kei-convert-large', 6]]))
  })

  it('recalibrates only once the calibration is five minutes old', async () => {
    const { read, kei, advance } = reader([], history, [])
    await read()
    await read()
    const historyReads = () => kei.listWorkflows.mock.calls.filter(([input]) => input.status === 'SUCCESS').length
    expect(historyReads()).toBe(1)
    advance(CALIBRATION_TTL_MS)
    await read()
    expect(historyReads()).toBe(2)
  })
})
