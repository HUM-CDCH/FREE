import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument }))

import { countPdfPages } from './_pdf_pages'

function loadingTask(promise: Promise<unknown>) {
  // An unobserved rejection would fail the run before the counter awaits it.
  promise.catch(() => undefined)
  return { promise, destroy: vi.fn(async () => {}) }
}

describe('countPdfPages releases pdf.js', () => {
  beforeEach(() => getDocument.mockReset())

  it('destroys the loading task after a count and after a failure to open', async () => {
    const counted = loadingTask(Promise.resolve({ numPages: 7 }))
    getDocument.mockReturnValueOnce(counted)
    expect(await countPdfPages(new Uint8Array([1]))).toBe(7)
    expect(counted.destroy).toHaveBeenCalledTimes(1)

    const failed = loadingTask(Promise.reject(new Error('Invalid PDF structure.')))
    getDocument.mockReturnValueOnce(failed)
    expect(await countPdfPages(new Uint8Array([1]))).toBeNull()
    expect(failed.destroy).toHaveBeenCalledTimes(1)
  })
})
