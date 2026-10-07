import { describe, expect, it, vi } from 'vitest'
import { blankPdf, junkObjects } from '../test/support/pdf'
import { countPdfPages, PAGE_COUNT_CONCURRENCY } from './_pdf_pages'

/** Every page-count worker this file starts, in order: the real worker, counted. */
const workers = vi.hoisted(() => [] as unknown[])
vi.mock('node:worker_threads', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:worker_threads')>()
  class CountedWorker extends real.Worker {
    constructor(...args: ConstructorParameters<typeof real.Worker>) {
      super(...args)
      workers.push(this)
    }
  }
  return { ...real, Worker: CountedWorker }
})

describe('countPdfPages', () => {
  it('counts the pages of a PDF without rendering them', async () => {
    expect(await countPdfPages(blankPdf(1))).toBe(1)
    expect(await countPdfPages(blankPdf(30))).toBe(30)
    expect(await countPdfPages(blankPdf(31))).toBe(31)
  })

  it('answers null, never an exception, for bytes pdf.js cannot open', async () => {
    const header = new TextEncoder().encode('%PDF-1.7\n')
    const garbage = new Uint8Array(header.byteLength + 200)
    garbage.set(header)
    await expect(countPdfPages(garbage)).resolves.toBeNull()
    await expect(countPdfPages(new TextEncoder().encode('%PDF-'))).resolves.toBeNull()
  })

  it('counts off the event loop: timers keep firing while pdf.js rebuilds a hostile PDF', async () => {
    const hostile = junkObjects(20 * 1024 * 1024)
    let last = performance.now()
    let longestGap = 0
    const ticker = setInterval(() => {
      const now = performance.now()
      longestGap = Math.max(longestGap, now - last)
      last = now
    }, 10)
    try {
      // In process, pdf.js holds the event loop for about a second on these 20 MiB.
      await expect(countPdfPages(hostile)).resolves.toBeNull()
      longestGap = Math.max(longestGap, performance.now() - last)
    } finally {
      clearInterval(ticker)
    }
    // Timer scheduling on a busy runner jitters; a blocked loop shows a gap of the whole count.
    expect(longestGap).toBeLessThan(700)
  })

  it('answers null once the count outlives its deadline', async () => {
    await expect(countPdfPages(junkObjects(20 * 1024 * 1024), { deadlineMs: 50 })).resolves.toBeNull()
    await expect(countPdfPages(blankPdf(3), { deadlineMs: 0 })).resolves.toBeNull()
  })

  it('runs at most PAGE_COUNT_CONCURRENCY counts at once; the next waits for a slot', async () => {
    expect(PAGE_COUNT_CONCURRENCY).toBe(2)
    const before = workers.length
    const hostile = junkObjects(20 * 1024 * 1024)
    let finished = 0
    const running = [countPdfPages(hostile), countPdfPages(hostile)].map((count) => count.finally(() => { finished += 1 }))
    const waiting = countPdfPages(blankPdf(3))
    // A previous test's workers may still be terminating, so the first two can wait a moment for their slots.
    await vi.waitFor(() => expect(workers.length - before).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 100))
    // pdf.js needs about a second for each hostile count; until one finishes the third has no worker.
    expect(finished).toBe(0)
    expect(workers.length - before).toBe(2)

    await Promise.race(running)
    await vi.waitFor(() => expect(workers.length - before).toBe(3))
    await expect(waiting).resolves.toBe(3)
    await Promise.all(running)
  })

  it('a count still waiting for a slot at its deadline answers null without starting a worker', async () => {
    const before = workers.length
    const hostile = junkObjects(20 * 1024 * 1024)
    const running = [countPdfPages(hostile), countPdfPages(hostile)]

    await expect(countPdfPages(blankPdf(3), { deadlineMs: 50 })).resolves.toBeNull()
    expect(workers.length - before).toBe(2)
    await Promise.all(running)
    // The slots were handed back: a later count runs.
    await expect(countPdfPages(blankPdf(3))).resolves.toBe(3)
  })

  it("leaves the caller's bytes intact", async () => {
    const bytes = blankPdf(2)
    const before = bytes.slice(0, 16)
    const length = bytes.byteLength
    await countPdfPages(bytes)
    expect(bytes.byteLength).toBe(length)
    expect(bytes.slice(0, 16)).toEqual(before)
  })

  it('answers null and releases its slot if copying the caller bytes fails', async () => {
    const bytes = blankPdf(1)
    bytes.slice = () => { throw new Error('copy failed') }
    const failed = Array.from({ length: PAGE_COUNT_CONCURRENCY }, () => countPdfPages(bytes))
    await expect(Promise.all(failed)).resolves.toEqual([null, null])
    await expect(countPdfPages(blankPdf(2))).resolves.toBe(2)
  })
})
