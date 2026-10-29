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
  type EvidenceOccurrence,
  verifiedEvidenceBbox,
} from './evidenceNavigation'
import { scrollWithinPane } from './scrollWithinPane'
import { evidenceColorVars, markValueId, ownsMark } from './durableRailModel'

/** What the rail says about one value, for its mark on the page. */
export type MarkInfo = { name: string; value: string; word: string | null; style: 'link' | 'rule' | 'doubtful' | 'neutral'; anchorId: string; precision?: EvidenceLink['precision']; color?: string }

/** The rail's values for the marks: a key `describe` names is a value a mark selects. */
export type RailMarkState = {
  describe: ReadonlyMap<string, MarkInfo>
  selected: string | null
  /** Stable retained value IDs, including explicit correction occurrences. */
  savedLinks?: readonly {key:string;link:EvidenceLink;occurrenceIds?:readonly string[]}[]
}

/** The Results rail's values and selection, which the marks show and select. */
export type RailMarks = RailMarkState & {
  onSelect: (keys: string[], mark: HTMLElement) => void
  /** The values under the pointer, here or in Results: their marks are lit. */
  hovered?: readonly string[] | null
  /** A mark under the pointer names its values; leaving it, none. */
  onHover?: (keys: readonly string[] | null) => void
}

/* A segment link's mark is boxed to its own quoted text when pdf.js's text layer shows it, so two values of one
 * paragraph are two marks. shortcut: a scanned page (no text layer) keeps the whole block, and the text is found by its
 * characters only; upgrade when the Parsing Service emits the quote's line boxes with the link. */
type Box = { x0: number; y0: number; x1: number; y1: number }
/** The quote's spans inside the one passage a link is located to; none when the link is a cell's or a page's. */
const quoteSpans = (link: EvidenceLink) => link.precision !== 'segment' ? []
  : (link.grounding?.textSpans ?? []).filter(span => `a_${span.segment}` === link.evidenceAnchorId)
/** A narrowable link's identity within its passage (its spans), or none: the whole block stays one mark. */
const narrowKey = (link: EvidenceLink) => quoteSpans(link).map(span => `${span.start}-${span.end}`).join(',') || null
// Whitespace and soft hyphens never match across the parse and the PDF's text layer; ligatures are unfolded. `at` holds,
// per UTF-16 unit of the squeezed text, the source character's [start, end) offsets (what a DOM Range takes).
const squeezed = (text: string) => {
  let out = '', offset = 0
  const at: [number, number][] = []
  for (const char of text) {
    if (!/[\s­]/.test(char)) { const folded = char.normalize('NFKC'); out += folded; for (let i = 0; i < folded.length; i++) at.push([offset, offset + char.length]) }
    offset += char.length
  }
  return { text: out, at }
}
/** A page's text layer as read once: its frame and each text run with its box in page points. */
type TextLayer = { frame: DOMRect; runs: { node: Text; box: Box }[] }
/** The box, in page points, of `link`'s quoted text inside `occurrence`'s block; none when the page's text layer lacks it.
 *  `layers` keeps each text layer read during one paint: reading every run's box again for each link froze long documents. */
function narrowBox(container: HTMLElement, document: ParsedDocument, occurrence: EvidenceOccurrence, link: EvidenceLink,
  layers: Map<Element, TextLayer | null> = new Map()): Box | null {
  const spans = quoteSpans(link)
  if (!spans.length) return null
  const page = container.querySelector(`.page[data-page-number="${occurrence.page_number}"]`)
  const layer = page?.querySelector('.textLayer')
  const bbox = verifiedEvidenceBbox(document, occurrence)
  const size = document.pages.find(each => each.page_number === occurrence.page_number)
  if (!layer || !bbox || !size) return null
  const toPt = (frame: DOMRect, rect: DOMRect): Box => ({ x0: (rect.left - frame.left) / frame.width * size.width_pt, y0: (rect.top - frame.top) / frame.height * size.height_pt,
    x1: (rect.right - frame.left) / frame.width * size.width_pt, y1: (rect.bottom - frame.top) / frame.height * size.height_pt })
  if (!layers.has(layer)) {
    const frame = layer.getBoundingClientRect()
    const entry: TextLayer | null = frame.width && frame.height ? { frame, runs: [] } : null
    const walker = window.document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
    if (entry) for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (parent && (node as Text).data.trim()) entry.runs.push({ node: node as Text, box: toPt(frame, parent.getBoundingClientRect()) })
    }
    layers.set(layer, entry)
  }
  const read = layers.get(layer)
  if (!read) return null
  const start = Math.min(...spans.map(span => span.start)), end = Math.max(...spans.map(span => span.end))
  const anchor = document.evidence_index.anchors.find(each => each.anchor_id === link.evidenceAnchorId)
  const found = anchor?.kind === 'text' ? document.content_stream.find(each => each.block_id === anchor.block_id) : undefined
  const block = found && 'text' in found ? found.text : null
  // Span offsets count code points, not UTF-16 units.
  const chars = block ? [...block] : null
  const quoted = chars?.slice(start, end).join('') || link.grounding?.raw || ''
  const target = squeezed(quoted).text
  if (!target) return null
  // The same text may be printed twice in its block: take the occurrence the link's offsets name.
  const whole = block ? squeezed(block).text : '', before = chars ? squeezed(chars.slice(0, start).join('')).text.length : 0
  let nth = 0
  for (let at = whole.indexOf(target); at >= 0 && at < before; at = whole.indexOf(target, at + 1)) nth++
  const nodes = read.runs.filter(({ box }) => {
    const x = (box.x0 + box.x1) / 2, y = (box.y0 + box.y1) / 2
    return x >= bbox.x0 - 3 && x <= bbox.x1 + 3 && y >= bbox.y0 - 3 && y <= bbox.y1 + 3
  }).map(({ node }) => node)
  let text = ''
  const where: [Text, number, number][] = []
  for (const node of nodes) {
    const squeezedNode = squeezed(node.data)
    text += squeezedNode.text
    for (const [start, end] of squeezedNode.at) where.push([node, start, end])
  }
  // The block's nth printing of the text, or its only one when the layer splits the block differently.
  let index = text.indexOf(target)
  for (let count = 0; count < nth && index >= 0; count++) index = text.indexOf(target, index + 1)
  if (index < 0) index = text.indexOf(target)
  if (index < 0) return null
  const first = where[index]!, last = where[index + target.length - 1]!
  const range = window.document.createRange()
  range.setStart(first[0], first[1]); range.setEnd(last[0], last[2])
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => toPt(read.frame, rect))
  if (!rects.length) return null
  return { x0: Math.max(0, Math.min(...rects.map(r => r.x0)) - 1), y0: Math.max(0, Math.min(...rects.map(r => r.y0)) - 1),
    x1: Math.min(size.width_pt, Math.max(...rects.map(r => r.x1)) + 1), y1: Math.min(size.height_pt, Math.max(...rects.map(r => r.y1)) + 1) }
}

function appendOverlay(
  container: HTMLElement,
  parsedDocument: ParsedDocument,
  occurrence: EvidenceOccurrence,
  options: {
    className: string
    element?: HTMLElement
    background?: string
    border?: string
    evidenceAnchorId?: string
    resultPath?: readonly (string | number)[]
    /** The box of the link's own quoted text (`narrowBox`), in place of the block's; `markId` names that mark. */
    box?: Box | null
    markId?: string
    /** A mark the researcher can select: a button with its accessible name. */
    mark?: { label: string; current: boolean; onClick: (element: HTMLElement) => void; onHover?: (over: boolean) => void }
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
  const box = options.box ?? bbox
  const tag = options.mark ? 'BUTTON' : 'DIV'
  const overlay = options.element?.tagName === tag ? options.element : window.document.createElement(tag.toLowerCase())
  if (options.element && options.element !== overlay) options.element.remove()
  overlay.className = options.className
  if (options.mark) {
    const { label, current, onClick, onHover } = options.mark
    ;(overlay as HTMLButtonElement).type = 'button'
    overlay.setAttribute('aria-label', label)
    overlay.removeAttribute('aria-hidden')
    if (current) overlay.setAttribute('aria-current', 'true')
    else overlay.removeAttribute('aria-current')
    overlay.onclick = () => onClick(overlay)
    overlay.onmouseenter = onHover ? () => onHover(true) : null
    overlay.onmouseleave = onHover ? () => onHover(false) : null
  } else overlay.ariaHidden = 'true'
  overlay.dataset.occurrenceId = occurrence.occurrence_id
  overlay.dataset.markId = options.markId ?? occurrence.occurrence_id
  if (options.evidenceAnchorId)
    overlay.dataset.evidenceAnchorId = options.evidenceAnchorId
  if (options.resultPath)
    overlay.dataset.resultPath = JSON.stringify(options.resultPath)
  Object.assign(overlay.style, {
    position: 'absolute',
    left: `${(box.x0 / pageMeta.width_pt) * 100}%`,
    top: `${(box.y0 / pageMeta.height_pt) * 100}%`,
    width: `${((box.x1 - box.x0) / pageMeta.width_pt) * 100}%`,
    height: `${((box.y1 - box.y0) / pageMeta.height_pt) * 100}%`,
    ...(options.mark ? {} : { border: options.border ?? '0', background: options.background, pointerEvents: 'none' }),
    borderRadius: '2px',
    zIndex: options.border ? '5' : '4',
  })
  if (getComputedStyle(page).position === 'static')
    page.style.position = 'relative'
  if (overlay.parentElement !== page) page.append(overlay)
  return overlay
}

/** Dims the page of a passage's first occurrence around each of its occurrences there:
 *  canvas-coloured rectangles at 45% outside every bbox grown by 24pt, so the page reads through at .55 and the
 *  passage stays clear, both places of a paragraph continued in the next column included; they take no pointer hits. */
function appendDimming(container: HTMLElement, parsedDocument: ParsedDocument, occurrences: readonly EvidenceOccurrence[], link: EvidenceLink | null = null) {
  const number = occurrences[0]?.page_number
  const page = container.querySelector(`.page[data-page-number="${number}"]`)
  const meta = parsedDocument.pages.find((candidate) => candidate.page_number === number)
  if (!(page instanceof HTMLElement) || !meta) return
  const holes = occurrences
    .filter((occurrence) => occurrence.page_number === number)
    .flatMap((occurrence) => (link && narrowBox(container, parsedDocument, occurrence, link)) || verifiedEvidenceBbox(parsedDocument, occurrence) || [])
    .map(({ x0, y0, x1, y1 }) => [Math.max(0, x0 - 24), Math.max(0, y0 - 24),
      Math.min(meta.width_pt, x1 + 24), Math.min(meta.height_pt, y1 + 24)] as const)
  if (holes.length === 0) return
  // The page in bands between consecutive hole edges; each band is shaded outside the holes spanning it.
  const edges = [...new Set([0, meta.height_pt, ...holes.flatMap(([, y0, , y1]) => [y0, y1])])].sort((a, b) => a - b)
  const shades: (readonly [number, number, number, number])[] = []
  for (const [index, top] of edges.slice(0, -1).entries()) {
    const bottom = edges[index + 1]!
    let left = 0
    for (const [x0, , x1] of holes.filter(([, y0, , y1]) => y0 <= top && bottom <= y1).sort((a, b) => a[0] - b[0])) {
      if (x0 > left) shades.push([left, top, x0, bottom])
      left = Math.max(left, x1)
    }
    if (left < meta.width_pt) shades.push([left, top, meta.width_pt, bottom])
  }
  const pct = (value: number, of: number) => `${(value / of) * 100}%`
  for (const [left, top, right, bottom] of shades) {
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
 * Owns persistent result-path painting and focused-anchor navigation. The
 * workspace supplies the inspected attempt, partial links, schema field names,
 * and viewer refs; occurrence filtering, repaint, scroll, and cleanup stay here.
 */
export function useEvidenceOverlays({
  containerRef,
  viewerRef,
  parsedDocument,
  attempt,
  active,
  dimLink = null,
  marks = null,
}: {
  containerRef: RefObject<HTMLDivElement | null>
  viewerRef: RefObject<PDFViewer | null>
  parsedDocument: ParsedDocument | null
  attempt: Pick<ExtractionAttempt, 'extractionId'> | null
  active: boolean
  /** The one-by-one value's link: its page is dimmed around it when it is located to a cell or a segment. */
  dimLink?: EvidenceLink | null
  /** The rail's saved values: model and correction Evidence paint as marks that select them. */
  marks?: RailMarks | null
}) {
  const stopFocusedPaint = useRef<(() => void) | null>(null)
  // The focus's anchor and the spans it is boxed to: two parts of one passage are two focuses.
  const focusedAnchor = useRef<string | null>(null)
  // An Evidence click changes the selected value without navigating the source.
  // Retire the old focus if it belongs to another passage; a freshly located
  // result's focus and the Evidence tab's own focus survive background repaints.
  const selected = marks?.selected ?? null
  const previousSelected = useRef(selected)
  useEffect(() => {
    const anchors = marks?.savedLinks?.filter(({ key }) => selected !== null && ownsMark(selected, key)).map(({ link }) => `${link.evidenceAnchorId}#${narrowKey(link) ?? ''}`)
      ?? [selected ? `${marks?.describe.get(selected)?.anchorId}#` : null]
    const switchedPassage = focusedAnchor.current !== null && !anchors.includes(focusedAnchor.current)
    if (previousSelected.current !== selected && (selected === null || switchedPassage)) {
      stopFocusedPaint.current?.()
      stopFocusedPaint.current = null
      focusedAnchor.current = null
      removeOverlays(containerRef.current, 'parsed-evidence-focus')
    }
    previousSelected.current = selected
  }, [containerRef, marks, selected])
  useEffect(() => {
    const container = containerRef.current
    const viewer = viewerRef.current
    if (!active || !dimLink || !parsedDocument || !container || (dimLink.precision !== 'cell' && dimLink.precision !== 'segment')) return
    const anchor = parsedDocument.evidence_index.anchors.find((candidate) => candidate.anchor_id === dimLink.evidenceAnchorId)
    const occurrences = anchor ? anchorOccurrences(anchor) : []
    if (occurrences.length === 0) return
    const paint = () => { removeOverlays(container, 'evidence-dim'); appendDimming(container, parsedDocument, occurrences, dimLink) }
    viewer?.eventBus?.on('pagerendered', paint)
    viewer?.eventBus?.on('textlayerrendered', paint)
    paint()
    return () => {
      viewer?.eventBus?.off('pagerendered', paint)
      viewer?.eventBus?.off('textlayerrendered', paint)
      removeOverlays(container, 'evidence-dim')
    }
  }, [active, containerRef, dimLink, parsedDocument, viewerRef])
  useEffect(() => {
    const container = containerRef.current
    const viewer = viewerRef.current
    const evidenceLinks = marks?.savedLinks ?? null
    if (
      !container ||
      !parsedDocument ||
      !attempt ||
      evidenceLinks === null ||
      !active
    ) {
      removeOverlays(container, 'parsed-evidence-highlight')
      return
    }

    const anchors = new Map(
      parsedDocument.evidence_index.anchors.map((anchor) => [
        anchor.anchor_id,
        anchor,
      ]),
    )
    const paint = () => {
      const previous = new Map([...container.querySelectorAll<HTMLElement>('.parsed-evidence-highlight')]
        .map((element) => [element.dataset.markId!, element]))
      // One mark per occurrence, carrying every value its passage supports.
      const layers = new Map<Element, TextLayer | null>()
      const byOccurrence = new Map<string, { occurrence: EvidenceOccurrence; anchorId: string; keys: string[];resultPath:EvidenceLink['resultPath'];box:Box|null }>()
      for (const {link,key,occurrenceIds} of evidenceLinks) {
        if (link.precision === 'input') continue
        const anchor = anchors.get(link.evidenceAnchorId)
        if (!anchor) continue
        for (const occurrence of anchorOccurrences(anchor)) {
          // Correction Evidence names its explicitly selected occurrences; model Evidence marks every occurrence.
          if (occurrenceIds && !occurrenceIds.includes(occurrence.occurrence_id)) continue
          // A link whose quoted text the page shows is its own mark there, boxed to that text; else it shares the block's.
          const box = occurrenceIds ? null : narrowBox(container, parsedDocument, occurrence, link, layers)
          const id = box ? `${occurrence.occurrence_id}#${narrowKey(link)}` : occurrence.occurrence_id
          const entry = byOccurrence.get(id) ?? { occurrence, anchorId: anchor.anchor_id, keys: [],resultPath:link.resultPath, box }
          if (!entry.keys.includes(key)) entry.keys.push(key)
          byOccurrence.set(id, entry)
        }
      }
      for (const [id, { occurrence, anchorId, keys,resultPath,box }] of byOccurrence) {
        const element = previous.get(id)
        previous.delete(id)
        // A value's correction Evidence in its own model passage names it once; two values that read alike stay two.
        const infos = keys.filter((key) => !key.endsWith('#correction') || !keys.includes(markValueId(key)))
          .map((key) => marks?.describe.get(key)).filter((info): info is MarkInfo => Boolean(info))
        const style = infos[0]?.style ?? 'link'
        const decided = infos.length > 0 && infos.every((info) => info.word !== null)
        const current = marks?.selected !== null && marks?.selected !== undefined && keys.some((key) => ownsMark(marks.selected!, key))
        const hovered = keys.some((key) => marks?.hovered?.some((each) => ownsMark(each, key)))
        const selectable = keys.filter((key) => marks?.describe.has(key))
        const painted = appendOverlay(container, parsedDocument, occurrence, {
          element,
          className: `parsed-evidence-highlight evidence-mark ${style}${decided ? ' decided' : ''}${current ? ' selected' : ''}${hovered ? ' hovered' : ''}`,
          evidenceAnchorId: anchorId,
          resultPath,
          box, markId: id,
          ...(marks && infos.length > 0 ? { mark: {
            label: infos.map((info) => `${info.name}: ${info.value}${info.word ? `, ${info.word}` : ''}`).join('; '),
            current, onClick: (element: HTMLElement) => marks.onSelect(selectable, element),
            ...(marks.onHover ? { onHover: (over: boolean) => marks.onHover!(over ? selectable : null) } : {}),
          } } : {}),
        })
        // The mark takes its field's colour, or the one Evidence colour.
        const colors = evidenceColorVars(infos[0]?.color)
        if (painted) for (const name of ['--color-ev', '--color-ev-soft', '--color-ev-ghost'])
          if (colors[name]) painted.style.setProperty(name, colors[name]); else painted.style.removeProperty(name)
      }
      previous.forEach((element) => element.remove())
    }

    viewer?.eventBus?.on('pagerendered', paint)
    viewer?.eventBus?.on('textlayerrendered', paint)
    // Painting never navigates: only an explicit selection from the rail owns document navigation.
    paint()
    return () => {
      viewer?.eventBus?.off('pagerendered', paint)
      viewer?.eventBus?.off('textlayerrendered', paint)
    }
  }, [active, attempt, containerRef, marks, parsedDocument, viewerRef])

  useEffect(() => () => removeOverlays(containerRef.current, 'parsed-evidence-highlight'),
    [active, attempt?.extractionId, containerRef, parsedDocument])

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
    (anchor: ParsedEvidenceAnchor, link?: EvidenceLink) => {
      const viewer = viewerRef.current
      const container = containerRef.current
      stopFocusedPaint.current?.()
      stopFocusedPaint.current = null
      focusedAnchor.current = null
      removeOverlays(container, 'parsed-evidence-focus')
      if (!viewer || !container || !parsedDocument) return
      focusedAnchor.current = `${anchor.anchor_id}#${link ? narrowKey(link) ?? '' : ''}`
      // The rail narrows a correction's anchor to its selected occurrences before it asks.
      const occurrences = anchorOccurrences(anchor)
      const firstOccurrence = occurrences[0]
      if (!firstOccurrence) return
      if (link?.precision === 'input') {
        viewer.scrollPageIntoView({ pageNumber: firstOccurrence.page_number })
        return
      }
      // pdf.js resets an unrendered page's children; retain the selection through that render and later zooms.
      const paintFocus = () => {
        removeOverlays(container, 'parsed-evidence-focus')
        let firstFocus: HTMLElement | null = null
        for (const occurrence of occurrences) {
          const focus = appendOverlay(container, parsedDocument, occurrence, {
            className: 'parsed-evidence-focus',
            box: link ? narrowBox(container, parsedDocument, occurrence, link) : null,
            border: '2px solid var(--color-accent)',
            background: 'var(--color-ev-soft)',
          })
          if (focus) firstFocus ??= focus
        }
        return firstFocus
      }
      // The text layer narrows the focus to its quote after the first paint: show it again, unless the researcher has
      // scrolled the source since (pdf.js's own scrolling is no wheel, key, pointer or touch).
      const intents = ['wheel', 'keydown', 'pointerdown', 'touchstart']
      let focus = paintFocus(), moved = false
      const move = () => { moved = true }
      const repaint = () => {
        const box = focus?.style.cssText
        focus = paintFocus()
        if (box && focus && focus.style.cssText !== box && !moved) scrollWithinPane(container, focus)
      }
      viewer.eventBus?.on('pagerendered', repaint)
      viewer.eventBus?.on('textlayerrendered', repaint)
      for (const type of intents) container.addEventListener(type, move, { passive: true })
      stopFocusedPaint.current = () => {
        viewer.eventBus?.off('pagerendered', repaint); viewer.eventBus?.off('textlayerrendered', repaint)
        for (const type of intents) container.removeEventListener(type, move)
      }
      if (focus) scrollWithinPane(container, focus)
      else viewer.scrollPageIntoView({ pageNumber: firstOccurrence.page_number })
    },
    [containerRef, parsedDocument, viewerRef],
  )
}
