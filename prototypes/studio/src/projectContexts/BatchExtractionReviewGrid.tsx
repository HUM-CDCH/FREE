import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SchemaNode } from 'extraction/schema'
import type { BatchExtraction } from '../../shared/batchExtraction.contract'
import { batchExtractionProgress } from '../../shared/batchExtraction.contract'
import type { ReviewDecisionInput } from '../../shared/extraction.contract'
import { parseReviewedValue, resultPathKey } from '../reviewDecisions'
import { REVIEW_DRAFT_CONFLICT } from '../reviewDrafts'
import { Button, CheckIcon, EmptyState, Pill, PencilIcon, ProgressBar, SegmentedControl, Spinner, StatusDot, UndoIcon, XIcon } from '../ui'
import { memberStatus } from './batchExtractionStatus'
import { StatusPill } from './BatchExtractionScreens'
import {
  projectedRecords,
  useBatchExtractionReviewGrid,
  valuesAtColumn,
  decisionMatchesColumn,
  pendingReviewCount,
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

// The displayed percent is a label, not the literal CSS zoom multiplier:
// everything renders 20% larger than its label reads (100% label -> 1.2x
// actual zoom) because a literal 1:1 default read as too small on screen.
// Zoom math (fit's cap, +/- steps) stays entirely in label units; only the
// final CSS `zoom` value and the fit natural-width measurement need to
// convert between the two.
const ZOOM_VISUAL_SCALE = 1.2

function appliedZoom(percent: number) {
  return (percent / 100) * ZOOM_VISUAL_SCALE
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  )
}

/**
 * Zoom starts fixed at 100%. Entering "fit" mode (the fit button or the `0`
 * shortcut) measures the table's natural width against its scroll container
 * on every render and shrinks the percent (never past 100%) so all columns
 * fit without a horizontal scrollbar. Manual +/- drops back out of fit mode.
 */
function useGridZoom(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [percent, setPercent] = useState(ZOOM_DEFAULT)
  const [fit, setFit] = useState(false)

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
        if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) return
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
      // the actual applied zoom double-counts the zoom and spirals toward
      // ZOOM_MIN. `raw` is converted back out of actual-zoom units into
      // label units before stepping/clamping, since `percent` is a label.
      const naturalWidth = container.scrollWidth / appliedZoom(percent)
      if (naturalWidth <= 0) return
      const raw = ((container.clientWidth / naturalWidth) * 100) / ZOOM_VISUAL_SCALE
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
    if (member.latestExtraction && state?.status === 'ready') {
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

/** Live share of every loaded member's Review Decisions the researcher has
 *  touched so far — approvals/rejects/edits made locally count immediately,
 *  and a saved member (fully touched by definition) keeps counting as done.
 *  This is what actually moves as the researcher works the grid, unlike the
 *  batch's own persisted "reviewed" document count, which only advances on
 *  Save. Null while nothing has loaded yet. */
function aggregateReviewFraction(gridMembers: ReadonlyMap<string, MemberReviewState>): number | null {
  let totalDecisions = 0
  let totalTouched = 0
  for (const state of gridMembers.values()) {
    if (state.status !== 'ready') continue
    totalDecisions += state.decisions.length
    totalTouched += state.touched.size
  }
  if (totalDecisions === 0) return null
  return totalTouched / totalDecisions
}

function formatScalarValue(value: unknown): { text: string; missing: boolean } {
  if (value === null || value === undefined || value === '')
    return { text: 'Missing', missing: true }
  if (Array.isArray(value))
    return value.length > 0
      ? { text: value.map(String).join(', '), missing: false }
      : { text: 'Missing', missing: true }
  if (typeof value === 'boolean') return { text: value ? 'Yes' : 'No', missing: false }
  return { text: String(value), missing: false }
}

const qualityToneClass: Record<'success' | 'accent' | 'danger' | 'neutral', string> = {
  success: 'text-green',
  accent: 'text-accent',
  danger: 'text-danger',
  neutral: 'text-ink-muted',
}

/** A compact, always-visible bulk-approve affordance for one row or column
 *  header — hidden until hover/focus so the grid stays quiet at rest, and
 *  disabled once there's nothing left pending in its scope. */
function ApproveAllBadge({
  label,
  pendingCount,
  onClick,
}: {
  label: string
  pendingCount: number
  onClick(): void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={pendingCount > 0 ? label : 'Nothing pending here'}
      disabled={pendingCount === 0}
      onClick={onClick}
      className="flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-green text-green opacity-0 outline-none transition-colors hover:bg-green-soft focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0"
    >
      <CheckIcon size={8} />
    </button>
  )
}

/** The inverse of ApproveAllBadge: bulk-reverts decisions already touched in
 *  this row (but not yet saved) back to their unreviewed default, restoring
 *  "Needs review" for it. Disabled once nothing in the row has been touched. */
function RevertRowBadge({
  label,
  touchedCount,
  onClick,
}: {
  label: string
  touchedCount: number
  onClick(): void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={touchedCount > 0 ? label : 'Nothing to revert here'}
      disabled={touchedCount === 0}
      onClick={onClick}
      className="flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-line-strong text-ink-muted opacity-0 outline-none transition-colors hover:bg-surface-muted focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0"
    >
      <UndoIcon size={8} />
    </button>
  )
}

/** Share of this document's *reviewable* fields (every field with a Review
 *  Decision — i.e. grounded to Evidence — not just the ones touched so far)
 *  that the researcher has confirmed unchanged. Ungrounded/missing fields
 *  have no Review Decision and no Approve/Reject affordance in the grid, so
 *  they're excluded from the total: this reaches 100% exactly when every
 *  field the researcher *can* act on has been confirmed. Returns null while
 *  nothing has been touched. */
function confirmedNoChangeShare(
  decisions: readonly ReviewDecisionInput[],
  touched: ReadonlySet<string>,
): number | null {
  if (touched.size === 0 || decisions.length === 0) return null
  const confirmed = decisions.filter(
    (decision) =>
      touched.has(resultPathKey(decision.resultPath)) && decision.action === 'APPROVED',
  ).length
  return confirmed / decisions.length
}

function qualityTone(share: number): 'success' | 'accent' | 'danger' {
  if (share >= 0.9) return 'success'
  if (share >= 0.6) return 'accent'
  return 'danger'
}

/** A compact quality signal for one document's Extraction: "Not yet
 *  reviewed" while untouched, then "N% approved unchanged" (scoped to
 *  "so far" until every reviewable field has been acted on) once the
 *  researcher starts making Review Decisions. Scoped to fields with a
 *  Review Decision — ungrounded/missing fields have no Approve/Reject
 *  affordance in the grid, so they're excluded from both the percentage and
 *  the completion check. Not a correctness guarantee: a confirmed value can
 *  still be wrong if the researcher approved it without close reading. */
function QualityScoreBadge({
  decisions,
  touched,
}: {
  decisions: readonly ReviewDecisionInput[]
  touched: ReadonlySet<string>
}) {
  const share = confirmedNoChangeShare(decisions, touched)
  if (share === null)
    return (
      <span className={`text-[10.5px] font-semibold ${qualityToneClass.neutral}`}>
        Not yet reviewed
      </span>
    )
  const percent = Math.round(share * 100)
  const complete = touched.size >= decisions.length
  return (
    <span
      className={`text-[10.5px] font-semibold ${qualityToneClass[qualityTone(share)]}`}
      title={
        complete
          ? `${percent}% of reviewed fields were approved unchanged`
          : `${percent}% of the fields reviewed so far were approved unchanged`
      }
    >
      {percent}% approved unchanged{complete ? '' : ' so far'}
    </span>
  )
}

function decisionLabelAndTone(
  action: ReviewDecisionInput['action'],
): { label: string; tone: 'success' | 'stale' | 'danger' } {
  if (action === 'EDITED') return { label: 'Edited', tone: 'stale' }
  if (action === 'REJECTED') return { label: 'Rejected', tone: 'danger' }
  return { label: 'Approved', tone: 'success' }
}

/** One field of one record, either a plain value or an Approve/Reject/Edit cell. */
function GridCell({
  value,
  decision,
  touched,
  editable,
  active,
  editing,
  onActivate,
  onClose,
  onApprove,
  onReject,
  onStartEdit,
  onCommitEdit,
  onRevert,
}: {
  value: unknown
  decision: ReviewDecisionInput | undefined
  /** Whether the researcher has explicitly acted on this field — an
   *  untouched field is showing its unreviewed 'APPROVED' default. */
  touched: boolean
  editable: boolean
  active: boolean
  editing: boolean
  onActivate(): void
  onClose(): void
  onApprove(): void
  onReject(): void
  onStartEdit(): void
  onCommitEdit(raw: string): string | null
  onRevert(): void
}) {
  const [draftError, setDraftError] = useState<string | null>(null)

  const { text, missing } = formatScalarValue(value)
  const interactive = editable && Boolean(decision)
  const { label, tone } = decision
    ? decisionLabelAndTone(decision.action)
    : { label: '', tone: 'success' as const }

  if (!interactive)
    return (
      <div className="max-w-[16rem] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <StatusDot decision={decision} touched={touched} label={label} tone={tone} />
          <span className={`min-w-0 flex-1 truncate text-ink-faint ${missing ? 'italic' : ''}`}>
            {text}
          </span>
        </div>
      </div>
    )

  if (editing)
    return (
      <div className="max-w-[16rem] bg-surface px-2 py-1.5">
        <input
          autoFocus
          aria-label="Edit review value"
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
      </div>
    )

  return (
    <div className="max-w-[16rem] px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 truncate text-left outline-none"
        onClick={active ? onClose : onActivate}
      >
        <StatusDot decision={decision} touched={touched} label={label} tone={tone} />
        <span className={`min-w-0 flex-1 truncate text-ink ${missing ? 'italic text-ink-faint' : ''}`}>
          {text}
        </span>
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
          {touched && (
            <Button size="sm" variant="pill" onClick={onRevert}>
              Revert
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** A small decorative page-and-pencil mark for the validation progress row —
 *  purely cosmetic, no semantic weight beyond the adjacent progress bar. */
function PencilAndPaperIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      className={className}
    >
      {/* Opaque page fill so the progress track underneath doesn't show
          through the middle of the icon as it slides along the bar. */}
      <path
        d="M5 3h6l3 3v10.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5V3.5A.5.5 0 0 1 5 3Z"
        fill="var(--color-surface)"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M11 3v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6.5 9.5h4M6.5 12h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path
        d="m13.4 12.1 2 2-.9 2.4-2.4.9-2-2 2.4-.9z"
        fill="currentColor"
      />
    </svg>
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
  const [filter, setFilter] = useState<'all' | 'needs-review'>('all')
  // Cells key on their extraction id, so a cell from a previous batch or a
  // reloaded member is dropped during render rather than one frame later.
  const isCurrent = (cell: string | null) => cell === null || [...grid.members.values()].some(
    (state) => state.status === 'ready' && cell.startsWith(state.attempt.extractionId + '#'),
  )
  if (!isCurrent(activeCell)) setActiveCell(null)
  if (!isCurrent(editingCell)) setEditingCell(null)
  useEffect(() => {
    if (editingCell !== null) return
    for (const [id, state] of grid.members)
      if (state.status === 'ready' && !state.saveError) void grid.saveMember(id)
  })
  const progress = batchExtractionProgress(batch)
  const reviewFraction = aggregateReviewFraction(grid.members)
  const allRows = buildRows(batch, grid.members)
  const rows =
    filter === 'needs-review'
      ? allRows.filter((row) => {
          const member = batch.members.find((item) => item.sourceDocumentId === row.sourceDocumentId)
          return member ? needsReviewLocally(member) : false
        })
      : allRows
  const savingAny = [...grid.members.values()].some(
    (state) => state.status === 'ready' && state.saving,
  )

  /** Untouched (still-pending) decisions matching one column's path, across
   *  every ready+editable member — what a column-header bulk approve would
   *  affect. */
  function columnPendingCount(column: GridColumn): number {
    let count = 0
    for (const state of grid.members.values()) {
      if (state.status !== 'ready' || !state.editable) continue
      for (const decision of state.decisions) {
        if (
            decisionMatchesColumn(decision.resultPath, column) &&
          !state.touched.has(resultPathKey(decision.resultPath))
        )
          count += 1
      }
    }
    return count
  }

  /** Untouched (still-pending) decisions in one displayed row — what that
   *  row's bulk-approve badge would affect. */
  function rowPendingCount(state: MemberReviewState, recordIndex: number): number {
    if (state.status !== 'ready') return 0
    return state.decisions.filter(
      (decision) =>
        decision.resultPath[0] === 'records' &&
        decision.resultPath[1] === recordIndex &&
        !state.touched.has(resultPathKey(decision.resultPath)),
    ).length
  }

  /** Touched decisions in one displayed row that aren't saved yet — the
   *  inverse of rowPendingCount, and what that row's bulk-revert badge would
   *  restore back to "Needs review". */
  function rowTouchedCount(state: MemberReviewState, recordIndex: number): number {
    if (state.status !== 'ready') return 0
    return state.decisions.filter(
      (decision) =>
        decision.resultPath[0] === 'records' &&
        decision.resultPath[1] === recordIndex &&
        state.touched.has(resultPathKey(decision.resultPath)),
    ).length
  }

  /** Whether "Needs review" still accurately describes this member — false
   *  once every field's been approved locally (Approve all/row/column), even
   *  before saving, so the header count, the filter tab, and the per-row
   *  pill all move together. */
  function needsReviewLocally(member: BatchExtraction['members'][number]): boolean {
    if (memberStatus(member).label !== 'Needs review') return false
    const state = grid.members.get(member.sourceDocumentId)
    return !(state?.status === 'ready' && state.editable && pendingReviewCount(state) === 0)
  }

  const needsReviewCount = batch.members.filter(needsReviewLocally).length

  if (!schemaNodes)
    return (
      <div className="flex justify-center py-16">
        <Spinner label="Loading the pinned Schema Revision…" />
      </div>
    )

  return (
    <div className="flex flex-col gap-4">
      {grid.draftError && <div role="alert" className="text-xs text-danger">
        Draft not saved: {grid.draftError}
        <Button onClick={grid.retryDrafts} disabled={grid.draftSaving}>{grid.draftError === REVIEW_DRAFT_CONFLICT ? 'Reload server review' : 'Retry draft'}</Button>
      </div>}
      {!grid.draftError && <p role="status" className="text-xs text-ink-muted">{grid.draftSaving ? 'Saving draft…' : grid.dirtyCount > 0 ? 'Draft saved' : ''}</p>}
      <div className="flex shrink-0 flex-col gap-2.5 rounded-card border border-line bg-surface px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="shrink-0 rounded-md text-xs font-semibold text-ink-muted outline-none hover:text-ink"
              onClick={onBack}
            >
              <span aria-hidden="true">← </span>Back to results
            </button>
            <div
              className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-ink-faint"
              aria-label={`${progress.total} Source Document${progress.total === 1 ? '' : 's'}, ${progress.reviewed} reviewed, ${needsReviewCount} need review${progress.unreviewable ? `, ${progress.unreviewable} with no reviewable result` : ''}${progress.failed ? `, ${progress.failed} failed` : ''}`}
            >
              <span className="min-w-0 shrink-0 truncate">
                {progress.total} Source Document{progress.total === 1 ? '' : 's'}
              </span>
              <span className="flex shrink-0 flex-wrap items-center gap-1.5" aria-hidden="true">
                {progress.reviewed > 0 && <Pill tone="success">{progress.reviewed} reviewed</Pill>}
                {needsReviewCount > 0 && <Pill tone="accent">{needsReviewCount} need review</Pill>}
                {progress.unreviewable > 0 && (
                  <span className="text-ink-faint">{progress.unreviewable} no reviewable result</span>
                )}
                {progress.failed > 0 && <Pill tone="danger">{progress.failed} failed</Pill>}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <SegmentedControl
              aria-label="Filter Source Documents"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `All (${progress.total})` },
                {
                  value: 'needs-review',
                  label: `Needs review (${needsReviewCount})`,
                  title: 'Show only Source Documents that still need review',
                },
              ]}
            />
            <div
              role="group"
              aria-label="Grid zoom"
              className="flex shrink-0 items-center rounded-full border border-line bg-surface-muted p-0.5"
            >
              <button
                type="button"
                aria-label="Zoom out"
                title="Zoom out (-)"
                disabled={zoom.percent <= ZOOM_MIN}
                onClick={zoom.zoomOut}
                className="flex size-6.5 items-center justify-center rounded-full text-[15px] leading-none text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
              >
                −
              </button>
              <button
                type="button"
                aria-label="Fit columns to screen width"
                title="Fit columns to screen width"
                onClick={zoom.reset}
                disabled={zoom.fit}
                className="min-w-11 rounded-full px-1.5 text-center text-xs font-medium text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink disabled:hover:bg-transparent"
              >
                {zoom.fit ? 'Fit' : `${zoom.percent}%`}
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                title="Zoom in (+)"
                disabled={zoom.percent >= ZOOM_MAX}
                onClick={zoom.zoomIn}
                className="flex size-6.5 items-center justify-center rounded-full text-[15px] leading-none text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
              >
                +
              </button>
            </div>
            <Button size="sm" variant="secondary" disabled={savingAny || editingCell !== null} onClick={grid.approveAll}>
              Approve remaining
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!grid.canRevert || savingAny || editingCell !== null}
              onClick={grid.revertAll}
            >
              Revert all
            </Button>
            <span role="status" className="text-[11px] text-ink-muted">
              {savingAny ? 'Saving…' : 'Completed reviews save automatically'}
            </span>
          </div>
        </div>
        {reviewFraction !== null && (
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative h-5 min-w-0 flex-1">
              <ProgressBar
                fraction={reviewFraction}
                tone={reviewFraction >= 1 ? 'success' : 'accent'}
                aria-label="Validation progress"
                className="absolute top-1/2 -translate-y-1/2"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-ink-faint transition-[left] duration-300 ease-out"
                style={{ left: `${Math.min(1, Math.max(0, reviewFraction)) * 100}%` }}
              >
                <PencilAndPaperIcon />
              </span>
            </div>
            <span className="shrink-0 text-[10.5px] font-semibold text-ink-faint">
              {Math.round(reviewFraction * 100)}%
            </span>
          </div>
        )}
      </div>

      {grid.columns.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-3.5 px-1 text-[11px] text-ink-faint">
          <div className="flex flex-wrap items-center gap-3.5" aria-hidden="true">
            <span className="flex items-center gap-1.5">
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-line-strong" />
              </span>
              Grounded, pending
            </span>
            <span className="flex items-center gap-1.5">
              <span className="flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-full bg-green text-white">
                <CheckIcon size={7} />
              </span>
              Approved
            </span>
            <span className="flex items-center gap-1.5">
              <span className="flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-full bg-stale text-white">
                <PencilIcon size={6} />
              </span>
              Edited
            </span>
            <span className="flex items-center gap-1.5">
              <span className="flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-full bg-danger text-white">
                <XIcon size={7} />
              </span>
              Rejected
            </span>
          </div>
          <button
            type="button"
            aria-label={
              'Bulk Approve tip: hover a column header, or a row marked “Needs review,” for a bulk Approve action — it only ever touches values still pending, never one you already edited or rejected.'
            }
            title="Hover a column header, or a row marked “Needs review,” for a bulk Approve action — it only ever touches values still pending, never one you already edited or rejected."
            className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-line-strong text-[9px] font-bold leading-none text-ink-faint outline-none transition-colors hover:border-ink-muted hover:text-ink-muted focus-visible:border-accent"
          >
            ?
          </button>
        </div>
      )}

      {grid.columns.length === 0 ? (
        <EmptyState title="This Extraction Schema has no fields to review." />
      ) : (
        <div
          ref={gridContainerRef}
          className="sticky top-0 max-h-[80vh] overflow-auto rounded-card border border-line bg-surface"
        >
          <table
            className="w-full border-collapse text-[11.5px]"
            style={{ zoom: appliedZoom(zoom.percent) }}
          >
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 min-w-[14rem] border-b border-r border-line bg-surface px-3 py-2 text-left font-semibold text-ink-muted">
                  Documents
                </th>
                {grid.columns.map((column) => (
                  <th
                    key={column.key}
                    className="group sticky top-0 z-10 min-w-[10rem] border-b border-line bg-surface px-3 py-2 text-left font-semibold text-ink-muted"
                  >
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate">
                        {column.path.length > 1 ? column.path.join(' › ') : column.node.name}
                      </span>
                      <ApproveAllBadge
                        label={`Approve ${columnPendingCount(column)} pending in ${column.node.name}`}
                        pendingCount={savingAny || editingCell !== null ? 0 : columnPendingCount(column)}
                        onClick={() => grid.approveColumn(column)}
                      />
                    </div>
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
                const titleContent = (
                  <>
                    {documentName(row.sourceDocumentId)}
                    {row.recordCount > 1 ? ` · Record ${row.recordIndex + 1}/${row.recordCount}` : ''}
                  </>
                )
                const pendingInRow =
                  state?.status === 'ready' && state.editable
                    ? rowPendingCount(state, row.recordIndex)
                    : 0
                const touchedInRow =
                  state?.status === 'ready' && state.editable
                    ? rowTouchedCount(state, row.recordIndex)
                    : 0
                const nameCell = (
                  <td className="sticky left-0 z-10 min-w-[14rem] border-r border-line bg-surface px-3 py-2 align-top">
                    <div className="flex min-w-0 items-center gap-1">
                      {member.latestExtraction ? (
                        <button
                          type="button"
                          title="Open document"
                          className="min-w-0 truncate text-left text-[12px] font-semibold text-ink outline-none hover:text-accent hover:underline"
                          onClick={() =>
                            onOpenMember(row.sourceDocumentId, member.latestExtraction!.extractionId)
                          }
                        >
                          {titleContent}
                        </button>
                      ) : (
                        <p className="min-w-0 truncate text-[12px] font-semibold text-ink">
                          {titleContent}
                        </p>
                      )}
                      {state?.status === 'ready' && state.editable && !state.saving && editingCell === null && (
                        <>
                          <ApproveAllBadge
                            label={`Approve ${pendingInRow} pending in this row`}
                            pendingCount={pendingInRow}
                            onClick={() => grid.approveRow(row.sourceDocumentId, row.recordIndex)}
                          />
                          <RevertRowBadge
                            label={`Revert ${touchedInRow} in this row`}
                            touchedCount={touchedInRow}
                            onClick={() => grid.revertRow(row.sourceDocumentId, row.recordIndex)}
                          />
                        </>
                      )}
                    </div>
                    {isFirstRecordRow && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {(status.label !== 'Needs review' || needsReviewLocally(member)) && (
                          <StatusPill tone={status.tone} label={status.label} />
                        )}
                        {state?.status === 'ready' && (
                          <QualityScoreBadge decisions={state.decisions} touched={state.touched} />
                        )}
                        {state?.status === 'ready' && (
                          <span role="status" className="text-[10.5px] text-ink-muted">
                            {state.saving ? 'Saving…' : state.attempt.reviewedAt ? 'Review saved'
                              : state.saveError ? 'Review not saved'
                              : state.touched.size > 0 ? 'Draft' : ''}
                          </span>
                        )}
                      </div>
                    )}
                    {state?.status === 'ready' && state.saveError && (
                      <p className="mt-1 text-[10.5px] text-danger" role="alert">
                        {state.saveError}
                        {' '}<button type="button" className="font-semibold underline"
                          disabled={state.saving || editingCell !== null || pendingReviewCount(state) > 0}
                          onClick={() => void (state.editable ? grid.saveMember : grid.revertMember)(row.sourceDocumentId)}>Retry</button>
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
                  <tr key={`${row.sourceDocumentId}-${row.recordIndex}`} className="group">
                    {nameCell}
                    {grid.columns.map((column) => {
                      const values = valuesAtColumn(record, column)
                      const scalarNode: SchemaNode = column.node.type === 'array' && column.node.itemType
                        ? { id: column.node.id, name: column.node.name, type: column.node.itemType }
                        : column.node
                      return <td key={column.key} className="max-w-[16rem] align-top">
                        {values.length === 0 && <span className="px-3 py-2 text-ink-faint">Empty</span>}
                        {values.map(({ path, value }) => {
                          const resultPath = ['records', row.recordIndex, ...path]
                          const key = resultPathKey(resultPath)
                          const cellKey = state.attempt.extractionId + '#' + key
                          const decision = state.decisions.find((candidate) => resultPathKey(candidate.resultPath) === key)
                          const indexes = path.filter((segment): segment is number => typeof segment === 'number')
                          const label = column.node.name + (indexes.length ? ' · Item ' + indexes.map((index) => index + 1).join('.') : '')
                          return <div key={key} role="group" aria-label={label}>
                            {indexes.length > 0 && <p className="px-3 pt-2 text-[10px] text-ink-muted">{label}</p>}
                            <GridCell
                              value={value}
                              decision={decision}
                              touched={state.touched.has(key)}
                              editable={state.editable && !state.saving}
                              active={activeCell === cellKey}
                              editing={editingCell === cellKey}
                              onActivate={() => setActiveCell(cellKey)}
                              onClose={() => { setActiveCell(null); setEditingCell(null) }}
                              onApprove={() => { grid.setDecision(row.sourceDocumentId, resultPath, 'APPROVED'); setActiveCell(null) }}
                              onReject={() => { grid.setDecision(row.sourceDocumentId, resultPath, 'REJECTED'); setActiveCell(null) }}
                              onStartEdit={() => setEditingCell(cellKey)}
                              onCommitEdit={(raw) => {
                                const parsed = parseReviewedValue(scalarNode, raw)
                                if (parsed.error) return parsed.error
                                grid.setDecision(row.sourceDocumentId, resultPath, 'EDITED', parsed.value)
                                return null
                              }}
                              onRevert={() => { grid.revertDecision(row.sourceDocumentId, resultPath); setActiveCell(null) }}
                            />
                          </div>
                        })}
                      </td>
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
