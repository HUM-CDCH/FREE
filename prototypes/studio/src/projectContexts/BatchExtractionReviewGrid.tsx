import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SchemaNode } from 'extraction/schema'
import type { BatchExtraction } from '../../shared/batchExtraction.contract'
import { batchExtractionProgress } from '../../shared/batchExtraction.contract'
import type { ReviewDecisionInput } from '../../shared/extraction.contract'
import { parseReviewedValue, resultPathKey } from '../reviewDecisions'
import { Button, EmptyState, Spinner } from '../ui'
import { memberStatus, type StatusTone } from './batchExtractionStatus'
import { StatusPill } from './BatchExtractionScreens'
import {
  projectedRecords,
  useBatchExtractionReviewGrid,
  valueAtColumn,
  type GridColumn,
  type MemberReviewState,
} from '../useBatchExtractionReviewGrid'

// Mirrors the PDF viewer's zoom pill (App.tsx), sized for a table rather
// than a page: additive percent steps instead of pdf.js's own ratio steps.
// The floor is lower than the PDF viewer's: a schema with many columns
// needs auto-fit to shrink well past what's still comfortably readable
// rather than stop and leave a horizontal scrollbar.
const ZOOM_MIN = 20
const ZOOM_MAX = 200
const ZOOM_STEP = 10
const ZOOM_DEFAULT = 100

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  )
}

/**
 * Zoom starts in "fit" mode: the table's natural width is measured against
 * its scroll container on every render and the percent shrinks (never grows
 * past 100%) so all columns fit without a horizontal scrollbar. Manual +/-
 * drops out of fit mode; the fit button (or the `0` shortcut) returns to it.
 */
function useGridZoom(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [percent, setPercent] = useState(ZOOM_DEFAULT)
  const [fit, setFit] = useState(true)

  const zoomIn = () => {
    setFit(false)
    setPercent((value) => Math.min(ZOOM_MAX, value + ZOOM_STEP))
  }
  const zoomOut = () => {
    setFit(false)
    setPercent((value) => Math.max(ZOOM_MIN, value - ZOOM_STEP))
  }
  const reset = () => setFit(true)

  useEffect(() => {
    const controller = new AbortController()
    document.addEventListener(
      'keydown',
      (event) => {
        if (isEditableTarget(event.target)) return
        const key = event.key
        if (key === '+' || key === '=' || key === 'Add') {
          event.preventDefault()
          zoomIn()
        } else if (key === '-' || key === 'Subtract') {
          event.preventDefault()
          zoomOut()
        } else if (key === '0' || key === 'Numpad0') {
          event.preventDefault()
          reset()
        }
      },
      { signal: controller.signal },
    )
    return () => controller.abort()
  }, [])

  // No dependency array: re-measures after every render, so it tracks
  // column/row content changes without having to thread those as deps.
  useLayoutEffect(() => {
    if (!fit) return
    const container = containerRef.current
    if (!container) return

    const applyFit = () => {
      // `container.scrollWidth`, not the zoomed table's own scrollWidth: a
      // CSS `zoom`-affected element reports its own box in local (unzoomed)
      // units, while its *parent*'s scrollWidth reflects the zoomed,
      // as-rendered footprint — dividing the table's own scrollWidth by
      // percent double-counts the zoom and spirals toward ZOOM_MIN.
      const naturalWidth = container.scrollWidth / (percent / 100)
      if (naturalWidth <= 0) return
      const raw = (container.clientWidth / naturalWidth) * 100
      const stepped = Math.floor(raw / ZOOM_STEP) * ZOOM_STEP
      const next = Math.min(ZOOM_DEFAULT, Math.max(ZOOM_MIN, stepped))
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

type DisplayRow = {
  sourceDocumentId: string
  recordIndex: number
  recordCount: number
}

function buildRows(
  batch: BatchExtraction,
  gridMembers: ReadonlyMap<string, MemberReviewState>,
): DisplayRow[] {
  const rows: DisplayRow[] = []
  for (const member of batch.members) {
    const state = gridMembers.get(member.sourceDocumentId)
    if (member.latestExtraction?.outcome === 'SUCCEEDED' && state?.status === 'ready') {
      const records = projectedRecords(state.attempt, state.decisions)
      const count = Math.max(records.length, 1)
      for (let recordIndex = 0; recordIndex < count; recordIndex += 1)
        rows.push({ sourceDocumentId: member.sourceDocumentId, recordIndex, recordCount: records.length })
    } else {
      rows.push({ sourceDocumentId: member.sourceDocumentId, recordIndex: 0, recordCount: 1 })
    }
  }
  return rows
}

function formatScalarValue(value: unknown): { text: string; missing: boolean } {
  if (value === null || value === undefined || value === '')
    return { text: 'Missing', missing: true }
  if (typeof value === 'boolean') return { text: value ? 'Yes' : 'No', missing: false }
  return { text: String(value), missing: false }
}

function decisionTone(action: ReviewDecisionInput['action']): StatusTone {
  if (action === 'REJECTED') return 'danger'
  if (action === 'EDITED') return 'accent'
  return 'neutral'
}

const cellToneClass: Record<StatusTone, string> = {
  neutral: '',
  accent: 'bg-accent/10',
  success: 'bg-green/10',
  danger: 'bg-danger/10',
}

/** One field of one record, either a plain value or an Approve/Reject/Edit cell. */
function GridCell({
  value,
  column,
  decision,
  editable,
  active,
  editing,
  onActivate,
  onClose,
  onApprove,
  onReject,
  onStartEdit,
  onCommitEdit,
}: {
  value: unknown
  column: GridColumn
  decision: ReviewDecisionInput | undefined
  editable: boolean
  active: boolean
  editing: boolean
  onActivate(): void
  onClose(): void
  onApprove(): void
  onReject(): void
  onStartEdit(): void
  onCommitEdit(raw: string): string | null
}) {
  const [draftError, setDraftError] = useState<string | null>(null)

  if (column.editableKind === 'scalar-array') {
    const text = Array.isArray(value) && value.length > 0 ? value.map(String).join(', ') : '—'
    return <td className="max-w-[16rem] truncate px-3 py-2 text-ink-faint">{text}</td>
  }

  const { text, missing } = formatScalarValue(value)
  const interactive = editable && Boolean(decision)

  if (!interactive)
    return (
      <td className={`max-w-[16rem] truncate px-3 py-2 ${missing ? 'text-ink-faint italic' : 'text-ink'}`}>
        {text}
      </td>
    )

  const tone = decision ? decisionTone(decision.action) : 'neutral'

  if (editing)
    return (
      <td className="max-w-[16rem] bg-surface px-2 py-1.5">
        <input
          autoFocus
          className="w-full rounded-xs border border-accent bg-surface px-1.5 py-1 text-xs text-ink outline-none"
          defaultValue={String(value ?? '')}
          onChange={() => setDraftError(null)}
          onBlur={(event) => {
            const error = onCommitEdit(event.target.value)
            setDraftError(error)
            if (!error) onClose()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'Enter') {
              const error = onCommitEdit((event.target as HTMLInputElement).value)
              setDraftError(error)
              if (!error) onClose()
            }
          }}
        />
        {draftError && <p className="mt-1 text-[10.5px] text-danger">{draftError}</p>}
      </td>
    )

  return (
    <td className={`max-w-[16rem] px-3 py-2 ${cellToneClass[tone]}`}>
      <button
        type="button"
        className="block w-full truncate text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={active ? onClose : onActivate}
      >
        {text}
      </button>
      {active && (
        <div className="mt-1.5 flex gap-1">
          <Button size="sm" variant="pill" onClick={onApprove}>
            Approve
          </Button>
          <Button size="sm" variant="pill" onClick={onReject}>
            Reject
          </Button>
          <Button size="sm" variant="pill" onClick={onStartEdit}>
            Edit
          </Button>
        </div>
      )}
    </td>
  )
}

export default function BatchExtractionReviewGrid({
  batch,
  schemaNodes,
  documentName,
  onBack,
  onOpenMember,
  onMemberSaved,
}: {
  batch: BatchExtraction
  schemaNodes: readonly SchemaNode[] | null
  documentName(sourceDocumentId: string): string
  onBack(): void
  onOpenMember(sourceDocumentId: string, extractionId: string): void
  onMemberSaved?(): void
}) {
  const grid = useBatchExtractionReviewGrid(batch, schemaNodes, onMemberSaved)
  const gridContainerRef = useRef<HTMLDivElement | null>(null)
  const zoom = useGridZoom(gridContainerRef)
  const [activeCell, setActiveCell] = useState<string | null>(null)
  const [editingCell, setEditingCell] = useState<string | null>(null)
  const progress = batchExtractionProgress(batch)
  const rows = buildRows(batch, grid.members)
  const savingAny = [...grid.members.values()].some(
    (state) => state.status === 'ready' && state.saving,
  )

  if (!schemaNodes)
    return (
      <div className="flex justify-center py-16">
        <Spinner label="Loading the pinned Schema Revision…" />
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            className="shrink-0 rounded-md text-xs font-semibold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={onBack}
          >
            <span aria-hidden="true">← </span>Back to results
          </button>
          <p className="min-w-0 truncate text-[11px] text-ink-faint">
            {progress.total} Source Document{progress.total === 1 ? '' : 's'} ·{' '}
            {progress.reviewed} reviewed · {progress.needsReview} need review
            {progress.failed ? ` · ${progress.failed} failed` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div
            role="group"
            aria-label="Grid zoom"
            className="flex shrink-0 items-center rounded-full border border-line bg-surface-muted p-0.5"
          >
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out (Ctrl + -)"
              disabled={zoom.percent <= ZOOM_MIN}
              onClick={zoom.zoomOut}
              className="flex size-6.5 items-center justify-center rounded-full text-[15px] leading-none text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
            >
              −
            </button>
            <button
              type="button"
              aria-label="Fit columns to screen width"
              title="Fit columns to screen width"
              onClick={zoom.reset}
              disabled={zoom.fit}
              className="min-w-11 rounded-full px-1.5 text-center text-xs font-medium text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 disabled:hover:bg-transparent"
            >
              {zoom.fit ? 'Fit' : `${zoom.percent}%`}
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in (Ctrl + +)"
              disabled={zoom.percent >= ZOOM_MAX}
              onClick={zoom.zoomIn}
              className="flex size-6.5 items-center justify-center rounded-full text-[15px] leading-none text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
            >
              +
            </button>
          </div>
          <Button size="sm" variant="secondary" onClick={grid.approveAllVisible}>
            Approve all visible
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={grid.dirtyCount === 0 || savingAny}
            onClick={() => void grid.saveAll()}
          >
            {savingAny ? 'Saving…' : `Save all reviews${grid.dirtyCount ? ` (${grid.dirtyCount})` : ''}`}
          </Button>
        </div>
      </div>

      {grid.columns.length === 0 ? (
        <EmptyState title="This Extraction Schema has no fields to review." />
      ) : (
        <div ref={gridContainerRef} className="min-h-0 flex-1 overflow-auto rounded-card border border-line">
          <table
            className="w-full border-collapse text-[11.5px]"
            style={{ zoom: zoom.percent / 100 }}
          >
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 min-w-[14rem] border-b border-r border-line bg-surface px-3 py-2 text-left font-semibold text-ink-muted">
                  Documents
                </th>
                {grid.columns.map((column) => (
                  <th
                    key={column.key}
                    className="sticky top-0 z-10 min-w-[10rem] border-b border-line bg-surface px-3 py-2 text-left font-semibold text-ink-muted"
                  >
                    {column.path.length > 1 ? column.path.join(' › ') : column.node.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => {
                const member = batch.members.find(
                  (item) => item.sourceDocumentId === row.sourceDocumentId,
                )!
                const state = grid.members.get(row.sourceDocumentId)
                const status = memberStatus(member)
                const isFirstRecordRow = row.recordIndex === 0
                const nameCell = (
                  <td className="sticky left-0 z-10 min-w-[14rem] border-r border-line bg-surface px-3 py-2 align-top">
                    <p className="truncate text-[12px] font-semibold text-ink">
                      {documentName(row.sourceDocumentId)}
                      {row.recordCount > 1 ? ` · Record ${row.recordIndex + 1}/${row.recordCount}` : ''}
                    </p>
                    {isFirstRecordRow && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <StatusPill tone={status.tone} label={status.label} />
                        {state?.status === 'ready' && state.editable && state.touched.size > 0 && (
                          <Button
                            size="sm"
                            variant="pill"
                            disabled={state.saving}
                            onClick={() => void grid.saveMember(row.sourceDocumentId)}
                          >
                            {state.saving ? 'Saving…' : 'Save'}
                          </Button>
                        )}
                        {member.latestExtraction && (
                          <button
                            type="button"
                            className="text-[10.5px] font-medium text-accent outline-none hover:underline"
                            onClick={() =>
                              onOpenMember(row.sourceDocumentId, member.latestExtraction!.extractionId)
                            }
                          >
                            Open document
                          </button>
                        )}
                      </div>
                    )}
                    {state?.status === 'ready' && state.saveError && (
                      <p className="mt-1 text-[10.5px] text-danger" role="alert">
                        {state.saveError}
                      </p>
                    )}
                  </td>
                )

                if (!state)
                  return (
                    <tr key={`${row.sourceDocumentId}-${row.recordIndex}`}>
                      {nameCell}
                      <td className="px-3 py-2 text-ink-faint" colSpan={grid.columns.length}>
                        {status.message ?? '—'}
                      </td>
                    </tr>
                  )

                if (state.status === 'loading')
                  return (
                    <tr key={`${row.sourceDocumentId}-${row.recordIndex}`}>
                      {nameCell}
                      <td className="px-3 py-2" colSpan={grid.columns.length}>
                        <Spinner label="Loading…" />
                      </td>
                    </tr>
                  )

                if (state.status === 'error')
                  return (
                    <tr key={`${row.sourceDocumentId}-${row.recordIndex}`}>
                      {nameCell}
                      <td className="px-3 py-2" colSpan={grid.columns.length}>
                        <span className="text-danger">{state.message}</span>{' '}
                        <button
                          type="button"
                          className="font-semibold text-accent outline-none hover:underline"
                          onClick={() => grid.retryMember(row.sourceDocumentId)}
                        >
                          Retry
                        </button>
                      </td>
                    </tr>
                  )

                const records = projectedRecords(state.attempt, state.decisions)
                const record = records[row.recordIndex] ?? {}

                return (
                  <tr key={`${row.sourceDocumentId}-${row.recordIndex}`}>
                    {nameCell}
                    {grid.columns.map((column) => {
                      const resultPath = ['records', row.recordIndex, ...column.path]
                      const key = resultPathKey(resultPath)
                      const cellKey = `${row.sourceDocumentId}#${key}`
                      const decision = state.decisions.find(
                        (candidate) => resultPathKey(candidate.resultPath) === key,
                      )
                      return (
                        <GridCell
                          key={column.key}
                          value={valueAtColumn(record, column)}
                          column={column}
                          decision={decision}
                          editable={state.editable}
                          active={activeCell === cellKey}
                          editing={editingCell === cellKey}
                          onActivate={() => setActiveCell(cellKey)}
                          onClose={() => {
                            setActiveCell(null)
                            setEditingCell(null)
                          }}
                          onApprove={() => {
                            grid.setDecision(row.sourceDocumentId, resultPath, 'APPROVED')
                            setActiveCell(null)
                          }}
                          onReject={() => {
                            grid.setDecision(row.sourceDocumentId, resultPath, 'REJECTED')
                            setActiveCell(null)
                          }}
                          onStartEdit={() => setEditingCell(cellKey)}
                          onCommitEdit={(raw) => {
                            const parsed = parseReviewedValue(column.node, raw)
                            if (parsed.error) return parsed.error
                            grid.setDecision(row.sourceDocumentId, resultPath, 'EDITED', parsed.value)
                            return null
                          }}
                        />
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
