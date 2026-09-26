import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

/** How long an upload waits for its page count. A hostile PDF (100 MiB of objects with no cross-reference table) keeps
 *  pdf.js rebuilding one for seconds; past this it counts as unknown and converts on the large lane. */
export const PAGE_COUNT_DEADLINE_MS = 10_000

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

/**
 * The page count of a PDF, or null when pdf.js cannot open it in time. It never rejects: the count only picks kei's
 * conversion lane, and kei's PDFium still decides whether the PDF is readable, so an uncounted PDF converts on the
 * large lane rather than being refused (spec, *Studio → kei handoff → Unknown count*).
 *
 * pdf.js runs in a worker thread, never on Studio's event loop, and the worker is terminated once it answers or its
 * deadline passes, which releases everything pdf.js held.
 */
export function countPdfPages(
  bytes: Uint8Array,
  options: { deadlineMs?: number } = {},
): Promise<number | null> {
  const copy = bytes.slice() // moved to the worker; the caller still stages and hashes its bytes
  return new Promise((resolve) => {
    const worker = new Worker(COUNTER, {
      eval: true,
      workerData: { pdfjs: pdfjs(), bytes: copy },
      transferList: [copy.buffer],
    })
    let settled = false
    const finish = (count: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(count)
      void worker.terminate()
    }
    const deadline = setTimeout(() => finish(null), options.deadlineMs ?? PAGE_COUNT_DEADLINE_MS)
    worker.once('message', (count: unknown) =>
      finish(typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : null))
    worker.once('error', () => finish(null))
    worker.once('exit', () => finish(null))
  })
}
