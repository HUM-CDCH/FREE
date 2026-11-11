import type { ParsedDocument } from 'extraction/parsed-document'
import { memo, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { markLabel, describeMarks, type RailMarkState } from './useEvidenceOverlays'
import { evidenceColorVars, ownsMark, sharedColor } from './durableRailModel'
import { fieldWords } from './reviewVocabulary'
import { observeEvidenceHover } from './evidenceHover'
import type { SelectionChannel } from './selectionChannel'
import { recordBlockName, recordBlockTag, recordSpans } from './recordBlocks'

type SelectMark = (keys: string[], element: HTMLElement) => void

/**
 * The parsed Markdown in the document pane: a page-shaped text with the rail's values
 * marked at their anchors' Markdown spans (UTF-8 byte offsets), in the marks' style, selecting and lighting their values
 * as the page's marks do. A running Catalog's record blocks are outlined at their own lines of text, under the marks.
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
  const blocks = marksShown ? marks?.records : undefined
  const records = useMemo(() => document && blocks?.length ? recordSpans(document, bytes, blocks) : [], [document, bytes, blocks])
  useLayoutEffect(() => observeEvidenceHover(selection, [root.current]))
  if (!markdown) return (
    <div className="mx-auto max-w-[34ch] pt-16 text-center">
      <p className="m-0 text-content font-semibold text-ink">Markdown unavailable</p>
      <p className="mt-1.5 mb-0 text-compact leading-snug text-ink-muted">Parsed Markdown has not been received for this source document.</p>
    </div>
  )
  const decoder = new TextDecoder(), decode = (start: number, end: number) => decoder.decode(bytes.subarray(start, end))
  const keysByAnchor = new Map<string, string[]>()
  const links = savedLinks?.map(({ key, link }) => ({ key, anchorId: link.evidenceAnchorId, precision: link.precision })) ?? []
  for (const { key, anchorId, precision } of links) {
    if (precision === 'input') continue
    const keys = keysByAnchor.get(anchorId) ?? []
    if (!keys.includes(key)) keys.push(key)
    keysByAnchor.set(anchorId, keys)
  }
  const spans = (document?.evidence_index.anchors ?? []).flatMap(anchor => anchor.kind === 'text' && keysByAnchor.has(anchor.anchor_id)
    ? [{ ...anchor.markdown_span, anchorId: anchor.anchor_id, keys: keysByAnchor.get(anchor.anchor_id)! }] : [])
    .sort((a, b) => a.start - b.start)
    .filter((span, index, all) => index === 0 || span.start >= all[index - 1]!.end)
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
