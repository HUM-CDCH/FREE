import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SchemaNode } from 'extraction/schema'
import type { BatchExtraction, BatchExtractionMember } from '../../shared/batchExtraction.contract'
import {
  bulkApprovable, decided, finalizable, gridColumns, gridLayout, layoutValues, reviewable,
  type GridAction, type GridColumn, type GridLayout, type GridRecord, type GridValue,
} from '../batchReviewGrid'
import { durableRailRow } from '../durableRailModel'
import { DECISION_WORD, reviewedValueSummary, rowText, stateLabel } from '../reviewVocabulary'
import { gridMember, useBatchReviewGrid, type GridDecision, type MemberGridState } from '../useBatchReviewGrid'
import { Button, CheckIcon, EmptyState, SegmentedControl, Spinner, UndoIcon } from '../ui'
import {
  ApprovedGlyph, ContestedGlyph, EditedGlyph, MissingGlyph, NotReviewableGlyph, RejectedGlyph, ToCheckGlyph,
} from '../ui/icons'
import ReviewedValueEditor from '../ui/ReviewedValueEditor'
import { memberStatus } from './batchExtractionStatus'
import { StatusPill } from './BatchExtractionScreens'

// Additive percent steps; the floor lets a template with many fields fit the pane without a horizontal scrollbar.
const ZOOM_MIN = 20
const ZOOM_MAX = 200
const ZOOM_STEP = 10
const ZOOM_DEFAULT = 100
// The label reads 100% at 1.2x: a literal 1:1 table read as too small beside the rest of the page.
const ZOOM_VISUAL_SCALE = 1.2
const appliedZoom = (percent: number) => (percent / 100) * ZOOM_VISUAL_SCALE

const isEditableTarget = (target: EventTarget | null) => target instanceof Element &&
  target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null

/** Zoom starts at 100%. Fit (its button, or `0`) shrinks the table, never past 100%, until every column fits; + and −
 *  step it by hand and leave fit. */
function useGridZoom(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [percent, setPercent] = useState(ZOOM_DEFAULT)
  const [fit, setFit] = useState(false)
  const zoomIn = () => { setFit(false); setPercent((value) => Math.min(ZOOM_MAX, value + ZOOM_STEP)) }
  const zoomOut = () => { setFit(false); setPercent((value) => Math.max(ZOOM_MIN, value - ZOOM_STEP)) }
  const reset = () => setFit(true)
  useEffect(() => {
    const controller = new AbortController()
    document.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) return
      if (event.key === '+' || event.key === '=' || event.key === 'Add') { event.preventDefault(); zoomIn() }
      else if (event.key === '-' || event.key === 'Subtract') { event.preventDefault(); zoomOut() }
      else if (event.key === '0' || event.key === 'Numpad0') { event.preventDefault(); reset() }
    }, { signal: controller.signal })
    return () => controller.abort()
  }, [])
  // Measured after every render, so fit follows the rows and columns as they load.
  useLayoutEffect(() => {
    if (!fit) return
    const container = containerRef.current
    if (!container) return
    const applyFit = () => {
      // The container's scrollWidth is the zoomed table's rendered footprint; the table's own box stays unzoomed.
      const naturalWidth = container.scrollWidth / appliedZoom(percent)
      if (naturalWidth <= 0) return
      const raw = ((container.clientWidth / naturalWidth) * 100) / ZOOM_VISUAL_SCALE
      const next = Math.min(ZOOM_DEFAULT, Math.max(ZOOM_MIN, Math.floor(raw / ZOOM_STEP) * ZOOM_STEP))
      setPercent((current) => (current === next ? current : next))
    }
    applyFit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(applyFit)
    observer.observe(container)
    return () => observer.disconnect()
  })
  return { percent, fit, zoomIn, zoomOut, reset }
}

function CellGlyph({ kind }: { kind: ReturnType<typeof durableRailRow>['kind'] }) {
  switch (kind) {
    case 'to-check': return <ToCheckGlyph />
    case 'approved': return <ApprovedGlyph />
    case 'edited': return <EditedGlyph />
    case 'rejected': return <RejectedGlyph />
    case 'missing': return <MissingGlyph />
    case 'contested': return <ContestedGlyph />
    default: return <NotReviewableGlyph />
  }
}

/** A hover-revealed bulk action on a row or column header; disabled once nothing is left in its scope. */
function BulkBadge({ label, count, tone, onClick, children }: {
  label: string; count: number; tone: 'approve' | 'revert'; onClick(): void; children: ReactNode
}) {
  return (
    <button type="button" aria-label={label} title={count > 0 ? label : 'Nothing here'} disabled={count === 0} onClick={onClick}
      className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border opacity-0 outline-none transition-colors focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0 ${
        tone === 'approve' ? 'border-green text-green hover:bg-green-soft' : 'border-line-strong text-ink-muted hover:bg-surface-muted'}`}>
      {children}
    </button>
  )
}

/** One value of one record: its decision glyph and shown value, and when open its decisions. A Value Disagreement is
 *  approved by choosing a reading, in the document's review; here it can be edited or rejected. */
function GridCell({ value, open, editing, locked, onOpen, onClose, onDecide, onEdit, onOpenDocument }: {
  value: GridValue; open: boolean; editing: boolean; locked: boolean
  onOpen(): void; onClose(): void; onDecide(action: GridAction, edited?: unknown): void; onEdit(): void; onOpenDocument(): void
}) {
  const row = durableRailRow(value, null)
  const text = row.value && typeof row.value === 'object' ? reviewedValueSummary(value.node, row.value) : rowText(row)
  const missing = row.value === null || row.value === undefined || row.value === ''
  const canDecide = reviewable(value) && !locked
  const shown = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="flex shrink-0 items-center"><CellGlyph kind={row.kind} /></span>
      <span className={`min-w-0 flex-1 truncate ${missing ? 'italic text-ink-faint' : 'text-ink'}`} title={text}>{text}</span>
      {row.disagreement && <span className="shrink-0 text-[10px] text-ink-muted">readings differ</span>}
    </span>
  )
  if (!reviewable(value))
    return <div className="max-w-[16rem] px-3 py-2 text-ink-faint" aria-label={`${value.node.name}: ${stateLabel(row)}`}>{shown}</div>
  if (editing)
    return (
      <div className="w-[16rem] px-2 py-1.5">
        <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
          <ReviewedValueEditor node={value.node} initial={row.value} saveLabel="Save edit"
            onSave={(edited) => onDecide('EDITED', edited)} onTypedSave={(edited) => onDecide('EDITED', edited)} onCancel={onClose} />
        </fieldset>
      </div>
    )
  return (
    <div className="max-w-[16rem] px-3 py-2">
      <button type="button" disabled={locked} aria-expanded={open}
        aria-label={`${stateLabel(row)} ${value.node.name} ${text}`}
        className="flex w-full min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
        onClick={open ? onClose : onOpen}>
        {shown}
      </button>
      {open && canDecide && (
        <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label={`Decision for ${value.node.name}`}>
          {row.kind === 'to-check' ? <>
            {!row.disagreement && <Button size="sm" variant="pill" onClick={() => onDecide('APPROVED')}>Approve</Button>}
            <Button size="sm" variant="pill" onClick={onEdit}>Edit</Button>
            <Button size="sm" variant="pill" onClick={() => onDecide('REJECTED')}>Reject</Button>
            {row.disagreement && <Button size="sm" variant="pill" onClick={onOpenDocument}>Choose a reading…</Button>}
          </> : <>
            <span className="self-center text-[10.5px] font-semibold text-ink">{row.decision ? DECISION_WORD[row.decision.action] : ''}</span>
            <Button size="sm" variant="pill" onClick={onEdit}>Edit</Button>
            <Button size="sm" variant="pill" onClick={() => onDecide('PENDING')}>Back to To check</Button>
          </>}
        </div>
      )}
    </div>
  )
}

type Row =
  | { kind: 'values'; member: BatchExtractionMember; layout: GridLayout; record: GridRecord; first: boolean; span: number
      state: Extract<MemberGridState, { status: 'ready' }> }
  | { kind: 'status'; member: BatchExtractionMember; state: MemberGridState | undefined }

const EMPTY_RECORD: GridRecord = { key: 'document', index: 0, values: new Map() }

function gridRows(batch: BatchExtraction, members: ReadonlyMap<string, MemberGridState>): Row[] {
  return batch.members.flatMap((member): Row[] => {
    const state = members.get(member.extractionId)
    if (state?.status !== 'ready') return [{ kind: 'status', member, state }]
    const layout = gridLayout(state.page)
    const records = layout.records.length ? layout.records : [EMPTY_RECORD]
    return records.map((record, index) => ({ kind: 'values', member, layout, record, first: index === 0, span: records.length, state }))
  })
}

/**
 * The batch's review grid: each completed member's latest saved values, one row per record and one column per
 * top-level field. A decision saves at once as a correction of that value, as in the document's review; bulk Approve
 * decides only values still To check with one reading. Each document's review is saved on its own row: finalizing
 * names that member's shown results and Decision Version.
 */
export default function BatchReviewGrid({ batch, schemaNodes, documentName, onBack, onOpenMember, onFinalized }: {
  batch: BatchExtraction
  /** The pinned Template Revision's fields, for column order; values name their own producing fields. */
  schemaNodes: readonly SchemaNode[]
  documentName(sourceDocumentId: string): string
  onBack(): void
  onOpenMember(sourceDocumentId: string, extractionId: string): void
  onFinalized?(): void
}) {
  const grid = useBatchReviewGrid(batch, onFinalized)
  const descriptionId = useId()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const zoom = useGridZoom(containerRef)
  const [openCell, setOpenCell] = useState<string | null>(null)
  const [editingCell, setEditingCell] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'needs-review'>('all')
  const columns = gridColumns(grid.pages, schemaNodes)

  const ready = [...grid.members].flatMap(([id, state]) => state.status === 'ready' ? [[id, state] as const] : [])
  const loading = [...grid.members.values()].some((state) => state.status === 'loading')
  const busy = ready.some(([, state]) => state.saving) || editingCell !== null
  const open = (state: Extract<MemberGridState, { status: 'ready' }>) => !state.saving
  const approvable = (predicate: (value: GridValue) => boolean): GridDecision[] =>
    ready.flatMap(([id, state]) => open(state)
      ? layoutValues(gridLayout(state.page)).filter((value) => bulkApprovable(value) && predicate(value))
        .map((value) => ({ extractionId: id, value, action: 'APPROVED' as const }))
      : [])
  const remaining = approvable(() => true)
  const toCheckCount = ready.reduce((total, [, state]) => total + state.page.reviewCounts.toCheck, 0)
  const reviewed = batch.members.filter((member) => member.currentReview !== null).length
  const outside = batch.members.filter((member) => !gridMember(member)).length
  const needsReview = (row: Row) => row.kind === 'values' ? row.state.page.finalization === null : row.member.currentReview === null
  const rows = gridRows(batch, grid.members).filter((row) => filter === 'all' || needsReview(row))
  const needsReviewCount = batch.members.filter((member) => {
    const state = grid.members.get(member.extractionId)
    return state?.status === 'ready' ? state.page.finalization === null : gridMember(member) && member.currentReview === null
  }).length

  const decide = (decisions: GridDecision[]) => { setOpenCell(null); setEditingCell(null); if (decisions.length) void grid.decide(decisions) }
  const columnValues = (column: GridColumn) => approvable((value) => value.fieldId === column.fieldId)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-2.5 rounded-card border border-line bg-surface px-4 py-3">
        <div className="flex flex-col flex-wrap gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" className="shrink-0 rounded-md text-xs font-semibold text-ink-muted outline-none hover:text-ink" onClick={onBack}>
              <span aria-hidden="true">← </span>Back to documents
            </button>
            <p className="min-w-0 text-[11px] text-ink-faint" role="status" aria-atomic="true">
              {batch.members.length} Source Document{batch.members.length === 1 ? '' : 's'} · {reviewed} reviewed
              {' · '}{loading ? 'Loading values…' : `${toCheckCount} value${toCheckCount === 1 ? '' : 's'} to check`}
              {outside > 0 && ` · ${outside} not in the grid until completed with saved values`}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <SegmentedControl aria-label="Filter Source Documents" value={filter} onChange={setFilter} options={[
              { value: 'all', label: `All (${batch.members.length})` },
              { value: 'needs-review', label: `Needs review (${needsReviewCount})` },
            ]} />
            <div role="group" aria-label="Grid zoom" className="flex shrink-0 items-center rounded-full border border-line bg-surface-muted p-0.5">
              <button type="button" aria-label="Zoom out" title="Zoom out (-)" disabled={zoom.percent <= ZOOM_MIN} onClick={zoom.zoomOut}
                className="flex size-6.5 items-center justify-center rounded-full text-[15px] leading-none text-ink-muted outline-none hover:bg-surface hover:text-ink disabled:opacity-40">−</button>
              <button type="button" aria-label="Fit columns to screen width" title="Fit columns to screen width" onClick={zoom.reset} disabled={zoom.fit}
                className="min-w-11 rounded-full px-1.5 text-center text-xs font-medium text-ink-muted outline-none hover:bg-surface hover:text-ink">{zoom.fit ? 'Fit' : `${zoom.percent}%`}</button>
              <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={zoom.percent >= ZOOM_MAX} onClick={zoom.zoomIn}
                className="flex size-6.5 items-center justify-center rounded-full text-[15px] leading-none text-ink-muted outline-none hover:bg-surface hover:text-ink disabled:opacity-40">+</button>
            </div>
            <Button size="sm" variant="secondary" disabled={busy || remaining.length === 0} aria-describedby={descriptionId}
              onClick={() => decide(remaining)}>
              Approve remaining ({remaining.length})
            </Button>
          </div>
        </div>
        <p id={descriptionId} className="text-[11px] leading-snug text-ink-muted">
          Each decision saves at once. Approve remaining, a column’s or a row’s ✓ approve only values still To check, in every
          loaded document including rows a filter hides; edits, rejections and values whose readings differ stay as they are.
          Save each document’s review on its row once nothing is left to check.
        </p>
      </div>

      {columns.length === 0 && !loading ? (
        <EmptyState title={ready.length ? 'No saved values to review.' : 'No completed document with saved values yet.'} />
      ) : (
        <div ref={containerRef} className="max-h-[80vh] overflow-auto rounded-card border border-line bg-surface">
          <table className="w-full border-collapse text-[11.5px]" style={{ zoom: appliedZoom(zoom.percent) }}>
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 min-w-[14rem] border-b border-r border-line bg-surface px-3 py-2 text-left font-semibold text-ink-muted">Documents</th>
                {columns.map((column) => {
                  const pending = columnValues(column)
                  return (
                    <th key={column.fieldId} className="group sticky top-0 z-10 min-w-[10rem] border-b border-line bg-surface px-3 py-2 text-left font-semibold text-ink-muted">
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="min-w-0 truncate" title={column.document ? `${column.name} (one per document)` : column.name}>{column.name}</span>
                        <BulkBadge tone="approve" label={`Approve ${pending.length} to check in ${column.name}`} count={busy ? 0 : pending.length}
                          onClick={() => decide(pending)}><CheckIcon size={8} /></BulkBadge>
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => {
                const { member } = row
                const name = documentName(member.sourceDocumentId)
                const openDocument = () => onOpenMember(member.sourceDocumentId, member.extractionId)
                if (row.kind === 'status') {
                  const status = memberStatus(member)
                  return (
                    <tr key={member.extractionId}>
                      <td className="sticky left-0 z-10 min-w-[14rem] border-r border-line bg-surface px-3 py-2 align-top">
                        <button type="button" className="min-w-0 truncate text-left text-[12px] font-semibold text-ink outline-none hover:underline" onClick={openDocument}>{name}</button>
                        <div className="mt-1"><StatusPill tone={status.tone} label={status.label} /></div>
                      </td>
                      <td className="px-3 py-2 text-ink-faint" colSpan={Math.max(columns.length, 1)}>
                        {row.state?.status === 'loading' ? <Spinner label="Loading…" />
                          : row.state?.status === 'error' ? <><span className="text-danger">{row.state.message}</span>{' '}
                            <button type="button" className="font-semibold text-accent outline-none hover:underline" onClick={() => grid.retry(member.extractionId)}>Retry</button></>
                          : member.reviewable ? 'Shown here once it completes. Open it to review its saved values meanwhile.'
                          : 'No saved values to review.'}
                      </td>
                    </tr>
                  )
                }
                const { state, record, layout } = row
                const id = member.extractionId
                const recordValues = [...record.values.values(), ...(row.first ? layout.document.values() : [])]
                const rowPending = state.saving ? [] : recordValues.filter(bulkApprovable)
                const rowDecided = state.saving ? [] : recordValues.filter(decided)
                const page = state.page
                return (
                  <tr key={`${id}:${record.key}`} className="group">
                    <td className="sticky left-0 z-10 min-w-[14rem] border-r border-line bg-surface px-3 py-2 align-top">
                      <div className="flex min-w-0 items-center gap-1">
                        <button type="button" title="Open document" onClick={openDocument}
                          className="min-w-0 truncate text-left text-[12px] font-semibold text-ink outline-none hover:underline">
                          {name}{row.span > 1 ? ` · Record ${record.index + 1}` : ''}
                        </button>
                        {editingCell === null && <>
                          <BulkBadge tone="approve" label={`Approve ${rowPending.length} to check in this row`} count={rowPending.length}
                            onClick={() => decide(rowPending.map((value) => ({ extractionId: id, value, action: 'APPROVED' })))}><CheckIcon size={8} /></BulkBadge>
                          <BulkBadge tone="revert" label={`Set ${rowDecided.length} decided in this row back to To check`} count={rowDecided.length}
                            onClick={() => decide(rowDecided.map((value) => ({ extractionId: id, value, action: 'PENDING' })))}><UndoIcon size={8} /></BulkBadge>
                        </>}
                      </div>
                      {row.first && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px]">
                          {page.finalization ? <StatusPill tone="success" label="Reviewed" />
                            : <span className="text-ink-muted">{page.reviewCounts.toCheck} of {page.reviewCounts.required} to check</span>}
                          {state.saving && <span role="status" className="text-ink-muted">Saving…</span>}
                          {!page.finalization && (
                            <Button size="sm" variant="positive" disabled={busy || !finalizable(page)}
                              title={finalizable(page) ? 'Finalize this document’s shown results and decisions' : 'Decide every value first'}
                              onClick={() => void grid.finalize(id)}>Save review</Button>
                          )}
                        </div>
                      )}
                      {row.first && state.error && <p role="alert" className="mt-1 text-[10.5px] text-danger">{state.error}</p>}
                    </td>
                    {columns.map((column) => {
                      if (column.document && !row.first) return null
                      const value = column.document ? layout.document.get(column.fieldId) : record.values.get(column.fieldId)
                      const cellKey = `${id}#${value?.id ?? column.fieldId}`
                      return (
                        <td key={column.fieldId} rowSpan={column.document ? row.span : undefined} className="max-w-[16rem] align-top">
                          {value ? (
                            <GridCell value={value} open={openCell === cellKey} editing={editingCell === cellKey}
                              locked={state.saving || (editingCell !== null && editingCell !== cellKey)}
                              onOpen={() => setOpenCell(cellKey)} onClose={() => { setOpenCell(null); setEditingCell(null) }}
                              onEdit={() => setEditingCell(cellKey)} onOpenDocument={openDocument}
                              onDecide={(action, edited) => decide([{ extractionId: id, value, action, edited }])} />
                          ) : <span className="block px-3 py-2 text-ink-faint">—</span>}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
