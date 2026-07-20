import { highlightAlpha, type Highlight } from './evidenceHighlights'

export type PaintEntry = {
  highlight: Highlight
  rects: readonly Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>[]
  pageTop: number
  pageLeft: number
}

export function paintEvidenceEntries(
  context: Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'fillRect' | 'globalAlpha' | 'fillStyle'>,
  entries: readonly PaintEntry[],
  focusPath: string[] | null,
): void {
  for (const entry of entries) {
    context.save()
    context.globalAlpha = highlightAlpha(entry.highlight.path, focusPath)
    context.fillStyle = entry.highlight.color
    for (const rect of entry.rects) {
      context.fillRect(entry.pageLeft + rect.x - 1, entry.pageTop + rect.y - 2, rect.width + 2, rect.height + 2)
    }
    context.restore()
  }
}
