import { describe, expect, it } from 'vitest'
import { countPdfPages } from './_pdf_pages'

/** A valid PDF of `pages` blank pages with a correct cross-reference table. */
function blankPdf(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'),
  ]
  let body = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

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

  it("leaves the caller's bytes intact", async () => {
    const bytes = blankPdf(2)
    const before = bytes.slice(0, 16)
    const length = bytes.byteLength
    await countPdfPages(bytes)
    expect(bytes.byteLength).toBe(length)
    expect(bytes.slice(0, 16)).toEqual(before)
  })
})
