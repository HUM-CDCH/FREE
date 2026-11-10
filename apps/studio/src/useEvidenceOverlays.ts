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
import { evidenceColorVars, markValueId, ownsMark, sharedColor } from './durableRailModel'
import { fieldWords } from './reviewVocabulary'

/** What the rail says about one value, for its mark on the page. */
export type MarkInfo = { name: string; value: string; word: string | null; style: 'link' | 'rule' | 'doubtful' | 'neutral' | 'preview'; anchorId: string; precision?: EvidenceLink['precision']; color?: string }

/** A mark's accessible name and its tooltip: each value it supports, with what its underline says, in words. */
export const markLabel = (infos: readonly MarkInfo[]) => infos.map((info) =>
  `${fieldWords(info.name)}: ${info.value}${info.style === 'doubtful' ? ', uncertain' : info.style === 'rule' ? ', linked by rule' : ''}${info.word ? `, ${info.word}` : ''}`).join('; ')

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

// One pointer, so one mark under it and one name tag for the whole page view.
let pointed: HTMLElement | null = null
let nameTag: HTMLElement | null = null

/** The field name over the mark under the pointer: the marks' one tooltip. It is drawn beside the mark, never inside
 *  it, so the pointer cannot land on it (no flicker) and a value mark's multiply blend leaves it opaque; its CSS delays
 *  it, so sweeping the pointer across a page pops nothing. */
function nameMark(mark: HTMLElement | null, name = '') {
  nameTag?.remove()
  nameTag = null
  if (!mark?.parentElement || !name) return
  nameTag = window.document.createElement('div')
  nameTag.className = 'evidence-mark-name'
  nameTag.ariaHidden = 'true'
  nameTag.textContent = name
  Object.assign(nameTag.style, { left: mark.style.left, bottom: `calc(${100 - parseFloat(mark.style.top)}% + 4px)` })
  mark.parentElement.append(nameTag)
}

/** Hover follows the pointer's own movement: a mark that scrolls in under a still pointer lights nothing and names
 *  nothing (browsers fire `mouseenter` for it, never `mousemove`), and a move within one mark reports once. */
function followPointer(mark: HTMLElement, name: string, onHover: ((over: boolean) => void) | undefined) {
  mark.onmousemove = onHover ? () => {
    if (pointed === mark) return
    pointed = mark
    nameMark(mark, name)
    onHover(true)
  } : null
  mark.onmouseleave = onHover ? () => {
    pointed = null
    nameMark(null)
    onHover(false)
  } : null
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
    /** A mark the researcher can select: a button with its accessible name. */
    mark?: { label: string; name: string; current: boolean; onClick: (element: HTMLElement) => void; onHover?: (over: boolean) => void }
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
    overlay.onclick = () => { nameMark(null); onClick(overlay) }
    followPointer(overlay, options.mark.name, onHover)
  } else overlay.ariaHidden = 'true'
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
function appendDimming(container: HTMLElement, parsedDocument: ParsedDocument, occurrences: readonly EvidenceOccurrence[]) {
  const number = occurrences[0]?.page_number
  const page = container.querySelector(`.page[data-page-number="${number}"]`)
  const meta = parsedDocument.pages.find((candidate) => candidate.page_number === number)
  if (!(page instanceof HTMLElement) || !meta) return
  const holes = occurrences
    .filter((occurrence) => occurrence.page_number === number)
    .flatMap((occurrence) => verifiedEvidenceBbox(parsedDocument, occurrence) ?? [])
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

/** A link's value boxes, each with the occurrence it lies in (within 2pt); none if any box lies in no occurrence. */
function placedValueBoxes(parsedDocument: ParsedDocument, occurrences: readonly EvidenceOccurrence[], boxes: NonNullable<EvidenceLink['valueBoxes']>) {
  const placed: { occurrence: EvidenceOccurrence; box: (typeof boxes)[number] }[] = []
  for (const box of boxes) {
    const occurrence = occurrences.find((candidate) => {
      const bbox = verifiedEvidenceBbox(parsedDocument, candidate)
      return bbox && box.x0 >= bbox.x0 - 2 && box.y0 >= bbox.y0 - 2 && box.x1 <= bbox.x1 + 2 && box.y1 <= bbox.y1 + 2
    })
    if (!occurrence) return []
    placed.push({ occurrence, box })
  }
  return placed
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
  overviewRef,
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
  /** The strip over the document's scrollbar: it gets one tick per block mark, at the mark's place in the document. */
  overviewRef?: RefObject<HTMLElement | null>
}) {
  const stopFocusedPaint = useRef<(() => void) | null>(null)
  const focusedAnchor = useRef<string | null>(null)
  // An Evidence click changes the selected value without navigating the source.
  // Retire the old focus if it belongs to another passage; a freshly located
  // result's focus and the Evidence tab's own focus survive background repaints.
  const selected = marks?.selected ?? null
  const previousSelected = useRef(selected)
  useEffect(() => {
    const anchors = marks?.savedLinks?.filter(({ key }) => selected !== null && ownsMark(selected, key)).map(({ link }) => link.evidenceAnchorId)
      ?? [selected ? marks?.describe.get(selected)?.anchorId : null]
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
    const paint = () => { removeOverlays(container, 'evidence-dim'); appendDimming(container, parsedDocument, occurrences) }
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
    const evidenceLinks = marks?.savedLinks ?? null
    if (
      !container ||
      !parsedDocument ||
      !attempt ||
      evidenceLinks === null ||
      !active
    ) {
      removeOverlays(container, 'parsed-evidence-highlight')
      removeOverlays(container, 'parsed-evidence-value')
      overviewRef?.current?.replaceChildren()
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
        .map((element) => [element.dataset.occurrenceId!, element]))
      // One mark per occurrence, its block's box, carrying every value its passage supports: never narrowed to a quote.
      // Every placed value's printing is drawn apart, inside its block mark (ADR 0031); placed first, so a block
      // that holds one can recede behind it.
      const placedValues = evidenceLinks.flatMap(({ link, key, occurrenceIds }) => {
        const anchor = anchors.get(link.evidenceAnchorId)
        if (!link.valueBoxes || link.precision === 'input' || !anchor) return []
        const occurrences = anchorOccurrences(anchor).filter((occurrence) => !occurrenceIds || occurrenceIds.includes(occurrence.occurrence_id))
        return placedValueBoxes(parsedDocument, occurrences, link.valueBoxes).map((placed) => ({ ...placed, link, key }))
      })
      const placedKeys = new Map<string, Set<string>>()
      for (const { occurrence, key } of placedValues) placedKeys.set(occurrence.occurrence_id, (placedKeys.get(occurrence.occurrence_id) ?? new Set()).add(key))
      const byOccurrence = new Map<string, { occurrence: EvidenceOccurrence; anchorId: string; keys: string[];resultPath:EvidenceLink['resultPath'] }>()
      for (const {link,key,occurrenceIds} of evidenceLinks) {
        if (link.precision === 'input') continue
        const anchor = anchors.get(link.evidenceAnchorId)
        if (!anchor) continue
        for (const occurrence of anchorOccurrences(anchor)) {
          // Correction Evidence names its explicitly selected occurrences; model Evidence marks every occurrence.
          if (occurrenceIds && !occurrenceIds.includes(occurrence.occurrence_id)) continue
          const entry = byOccurrence.get(occurrence.occurrence_id) ?? { occurrence, anchorId: anchor.anchor_id, keys: [],resultPath:link.resultPath }
          if (!entry.keys.includes(key)) entry.keys.push(key)
          byOccurrence.set(occurrence.occurrence_id, entry)
        }
      }
      for (const { occurrence, anchorId, keys,resultPath } of byOccurrence.values()) {
        const element = previous.get(occurrence.occurrence_id)
        previous.delete(occurrence.occurrence_id)
        // A value's correction Evidence in its own model passage names it once; two values that read alike stay two.
        const described = keys.filter((key) => !key.endsWith('#correction') || !keys.includes(markValueId(key)))
          .flatMap((key) => { const info = marks?.describe.get(key); return info ? [{ key, info }] : [] })
        const infos = described.map(({ info }) => info)
        // The underline says how a value is linked, on the most exact mark the value has. So the block keeps it for
        // the values with no value mark here, and recedes once every value it supports has its own.
        const placedHere = placedKeys.get(occurrence.occurrence_id)
        const unplaced = described.filter(({ key }) => !placedHere?.has(key)).map(({ info }) => info)
        const valued = placedHere !== undefined && unplaced.length === 0
        const cue = unplaced.length > 0 ? unplaced : infos
        const style = cue.some((info) => info.style === 'preview') ? 'preview' : cue[0]?.style ?? 'link'
        const decided = infos.length > 0 && infos.every((info) => info.word !== null)
        const current = marks?.selected !== null && marks?.selected !== undefined && keys.some((key) => ownsMark(marks.selected!, key))
        const hovered = keys.some((key) => marks?.hovered?.some((each) => ownsMark(each, key)))
        const selectable = keys.filter((key) => marks?.describe.has(key))
        const painted = appendOverlay(container, parsedDocument, occurrence, {
          element,
          className: `parsed-evidence-highlight evidence-mark ${style}${decided ? ' decided' : ''}${valued ? ' valued' : ''}${current ? ' selected' : ''}${hovered ? ' hovered' : ''}`,
          evidenceAnchorId: anchorId,
          resultPath,
          ...(marks && infos.length > 0 ? { mark: {
            label: markLabel(infos), name: [...new Set(infos.map((info) => fieldWords(info.name)))].join(', '),
            current, onClick: (element: HTMLElement) => marks.onSelect(selectable, element),
            ...(marks.onHover ? { onHover: (over: boolean) => marks.onHover!(over ? selectable : null) } : {}),
          } } : {}),
        })
        // The mark takes its field's colour, the one Evidence colour, or a neutral one when its values' fields differ.
        const colors = evidenceColorVars(sharedColor(infos.map((info) => info.color)))
        if (painted) for (const name of ['--color-ev', '--color-ev-soft', '--color-ev-ghost'])
          if (colors[name]) painted.style.setProperty(name, colors[name]); else painted.style.removeProperty(name)
      }
      previous.forEach((element) => element.remove())
      // A value mark is kept across paints, as a block mark is: the one under the pointer is not replaced as its own
      // hover repaints.
      const previousValues = new Map([...container.querySelectorAll<HTMLElement>('.parsed-evidence-value')]
        .map((element) => [element.dataset.valueMark!, element]))
      for (const [index, { occurrence, box, link, key }] of placedValues.entries()) {
        const page = container.querySelector(`.page[data-page-number="${occurrence.page_number}"]`)
        const meta = parsedDocument.pages.find((candidate) => candidate.page_number === occurrence.page_number)
        if (!(page instanceof HTMLElement) || !meta) continue
        const id = `${occurrence.occurrence_id}|${key}|${index}`
        const mark = previousValues.get(id) ?? window.document.createElement('div')
        previousValues.delete(id)
        mark.dataset.valueMark = id
        // The selected or hovered value's printing is the strong one; the others stay a quiet highlighter. Its
        // underline is its own link's: dotted by rule, dashed for an uncertain passage, thinner once decided.
        const current = marks?.selected != null && ownsMark(marks.selected, key)
        const hovered = marks?.hovered?.some((each) => ownsMark(each, key))
        const info = marks?.describe.get(key)
        mark.className = `parsed-evidence-value evidence-value-mark ${info?.style ?? 'link'}${info?.word ? ' decided' : ''}${current ? ' selected' : ''}${hovered ? ' hovered' : ''}`
        mark.ariaHidden = 'true'
        mark.dataset.occurrenceId = occurrence.occurrence_id
        mark.dataset.resultPath = JSON.stringify(link.resultPath)
        // A value the rail names is picked by its own mark: the pointer selects that one value in Results, where a
        // block picks among all its passage supports, and lights only its row. A pointer shortcut, not announced:
        // the block mark stays the button and the value's Results row the keyboard's way to it.
        const pick = marks && info ? marks : null
        mark.onclick = pick ? () => { nameMark(null); pick.onSelect([key], mark) } : null
        followPointer(mark, info ? fieldWords(info.name) : '', pick?.onHover ? (over) => pick.onHover!(over ? [key] : null) : undefined)
        Object.assign(mark.style, {
          position: 'absolute', left: `${(box.x0 / meta.width_pt) * 100}%`, top: `${(box.y0 / meta.height_pt) * 100}%`,
          width: `${((box.x1 - box.x0) / meta.width_pt) * 100}%`, height: `${((box.y1 - box.y0) / meta.height_pt) * 100}%`,
          pointerEvents: pick ? 'auto' : 'none', zIndex: '5',
        })
        const colors = evidenceColorVars(info?.color)
        for (const name of ['--color-ev', '--color-ev-soft', '--color-ev-ghost'])
          if (colors[name]) mark.style.setProperty(name, colors[name]); else mark.style.removeProperty(name)
        if (getComputedStyle(page).position === 'static') page.style.position = 'relative'
        if (mark.parentElement !== page) page.append(mark)
      }
      previousValues.forEach((element) => element.remove())
      // The overview: one tick per block mark over the scrollbar, at the mark's place and height in the whole document
      // and in its colour. Every rectangle is read before a tick is attached, so the page is laid out once.
      const overview = overviewRef?.current, height = container.scrollHeight
      if (overview && height > 0) {
        const top = container.getBoundingClientRect().top - container.scrollTop
        overview.replaceChildren(...[...container.querySelectorAll<HTMLElement>('.parsed-evidence-highlight')].map((block) => {
          const rect = block.getBoundingClientRect(), tick = window.document.createElement('div')
          tick.className = `evidence-tick${block.classList.contains('selected') ? ' selected' : ''}${block.classList.contains('hovered') ? ' hovered' : ''}`
          tick.style.top = `${((rect.top - top) / height) * 100}%`
          tick.style.height = `${(rect.height / height) * 100}%`
          const color = block.style.getPropertyValue('--color-ev')
          if (color) tick.style.setProperty('--color-ev', color)
          return tick
        }))
      }
    }

    viewer?.eventBus?.on('pagerendered', paint)
    // Painting never navigates: only an explicit selection from the rail owns document navigation.
    paint()
    return () => {
      viewer?.eventBus?.off('pagerendered', paint)
    }
  }, [active, attempt, containerRef, marks, overviewRef, parsedDocument, viewerRef])

  // Marks outlive a repaint (a hover, a selection), block and value alike, and go with their Extraction or document.
  useEffect(() => () => {
    removeOverlays(containerRef.current, 'parsed-evidence-highlight')
    removeOverlays(containerRef.current, 'parsed-evidence-value')
  }, [active, attempt?.extractionId, containerRef, parsedDocument])

  useEffect(
    () => () => {
      stopFocusedPaint.current?.()
      stopFocusedPaint.current = null
      removeOverlays(containerRef.current, 'parsed-evidence-focus')
      removeOverlays(containerRef.current, 'parsed-evidence-highlight')
      removeOverlays(containerRef.current, 'parsed-evidence-value')
      overviewRef?.current?.replaceChildren()
    },
    [attempt?.extractionId, containerRef, overviewRef, parsedDocument],
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
      focusedAnchor.current = anchor.anchor_id
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
            border: '2px solid var(--color-accent)',
            background: 'var(--color-ev-soft)',
          })
          if (focus) firstFocus ??= focus
        }
        return firstFocus
      }
      viewer.eventBus?.on('pagerendered', paintFocus)
      stopFocusedPaint.current = () => viewer.eventBus?.off('pagerendered', paintFocus)
      const focus = paintFocus()
      // A value mark painted for this link is what the researcher looks for: bring it into view rather than its block.
      const path = JSON.stringify(link?.resultPath)
      const value = [...container.querySelectorAll<HTMLElement>('.parsed-evidence-value')].find((mark) => mark.dataset.resultPath === path
        && occurrences.some((occurrence) => occurrence.occurrence_id === mark.dataset.occurrenceId))
      if (value) scrollWithinPane(container, value)
      else if (focus) scrollWithinPane(container, focus)
      else viewer.scrollPageIntoView({ pageNumber: firstOccurrence.page_number })
    },
    [containerRef, parsedDocument, viewerRef],
  )
}
