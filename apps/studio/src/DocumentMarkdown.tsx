import type { ParsedContentBlock, ParsedDocument, TextEvidenceAnchor } from 'extraction/parsed-document'
import { memo, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { markLabel, describeMarks, type RailMarkState } from './useEvidenceOverlays'
import { evidenceColorVars, ownsMark, sharedColor } from './durableRailModel'
import { fieldWords } from './reviewVocabulary'
import { observeEvidenceHover } from './evidenceHover'
import type { SelectionChannel } from './selectionChannel'
import { recordBlockName, recordBlockTag, recordSpans } from './recordBlocks'

type SelectMark = (keys: string[], element: HTMLElement) => void
type SavedLink = RailMarkState['savedLinks'][number]
type MarkSpan = { start: number; end: number; anchorId: string; keys: string[] }

/** Saved offsets count code points in the canonical block, not bytes in its Markdown wrapper.
 * Keep the anchor when that mapping cannot be checked; never search for the value's text. */
function valueMarks(anchor: TextEvidenceAnchor, block: ParsedContentBlock | undefined, source: string, links: readonly SavedLink[]): MarkSpan[] {
  const text = block && 'text' in block ? block.text : null
  const prefix = block?.kind === 'heading' ? `${'#'.repeat(block.level)} `
    : block?.kind === 'code' ? `\`\`\`${block.language ?? ''}\n` : ''
  const suffix = block?.kind === 'code' ? '\n```' : ''
  const points = text !== null && source === prefix + text + suffix ? Array.from(text) : null
  const encoder = new TextEncoder()
  const offset = (at: number) => anchor.markdown_span.start + encoder.encode(prefix + points!.slice(0, at).join('')).length
  const ranges = links.flatMap(({ key, link }) => {
    const located = link.location ?? (link.grounding && (!('support' in link.grounding) || link.grounding.support === 'literal')
      ? link.grounding : undefined)
    const spans = located?.textSpans.filter(span => `a_${span.segment}` === anchor.anchor_id)
    const precise = points && spans?.length && spans.every(span => Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end)
      && 0 <= span.start && span.start < span.end && span.end <= points.length)
    return (precise ? spans.map(span => ({ start: offset(span.start), end: offset(span.end) })) : [anchor.markdown_span])
      .map(span => ({ ...span, key }))
  })
  // Partition overlaps so a shared word selects every value it supports, without nested buttons or lost fields.
  const boundaries = [...new Set(ranges.flatMap(span => [span.start, span.end]))].sort((a, b) => a - b)
  const marks: MarkSpan[] = []
  for (let index = 1; index < boundaries.length; index++) {
    const start = boundaries[index - 1]!, end = boundaries[index]!
    const keys = [...new Set(ranges.filter(span => span.start <= start && end <= span.end).map(span => span.key))]
    if (!keys.length) continue
    const prior = marks.at(-1)
    if (prior?.end === start && prior.keys.length === keys.length && prior.keys.every((key, index) => key === keys[index])) prior.end = end
    else marks.push({ start, end, anchorId: anchor.anchor_id, keys })
  }
  return marks
}

/**
 * The parsed Markdown in the document pane: a page-shaped text with the rail's values
 * marked at their saved literal spans when they map to the Markdown, else at their anchors (UTF-8 byte offsets).
 * Marks select and light their values as the page's marks do. A running Catalog's record blocks are outlined at
 * their own lines of text, under the marks.
 */
function DocumentMarkdown({ markdown, document, selection, extractionId, active = true, marksShown = true, onSelect }: {
  markdown: string | null; document: ParsedDocument | null; selection: SelectionChannel; extractionId: string | null
  active?: boolean; marksShown?: boolean; onSelect: SelectMark
}) {
  const published = useSyncExternalStore(selection.subscribe, () => selection.snapshot().marks)
  const marks: RailMarkState | null = active && published?.extractionId === extractionId ? published : null
  // Results republishes descriptions and links on selection; only the UTF-8 encoding survives those updates.
  const bytes = useMemo(() => new TextEncoder().encode(markdown ?? ''), [markdown])
  const root = useRef<HTMLPreElement>(null)
  const describe = marks?.describe, savedLinks = marks?.savedLinks
  const outlines = marksShown ? marks?.records : undefined
  const records = useMemo(() => document && outlines?.length ? recordSpans(document, bytes, outlines) : [], [document, bytes, outlines])
  useLayoutEffect(() => observeEvidenceHover(selection, [root.current]))
  if (!markdown) return (
    <div className="mx-auto max-w-[34ch] pt-16 text-center">
      <p className="m-0 text-content font-semibold text-ink">Markdown unavailable</p>
      <p className="mt-1.5 mb-0 text-compact leading-snug text-ink-muted">Parsed Markdown has not been received for this source document.</p>
    </div>
  )
  const decoder = new TextDecoder(), decode = (start: number, end: number) => decoder.decode(bytes.subarray(start, end))
  const linksByAnchor = new Map<string, SavedLink[]>()
  for (const saved of savedLinks ?? []) {
    if (saved.link.precision === 'input') continue
    const anchorId = saved.link.evidenceAnchorId
    const links = linksByAnchor.get(anchorId) ?? []
    links.push(saved)
    linksByAnchor.set(anchorId, links)
  }
  const blocks = new Map((document?.content_stream ?? []).map(block => [block.block_id, block]))
  const spans = (document?.evidence_index.anchors ?? []).filter((anchor): anchor is TextEvidenceAnchor => anchor.kind === 'text' && linksByAnchor.has(anchor.anchor_id))
    .sort((a, b) => a.markdown_span.start - b.markdown_span.start)
    .filter((anchor, index, all) => index === 0 || anchor.markdown_span.start >= all[index - 1]!.markdown_span.end)
    .flatMap(anchor => valueMarks(anchor, blocks.get(anchor.block_id), decode(anchor.markdown_span.start, anchor.markdown_span.end), linksByAnchor.get(anchor.anchor_id)!))
  const parts: React.ReactNode[] = []
  let at = 0, record = 0
  /** The text of these bytes, each record block's part of it in its outline; asked for in reading order. */
  const outlined = (from: number, to: number) => {
    const pieces: React.ReactNode[] = []
    for (; record < records.length && records[record]!.from < to; record += 1) {
      const span = records[record]!, start = Math.max(span.from, from), end = Math.min(span.to, to)
      if (end > start) {
        pieces.push(decode(from, start), <span key={`record:${start}`} role="group" aria-label={recordBlockName(span.state, span.labels)}
          className={`record-block ${span.state}`}
          data-record-label={start === span.from && (span.first || span.labels.length > 1) ? recordBlockTag(span.labels) : undefined}>{decode(start, end)}</span>)
        from = end
      }
      // The rest of it lies in the text asked for next.
      if (span.to > to) break
    }
    pieces.push(decode(from, to))
    return pieces
  }
  for (const span of spans) {
    if (span.end > bytes.length) break
    parts.push(...outlined(at, span.start))
    const keys = span.keys.filter(key => describe?.has(key))
    const infos = describeMarks(keys, describe).map(({ info }) => info)
    const selected = marks?.selected != null && keys.some(key => ownsMark(marks.selected!, key))
    const text = outlined(span.start, span.end)
    parts.push(!marksShown && !selected ? <span key={span.start} data-evidence-anchor-id={span.anchorId}>{text}</span>
      : keys.length === 0 ? <span key={span.start} className="evidence-mark" style={{ border: 0, cursor: 'auto' }}>{text}</span>
      : <button key={span.start} type="button" style={evidenceColorVars(sharedColor(infos.map(info => info.color)))}
        className={`evidence-mark ${infos.some(info => info.style === 'preview') ? 'preview' : infos[0]!.style}${infos.every(info => info.word) ? ' decided' : ''}${selected ? ' selected' : ''} whitespace-pre-wrap text-left font-mono`}
        data-evidence-anchor-id={span.anchorId} data-hover-keys={JSON.stringify(keys)} aria-label={markLabel(infos)}
        data-name={[...new Set(infos.map(info => fieldWords(info.name)))].join(', ')} aria-current={selected || undefined}
        onClick={event => onSelect(keys, event.currentTarget)} onMouseMove={() => selection.hover(keys)} onMouseLeave={() => selection.hover(null)}>{text}</button>)
    at = span.end
  }
  parts.push(...outlined(at, bytes.length))
  return <pre ref={root} aria-label="Parsed Markdown" className="mx-auto m-0 max-w-[816px] bg-surface px-10 py-8 font-mono text-secondary whitespace-pre-wrap text-ink shadow-page">
    {parts}
  </pre>
}

export default memo(DocumentMarkdown)
