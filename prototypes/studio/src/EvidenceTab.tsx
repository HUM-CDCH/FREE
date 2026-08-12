import type { ReactNode } from 'react'
import Panel from './ui/Panel'
import type { ParsedDocument, ParsedEvidenceAnchor, TableCellEvidenceAnchor, TextEvidenceAnchor } from '../shared/parsedDocument'
import { blockForAnchor, tableForAnchor } from '../shared/parsedDocument'
import type { ExtractionAttempt } from '../shared/extraction.contract'

function groupByPage(anchors: ParsedEvidenceAnchor[]) {
  const groups = new Map<number, ParsedEvidenceAnchor[]>()
  for (const anchor of anchors) {
    const page = anchor.kind === 'text' ? anchor.page_number : anchor.producer_observations[0].page_number
    groups.set(page, [...(groups.get(page) ?? []), anchor])
  }
  return [...groups.entries()].sort(([left], [right]) => left - right)
}

function Detail({ children }: { children: ReactNode }) {
  return <span className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">{children}</span>
}

function TextAnchor({ anchor, document, onSelect, reviewedCount }: { anchor: TextEvidenceAnchor; document: ParsedDocument; onSelect: () => void; reviewedCount: number }) {
  const block = blockForAnchor(document, anchor)
  const blockText = block && ('text' in block ? block.text : block.kind === 'list' ? block.items.join(' ') : '')
  return (
    <button type="button" onClick={onSelect} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-accent/60 hover:bg-accent-ghost focus-visible:outline-2 focus-visible:outline-accent" aria-label={`Evidence anchor ${anchor.anchor_id} on page ${anchor.page_number}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-semibold text-ink">{blockText || 'Text block'}</span>
        <Detail>text</Detail>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Detail>block {anchor.block_id}</Detail>
        <Detail>UTF-8 bytes {anchor.markdown_span.start}–{anchor.markdown_span.end}</Detail>
        <Detail>{anchor.bbox ? 'geometry verified' : 'geometry unavailable'}</Detail>
        {reviewedCount > 0 && <Detail>{reviewedCount} reviewed occurrence{reviewedCount === 1 ? '' : 's'}</Detail>}
      </div>
    </button>
  )
}

function TableAnchor({ anchor, document, onSelect, reviewedCount }: { anchor: TableCellEvidenceAnchor; document: ParsedDocument; onSelect: () => void; reviewedCount: number }) {
  const table = tableForAnchor(document, anchor)
  const observation = anchor.producer_observations[0]
  return (
    <button type="button" onClick={onSelect} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-accent/60 hover:bg-accent-ghost focus-visible:outline-2 focus-visible:outline-accent" aria-label={`Evidence anchor ${anchor.anchor_id} on page ${observation.page_number}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-semibold text-ink">Table cell {anchor.cell_id}</span>
        <Detail>table cell</Detail>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Detail>logical {anchor.logical_table_id}</Detail>
        <Detail>cell {anchor.canonical_row},{anchor.canonical_column}</Detail>
        {observation && <Detail>producer {observation.producer_ref ?? 'unidentified'} · {observation.row_offset},{observation.column_offset}</Detail>}
        <Detail>{observation?.bbox ? 'geometry verified' : 'geometry unavailable'}</Detail>
        {reviewedCount > 0 && <Detail>{reviewedCount} reviewed occurrence{reviewedCount === 1 ? '' : 's'}</Detail>}
      </div>
      {table && <p className="mt-1.5 text-[11px] text-ink-muted">{table.continuation === 'derived_continuation' ? 'Reviewed continuation across physical pages' : 'Page-local table'} · {table.spans.length} page span{table.spans.length === 1 ? '' : 's'}</p>}
    </button>
  )
}

function EvidenceTab({ document, onSelectAnchor, reviewDecisions = [] }: { document: ParsedDocument | null; onSelectAnchor: (anchor: ParsedEvidenceAnchor) => void; reviewDecisions?: ExtractionAttempt['reviewDecisions'] }) {
  if (!document) {
    return <Panel><div className="rounded-xl border border-dashed border-line px-4 py-7 text-center"><p className="text-sm font-semibold text-ink">Source Evidence unavailable</p><p className="mt-1 text-xs leading-relaxed text-ink-muted">Complete parsing to inspect page-scoped Evidence anchors.</p></div></Panel>
  }

  const groups = groupByPage(document.evidence_index.anchors)
  const diagnostics = document.diagnostics
  const unplaced = document.pages.flatMap((page) => page.unplaced_content.map((tableId) => ({ page: page.page_number, tableId })))
  return (
    <Panel header={<div><h2 className="text-[13px] font-bold text-ink">Source Evidence</h2><p className="text-[11px] text-ink-muted">{document.evidence_index.anchors.length} anchors · {document.page_count} physical pages</p></div>}>
      {diagnostics.length > 0 && <section className="mb-4 rounded-lg border border-amber-300/60 bg-amber-50/50 p-3"><h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-amber-800">Diagnostics</h3><ul className="mt-1.5 space-y-1 text-[11px] text-amber-900">{diagnostics.map((diagnostic, index) => <li key={index}>{typeof diagnostic.code === 'string' ? diagnostic.code : 'placement diagnostic'}{typeof diagnostic.message === 'string' ? `: ${diagnostic.message}` : ''}</li>)}</ul></section>}
      {unplaced.length > 0 && <section className="mb-4 rounded-lg border border-line bg-surface-muted p-3"><h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted">Unplaced content</h3><ul className="mt-1.5 space-y-1 text-[11px] text-ink-muted">{unplaced.map((item) => <li key={`${item.page}-${item.tableId}`}>Page {item.page}: {item.tableId}</li>)}</ul></section>}
      {groups.length === 0 ? <div className="rounded-xl border border-dashed border-line px-4 py-7 text-center text-xs text-ink-muted">No Evidence anchors were published.</div> : groups.map(([page, anchors]) => <section key={page} className="mb-4 last:mb-0"><h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted">Physical page {page}</h3><div className="flex flex-col gap-2">{anchors.map((anchor) => {
        const reviewedCount = reviewDecisions.find((decision) => decision.evidenceAnchorId === anchor.anchor_id)?.reviewedOccurrenceIds.length ?? 0
        return anchor.kind === 'text' ? <TextAnchor key={anchor.anchor_id} anchor={anchor} document={document} reviewedCount={reviewedCount} onSelect={() => onSelectAnchor(anchor)} /> : <TableAnchor key={anchor.anchor_id} anchor={anchor} document={document} reviewedCount={reviewedCount} onSelect={() => onSelectAnchor(anchor)} />
      })}</div></section>)}
    </Panel>
  )
}

export default EvidenceTab
