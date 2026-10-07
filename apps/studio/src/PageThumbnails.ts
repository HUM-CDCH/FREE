import type { PDFDocumentProxy } from 'pdfjs-dist'

/** The rail's cards are 46×58; a letter page at 0.12 is 73×95, downscaled on draw. */
export const THUMBNAIL_SCALE = 0.12

export type ThumbnailRenderer = {
  /** Resolves the page's bitmap, or null when it could not be rendered (the card then shows its number only). */
  render(page: number): Promise<ImageBitmap | null>
  /** Drops the cached bitmaps; called when the document closes. */
  dispose(): void
}

type ThumbnailSource = Pick<PDFDocumentProxy, 'getPage'>

async function paintPage(pdf: ThumbnailSource, pageNumber: number): Promise<ImageBitmap | null> {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: THUMBNAIL_SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  // pdfjs-dist 6: `canvas` is the required render target; `canvasContext` survives only as a deprecated path.
  await page.render({ canvas, viewport }).promise
  return typeof createImageBitmap === 'function' ? createImageBitmap(canvas) : null
}

/** Renders the pages of one document at THUMBNAIL_SCALE, once each, from the viewer's own `PDFDocumentProxy`. */
export function createThumbnailRenderer(
  pdf: ThumbnailSource,
  paint: (pdf: ThumbnailSource, page: number) => Promise<ImageBitmap | null> = paintPage,
): ThumbnailRenderer {
  const cache = new Map<number, Promise<ImageBitmap | null>>()
  return {
    render(page) {
      let pending = cache.get(page)
      if (!pending) {
        pending = paint(pdf, page).catch(() => null)
        cache.set(page, pending)
      }
      return pending
    },
    dispose() {
      for (const pending of cache.values()) void pending.then((bitmap) => bitmap?.close())
      cache.clear()
    },
  }
}
