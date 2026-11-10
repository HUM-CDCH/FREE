import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BatchExtraction } from '../shared/batchExtraction.contract'
import { durableRequest } from './durableExtractionApi'
import { batchStoppable, stopBatchExtraction } from './stopBatchExtraction'

vi.mock('./durableExtractionApi', () => ({
  durableRoot: (id: string) => `/api/extractions/${id}/durable`,
  durableRequest: vi.fn(),
}))

afterEach(() => vi.mocked(durableRequest).mockReset())

type Status = BatchExtraction['members'][number]['executionStatus']
const member = (id: string, executionStatus: Status) => ({ extractionId: id, sourceDocumentId: `document-${id}`,
  sourceRepresentationRevisionId: `source-${id}`, executionStatus, completed: executionStatus === 'COMPLETED', reviewable: false, currentReview: null })
const batch = (...members: ReturnType<typeof member>[]) => ({ members }) as unknown as BatchExtraction

/** Answers each Extraction's read with `status` at `version`, and records every stop. */
function serve(states: Record<string, { status: Status; version: number }>, refuseFirstStop: string[] = []) {
  const refused = new Set<string>()
  vi.mocked(durableRequest).mockImplementation(async (url: string, body?: unknown) => {
    const id = url.split('/')[3]!
    if (!body) return { status: states[id]!.status, controlVersion: states[id]!.version } as never
    if (refuseFirstStop.includes(id) && !refused.has(id)) {
      refused.add(id)
      states[id]!.version += 1
      throw new Error('The Extraction changed.')
    }
    return { controlVersion: states[id]!.version + 1 } as never
  })
}
const stops = () => vi.mocked(durableRequest).mock.calls.filter(([, body]) => body !== undefined)
  .map(([url, body]) => [url.split('/')[3], (body as { expectedVersion: number }).expectedVersion, (body as { action: string }).action])

describe('stopBatchExtraction', () => {
  it('stops every member still at work, under its own control version, and leaves finished and failed ones', async () => {
    serve({ queued: { status: 'QUEUED', version: 1 }, running: { status: 'RUNNING', version: 4 }, pausing: { status: 'PAUSING', version: 2 },
      paused: { status: 'PAUSED', version: 7 } })
    const running = batch(member('queued', 'QUEUED'), member('running', 'RUNNING'), member('pausing', 'PAUSING'), member('paused', 'PAUSED'),
      member('done', 'COMPLETED'), member('failed', 'FAILED'), member('stopped', 'STOPPED'))
    expect(batchStoppable(running)).toBe(true)
    await stopBatchExtraction([running])
    expect(stops().sort()).toEqual([['paused', 7, 'stop'], ['pausing', 2, 'stop'], ['queued', 1, 'stop'], ['running', 4, 'stop']])
  })

  it('reads again when a command moved the version meanwhile, and stops nothing that ended on its own', async () => {
    serve({ moved: { status: 'RUNNING', version: 3 }, ended: { status: 'COMPLETED', version: 9 } }, ['moved'])
    await stopBatchExtraction([batch(member('moved', 'RUNNING'), member('ended', 'RUNNING'))])
    expect(stops()).toEqual([['moved', 3, 'stop'], ['moved', 4, 'stop']])
  })

  it('has nothing to stop once every member finished or failed', () => {
    expect(batchStoppable(batch(member('done', 'COMPLETED'), member('failed', 'FAILED')))).toBe(false)
  })
})
