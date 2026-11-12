import type { ParsedDocument } from 'extraction/parsed-document'
import type { SourceRange } from 'extraction/durable-types'
import type { DurableState } from './durableExtractionApi'
import { verifiedEvidenceBbox } from './evidenceNavigation'

/** A Catalog record's block on the source while its run goes on: a `preview` discovery has found, whose limits can
 *  still change, or a `closed` record, whose text is settled and which is queued, being read or read. `ranges` is the
 *  text it owns; empty when only its start (`segment`) is known. Display only: never Evidence, a saved link, a review
 *  decision or an export. */
export type RecordBlock = { key: string; state: 'preview' | 'closed'; label: string; segment: string; ranges: readonly SourceRange[] }

/** What a block says in words, for those who cannot see its outline. */
export const recordBlockName = (state: RecordBlock['state'], labels: readonly string[]) =>
  `${labels.join(', ')}${state === 'preview' ? ': still being found, its limits can change' : ''}${labels.length > 1 ? '. They share this block; the text view shows the lines of each.' : ''}`

/** A block's tag: its record where it begins, or every record sharing it (the first few, then how many more). */
export const recordBlockTag = (labels: readonly string[]) => labels.length > 3 ? `${labels.slice(0, 3).join(' · ')} +${labels.length - 3}` : labels.join(' · ')

/** The run's record blocks: every closed record, then each preview no closed record already covers. A preview gives
 *  way wherever a closed record's text begins; one left with no text of its own is not shown. */
export function recordBlocks(state: Pick<DurableState, 'records' | 'discovery'>): RecordBlock[] {
  const closed = (state.records ?? []).flatMap((record): RecordBlock[] => record.segment === null ? [] : [{
    key: `record:${record.ordinal}`, state: 'closed', label: `Record ${record.ordinal + 1}`, segment: record.segment, ranges: record.ranges ?? [] }])
  const settled = new Map<string, SourceRange[]>(), startsOnly = new Set<string>()
  for (const block of closed) {
    if (!block.ranges.length) startsOnly.add(block.segment)
    for (const range of block.ranges) settled.set(range.segment, [...settled.get(range.segment) ?? [], range])
  }
  const previews = (state.discovery?.found ?? []).flatMap((found, index): RecordBlock[] => {
    const ranges = (found.ranges ?? []).flatMap(range => {
      const taken = settled.get(range.segment) ?? []
      if (taken.some(each => each.start <= range.start && range.start < each.end)) return []
      return [{ ...range, end: Math.min(range.end, ...taken.filter(each => each.start > range.start).map(each => each.start)) }]
    })
    if (startsOnly.has(found.segment) || (found.ranges?.length ? !ranges.length : settled.has(found.segment))) return []
    return [{ key: `preview:${index}`, state: 'preview', label: found.label ? `Preview · ${found.label}` : 'Preview', segment: found.segment, ranges }]
  })
  return [...closed, ...previews]
}

type SegmentText = { text: string; byte: number; unit: (codePoint: number) => number; block: ParsedDocument['content_stream'][number] }

/** A segment's own text as the parsed Markdown holds it, with the byte it starts at and the UTF-16 offset of each of
 *  its code points (the worker counts code points). Null when the Markdown rewrites the text (a list) or is not
 *  there: then only the segment's whole block is known. */
export function segmentTexts(document: ParsedDocument, markdown: Uint8Array | null) {
  const blocks = new Map(document.content_stream.map(block => [block.block_id, block]))
  const decoder = new TextDecoder(), read = new Map<string, SegmentText | null>()
  return (segment: string): SegmentText | null => {
    if (read.has(segment)) return read.get(segment)!
    const block = blocks.get(`b_${segment}`), span = block?.markdown_span
    let found: SegmentText | null = null
    if (markdown && block && span && block.kind !== 'list' && span.end <= markdown.length) {
      const written = decoder.decode(markdown.subarray(span.start, span.end))
      // What Markdown writes before the text: a heading's marks, a code fence's line (ASCII, so bytes too).
      const lead = block.kind === 'heading' ? block.level + 1 : block.kind === 'code' ? 4 + (block.language?.length ?? 0) : 0
      // A table's Markdown is its segment's text.
      const text = 'text' in block ? block.text : written
      if (written.startsWith(text, lead)) {
        let unit = (codePoint: number) => Math.min(codePoint, text.length)
        if (/[\uD800-\uDBFF]/.test(text)) {
          const units = [0]
          for (const character of text) units.push(units.at(-1)! + character.length)
          unit = codePoint => units[Math.min(codePoint, units.length - 1)]!
        }
        found = { text, byte: span.start + lead, unit, block }
      }
    }
    read.set(segment, found)
    return found
  }
}

const rangesOf = (block: RecordBlock): readonly (SourceRange | { segment: string })[] => block.ranges.length ? block.ranges : [{ segment: block.segment }]

export type RecordSpan = { from: number; to: number; state: RecordBlock['state']; labels: string[]; exact: boolean; first: boolean }
/** The record blocks' text in the parsed Markdown, as byte spans in reading order that never overlap (a closed record's
 *  text is never a preview's too). An `exact` span is a record's own lines; any other is its whole block, where that is
 *  all the source says, and names every record sharing it. `first` marks where a record begins. */
export function recordSpans(document: ParsedDocument, markdown: Uint8Array, blocks: readonly RecordBlock[]): RecordSpan[] {
  const texts = segmentTexts(document, markdown), encoder = new TextEncoder()
  const bytes = (text: string) => encoder.encode(text).length
  const whole = new Map(document.content_stream.map(block => [block.block_id, block.markdown_span]))
  const spans = blocks.flatMap(block => rangesOf(block).flatMap((range, index): RecordSpan[] => {
    const { state, label } = block
    const source = 'start' in range ? texts(range.segment) : null, span = whole.get(`b_${range.segment}`)
    if (!source || !('start' in range))
      return span && span.end <= markdown.length ? [{ from: span.start, to: span.end, state, labels: [label], exact: false, first: index === 0 }] : []
    const start = source.unit(range.start), from = source.byte + bytes(source.text.slice(0, start))
    return [{ from, to: from + bytes(source.text.slice(start, source.unit(range.end))), state, labels: [label], exact: true, first: index === 0 }]
  }))
  // Closed before a preview where two begin together; what an earlier span holds is not drawn again.
  spans.sort((a, b) => a.from - b.from || Number(a.state === 'preview') - Number(b.state === 'preview'))
  const drawn: RecordSpan[] = []
  for (const span of spans) {
    const last = drawn.at(-1), from = Math.max(span.from, last?.to ?? 0)
    if (span.to > from) drawn.push({ ...span, from })
    else if (last && !last.exact && !span.exact && last.state === span.state) { last.labels.push(...span.labels); last.first ||= span.first }
  }
  return drawn
}

type Box = { x0: number; y0: number; x1: number; y1: number }
const union = (boxes: readonly Box[]): Box => ({ x0: Math.min(...boxes.map(box => box.x0)), y0: Math.min(...boxes.map(box => box.y0)),
  x1: Math.max(...boxes.map(box => box.x1)), y1: Math.max(...boxes.map(box => box.y1)) })

export type RecordPiece = { id: string; page: number; box: Box; state: RecordBlock['state']; labels: string[]; tag: string[]; start: boolean; end: boolean }
/** The record blocks on the page, as the regions to outline: every block a record covers, those stacked down one
 *  column of a page as one region, the first (`start`) and last (`end`) closing the outline. The source places a block
 *  and a table's cells, nothing finer: a record gets its own rows of a table, and otherwise its whole block, which the
 *  records sharing it then share (`labels`). `tag` names a record on the region where it begins and every record of a
 *  shared region, once for each corner regions begin at; empty on a region that only continues one. */
export function recordPieces(document: ParsedDocument, markdown: Uint8Array | null, blocks: readonly RecordBlock[]): RecordPiece[] {
  const texts = segmentTexts(document, markdown)
  const anchors = new Map(document.evidence_index.anchors.map(anchor => [anchor.anchor_id, anchor]))
  const placed = (anchorId: string) => (anchors.get(anchorId)?.producer_observations ?? []).flatMap(occurrence => {
    const box = verifiedEvidenceBbox(document, occurrence)
    return box ? [{ page: occurrence.page_number, box }] : []
  })
  const tables = new Map<string, { from: number; to: number; page: number; box: Box }[] | null>()
  /** A table's placed cells where its segment's text has them: read in order, each after the one before with only
   *  white space between. Null when its text does not read so: then the table's box is all that is known. */
  const tableCells = (segment: string) => {
    if (tables.has(segment)) return tables.get(segment)!
    const source = texts(segment), tableId = source?.block.kind === 'table' ? source.block.table_id : null
    const table = document.tables.find(each => each.table_id === tableId)
    let cells: { from: number; to: number; page: number; box: Box }[] | null = source && table ? [] : null, at = 0
    for (const cell of table ? [...table.cells].sort((a, b) => a.row - b.row || a.column - b.column) : []) {
      if (!cell.text.trim()) continue
      const from = source!.text.indexOf(cell.text, at)
      if (from < 0 || source!.text.slice(at, from).trim()) { cells = null; break }
      at = from + cell.text.length
      cells!.push(...placed(cell.evidence_anchor_id).slice(0, 1).map(place => ({ from, to: at, ...place })))
    }
    tables.set(segment, cells)
    return cells
  }
  const order = new Map(document.content_stream.map((block, index) => [block.block_id.slice(2), index]))
  const pieces = new Map<string, RecordPiece>()
  for (const block of blocks) {
    const regions: { page: number; box: Box }[] = []
    let previous: (SourceRange | { segment: string }) | undefined
    for (const range of rangesOf(block)) {
      const source = 'start' in range ? texts(range.segment) : null
      const cells = source && 'start' in range ? tableCells(range.segment)?.filter(cell => cell.from < source.unit(range.end) && cell.to > source.unit(range.start)) : undefined
      for (const region of cells?.length ? [{ page: cells[0]!.page, box: union(cells.filter(cell => cell.page === cells[0]!.page).map(cell => cell.box)) }] : placed(`a_${range.segment}`)) {
        const last = regions.at(-1)
        // Merge only consecutive source portions; geometry cannot bridge a hole in ownership.
        const continuous = previous && (previous.segment === range.segment
          ? 'end' in previous && 'start' in range && previous.end >= range.start
          : order.get(range.segment) === (order.get(previous.segment) ?? -2) + 1
            && 'end' in previous && 'start' in range && range.start === 0
            && texts(previous.segment)?.unit(previous.end) === texts(previous.segment)?.text.length)
        if (continuous && last && last.page === region.page && region.box.y0 >= last.box.y0 && Math.min(last.box.x1, region.box.x1) > Math.max(last.box.x0, region.box.x0)) last.box = union([last.box, region.box])
        else regions.push(region)
      }
      previous = range
    }
    for (const [index, { page, box }] of regions.entries()) {
      const id = `${block.state}|${page}|${box.x0},${box.y0},${box.x1},${box.y1}`
      const piece = pieces.get(id) ?? { id, page, box, state: block.state, labels: [], tag: [], start: false, end: false }
      if (!piece.labels.includes(block.label)) piece.labels.push(block.label)
      piece.start ||= index === 0
      piece.end ||= index === regions.length - 1
      pieces.set(id, piece)
    }
  }
  const tags = new Map<string, string[]>()
  for (const piece of pieces.values()) {
    if (!piece.start && piece.labels.length < 2) continue
    const corner = `${piece.state}|${piece.page}|${piece.box.x0},${piece.box.y0}`, tag = tags.get(corner)
    if (tag) tag.push(...piece.labels.filter(label => !tag.includes(label)))
    else tags.set(corner, piece.tag = [...piece.labels])
  }
  return [...pieces.values()]
}
