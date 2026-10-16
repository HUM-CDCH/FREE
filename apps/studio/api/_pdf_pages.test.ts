import type { EventEmitter } from 'node:events'
import type { WorkerOptions } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_COUNT_CONCURRENCY } from './_pdf_pages'

type CounterWorker = EventEmitter & {
  bytes: Uint8Array
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>
  exit(): Promise<void>
}

const control = vi.hoisted(() => ({ workers: [] as CounterWorker[], constructionFails: false }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  class ControlledWorker extends EventEmitter {
    readonly bytes: Uint8Array
    readonly terminate: CounterWorker['terminate']
    private readonly exited: Promise<number>
    private releaseExit!: (code: number) => void

    constructor(_source: string, options: WorkerOptions) {
      super()
      if (control.constructionFails) throw new Error('worker creation failed')
      // Perform the real transfer, so detaching the caller's buffer would fail the copy assertion.
      this.bytes = structuredClone(options.workerData, {
        transfer: options.transferList as ArrayBuffer[],
      }).bytes
      this.exited = new Promise((resolve) => { this.releaseExit = resolve })
      this.terminate = vi.fn(() => this.exited)
      control.workers.push(this)
    }

    async exit(): Promise<void> {
      this.emit('exit', 0)
      this.releaseExit(0)
      await this.exited
    }
  }
  return { Worker: ControlledWorker }
})

let countPdfPages: typeof import('./_pdf_pages')['countPdfPages']
const bytes = () => new Uint8Array([1, 2, 3])

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  control.constructionFails = false
  control.workers.length = 0
  countPdfPages = (await import('./_pdf_pages')).countPdfPages
})

afterEach(async () => {
  // A result settles before termination releases its slot. Drain workers, including any queued successor.
  for (const worker of control.workers) await worker.exit()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

describe('countPdfPages worker lifecycle', () => {
  it("transfers a copy and leaves the caller's bytes intact", async () => {
    const input = bytes()
    const before = input.slice()
    const count = countPdfPages(input)
    expect(control.workers[0].bytes).toEqual(before)
    expect(input).toEqual(before)
    control.workers[0].emit('message', 3)
    await expect(count).resolves.toBe(3)
  })

  it('runs at most PAGE_COUNT_CONCURRENCY workers, holding a slot until termination finishes', async () => {
    expect(PAGE_COUNT_CONCURRENCY).toBe(2)
    const first = countPdfPages(bytes())
    const second = countPdfPages(bytes())
    const waiting = countPdfPages(bytes())
    expect(control.workers).toHaveLength(2)

    control.workers[0].emit('message', 1)
    await expect(first).resolves.toBe(1)
    expect(control.workers[0].terminate).toHaveBeenCalledOnce()
    // Awaiting a count does not mean its worker has exited, even when it answered successfully.
    expect(control.workers).toHaveLength(2)
    await control.workers[0].exit()
    expect(control.workers).toHaveLength(3)
    expect(control.workers[1].terminate).not.toHaveBeenCalled()

    control.workers[1].emit('message', 2)
    control.workers[2].emit('message', 3)
    await expect(Promise.all([second, waiting])).resolves.toEqual([2, 3])
  })

  it('expires a waiting count without starting a worker, then hands the slots back', async () => {
    const running = [countPdfPages(bytes()), countPdfPages(bytes())]
    const waiting = countPdfPages(bytes(), { deadlineMs: 50 })
    const answered = vi.fn()
    void waiting.then(answered)
    await vi.advanceTimersByTimeAsync(49)
    expect(answered).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting).resolves.toBeNull()
    expect(control.workers).toHaveLength(2)

    for (const worker of control.workers) {
      worker.emit('message', 1)
      await worker.exit()
    }
    await expect(Promise.all(running)).resolves.toEqual([1, 1])
    const later = countPdfPages(bytes())
    expect(control.workers).toHaveLength(3)
    control.workers[2].emit('message', 3)
    await expect(later).resolves.toBe(3)
  })

  it('terminates an overdue worker, retaining its slot until it exits', async () => {
    const running = [countPdfPages(bytes(), { deadlineMs: 50 }), countPdfPages(bytes(), { deadlineMs: 50 })]
    const waiting = countPdfPages(bytes())
    await vi.advanceTimersByTimeAsync(50)
    await expect(Promise.all(running)).resolves.toEqual([null, null])
    expect(control.workers).toHaveLength(2)
    for (const worker of control.workers) expect(worker.terminate).toHaveBeenCalledOnce()

    await control.workers[0].exit()
    expect(control.workers).toHaveLength(3)
    control.workers[2].emit('message', 3)
    await expect(waiting).resolves.toBe(3)
  })

  it('includes time spent waiting for a slot in the deadline', async () => {
    const running = [countPdfPages(bytes()), countPdfPages(bytes())]
    const waiting = countPdfPages(bytes(), { deadlineMs: 50 })
    await vi.advanceTimersByTimeAsync(30)
    control.workers[0].emit('message', 1)
    await control.workers[0].exit()
    expect(control.workers).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(19)
    expect(control.workers[2].terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting).resolves.toBeNull()
    expect(control.workers[2].terminate).toHaveBeenCalledOnce()
    control.workers[1].emit('message', 1)
    await expect(Promise.all(running)).resolves.toEqual([1, 1])
  })

  it('answers null once a zero-length deadline passes', async () => {
    const count = countPdfPages(bytes(), { deadlineMs: 0 })
    await vi.advanceTimersByTimeAsync(0)
    await expect(count).resolves.toBeNull()
    expect(control.workers[0].terminate).toHaveBeenCalledOnce()
  })

  it.each([0, -1, 1.5, '2', null])('rejects an invalid worker count %s', async (message) => {
    const count = countPdfPages(bytes())
    control.workers[0].emit('message', message)
    await expect(count).resolves.toBeNull()
  })

  it.each(['error', 'exit'])('answers null when the worker emits %s', async (event) => {
    const count = countPdfPages(bytes())
    control.workers[0].emit(event, event === 'error' ? new Error('worker failed') : 1)
    await expect(count).resolves.toBeNull()
    expect(control.workers[0].terminate).toHaveBeenCalledOnce()
  })

  it('answers null and releases its slot if copying the caller bytes fails', async () => {
    const input = bytes()
    input.slice = () => { throw new Error('copy failed') }
    await expect(Promise.all([countPdfPages(input), countPdfPages(input)])).resolves.toEqual([null, null])
    expect(control.workers).toHaveLength(0)
    const later = countPdfPages(bytes())
    control.workers[0].emit('message', 2)
    await expect(later).resolves.toBe(2)
  })

  it('answers null and releases its slot if creating the worker fails', async () => {
    control.constructionFails = true
    await expect(Promise.all([countPdfPages(bytes()), countPdfPages(bytes())])).resolves.toEqual([null, null])
    control.constructionFails = false
    const later = countPdfPages(bytes())
    control.workers[0].emit('message', 2)
    await expect(later).resolves.toBe(2)
  })
})
