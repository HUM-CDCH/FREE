import type { ParsedDocument } from 'extraction/parsed-document'
import type { RailMarks } from './useEvidenceOverlays'
import { evidenceColorVars, markValueId, ownsMark } from './durableRailModel'

type Marks = RailMarks

/**
 * The parsed Markdown in the document pane: a page-shaped text with the rail's values
 * marked at their anchors' Markdown spans (UTF-8 byte offsets), in the marks' style, selecting and lighting their values
 * as the page's marks do.
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
  const links=marks?.savedLinks?.map(({key,link})=>({key,anchorId:link.evidenceAnchorId,precision:link.precision}))
    ?? [...marks?.describe??[]].map(([key,info])=>({key,anchorId:info.anchorId,precision:info.precision}))
  for (const {key,anchorId,precision} of links) {
    if(precision==='input')continue
    const keys=keysByAnchor.get(anchorId)??[]
    if(!keys.includes(key))keys.push(key)
    keysByAnchor.set(anchorId,keys)
  }
  const spans = (document?.evidence_index.anchors ?? []).flatMap((anchor) => anchor.kind === 'text' && keysByAnchor.has(anchor.anchor_id)
    ? [{ ...anchor.markdown_span, anchorId: anchor.anchor_id, keys: keysByAnchor.get(anchor.anchor_id)! }] : [])
    .sort((a, b) => a.start - b.start)
    .filter((span, index, all) => index === 0 || span.start >= all[index - 1]!.end) // nested spans: the outer one marks
  const parts: React.ReactNode[] = []
  let at = 0
  for (const span of spans) {
    if (span.end > bytes.length) break
    parts.push(decode(at, span.start))
    // A record start discovery found has no value to select: filled as on the page, with no underline or pointer.
    const keys = span.keys.filter((key) => marks!.describe.has(key))
    // A value's correction Evidence in its own model passage names it once; two values that read alike stay two.
    const infos = keys.filter((key) => !key.endsWith('#correction') || !keys.includes(markValueId(key))).map((key) => marks!.describe.get(key)!)
    const selected = marks!.selected !== null && keys.some((key) => ownsMark(marks!.selected!, key))
    const hovered = keys.some((key) => marks!.hovered?.some((each) => ownsMark(each, key)))
    parts.push(!marksShown && !selected ? <span key={span.start} data-evidence-anchor-id={span.anchorId}>{decode(span.start, span.end)}</span>
      : keys.length === 0 ? <span key={span.start} className="evidence-mark" style={{ border: 0, cursor: 'auto' }}>{decode(span.start, span.end)}</span> : (
      <button key={span.start} type="button" style={evidenceColorVars(infos[0]!.color)} className={`evidence-mark ${infos[0]!.style}${infos.every((info) => info.word) ? ' decided' : ''}${selected ? ' selected' : ''}${hovered ? ' hovered' : ''} whitespace-pre-wrap text-left font-mono`}
        data-evidence-anchor-id={span.anchorId}
        aria-label={infos.map((info) => `${info.name}: ${info.value}${info.word ? `, ${info.word}` : ''}`).join('; ')} aria-current={selected || undefined}
        onClick={(event) => marks!.onSelect(keys, event.currentTarget)}
        onMouseEnter={() => marks!.onHover?.(keys)} onMouseLeave={() => marks!.onHover?.(null)}>{decode(span.start, span.end)}</button>
    ))
    at = span.end
  }
  parts.push(decode(at, bytes.length))
  return <pre aria-label="Parsed Markdown" className="mx-auto m-0 max-w-[816px] bg-surface px-10 py-8 font-mono text-secondary whitespace-pre-wrap text-ink shadow-page">{parts}</pre>
}
