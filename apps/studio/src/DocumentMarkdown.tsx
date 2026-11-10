import type { ParsedDocument } from 'extraction/parsed-document'
import { memo, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { markLabel, describeMarks, type MarkInfo, type RailMarkState } from './useEvidenceOverlays'
import { evidenceColorVars, ownsMark, sharedColor } from './durableRailModel'
import { fieldWords } from './reviewVocabulary'
import { observeEvidenceHover } from './evidenceHover'
import type { SelectionChannel } from './selectionChannel'

type SelectMark = (keys: string[], element: HTMLElement) => void

type Passage = { start: number; anchorId: string; keys: string[]; infos: MarkInfo[]; text: string }
const MarkdownMark = memo(function MarkdownMark({ passage, selected, marksShown, onSelect, onHover }: {
  passage: Passage; selected: boolean; marksShown: boolean
  onSelect: SelectMark; onHover: SelectionChannel['hover']
}) {
  const { keys, infos, text, anchorId } = passage
  if (!marksShown && !selected) return <span data-evidence-anchor-id={anchorId}>{text}</span>
  if (keys.length === 0) return <span className="evidence-mark" style={{ border: 0, cursor: 'auto' }}>{text}</span>
  return <button type="button" style={evidenceColorVars(sharedColor(infos.map(info => info.color)))}
    className={`evidence-mark ${infos.some(info => info.style === 'preview') ? 'preview' : infos[0]!.style}${infos.every(info => info.word) ? ' decided' : ''}${selected ? ' selected' : ''} whitespace-pre-wrap text-left font-mono`}
    data-evidence-anchor-id={anchorId} data-hover-keys={JSON.stringify(keys)} aria-label={markLabel(infos)}
    data-name={[...new Set(infos.map(info => fieldWords(info.name)))].join(', ')} aria-current={selected || undefined}
    onClick={event => onSelect(keys, event.currentTarget)} onMouseMove={() => onHover(keys)} onMouseLeave={() => onHover(null)}>{text}</button>
})

/**
 * The parsed Markdown in the document pane: a page-shaped text with the rail's values
 * marked at their anchors' Markdown spans (UTF-8 byte offsets), in the marks' style, selecting and lighting their values
 * as the page's marks do.
 */
function DocumentMarkdown({ markdown, document, selection, extractionId, active = true, marksShown = true, onSelect }: {
  markdown: string | null; document: ParsedDocument | null; selection: SelectionChannel; extractionId: string | null
  active?: boolean; marksShown?: boolean; onSelect: SelectMark
}) {
  const published = useSyncExternalStore(selection.subscribe, () => selection.snapshot().marks)
  const marks: RailMarkState | null = active && published?.extractionId === extractionId ? published : null
  const bytes = useMemo(() => new TextEncoder().encode(markdown ?? ''), [markdown])
  const root = useRef<HTMLPreElement>(null)
  const describe = marks?.describe, savedLinks = marks?.savedLinks
  // The document's UTF-8 byte spans and decoded source pieces survive selection, hover and unrelated parent renders.
  const parts = useMemo(() => {
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
    const result: (string | Passage)[] = []
    let at = 0
    for (const span of spans) {
      if (span.end > bytes.length) break
      result.push(decode(at, span.start))
      const keys = span.keys.filter(key => describe?.has(key))
      const infos = describeMarks(keys, describe).map(({ info }) => info)
      result.push({ start: span.start, anchorId: span.anchorId, keys, infos, text: decode(span.start, span.end) })
      at = span.end
    }
    result.push(decode(at, bytes.length))
    return result
  }, [bytes, document, describe, savedLinks])
  useLayoutEffect(() => observeEvidenceHover(selection, [root.current]))
  if (!markdown) return (
    <div className="mx-auto max-w-[34ch] pt-16 text-center">
      <p className="m-0 text-content font-semibold text-ink">Markdown unavailable</p>
      <p className="mt-1.5 mb-0 text-compact leading-snug text-ink-muted">Parsed Markdown has not been received for this source document.</p>
    </div>
  )
  return <pre ref={root} aria-label="Parsed Markdown" className="mx-auto m-0 max-w-[816px] bg-surface px-10 py-8 font-mono text-secondary whitespace-pre-wrap text-ink shadow-page">
    {parts.map(part => typeof part === 'string' ? part : <MarkdownMark key={part.start} passage={part}
      selected={marks?.selected != null && part.keys.some(key => ownsMark(marks.selected!, key))}
      marksShown={marksShown} onSelect={onSelect} onHover={selection.hover} />)}
  </pre>
}

export default memo(DocumentMarkdown)
