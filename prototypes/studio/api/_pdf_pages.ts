import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

/**
 * The page count of a PDF, or null when pdf.js cannot open it. It opens the document without loading a page and
 * destroys the loading task whatever happens. It never rejects: the count only picks kei's conversion lane, and kei's
 * PDFium still decides whether the PDF is readable, so an uncounted PDF converts on the large lane rather than being
 * refused (spec, *Studio → kei handoff → Unknown count*).
 */
export async function countPdfPages(bytes: Uint8Array): Promise<number | null> {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes.slice(), // pdf.js may transfer the buffer; the caller still stages and hashes its bytes
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  })
  try {
    return (await loadingTask.promise).numPages
  } catch {
    return null
  } finally {
    await loadingTask.destroy().catch(() => undefined)
  }
}
