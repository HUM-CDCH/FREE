import { MessageChannel, type MessagePort, type Worker, type WorkerOptions } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blankPdf } from '../test/support/pdf'
import { countPdfPages } from './_pdf_pages'

const control = vi.hoisted(() => ({
  workers: [] as Worker[],
  parser: undefined as { pdfjs: string; gate: SharedArrayBuffer; ready: MessagePort } | undefined,
}))
vi.mock('node:worker_threads', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:worker_threads')>()
  class ObservedWorker extends real.Worker {
    constructor(source: string, options: WorkerOptions) {
      // Only the blocking-parser case substitutes pdf.js; the worker runs the production program in every case.
      if (control.parser) options = {
        ...options,
        workerData: { ...options.workerData, ...control.parser },
        transferList: [...options.transferList ?? [], control.parser.ready],
      }
      super(source, options)
      control.workers.push(this)
    }
  }
  return { ...real, Worker: ObservedWorker }
})

afterEach(async () => {
  // Never let a timed-out real worker keep a slot (or expensive parsing) alive in the next test.
  await Promise.all(control.workers.map((worker) => worker.terminate()))
  control.workers.length = 0
  control.parser = undefined
})

describe('countPdfPages real worker', () => {
  it.each([1, 30, 31])('counts a %s-page PDF without rendering it', async (pages) => {
    const bytes = blankPdf(pages)
    const before = bytes.slice()
    await expect(countPdfPages(bytes)).resolves.toBe(pages)
    expect(bytes).toEqual(before)
  })

  it.each([
    { name: 'a header followed by garbage', input: '%PDF-1.7\n' + '\0'.repeat(200) },
    { name: 'a truncated header', input: '%PDF-' },
  ])('answers null for $name', async ({ input }) => {
    await expect(countPdfPages(new TextEncoder().encode(input))).resolves.toBeNull()
  })

  it('keeps main-loop timers running while the parser is blocked in its worker', async () => {
    const { port1, port2 } = new MessageChannel()
    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    const started = new Promise<void>((resolve) => port1.once('message', () => resolve()))
    // A synchronous parser wait makes the thread boundary observable without a CPU-speed or scheduling-gap limit.
    const parser = `
      import { workerData } from 'node:worker_threads'
      export function getDocument() {
        workerData.ready.postMessage('parsing')
        const gate = new Int32Array(workerData.gate)
        const outcome = Atomics.wait(gate, 0, 0, 10_000)
        return { promise: Promise.resolve({ numPages: outcome === 'timed-out' ? 1 : 2 }) }
      }
    `
    control.parser = { pdfjs: `data:text/javascript,${encodeURIComponent(parser)}`, gate: gate.buffer, ready: port2 }
    let timerRan = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const count = countPdfPages(blankPdf(2))
      await started
      timer = setTimeout(() => {
        timerRan = true
        Atomics.store(gate, 0, 1)
        Atomics.notify(gate, 0)
      }, 0)
      await expect(count).resolves.toBe(2)
      expect(timerRan).toBe(true)
    } finally {
      clearTimeout(timer)
      Atomics.store(gate, 0, 1)
      Atomics.notify(gate, 0)
      port1.close()
      port2.close()
    }
  })
})
