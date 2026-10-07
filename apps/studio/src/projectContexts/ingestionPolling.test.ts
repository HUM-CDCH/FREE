import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceIngestionListing } from '../../shared/sourceDocumentIngestion.contract'
import { startIngestionPolling, type IngestionReading } from './ingestionPolling'
import { ProjectContextRequestError } from './transport'

const empty: SourceIngestionListing = { ingestions: [], absent: [] }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function poller(options: {
  list?: (signal: AbortSignal) => Promise<SourceIngestionListing>
  busy?: () => boolean
  hidden?: () => boolean
} = {}) {
  const list = vi.fn(options.list ?? (async () => empty))
  const readings: IngestionReading[] = []
  let visible: () => void = () => {}
  const started = startIngestionPolling({
    list,
    onReading: (reading) => readings.push(reading),
    busy: options.busy ?? (() => false),
    isHidden: options.hidden ?? (() => false),
    onVisible: (listener) => { visible = listener; return () => { visible = () => {} } },
  })
  return { list, readings, poller: started, becomeVisible: () => visible() }
}

describe('startIngestionPolling', () => {
  it('reads at once, then every 3 s while busy and every 30 s while idle', async () => {
    let busy = true
    const { list, poller: running } = poller({ busy: () => busy })
    await vi.advanceTimersByTimeAsync(0); expect(list).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000); expect(list).toHaveBeenCalledTimes(2)
    busy = false
    await vi.advanceTimersByTimeAsync(3000); expect(list).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(29_999); expect(list).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1); expect(list).toHaveBeenCalledTimes(4)
    running.stop()
  })

  it('never overlaps reads: a slow read delays the next one instead of stacking', async () => {
    const pending: PromiseWithResolvers<SourceIngestionListing>[] = []
    const { list, poller: running } = poller({
      busy: () => true,
      list: () => { const read = Promise.withResolvers<SourceIngestionListing>(); pending.push(read); return read.promise },
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(list).toHaveBeenCalledTimes(1)
    pending[0]!.resolve(empty)
    await vi.advanceTimersByTimeAsync(2999); expect(list).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(list).toHaveBeenCalledTimes(2)
    running.stop()
  })

  it('a failed read keeps the rows, marks them stale and backs off 3, 6, 12, then 30 s', async () => {
    const { list, readings, poller: running } = poller({ list: async () => { throw new Error('offline') } })
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(1)
    for (const [index, wait] of [3000, 6000, 12_000, 30_000, 30_000].entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(list).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(list).toHaveBeenCalledTimes(index + 2)
    }
    expect(readings.every((reading) => reading.kind === 'unavailable')).toBe(true)
    running.stop()
  })

  it('a 404 reports gone and stops', async () => {
    const { list, readings } = poller({
      busy: () => true,
      list: async () => { throw new ProjectContextRequestError(404, { code: 'not_found', message: 'Gone.' }) },
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(list).toHaveBeenCalledOnce()
    expect(readings).toEqual([{ kind: 'gone' }])
  })

  it('no reads while hidden; reads at once when visible again', async () => {
    let hidden = true
    const { list, becomeVisible, poller: running } = poller({ hidden: () => hidden, busy: () => true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(list).not.toHaveBeenCalled()
    hidden = false
    becomeVisible()
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledOnce()
    running.stop()
  })

  it('readNow reads immediately and restarts the cadence', async () => {
    const { list, poller: running } = poller()
    await vi.advanceTimersByTimeAsync(0)
    running.readNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(29_999); expect(list).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); expect(list).toHaveBeenCalledTimes(3)
    running.stop()
  })

  it('readNow during a read in flight reads once more right after it', async () => {
    const pending: PromiseWithResolvers<SourceIngestionListing>[] = []
    const { list, poller: running } = poller({
      list: () => { const read = Promise.withResolvers<SourceIngestionListing>(); pending.push(read); return read.promise },
    })
    await vi.advanceTimersByTimeAsync(0)
    running.readNow()
    running.readNow()
    expect(list).toHaveBeenCalledOnce()
    pending[0]!.resolve(empty)
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(2)
    running.stop()
  })

  it('stop aborts the read in flight and ignores its result', async () => {
    let signal: AbortSignal | undefined
    const read = Promise.withResolvers<SourceIngestionListing>()
    const { readings, poller: running } = poller({ list: (given) => { signal = given; return read.promise } })
    await vi.advanceTimersByTimeAsync(0)
    running.stop()
    expect(signal?.aborted).toBe(true)
    read.resolve(empty)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readings).toEqual([])
  })
})
