import type { ParsedDocument } from 'extraction/parsed-document'
import type { MarkInfo } from './useEvidenceOverlays'

type Marks = { describe: ReadonlyMap<string, MarkInfo>; selected: string | null; onSelect: (keys: string[], mark: HTMLElement) => void }

/**
 * The parsed Markdown in the document pane (results review redesign §7.4): a page-shaped text with the rail's values
 * marked at their anchors' Markdown spans (UTF-8 byte offsets), in the marks' style, selecting their values as the
 * page's marks do.
 */
export default function DocumentMarkdown({ markdown, document, marks, marksShown = true }: { markdown: string | null; document: ParsedDocument | null; marks: Marks | null; marksShown?: boolean }) {
  if (!markdown) return (
    <div className="mx-auto max-w-[34ch] pt-16 text-center">
      <p className="m-0 text-content font-semibold text-ink">Markdown unavailable</p>
      <p className="mt-1.5 mb-0 text-compact leading-snug text-ink-muted">Parsed Markdown has not been received for this source document.</p>
    </div>
  )
  const bytes = new TextEncoder().encode(markdown)
  const decode = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end))
  const keysByAnchor = new Map<string, string[]>()
  for (const [key, info] of marks?.describe ?? []) {
    if (info.precision !== 'input') keysByAnchor.set(info.anchorId, [...keysByAnchor.get(info.anchorId) ?? [], key])
  }
  const spans = (document?.evidence_index.anchors ?? []).flatMap((anchor) => anchor.kind === 'text' && keysByAnchor.has(anchor.anchor_id)
    ? [{ ...anchor.markdown_span, keys: keysByAnchor.get(anchor.anchor_id)! }] : [])
    .sort((a, b) => a.start - b.start)
    .filter((span, index, all) => index === 0 || span.start >= all[index - 1]!.end) // nested spans: the outer one marks
  const parts: React.ReactNode[] = []
  let at = 0
  for (const span of spans) {
    if (span.end > bytes.length) break
    parts.push(decode(at, span.start))
    const infos = span.keys.map((key) => marks!.describe.get(key)!)
    const selected = marks!.selected !== null && span.keys.includes(marks!.selected)
    parts.push(!marksShown && !selected ? decode(span.start, span.end) : (
      <button key={span.start} type="button" className={`evidence-mark ${infos[0]!.style}${infos.every((info) => info.word) ? ' decided' : ''}${selected ? ' selected' : ''} whitespace-pre-wrap text-left font-mono`}
        aria-label={infos.map((info) => `${info.name}: ${info.value}${info.word ? `, ${info.word}` : ''}`).join('; ')} aria-current={selected || undefined}
        onClick={(event) => marks!.onSelect(span.keys, event.currentTarget)}>{decode(span.start, span.end)}</button>
    ))
    at = span.end
  }
  parts.push(decode(at, bytes.length))
  return <pre aria-label="Parsed Markdown" className="mx-auto m-0 max-w-[816px] bg-surface px-10 py-8 font-mono text-secondary whitespace-pre-wrap text-ink shadow-page">{parts}</pre>
}
