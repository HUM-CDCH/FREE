import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type {
  ParsedDocument,
  ParsedEvidenceAnchor,
} from 'extraction/parsed-document'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'
import {
  anchorOccurrences,
  reviewedAnchorOccurrences,
  type EvidenceOccurrence,
  verifiedEvidenceBbox,
} from './evidenceNavigation'

const HIGHLIGHT_COLORS = [
  'rgba(148, 203, 236, 0.28)',
  'rgba(220, 205, 125, 0.28)',
  'rgba(194, 106, 119, 0.24)',
  'rgba(93, 168, 153, 0.24)',
]

function reviewedOccurrenceIds(
  attempt: Pick<ExtractionAttempt, 'reviewDecisions'> | null,
  evidenceAnchorId: string,
) {
  return attempt?.reviewDecisions?.find(
    (decision) => decision.evidenceAnchorId === evidenceAnchorId,
  )?.reviewedOccurrenceIds
}

function appendOverlay(
  container: HTMLElement,
  parsedDocument: ParsedDocument,
  occurrence: EvidenceOccurrence,
  options: {
    className: string
    background: string
    border?: string
    evidenceAnchorId?: string
    resultPath?: readonly (string | number)[]
  },
): HTMLElement | null {
  const page = container.querySelector(
    `.page[data-page-number="${occurrence.page_number}"]`,
  )
  if (!(page instanceof HTMLElement)) return null
  const bbox = verifiedEvidenceBbox(parsedDocument, occurrence)
  const pageMeta = parsedDocument.pages.find(
    (candidate) => candidate.page_number === occurrence.page_number,
  )
  if (!bbox || !pageMeta) return null
  const overlay = window.document.createElement('div')
  overlay.className = options.className
  overlay.ariaHidden = 'true'
  overlay.dataset.occurrenceId = occurrence.occurrence_id
  if (options.evidenceAnchorId)
    overlay.dataset.evidenceAnchorId = options.evidenceAnchorId
  if (options.resultPath)
    overlay.dataset.resultPath = JSON.stringify(options.resultPath)
  Object.assign(overlay.style, {
    position: 'absolute',
    left: `${(bbox.x0 / pageMeta.width_pt) * 100}%`,
    top: `${(bbox.y0 / pageMeta.height_pt) * 100}%`,
    width: `${((bbox.x1 - bbox.x0) / pageMeta.width_pt) * 100}%`,
    height: `${((bbox.y1 - bbox.y0) / pageMeta.height_pt) * 100}%`,
    border: options.border ?? '0',
    borderRadius: '2px',
    background: options.background,
    pointerEvents: 'none',
    zIndex: options.border ? '5' : '4',
  })
  if (getComputedStyle(page).position === 'static')
    page.style.position = 'relative'
  page.append(overlay)
  return overlay
}

/** Dims the page around one occurrence (results review redesign §7.3): four canvas-coloured rectangles at 45% around
 *  its bbox grown by 24pt, so the page reads through at .55 and the passage stays clear; they take no pointer hits. */
function appendDimming(container: HTMLElement, parsedDocument: ParsedDocument, occurrence: EvidenceOccurrence) {
  const page = container.querySelector(`.page[data-page-number="${occurrence.page_number}"]`)
  const bbox = verifiedEvidenceBbox(parsedDocument, occurrence)
  const meta = parsedDocument.pages.find((candidate) => candidate.page_number === occurrence.page_number)
  if (!(page instanceof HTMLElement) || !bbox || !meta) return
  const x0 = Math.max(0, bbox.x0 - 24), y0 = Math.max(0, bbox.y0 - 24)
  const x1 = Math.min(meta.width_pt, bbox.x1 + 24), y1 = Math.min(meta.height_pt, bbox.y1 + 24)
  const pct = (value: number, of: number) => `${(value / of) * 100}%`
  for (const [left, top, right, bottom] of [
    [0, 0, meta.width_pt, y0], [0, y1, meta.width_pt, meta.height_pt], [0, y0, x0, y1], [x1, y0, meta.width_pt, y1],
  ] as const) {
    const shade = window.document.createElement('div')
    shade.className = 'evidence-dim'
    shade.ariaHidden = 'true'
    Object.assign(shade.style, {
      position: 'absolute', left: pct(left, meta.width_pt), top: pct(top, meta.height_pt),
      width: pct(right - left, meta.width_pt), height: pct(bottom - top, meta.height_pt),
      background: 'var(--color-canvas)', opacity: '0.45', pointerEvents: 'none', zIndex: '6',
    })
    if (getComputedStyle(page).position === 'static') page.style.position = 'relative'
    page.append(shade)
  }
}

function removeOverlays(container: HTMLElement | null, className: string) {
  container
    ?.querySelectorAll(`.${className}`)
    .forEach((overlay) => overlay.remove())
}

/**
 * Scrolls the viewer once, straight to the overlay. pdf.js renders pages as
 * they enter the scroll container, so animating across pages competes with
 * that rendering and stutters; a long jump therefore lands instantly and only
 * a hop inside the current view glides.
 */
function scrollOverlayIntoView(container: HTMLElement, overlay: HTMLElement) {
  const view = container.getBoundingClientRect()
  const target = overlay.getBoundingClientRect()
  const deltaY = target.top - view.top - (view.height - target.height) / 2
  const deltaX = target.left - view.left - (view.width - target.width) / 2
  if (Math.abs(deltaY) < 2 && Math.abs(deltaX) < 2) return
  container.scrollTo({
    top: container.scrollTop + deltaY,
    left: container.scrollLeft + deltaX,
    behavior: Math.abs(deltaY) > view.height || Math.abs(deltaX) > view.width ? 'auto' : 'smooth',
  })
}


/**
 * Owns persistent result-path painting and focused-anchor navigation. The
 * workspace supplies the inspected attempt, partial links, schema field names,
 * and viewer refs; occurrence filtering, repaint, scroll, and cleanup stay here.
 */
export function useEvidenceOverlays({
  containerRef,
  viewerRef,
  parsedDocument,
  attempt,
  fieldNames,
  resultPath,
  active,
  partialEvidenceLinks,
  dimLink = null,
}: {
  containerRef: RefObject<HTMLDivElement | null>
  viewerRef: RefObject<PDFViewer | null>
  parsedDocument: ParsedDocument | null
  attempt: Pick<
    ExtractionAttempt,
    'extractionId' | 'executionStatus' | 'outcome' | 'evidenceLinks' | 'reviewDecisions'
  > | null
  fieldNames: readonly string[]
  resultPath: readonly string[] | null
  active: boolean
  partialEvidenceLinks?: readonly EvidenceLink[] | null
  /** The one-by-one value's link: its page is dimmed around it when it is located to a cell or a segment. */
  dimLink?: EvidenceLink | null
}) {
  const stopFocusedPaint = useRef<(() => void) | null>(null)
  useEffect(() => {
    const container = containerRef.current
    const viewer = viewerRef.current
    if (!active || !dimLink || !parsedDocument || !container || (dimLink.precision !== 'cell' && dimLink.precision !== 'segment')) return
    const anchor = parsedDocument.evidence_index.anchors.find((candidate) => candidate.anchor_id === dimLink.evidenceAnchorId)
    const occurrence = anchor ? anchorOccurrences(anchor)[0] : undefined
    if (!occurrence) return
    const paint = () => { removeOverlays(container, 'evidence-dim'); appendDimming(container, parsedDocument, occurrence) }
    viewer?.eventBus?.on('pagerendered', paint)
    paint()
    return () => {
      viewer?.eventBus?.off('pagerendered', paint)
      removeOverlays(container, 'evidence-dim')
    }
  }, [active, containerRef, dimLink, parsedDocument, viewerRef])
  useEffect(() => {
    const container = containerRef.current
    const viewer = viewerRef.current
    const running = attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING'
    const evidenceLinks = attempt?.outcome === 'SUCCEEDED'
      ? attempt.evidenceLinks ?? []
      : running ? partialEvidenceLinks ?? null : null
    if (
      !container ||
      !parsedDocument ||
      !attempt ||
      evidenceLinks === null ||
      !active ||
      !resultPath
    )
      return

    const reviewedByAnchor = new Map(
      (attempt.reviewDecisions ?? []).map((decision) => [
        decision.evidenceAnchorId,
        decision.reviewedOccurrenceIds,
      ]),
    )
    const anchors = new Map(
      parsedDocument.evidence_index.anchors.map((anchor) => [
        anchor.anchor_id,
        anchor,
      ]),
    )
    const paint = (): EvidenceOccurrence | undefined => {
      let firstOccurrence: EvidenceOccurrence | undefined
      const paintedOccurrenceIds = new Set<string>()
      removeOverlays(container, 'parsed-evidence-highlight')
      evidenceLinks.forEach((link, linkIndex) => {
        if (
          !resultPath.every(
            (segment, index) => segment === String(link.resultPath[index]),
          )
        )
          return
        const anchor = anchors.get(link.evidenceAnchorId)
        if (!anchor) return
        const fieldName = link.resultPath.find(
          (segment): segment is string =>
            typeof segment === 'string' && fieldNames.includes(segment),
        )
        const fieldIndex = fieldName ? fieldNames.indexOf(fieldName) : linkIndex
        const color = HIGHLIGHT_COLORS[fieldIndex % HIGHLIGHT_COLORS.length]!
        const reviewed = reviewedByAnchor.get(anchor.anchor_id)
        for (const occurrence of anchorOccurrences(anchor)) {
          if (reviewed && !reviewed.includes(occurrence.occurrence_id)) continue
          if (paintedOccurrenceIds.has(occurrence.occurrence_id)) continue
          paintedOccurrenceIds.add(occurrence.occurrence_id)
          firstOccurrence ??= occurrence
          appendOverlay(container, parsedDocument, occurrence, {
            className: 'parsed-evidence-highlight',
            background: color,
            evidenceAnchorId: anchor.anchor_id,
            resultPath: link.resultPath,
          })
        }
      })
      return firstOccurrence
    }

    viewer?.eventBus?.on('pagerendered', paint)
    const firstOccurrence = paint()
    // A selected anchor owns navigation even while pdf.js has yet to render
    // its page and the focus overlay cannot be painted.
    if (firstOccurrence && !running && !stopFocusedPaint.current)
      viewer?.scrollPageIntoView({ pageNumber: firstOccurrence.page_number })
    return () => {
      viewer?.eventBus?.off('pagerendered', paint)
      removeOverlays(container, 'parsed-evidence-highlight')
    }
  }, [active, attempt, containerRef, fieldNames, parsedDocument, partialEvidenceLinks, resultPath, viewerRef])

  useEffect(
    () => () => {
      stopFocusedPaint.current?.()
      stopFocusedPaint.current = null
      removeOverlays(containerRef.current, 'parsed-evidence-focus')
      removeOverlays(containerRef.current, 'parsed-evidence-highlight')
    },
    [attempt?.extractionId, containerRef, parsedDocument],
  )

  return useCallback(
    (anchor: ParsedEvidenceAnchor) => {
      const viewer = viewerRef.current
      const container = containerRef.current
      stopFocusedPaint.current?.()
      stopFocusedPaint.current = null
      removeOverlays(container, 'parsed-evidence-focus')
      if (!viewer || !container || !parsedDocument) return
      const occurrences = reviewedAnchorOccurrences(
        anchor,
        reviewedOccurrenceIds(attempt, anchor.anchor_id),
      )
      const firstOccurrence = occurrences[0]
      if (!firstOccurrence) return
      // pdf.js resets an unrendered page's children; retain the selection through that render and later zooms.
      const paintFocus = () => {
        removeOverlays(container, 'parsed-evidence-focus')
        let firstFocus: HTMLElement | null = null
        for (const occurrence of occurrences) {
          const focus = appendOverlay(container, parsedDocument, occurrence, {
            className: 'parsed-evidence-focus',
            border: '2px solid #d97706',
            background: 'rgb(251 191 36 / 0.22)',
          })
          if (focus) firstFocus ??= focus
        }
        return firstFocus
      }
      viewer.eventBus?.on('pagerendered', paintFocus)
      stopFocusedPaint.current = () => viewer.eventBus?.off('pagerendered', paintFocus)
      const firstFocus = paintFocus()
      if (firstFocus) scrollOverlayIntoView(container, firstFocus)
      else viewer.scrollPageIntoView({ pageNumber: firstOccurrence.page_number })
    },
    [attempt, containerRef, parsedDocument, viewerRef],
  )
}
