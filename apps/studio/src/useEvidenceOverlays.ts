import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type {
  ParsedDocument,
  ParsedEvidenceAnchor,
} from 'extraction/parsed-document'
import type { EvidenceLink } from 'extraction/durable-types'
import {
  anchorOccurrences,
  type EvidenceOccurrence,
  verifiedEvidenceBbox,
} from './evidenceNavigation'
import { scrollWithinPane } from './scrollWithinPane'
import { evidenceColorVars, markValueId, ownsMark, sharedColor } from './durableRailModel'
import { fieldWords } from './reviewVocabulary'
import { observeEvidenceHover } from './evidenceHover'
import type { PublishedMarks, SelectionChannel } from './selectionChannel'
import { recordBlockName, recordBlockTag, recordPieces, type RecordBlock, type RecordPiece } from './recordBlocks'

type PageRender = { pageNumber: number; cssTransform?: boolean; isDetailView?: boolean }
type PageMap = ReadonlyMap<number, HTMLElement>

/** Page lookup is once per paint, never once per mark through pdf.js's text layers. */
function pageMap(container: HTMLElement, pageNumber?: number): PageMap {
  const pages = pageNumber === undefined ? [...container.querySelectorAll<HTMLElement>('.page')]
    : [container.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`)].filter((page): page is HTMLElement => page !== null)
  return new Map(pages.map(page => [Number(page.dataset.pageNumber), page]))
}

const transformOnly = (event?: PageRender) => event?.cssTransform || event?.isDetailView

/** What the rail says about one value, for its mark on the page. */
export type MarkInfo = { name: string; value: string; word: string | null; style: 'link' | 'rule' | 'doubtful' | 'neutral' | 'preview'; color?: string }

/** A mark's accessible name and its tooltip: each value it supports, with what its underline says, in words. */
export const markLabel = (infos: readonly MarkInfo[]) => infos.map((info) =>
  `${fieldWords(info.name)}: ${info.value}${info.style === 'doubtful' ? ', uncertain' : info.style === 'rule' ? ', linked by rule' : ''}${info.word ? `, ${info.word}` : ''}`).join('; ')

/** The rail's values for the marks: a key `describe` names is a value a mark selects. */
export type RailMarkState = {
  describe: ReadonlyMap<string, MarkInfo>
  selected: string | null
  /** Stable retained value IDs, including explicit correction occurrences. */
  savedLinks: readonly {key:string;link:EvidenceLink;occurrenceIds?:readonly string[]}[]
  /** A running Catalog's record blocks: outlines under the marks, never Evidence and never selectable. */
  records?: readonly RecordBlock[]
}

/** A correction in its model passage names the value once; distinct values that read alike stay distinct. */
export const describeMarks = (keys: readonly string[], describe: RailMarkState['describe'] | undefined) =>
  keys.filter(key => !key.endsWith('#correction') || !keys.includes(markValueId(key)))
    .flatMap(key => { const info = describe?.get(key); return info ? [{ key, info }] : [] })

function appendOverlay(
  pages: PageMap,
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
    mark?: { label: string; current: boolean }
  },
): HTMLElement | null {
  const page = pages.get(occurrence.page_number)
  if (!page) return null
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
    const { label, current } = options.mark
    ;(overlay as HTMLButtonElement).type = 'button'
    overlay.setAttribute('aria-label', label)
    overlay.removeAttribute('aria-hidden')
    if (current) overlay.setAttribute('aria-current', 'true')
    else overlay.removeAttribute('aria-current')
  } else overlay.ariaHidden = 'true'
  overlay.dataset.occurrenceId = occurrence.occurrence_id
  if (options.evidenceAnchorId)
    overlay.dataset.evidenceAnchorId = options.evidenceAnchorId
  if (options.resultPath)
    overlay.dataset.resultPath = JSON.stringify(options.resultPath)
  else delete overlay.dataset.resultPath
  Object.assign(overlay.style, {
    position: 'absolute',
    left: `${(bbox.x0 / pageMeta.width_pt) * 100}%`,
    top: `${(bbox.y0 / pageMeta.height_pt) * 100}%`,
    width: `${((bbox.x1 - bbox.x0) / pageMeta.width_pt) * 100}%`,
    height: `${((bbox.y1 - bbox.y0) / pageMeta.height_pt) * 100}%`,
    ...(options.mark ? {} : { border: options.border ?? '0', background: options.background ?? '', pointerEvents: 'none' }),
    borderRadius: '2px',
    zIndex: options.border ? '5' : '4',
  })
  // pdf.js owns `.pdfViewer .page { position: relative }`.
  if (overlay.parentElement !== page) page.append(overlay)
  return overlay
}

/** Dims the page of a passage's first occurrence around each of its occurrences there:
 *  canvas-coloured rectangles at 45% outside every bbox grown by 24pt, so the page reads through at .55 and the
 *  passage stays clear, both places of a paragraph continued in the next column included; they take no pointer hits. */
function appendDimming(pages: PageMap, parsedDocument: ParsedDocument, occurrences: readonly EvidenceOccurrence[]) {
  const number = occurrences[0]?.page_number
  const page = number === undefined ? undefined : pages.get(number)
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

type LocatedEvidence = { anchor: ParsedEvidenceAnchor; link?: EvidenceLink }
type Block = { occurrence: EvidenceOccurrence; anchorId: string; keys: string[]; resultPath?: EvidenceLink['resultPath']; focus?: boolean }

/** One lifetime owns the source's occurrence marks, navigation intent, page events and pointer. Results selection
 * and explicit Evidence navigation are distinct facts; their visible outlines are resolved before touching the DOM. */
export function useEvidenceOverlays({ containerRef, viewer, parsedDocument, markdown = null, extractionId, active, marksShown = true, selection, onSelect, overviewRef }: {
  containerRef: RefObject<HTMLDivElement | null>
  viewer: PDFViewer | null
  parsedDocument: ParsedDocument | null
  /** The parsed Markdown: it says which rows of a table a record block owns. Without it a block is its whole table. */
  markdown?: string | null
  extractionId: string | null
  active: boolean
  marksShown?: boolean
  selection: SelectionChannel
  onSelect: (keys: string[], element: HTMLElement) => void
  overviewRef?: RefObject<HTMLElement | null>
}) {
  const controller = useRef<{ source: ParsedDocument; extractionId: string | null; update: () => void; paint: (event?: PageRender) => void; scale: () => void; locate: (anchor: ParsedEvidenceAnchor, link?: EvidenceLink) => void } | null>(null)
  const pending = useRef<(LocatedEvidence & { source: ParsedDocument | null; extractionId: string | null }) | null>(null)
  const presentation = useRef({ active, marksShown, onSelect, viewer })
  useLayoutEffect(() => {
    presentation.current = { active, marksShown, onSelect, viewer }
    controller.current?.update()
  }, [active, marksShown, onSelect, viewer])

  useEffect(() => {
    const container = containerRef.current, overview = overviewRef?.current
    if (!container || !parsedDocument) return
    const anchors = new Map(parsedDocument.evidence_index.anchors.map(anchor => [anchor.anchor_id, anchor]))
    const metadata = new Map(parsedDocument.pages.map(page => [page.page_number, page]))
    let located: LocatedEvidence | null = null, marks: PublishedMarks | null = null
    let snapshot = selection.snapshot()
    let blocks = new Map<string, Block>()
    let values: { occurrence: EvidenceOccurrence; box: NonNullable<EvidenceLink['valueBoxes']>[number]; link: EvidenceLink; key: string }[] = []
    let dim: EvidenceOccurrence[] = []
    const markdownBytes = markdown === null ? null : new TextEncoder().encode(markdown)
    let records: { blocks: readonly RecordBlock[] | null; pieces: RecordPiece[] } = { blocks: null, pieces: [] }
    let stopHover = () => {}
    let queued = false, disposed = false
    let pointed: HTMLElement | null = null, nameTag: HTMLElement | null = null
    const clearName = () => { nameTag?.remove(); nameTag = null }
    const interactive = (element: EventTarget | null) => element instanceof Element
      ? element.closest<HTMLElement>('[data-evidence-name]') : null
    const keysOf = (element: HTMLElement) => JSON.parse(element.dataset.hoverKeys!) as string[]
    const move = (event: MouseEvent) => {
      const mark = interactive(event.target)
      if (mark === pointed) return
      pointed = mark
      clearName()
      selection.hover(mark ? keysOf(mark) : null)
      if (!mark?.dataset.evidenceName) return
      nameTag = document.createElement('div')
      nameTag.className = 'evidence-mark-name'
      nameTag.ariaHidden = 'true'
      nameTag.textContent = mark.dataset.evidenceName
      Object.assign(nameTag.style, { left: mark.style.left, bottom: `calc(${100 - parseFloat(mark.style.top)}% + 4px)` })
      mark.parentElement?.append(nameTag)
    }
    const leave = () => { pointed = null; clearName(); selection.hover(null) }
    const out = (event: MouseEvent) => {
      if (pointed && !(event.relatedTarget instanceof Node && pointed.contains(event.relatedTarget))) leave()
    }
    const click = (event: MouseEvent) => {
      const mark = interactive(event.target)
      if (mark) { clearName(); presentation.current.onSelect(keysOf(mark), mark) }
    }
    const decorate = (element: HTMLElement, keys: readonly string[], name: string | undefined, color?: string) => {
      element.dataset.hoverKeys = JSON.stringify(keys)
      if (keys.length && name !== undefined) {
        element.dataset.evidenceName = name
      } else { delete element.dataset.evidenceName }
      const colors = evidenceColorVars(color)
      for (const property of ['--color-ev', '--color-ev-soft', '--color-ev-ghost'])
        if (colors[property]) element.style.setProperty(property, colors[property]); else element.style.removeProperty(property)
    }
    // Both initial paint and zoom use the occurrence geometry. No mark rectangles, copied CSS percentages or
    // disposable page children are needed to keep off-screen overview ticks positioned.
    const paintOverview = (pages = pageMap(container)) => {
      if (!overview) return
      const height = container.scrollHeight, top = container.getBoundingClientRect().top - container.scrollTop
      const layouts = new Map([...pages].map(([number, page]) => [number, {
        top: page.getBoundingClientRect().top + page.clientTop, height: page.clientHeight,
      }]))
      const previous = new Map([...overview.querySelectorAll<HTMLElement>('[data-occurrence-id]')]
        .filter(element => pages.has(Number(element.dataset.pageNumber))).map(element => [element.dataset.occurrenceId!, element]))
      for (const { occurrence, keys } of blocks.values()) {
        if (!keys.length || !pages.has(occurrence.page_number)) continue
        const page = layouts.get(occurrence.page_number), meta = metadata.get(occurrence.page_number)
        const bbox = verifiedEvidenceBbox(parsedDocument, occurrence)
        if (!page || !meta || !bbox || height <= 0) continue
        const tick = previous.get(occurrence.occurrence_id) ?? document.createElement('div')
        previous.delete(occurrence.occurrence_id)
        tick.dataset.occurrenceId = occurrence.occurrence_id
        tick.dataset.pageNumber = String(occurrence.page_number)
        tick.classList.add('evidence-tick')
        tick.classList.toggle('selected', keys.some(key => !!marks?.selected && ownsMark(marks.selected, key)))
        tick.style.top = `${(page.top + bbox.y0 / meta.height_pt * page.height - top) / height * 100}%`
        tick.style.height = `${(bbox.y1 - bbox.y0) / meta.height_pt * page.height / height * 100}%`
        decorate(tick, keys, undefined, sharedColor(describeMarks(keys, marks?.describe).map(({ info }) => info.color)))
        if (tick.parentElement !== overview) overview.append(tick)
      }
      previous.forEach(element => element.remove())
    }
    const bindHover = () => {
      stopHover()
      stopHover = observeEvidenceHover(selection, [container, overview])
    }
    const paint = (event?: PageRender) => {
      if (transformOnly(event)) return
      const pages = pageMap(container, event?.pageNumber)
      const elements = (selector: string) => [...pages.values()].flatMap(page => [...page.querySelectorAll<HTMLElement>(selector)])
      const previous = new Map(elements('.parsed-evidence-highlight, .parsed-evidence-focus').map(element => [element.dataset.occurrenceId!, element]))
      const placedKeys = new Map<string, Set<string>>()
      for (const { occurrence, key } of values) placedKeys.set(occurrence.occurrence_id, (placedKeys.get(occurrence.occurrence_id) ?? new Set()).add(key))
      for (const { occurrence, anchorId, keys, resultPath, focus } of blocks.values()) {
        if (!pages.has(occurrence.page_number)) continue
        const described = describeMarks(keys, marks?.describe)
        const infos = described.map(({ info }) => info)
        const placedHere = placedKeys.get(occurrence.occurrence_id)
        const unplaced = described.filter(({ key }) => !placedHere?.has(key)).map(({ info }) => info)
        const valued = placedHere !== undefined && unplaced.length === 0
        const cue = unplaced.length ? unplaced : infos
        const style = cue.some(info => info.style === 'preview') ? 'preview' : cue[0]?.style ?? 'link'
        const current = keys.some(key => marks?.selected && ownsMark(marks.selected, key))
        const selectable = focus && !presentation.current.marksShown && !current ? [] : keys.filter(key => marks?.describe.has(key))
        const element = appendOverlay(pages, parsedDocument, occurrence, {
          element: previous.get(occurrence.occurrence_id),
          className: `${keys.length ? `parsed-evidence-highlight evidence-mark ${style}${infos.length && infos.every(info => info.word !== null) ? ' decided' : ''}${valued ? ' valued' : ''}${current ? ' selected' : ''}` : ''}${focus ? ' parsed-evidence-focus' : ''}`,
          evidenceAnchorId: anchorId, resultPath,
          ...(infos.length && selectable.length ? { mark: { label: markLabel(infos), current } } : {}),
          ...(focus ? { border: '2px solid var(--color-accent)', background: 'var(--color-ev-soft)' } : {}),
        })
        previous.delete(occurrence.occurrence_id)
        if (element) decorate(element, selectable, infos.length ? [...new Set(infos.map(info => fieldWords(info.name)))].join(', ') : undefined, sharedColor(infos.map(info => info.color)))
      }
      previous.forEach(element => element.remove())
      const previousValues = new Map(elements('.parsed-evidence-value').map(element => [element.dataset.valueMark!, element]))
      for (const [index, { occurrence, box, link, key }] of values.entries()) {
        const page = pages.get(occurrence.page_number), meta = metadata.get(occurrence.page_number)
        if (!page || !meta) continue
        const id = `${occurrence.occurrence_id}|${key}|${index}`
        const mark = previousValues.get(id) ?? document.createElement('div'), info = marks?.describe.get(key)
        previousValues.delete(id)
        mark.dataset.valueMark = id
        mark.className = `parsed-evidence-value evidence-value-mark ${info?.style ?? 'link'}${info?.word ? ' decided' : ''}${marks?.selected && ownsMark(marks.selected, key) ? ' selected' : ''}`
        mark.ariaHidden = 'true'
        mark.dataset.occurrenceId = occurrence.occurrence_id
        mark.dataset.resultPath = JSON.stringify(link.resultPath)
        Object.assign(mark.style, {
          position: 'absolute', left: `${box.x0 / meta.width_pt * 100}%`, top: `${box.y0 / meta.height_pt * 100}%`,
          width: `${(box.x1 - box.x0) / meta.width_pt * 100}%`, height: `${(box.y1 - box.y0) / meta.height_pt * 100}%`,
          pointerEvents: info ? 'auto' : 'none', zIndex: '5',
        })
        decorate(mark, [key], info ? fieldWords(info.name) : undefined, info?.color)
        if (mark.parentElement !== page) page.append(mark)
      }
      previousValues.forEach(element => element.remove())
      // Record blocks: outlines under every mark (z-index 3) that take no pointer, placed like the marks, by the page's size.
      const previousRecords = new Map(elements('.record-block').map(element => [element.dataset.recordBlock!, element]))
      for (const piece of records.pieces) {
        const page = pages.get(piece.page), meta = metadata.get(piece.page)
        if (!page || !meta) continue
        const outline = previousRecords.get(piece.id) ?? document.createElement('div')
        previousRecords.delete(piece.id)
        outline.dataset.recordBlock = piece.id
        outline.className = `record-block ${piece.state}${piece.start ? ' start' : ''}${piece.end ? ' end' : ''}`
        outline.setAttribute('role', 'img')
        outline.setAttribute('aria-label', recordBlockName(piece.state, piece.labels))
        if (piece.tag.length) outline.dataset.recordLabel = recordBlockTag(piece.tag)
        else delete outline.dataset.recordLabel
        Object.assign(outline.style, { left: `${piece.box.x0 / meta.width_pt * 100}%`, top: `${piece.box.y0 / meta.height_pt * 100}%`,
          width: `${(piece.box.x1 - piece.box.x0) / meta.width_pt * 100}%`, height: `${(piece.box.y1 - piece.box.y0) / meta.height_pt * 100}%` })
        if (outline.parentElement !== page) page.append(outline)
      }
      previousRecords.forEach(element => element.remove())
      for (const page of pages.values()) page.querySelectorAll('.evidence-dim').forEach(element => element.remove())
      appendDimming(pages, parsedDocument, dim)
      if (pointed && !container.contains(pointed)) leave()
      paintOverview(pages)
      bindHover()
    }
    const update = (requested?: LocatedEvidence) => {
      queued = false
      const next = selection.snapshot().marks
      const previousSelected = marks?.selected ?? null
      marks = next?.extractionId === extractionId ? next : null
      if (located && previousSelected !== (marks?.selected ?? null) && !marks?.savedLinks.some(({ key, link }) =>
        marks?.selected != null && ownsMark(marks.selected, key) && link.evidenceAnchorId === located?.anchor.anchor_id)) located = null
      if (requested) located = requested
      blocks = new Map(); values = []; dim = []
      // The blocks are placed again only when Results publishes other ones (a poll that found nothing new publishes the same).
      const shown = presentation.current.active ? marks?.records ?? null : null
      if (shown !== records.blocks) records = { blocks: shown, pieces: shown ? recordPieces(parsedDocument, markdownBytes, shown) : [] }
      if (presentation.current.active) {
        for (const { key, link, occurrenceIds } of marks?.savedLinks ?? []) {
          const anchor = anchors.get(link.evidenceAnchorId)
          if (!anchor || link.precision === 'input') continue
          const occurrences = anchorOccurrences(anchor).filter(occurrence => !occurrenceIds || occurrenceIds.includes(occurrence.occurrence_id))
          if (link.valueBoxes) values.push(...placedValueBoxes(parsedDocument, occurrences, link.valueBoxes).map(placed => ({ ...placed, link, key })))
          for (const occurrence of occurrences) {
            const block = blocks.get(occurrence.occurrence_id) ?? { occurrence, anchorId: anchor.anchor_id, keys: [], resultPath: link.resultPath }
            if (!block.keys.includes(key)) block.keys.push(key)
            blocks.set(occurrence.occurrence_id, block)
          }
        }
        const link = marks ? selection.snapshot().dim : null, anchor = link && anchors.get(link.evidenceAnchorId)
        if (anchor && (link?.precision === 'segment' || link?.precision === 'cell')) dim = anchorOccurrences(anchor)
      }
      // Precedence is a property of the evidence, not state inferred back from CSS or DOM. Invalid geometry cannot
      // suppress a focus. Keep the exact located anchor: correction navigation may restrict its occurrences.
      const selectedPages = new Set([...blocks.values()].filter(block => verifiedEvidenceBbox(parsedDocument, block.occurrence)
        && block.keys.some(key => marks?.selected && ownsMark(marks.selected, key))).map(block => block.occurrence.page_number))
      if (located && located.link?.precision !== 'input') for (const occurrence of anchorOccurrences(located.anchor)) {
        if (selectedPages.has(occurrence.page_number)) continue
        const block = blocks.get(occurrence.occurrence_id) ?? { occurrence, anchorId: located.anchor.anchor_id, keys: [] }
        blocks.set(occurrence.occurrence_id, { ...block, focus: true })
      }
      if (overview) for (const tick of overview.querySelectorAll<HTMLElement>('[data-occurrence-id]'))
        if (!blocks.get(tick.dataset.occurrenceId!)?.keys.length) tick.remove()
      paint()
    }
    const sync = () => {
      const next = selection.snapshot()
      if ((next.marks !== snapshot.marks || next.dim !== snapshot.dim) && !queued) {
        queued = true
        // Results publishes marks, dimming and navigation in the same commit. Paint once; locate flushes before scrolling.
        queueMicrotask(() => { if (queued && !disposed) update() })
      }
      snapshot = next
    }
    const scale = () => paintOverview()
    const locate = (anchor: ParsedEvidenceAnchor, link?: EvidenceLink) => {
      update({ anchor, link })
      const viewer = presentation.current.viewer
      const occurrences = anchorOccurrences(anchor), first = occurrences[0]
      if (!viewer || !first) return
      const path = JSON.stringify(link?.resultPath)
      const value = [...container.querySelectorAll<HTMLElement>('.parsed-evidence-value')].find(mark => mark.dataset.resultPath === path
        && occurrences.some(occurrence => occurrence.occurrence_id === mark.dataset.occurrenceId))
      if (link?.precision !== 'input' && value) scrollWithinPane(container, value)
      else {
        const pages = pageMap(container)
        const occurrence = link?.precision !== 'input' && occurrences.find(each => verifiedEvidenceBbox(parsedDocument, each) && pages.has(each.page_number))
        const page = occurrence && pages.get(occurrence.page_number)
        const bbox = occurrence && verifiedEvidenceBbox(parsedDocument, occurrence), meta = occurrence && metadata.get(occurrence.page_number)
        if (page && bbox && meta) {
          const rect = page.getBoundingClientRect()
          scrollWithinPane(container, new DOMRect(rect.left + page.clientLeft + bbox.x0 / meta.width_pt * page.clientWidth,
            rect.top + page.clientTop + bbox.y0 / meta.height_pt * page.clientHeight,
            (bbox.x1 - bbox.x0) / meta.width_pt * page.clientWidth, (bbox.y1 - bbox.y0) / meta.height_pt * page.clientHeight))
        } else viewer.scrollPageIntoView({ pageNumber: first.page_number })
      }
    }
    controller.current = { source: parsedDocument, extractionId, update, locate, paint, scale }
    const unsubscribe = selection.subscribe(sync)
    container.addEventListener('mousemove', move)
    container.addEventListener('mouseleave', leave)
    container.addEventListener('mouseout', out)
    container.addEventListener('click', click)
    update()
    // A child can request navigation in its mount effect before this parent effect installs the presenter.
    const request = pending.current
    pending.current = null
    if (request?.source === parsedDocument && request.extractionId === extractionId) locate(request.anchor, request.link)
    return () => {
      disposed = true
      controller.current = null
      unsubscribe(); stopHover(); clearName()
      if (pointed) selection.hover(null)
      container.removeEventListener('mousemove', move)
      container.removeEventListener('mouseleave', leave)
      container.removeEventListener('mouseout', out)
      container.removeEventListener('click', click)
      container.querySelectorAll('.parsed-evidence-highlight, .parsed-evidence-value, .parsed-evidence-focus, .evidence-dim, .record-block').forEach(element => element.remove())
      overview?.replaceChildren()
    }
  }, [containerRef, overviewRef, parsedDocument, markdown, extractionId, selection])
  // The source owns location; the viewer owns page events and can be replaced independently.
  useEffect(() => {
    const current = controller.current, bus = viewer?.eventBus
    if (!current || !bus) return
    const initialize = () => current.update()
    bus.on('pagesinit', initialize)
    bus.on('pagerendered', current.paint)
    bus.on('scalechanging', current.scale)
    return () => {
      bus.off('pagesinit', initialize)
      bus.off('pagerendered', current.paint)
      bus.off('scalechanging', current.scale)
    }
  }, [viewer, containerRef, overviewRef, parsedDocument, markdown, extractionId, selection])
  return useCallback((anchor: ParsedEvidenceAnchor, link?: EvidenceLink) => {
    if (controller.current?.source === parsedDocument && controller.current?.extractionId === extractionId)
      controller.current?.locate(anchor, link)
    else pending.current = { anchor, link, source: parsedDocument, extractionId }
  }, [parsedDocument, extractionId])
}
