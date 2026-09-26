import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

/** How long an upload waits for its page count. A hostile PDF (100 MiB of objects with no cross-reference table) keeps
 *  pdf.js rebuilding one for seconds; past this it counts as unknown and converts on the large lane. */
export const PAGE_COUNT_DEADLINE_MS = 10_000

/** How many counts run at once. pdf.js rebuilding a hostile 100 MiB PDF's cross-reference table holds about 1.6 GB of
 *  heap in its worker, so concurrent uploads wait for a slot, within the same deadline, instead of each starting one. */
export const PAGE_COUNT_CONCURRENCY = 2

/**
 * The worker's whole program: open the document without loading a page and post its page count, or null when pdf.js
 * cannot open it. It is evaluated from this source rather than loaded from a file, so it runs the same under Vitest,
 * the development server and the built server bundle; pdf.js is imported from the path this module resolved.
 */
const COUNTER = `
const { parentPort, workerData } = require('node:worker_threads')
import(workerData.pdfjs).then(
  async (pdfjs) => {
    const task = pdfjs.getDocument({
      data: workerData.bytes, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0,
    })
    try {
      parentPort.postMessage((await task.promise).numPages)
    } catch {
      parentPort.postMessage(null)
    }
  },
  () => parentPort.postMessage(null),
)
`

let pdfjsUrl: string | undefined
const pdfjs = () =>
  (pdfjsUrl ??= pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)

let running = 0
const waiting: Array<() => void> = []

/** Waits for a finished count's slot until `deadline` (a `performance.now()` time); false when the deadline came first. */
function freedSlot(deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const granted = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(granted), 1)
      resolve(false)
    }, Math.max(0, deadline - performance.now()))
    waiting.push(granted)
  })
}

/** Hands a finished count's slot to the next waiter, or frees it. */
function release(): void {
  const next = waiting.shift()
  if (next) next()
  else running -= 1
}

/** One count in its own worker, holding a slot until the worker is gone. */
function counted(bytes: Uint8Array, deadline: number): Promise<number | null> {
  return new Promise((resolve) => {
    const copy = bytes.slice() // moved to the worker; the caller still stages and hashes its bytes
    let worker: Worker
    try {
      worker = new Worker(COUNTER, {
        eval: true,
        workerData: { pdfjs: pdfjs(), bytes: copy },
        transferList: [copy.buffer],
      })
    } catch {
      release()
      resolve(null)
      return
    }
    let settled = false
    const finish = (count: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(count)
      void worker.terminate().finally(release)
    }
    const timer = setTimeout(() => finish(null), Math.max(0, deadline - performance.now()))
    worker.once('message', (count: unknown) =>
      finish(typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : null))
    worker.once('error', () => finish(null))
    worker.once('exit', () => finish(null))
  })
}

/**
 * The page count of a PDF, or null when pdf.js cannot open it in time. It never rejects: the count only picks kei's
 * conversion lane, and kei's PDFium still decides whether the PDF is readable, so an uncounted PDF converts on the
 * large lane rather than being refused (spec, *Studio → kei handoff → Unknown count*).
 *
 * pdf.js runs in a worker thread, never on Studio's event loop, and the worker is terminated once it answers or its
 * deadline passes, which releases everything pdf.js held. At most PAGE_COUNT_CONCURRENCY workers run at once; the
 * deadline counts from the call, so time spent waiting for a slot is part of it.
 */
export function countPdfPages(
  bytes: Uint8Array,
  options: { deadlineMs?: number } = {},
): Promise<number | null> {
  const deadline = performance.now() + (options.deadlineMs ?? PAGE_COUNT_DEADLINE_MS)
  if (running < PAGE_COUNT_CONCURRENCY) {
    running += 1
    return counted(bytes, deadline)
  }
  return freedSlot(deadline).then((granted) => (granted ? counted(bytes, deadline) : null))
}
