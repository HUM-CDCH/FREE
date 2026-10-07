/** A valid PDF of `pages` blank pages with a correct cross-reference table. `tag` goes into a comment after the
 *  header, so two PDFs of one page count can still differ in content. */
export function blankPdf(pages: number, tag = ''): Uint8Array {
  const kids = Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'),
  ]
  let body = tag === '' ? '%PDF-1.4\n' : `%PDF-1.4\n% ${tag}\n`
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

/** `%PDF-1.7` and `size` bytes of objects with no cross-reference table: pdf.js scans all of them to rebuild one, and
 *  then cannot open the document. */
export function junkObjects(size: number): Uint8Array {
  const parts = ['%PDF-1.7\n']
  let length = parts[0]!.length
  for (let index = 1; length < size; index += 1) {
    const object = `${index} 0 obj\n<< /Type /Junk /K ${index} >>\nendobj\n`
    parts.push(object)
    length += object.length
  }
  return new TextEncoder().encode(parts.join(''))
}
