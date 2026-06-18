// NuExtract3 is a vision model: it reads page images, not raw PDF bytes. Neither
// provider SDK rasterises for us — ai-sdk-ollama keeps only image/* parts and
// silently drops application/pdf, while @ai-sdk/openai-compatible wraps a PDF as
// an OpenAI file_data part that llama.cpp can't read. So the document never
// reaches the model and it answers from the instructions alone (a generic, un-
// grounded schema). We rasterise client-side, mirroring the Python backend's
// SourceDocumentInputPreparer (pypdfium2 @ NUEXTRACT3_PDF_DPI=64).

// 72 is the PDF user-space unit (points per inch), so 64/72 reproduces the
// backend's 64-DPI render. The model works fine at low DPI and small JPEGs keep
// the request payload manageable.
const RASTER_SCALE = 64 / 72
const JPEG_QUALITY = 0.9

let workerConfigured = false

/**
 * Render every page of `pdf` to a JPEG data URL.
 *
 * This is an independent render pass via `getDocument`, deliberately separate
 * from the on-screen `PDFViewer`: pdf.js virtualises the viewer and only keeps
 * canvases for visible pages, so harvesting them would ship a partial document.
 */
export async function rasterizePdfToJpegPages(blob: Blob, signal?: AbortSignal): Promise<string[]> {
  const pdfjsLib = await import('pdfjs-dist')
  if (!workerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.mjs',
      import.meta.url,
    ).toString()
    workerConfigured = true
  }

  const data = new Uint8Array(await blob.arrayBuffer())
  const loadingTask = pdfjsLib.getDocument({ data })
  const pdf = await loadingTask.promise
  try {
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (signal?.aborted) {
        throw new DOMException('Rasterisation aborted', 'AbortError')
      }
      const page = await pdf.getPage(pageNumber)
      try {
        const viewport = page.getViewport({ scale: RASTER_SCALE })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const canvasContext = canvas.getContext('2d')
        if (!canvasContext) {
          throw new Error('Unable to rasterise source document: 2D canvas is unavailable')
        }
        await page.render({ canvas, canvasContext, viewport }).promise
        pages.push(canvas.toDataURL('image/jpeg', JPEG_QUALITY))
      } finally {
        page.cleanup()
      }
    }
    if (pages.length === 0) {
      throw new Error('Source document has no pages to rasterise')
    }
    return pages
  } finally {
    await loadingTask.destroy()
  }
}
