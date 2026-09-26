import { describe, expect, it } from 'vitest'
import { blankPdf, junkObjects } from '../test/support/pdf'
import { countPdfPages } from './_pdf_pages'

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

  it("leaves the caller's bytes intact", async () => {
    const bytes = blankPdf(2)
    const before = bytes.slice(0, 16)
    const length = bytes.byteLength
    await countPdfPages(bytes)
    expect(bytes.byteLength).toBe(length)
    expect(bytes.slice(0, 16)).toEqual(before)
  })
})
