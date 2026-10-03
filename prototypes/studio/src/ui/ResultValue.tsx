import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import pluralize from 'pluralize'
import type { SchemaNode } from 'extraction/schema'
import type {
  ReviewDecision,
  ReviewDecisionAction,
  ReviewDecisionInput,
} from '../../shared/extraction.contract'
import { parseReviewedValue } from '../reviewDecisions'

// Local copy so the UI lib imports zero app code (mirrors template.ts#isRecord).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Array item rows take the singular of their parent field's name, e.g. field
// "figures" -> "Figure 1", "Figure 2", rather than the generic "Item N".
// eslint-disable-next-line react-refresh/only-export-components -- tiny helper shared by this file's own ArraySection and by ResultsTab
export function singularItemLabel(fieldName: string, index: number): string {
  const singular = pluralize.singular(fieldName)
  return `${singular.charAt(0).toUpperCase()}${singular.slice(1)} ${index + 1}`
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ResultPath = string[]
export type OnResultChange = (path: ResultPath, value: string) => void
type VisibleReviewDecision = ReviewDecision | ReviewDecisionInput

export type ResultReview = {
  getDecision: (path: ResultPath) => VisibleReviewDecision | undefined
  getSchemaNode: (path: ResultPath) => SchemaNode | null
  /** Every field defaults to an unreviewed 'APPROVED' decision, so a decision
   *  alone doesn't mean the researcher looked at it — isTouched distinguishes
   *  that default from an explicit choice. Missing isTouched treats every
   *  decision as touched (existing callers keep today's behavior). */
  isTouched?: (path: ResultPath) => boolean
  onEditingChange?: (key: string, editing: boolean) => void
  onDecision?: (
    path: ResultPath,
    action: ReviewDecisionAction,
    reviewedValue?: ReviewDecisionInput['reviewedValue'],
  ) => void
  readOnly?: boolean
}

export type ResultValueProps = {
  name: string
  value: unknown
  path?: ResultPath
  onChange?: OnResultChange
  depth?: number
  defaultExpanded?: boolean
  /** When provided, clicking an ObjectSection/ArraySection header navigates to
   *  that node instead of toggling expand/collapse. The callback receives the
   *  node's full path so ResultsTab can update navPath. */
  onNavigateTo?: (path: string[]) => void
  /** When true, long primitive values are shown in full without a More button. */
  expandText?: boolean
  /** Exact canonical Evidence link for a scalar result path, when grounded. */
  getEvidenceAnchorId?: (path: ResultPath) => string | undefined
  /** Reviewer-facing doubt about that link, when grounding flagged one. */
  getEvidenceCheck?: (path: ResultPath) => string | undefined
  /** What tied a recipe Catalog value to its field, in the researcher's words. */
  getEvidenceDetail?: (path: ResultPath) => string | undefined
  /** The candidates of a value the service left empty because its sources disagreed. */
  getContested?: (path: ResultPath) => readonly unknown[] | undefined
  /** The verifier's state of a populated value without Evidence: unsupported, not completed or excluded by policy. */
  getClaimStatus?: (path: ResultPath) => ClaimStatusNote | undefined
  onSelectEvidence?: (anchorId: string) => void
  review?: ResultReview
  /** The value's §8 state, when the caller knows it; reading and queued rows show no value text. */
  getValueState?: (path: ResultPath) => ValueState | undefined
}

export type ClaimStatusNote = { label: string; detail: string }

/** The six per-value states of §8: this component styles them; the settled attempt supplies grounded, empty and
 *  contested, the streaming view later supplies checking, reading and queued. */
export type ValueState = 'grounded' | 'checking' | 'reading' | 'queued' | 'empty' | 'contested'

// ── Shared UI atoms ───────────────────────────────────────────────────────────

function MissingBadge() {
  return (
    <span className="rounded-full border border-line-strong bg-surface-muted px-2 py-0.5 text-overline font-bold uppercase tracking-[0.08em] text-ink-faint">
      Missing
    </span>
  )
}

const candidateText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value)

/** An unresolved conflict, never documented absence: the sources disagreed and the service kept neither value. */
function ContestedBadge({ candidates }: { candidates: readonly unknown[] }) {
  const listed = candidates.map(candidateText).join(' · ')
  return (
    <span className="flex min-w-0 items-center gap-1.5" role="note" aria-label={`Contested: sources disagreed (${listed})`} title={`Sources disagreed: ${listed}`}>
      <span className="shrink-0 rounded-full border border-stale/50 bg-stale-soft px-2 py-0.5 text-overline font-bold uppercase tracking-[0.08em] text-stale-ink">
        Contested
      </span>
      <span className="min-w-0 truncate text-compact text-ink-muted">{listed}</span>
    </span>
  )
}

const candidateTitle = 'Candidate · being verified'

/** The hollow marker of a candidate value that verification has not settled yet. */
function CandidateMarker({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full border border-ink-muted ${className}`} />
}

/** A grounded value with no decision yet (decision 14): the same hollow marker, in accent, before the value. The Results
 *  badge counts these ("n to check"). */
function ToCheckMarker({ className = '' }: { className?: string }) {
  return <span role="img" aria-label="to check" title="To check" className={`size-2 shrink-0 rounded-full border border-accent ${className}`} />
}

/** A value with Evidence is itself the way to it (decision 14): a link-styled button named for the field, described by
 *  the value it shows, at least 24px tall. */
function EvidenceValue({ label, title, valueId, onSelect, children }: {
  label: string
  title?: string
  valueId: string
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={valueId}
      title={title}
      className="inline-flex min-h-6 min-w-0 max-w-full cursor-pointer items-start text-left text-ink underline decoration-accent/40 underline-offset-2 outline-none transition-colors hover:text-accent hover:decoration-accent"
      onClick={onSelect}
    >
      {children}
    </button>
  )
}

function CollapseArrow({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
      style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
    >
      <polygon points="0,0 8,4 0,8" />
    </svg>
  )
}

// "Row drills into a deeper screen" accessory, placed right after the name so
// it's never lost off the end of a wide row — reuses the breadcrumb bar's own
// '›' separator glyph so the same glyph always means "navigate", never "expand
// in place".
function EnterChevron() {
  return (
    <span className="shrink-0 text-base font-bold leading-none text-ink-muted">›</span>
  )
}

export function PencilIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
    </svg>
  )
}

export function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4,10.5 8,15 16,5" />
    </svg>
  )
}

export function XIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <line x1="5" y1="5" x2="15" y2="15" />
      <line x1="15" y1="5" x2="5" y2="15" />
    </svg>
  )
}

export function UndoIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 8.5a6 6 0 1 1 1.3 6.2" />
      <polyline points="4.5,4.5 4.5,8.5 8.5,8.5" />
    </svg>
  )
}

// Returns the first non-empty string value in a record — used as a collapsed preview label.
function firstStringValue(obj: Record<string, unknown>): string | null {
  for (const val of Object.values(obj)) {
    if (typeof val === 'string' && val.trim()) return val.trim()
  }
  return null
}

// ── PrimitiveRow ──────────────────────────────────────────────────────────────

function PrimitiveRow({
  name, value, path, onChange, expandText, evidenceAnchorId, evidenceCheck, evidenceDetail, contested, claimStatus, onSelectEvidence, review, state,
}: { name: string; value: unknown; path: ResultPath; onChange?: OnResultChange; expandText?: boolean; evidenceAnchorId?: string; evidenceCheck?: string; evidenceDetail?: string; contested?: readonly unknown[]; claimStatus?: ClaimStatusNote; onSelectEvidence?: (anchorId: string) => void; review?: ResultReview; state?: ValueState }) {
  const missing = value === null || value === undefined || value === ''
  const text = missing ? '' : String(value)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const valueRef = useRef<HTMLSpanElement | null>(null)

  // The value is shown clamped to two lines; whether it actually needs a
  // "More" button depends on rendered width, not character count, so this
  // measures real overflow (scrollHeight vs clientHeight) instead of
  // guessing from text.length. Only measured while collapsed — once expanded
  // the clamp is lifted so there's nothing left to overflow, and remeasuring
  // then would hide the "Less" button.
  useLayoutEffect(() => {
    if (expandText || missing || expanded) return
    const el = valueRef.current
    if (!el) return
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, expandText, missing, expanded])
  const long = !expandText && overflowing
  const decision = review?.getDecision(path)
  const touched = Boolean(decision) && (review?.isTouched?.(path) ?? true)
  const reviewEditable = Boolean(decision && review?.onDecision && !review.readOnly)
  const editKey = JSON.stringify(path)
  const onEditingChange = review?.onEditingChange
  useEffect(() => {
    if (!editing || !onEditingChange) return
    onEditingChange(editKey, true)
    return () => onEditingChange(editKey, false)
  }, [editing, editKey, onEditingChange])
  const decisionLabel = decision
    ? decision.action === 'APPROVED'
      ? 'Approved'
      : decision.action === 'EDITED'
        ? 'Edited'
        : 'Rejected'
    : null
  const decisionTone = decision?.action === 'APPROVED' ? 'success' : decision?.action === 'EDITED' ? 'stale' : 'danger'
  // Evidence stays reachable after an edit or rejection, but it shows what the extraction found, not the reviewed value.
  const evidenceForExtracted = decision?.action === 'EDITED' || decision?.action === 'REJECTED'
  const evidenceLabel = evidenceForExtracted ? `View Evidence for extracted value of ${name}` : `View Evidence for ${name}`
  const evidenceTitle = evidenceForExtracted ? 'Evidence for the extracted value' : undefined
  const valueId = useId()
  const evidenceShown = Boolean(evidenceAnchorId && onSelectEvidence)
  // "To check": a grounded value whose decision the researcher has not made yet. Decided rows show their status dot.
  const toCheck = Boolean(decision) && !touched
  const statusDot = toCheck
    ? <span className="w-3.5 shrink-0" />
    : <StatusDot decision={decision} touched={touched} label={decisionLabel ?? ''} tone={decisionTone} />
  /** The value text, as the button to its Evidence when it has one. */
  const valueText = (span: ReactNode) => evidenceShown
    ? <EvidenceValue label={evidenceLabel} title={evidenceTitle} valueId={valueId} onSelect={() => onSelectEvidence!(evidenceAnchorId!)}>{span}</EvidenceValue>
    : span

  function startEdit() {
    setReviewError(null)
    setDraft(text)
    setEditing(true)
  }
  function save() {
    if (reviewEditable) {
      const parsed = parseReviewedValue(review?.getSchemaNode(path) ?? null, draft)
      if (parsed.error) {
        setReviewError(parsed.error)
        return
      }
      review?.onDecision?.(path, 'EDITED', parsed.value)
    } else {
      onChange?.(path, draft)
    }
    setEditing(false)
  }
  function cancel() { setReviewError(null); setEditing(false) }

  if (state === 'reading' || state === 'queued') {
    return (
      <div className="-mx-2 grid grid-cols-[14px_minmax(7rem,max-content)_minmax(0,1fr)] items-center gap-x-2 rounded-[3px] px-2 py-1.5">
        <span className="w-3.5 shrink-0" />
        <span className={`font-mono text-content font-medium ${state === 'queued' ? 'text-ink-muted' : 'text-ink'}`}>{name}</span>
        {state === 'reading'
          ? <span role="img" aria-label="Reading" title="Reading" className="h-3 w-24 animate-pulse rounded-sm border border-dashed border-line-strong" />
          : <span role="img" aria-label="Queued" title="Queued" className="h-px w-16 bg-line-strong" />}
      </div>
    )
  }

  if (editing) {
    return (
      <div className="my-0.5 flex items-center gap-1.5 rounded-[3px] border border-accent bg-accent-ghost px-2.5 py-2"
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) save() }}>
        <span className="w-2 shrink-0" />
        <span className="shrink-0 font-mono text-content font-medium text-ink">{name}</span>
        {review?.getSchemaNode(path)?.allowedValues ? (
          <select
            aria-label={`Reviewed value for ${name}`}
            className="min-w-0 flex-1 rounded-[3px] border border-line-strong bg-surface px-2 py-1 text-content text-ink outline-none focus-visible:border-accent"
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
          >
            {review.getSchemaNode(path)?.allowedValues?.map((option) => <option key={option}>{option}</option>)}
          </select>
        ) : review?.getSchemaNode(path)?.type === 'boolean' ? (
          <select
            aria-label={`Reviewed value for ${name}`}
            className="min-w-0 flex-1 rounded-[3px] border border-line-strong bg-surface px-2 py-1 text-content text-ink outline-none focus-visible:border-accent"
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            aria-label={`Reviewed value for ${name}`}
            className="min-w-0 flex-1 rounded-[3px] border border-line-strong bg-surface px-2 py-1 text-content text-ink outline-none focus-visible:border-accent"
            type={review?.getSchemaNode(path)?.type === 'date' ? 'date' : review?.getSchemaNode(path)?.type === 'number' || review?.getSchemaNode(path)?.type === 'integer' ? 'number' : 'text'}
            step={review?.getSchemaNode(path)?.type === 'integer' ? '1' : undefined}
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
          />
        )}
        <button
          className="shrink-0 cursor-pointer rounded-[3px] border border-line-strong bg-surface px-2 py-1 text-compact font-semibold text-ink-muted outline-none hover:text-accent"
          type="button"
          aria-label={`Cancel editing reviewed value for ${name}`}
          onClick={cancel}
        >✗</button>
        {reviewError && <span role="alert" className="text-compact text-danger">{reviewError}</span>}
      </div>
    )
  }

  if (expandText && !missing) {
    return (
      <div className="-mx-2 group rounded-[3px] px-2 pb-2 pt-1.5 transition-colors hover:bg-accent-ghost/30">
        <div className="grid grid-cols-[14px_minmax(7rem,max-content)_minmax(0,1fr)_auto_auto] items-center gap-x-2">
          {statusDot}
          <span className="font-mono text-content font-medium text-ink">{name}</span>
          <span />
          {onChange && (
            <button
              className="shrink-0 cursor-pointer px-0.5 text-ink-faint opacity-0 outline-none transition-all group-hover:opacity-100 hover:text-accent"
              type="button"
              title={`Edit ${name}`}
              onClick={startEdit}
            >
              <PencilIcon />
            </button>
          )}
          {!evidenceAnchorId && claimStatus && <ClaimBadge status={claimStatus} />}
        </div>
        <div className="flex items-start gap-1.5 pl-4 pt-0.5 text-content leading-relaxed text-ink-muted"
          title={state === 'checking' ? candidateTitle : undefined}>
          {state === 'checking' && <CandidateMarker className="mt-[7px]" />}
          {toCheck && <ToCheckMarker className="mt-[7px]" />}
          {valueText(<span id={valueId} className="min-w-0 wrap-anywhere whitespace-pre-wrap">{text}</span>)}
        </div>
        {evidenceCheck && <EvidenceCheckNote reason={evidenceCheck} />}
        {evidenceDetail && <EvidenceDetail text={evidenceDetail} />}
        {reviewEditable && (
          <ReviewActions
            name={name}
            action={decision?.action ?? 'APPROVED'}
            touched={touched}
            onApprove={() => review?.onDecision?.(path, 'APPROVED', null)}
            onEdit={startEdit}
            onReject={() => review?.onDecision?.(path, 'REJECTED', null)}
            onReverse={() => review?.onDecision?.(path, 'APPROVED', null)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="-mx-2 group rounded-[3px] px-2 transition-colors hover:bg-accent-ghost/30">
      <div className="grid grid-cols-[14px_minmax(7rem,max-content)_minmax(0,1fr)_auto_auto] items-start gap-x-2 gap-y-0.5 py-1.5">
        {statusDot}
        <span className="font-mono text-content font-medium leading-snug text-ink">
          {name}
        </span>
        {missing ? (
          // A rejected value shows as Missing; it still leads to the extracted value's Evidence.
          contested ? <ContestedBadge candidates={contested} /> : valueText(<span id={valueId} className="inline-flex"><MissingBadge /></span>)
        ) : state === 'checking' ? (
          <span className={`flex min-w-0 gap-1.5 text-content text-ink-muted ${expanded ? 'items-baseline leading-relaxed' : 'items-center leading-snug'}`} title={candidateTitle}>
            <CandidateMarker />
            <span ref={valueRef} className={expanded ? 'min-w-0 wrap-anywhere whitespace-pre-wrap' : 'min-w-0 line-clamp-2'}>{text}</span>
          </span>
        ) : (
          <span className={`flex min-w-0 gap-1.5 ${expanded ? 'items-baseline' : 'items-start'}`}>
            {toCheck && <ToCheckMarker className={expanded ? '' : 'mt-[5px]'} />}
            {valueText(
              <span
                id={valueId}
                ref={valueRef}
                className={`${expanded
                  ? 'min-w-0 wrap-anywhere whitespace-pre-wrap text-content leading-relaxed'
                  : 'min-w-0 line-clamp-2 text-content leading-snug'} ${evidenceShown ? '' : expanded ? 'text-ink' : 'text-ink-muted'}`}
              >
                {text}
              </span>,
            )}
          </span>
        )}
        {!missing && !evidenceAnchorId && claimStatus && <ClaimBadge status={claimStatus} />}
        {(onChange || reviewEditable) && !reviewEditable && (
          <button
            className="shrink-0 cursor-pointer px-0.5 text-ink-faint opacity-0 outline-none transition-all group-hover:opacity-100 hover:text-accent"
            type="button"
            title={`Edit ${name}`}
            onClick={startEdit}
          >
            <PencilIcon />
          </button>
        )}
        {long && !missing && (
          <button
            className="col-start-3 justify-self-start cursor-pointer text-compact font-bold text-accent outline-none hover:underline"
            type="button"
            onClick={() => setExpanded(v => !v)}
          >
            {expanded ? 'Less' : 'More'}
          </button>
        )}
      </div>
      {evidenceCheck && <EvidenceCheckNote reason={evidenceCheck} />}
      {evidenceDetail && <EvidenceDetail text={evidenceDetail} />}
      {reviewEditable && (
        <ReviewActions
          name={name}
          action={decision?.action ?? 'APPROVED'}
          touched={touched}
          onApprove={() => review?.onDecision?.(path, 'APPROVED', null)}
          onEdit={startEdit}
          onReject={() => review?.onDecision?.(path, 'REJECTED', null)}
          onReverse={() => review?.onDecision?.(path, 'APPROVED', null)}
        />
      )}
    </div>
  )
}

function EvidenceDetail({ text }: { text: string }) {
  return <p className="pb-1 pl-[22px] text-compact leading-snug text-ink-faint">{text}</p>
}

// Leading status indicator: a hollow dot for an untouched (default-approved)
// field, or a solid dot colored/shaped by outcome once the researcher has
// acted. Hovering reveals the outcome and, once saved, when it happened —
// the row itself stays quiet instead of carrying a trailing text badge.
export function StatusDot({ decision, touched, label, tone }: { decision: VisibleReviewDecision | undefined; touched: boolean; label: string; tone: 'success' | 'stale' | 'danger' }) {
  if (!decision) return <span className="w-3.5 shrink-0" />
  if (!touched) {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" title="Pending review">
        <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-line-strong" />
      </span>
    )
  }
  const timestamp = 'createdAt' in decision
    ? new Date(decision.createdAt).toLocaleString()
    : null
  const toneClass = tone === 'success' ? 'bg-green' : tone === 'stale' ? 'bg-stale' : 'bg-danger'
  return (
    <span
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      title={timestamp ? `${label} · ${timestamp}` : label}
    >
      <span className={`flex h-2.5 w-2.5 items-center justify-center rounded-full text-white ${toneClass}`}>
        {tone === 'success' && <CheckIcon size={7} />}
        {tone === 'stale' && <PencilIcon size={6} />}
        {tone === 'danger' && <XIcon size={7} />}
      </span>
    </span>
  )
}

function ReviewActions({ name, action, touched, onApprove, onEdit, onReject, onReverse }: {
  name: string
  action: ReviewDecisionAction
  /** Whether the researcher has explicitly acted on this field — an
   *  untouched field is showing its unreviewed 'APPROVED' default, so none
   *  of the three buttons should read as pressed. */
  touched: boolean
  onApprove: () => void
  onEdit: () => void
  onReject: () => void
  onReverse: () => void
}) {
  return (
    <div className="mb-1 ml-4 flex items-center gap-1" role="group" aria-label={`Review ${name}`}>
      <div className="inline-flex overflow-hidden rounded-md border border-line">
        <button
          type="button"
          aria-label={`Approve ${name}`}
          aria-pressed={touched && action === 'APPROVED'}
          className="flex h-6 w-7 items-center justify-center border-r border-line text-ink-muted outline-none transition-colors hover:bg-accent-ghost hover:text-accent aria-pressed:border-green aria-pressed:bg-green aria-pressed:text-white aria-pressed:hover:bg-green"
          onClick={onApprove}
        ><CheckIcon /></button>
        <button
          type="button"
          aria-label={`Edit ${name}`}
          aria-pressed={touched && action === 'EDITED'}
          className="flex h-6 w-7 items-center justify-center border-r border-line text-ink-muted outline-none transition-colors hover:bg-accent-ghost hover:text-accent aria-pressed:border-stale aria-pressed:bg-stale aria-pressed:text-white aria-pressed:hover:bg-stale"
          onClick={onEdit}
        ><PencilIcon /></button>
        <button
          type="button"
          aria-label={`Reject ${name}`}
          aria-pressed={touched && action === 'REJECTED'}
          className="flex h-6 w-7 items-center justify-center text-ink-muted outline-none transition-colors hover:bg-accent-ghost hover:text-accent aria-pressed:border-danger aria-pressed:bg-danger aria-pressed:text-white aria-pressed:hover:bg-danger"
          onClick={onReject}
        ><XIcon /></button>
      </div>
      {action !== 'APPROVED' && (
        <button
          type="button"
          aria-label={`Reverse decision for ${name}`}
          title="Reverse to Approved"
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-muted outline-none transition-colors hover:bg-surface-muted hover:text-ink"
          onClick={onReverse}
        ><UndoIcon /></button>
      )}
    </div>
  )
}

/** The verifier's state of a populated value that has no Evidence: never a verdict on the value itself. */
function ClaimBadge({ status }: { status: ClaimStatusNote }) {
  return (
    <span role="note" aria-label={`${status.label}: ${status.detail}`} title={status.detail}
      className="shrink-0 rounded-full border border-stale/50 bg-stale-soft px-2 py-0.5 text-overline font-bold text-stale-ink">
      {status.label}
    </span>
  )
}

/** Grounding's doubt about a link: the value is not in the passage, or it also occurs elsewhere. A prompt to look,
 *  never a verdict: a quiet line under the value (decision 14: no pill), named by its reason. */
function EvidenceCheckNote({ reason }: { reason: string }) {
  return <p role="note" aria-label={reason} className="pb-1 pl-[22px] text-compact leading-snug text-stale-ink">{reason}</p>
}

// ── ObjectSection ─────────────────────────────────────────────────────────────

function ObjectSection({
  name, value, path, onChange, depth, defaultExpanded = true, onNavigateTo, expandText, getEvidenceAnchorId, getEvidenceCheck, getEvidenceDetail, getContested, getClaimStatus, onSelectEvidence, review, getValueState,
}: { name: string; value: Record<string, unknown>; path: ResultPath; onChange?: OnResultChange; depth: number; defaultExpanded?: boolean; onNavigateTo?: (path: string[]) => void; expandText?: boolean; getEvidenceAnchorId?: (path: ResultPath) => string | undefined; getEvidenceCheck?: (path: ResultPath) => string | undefined; getEvidenceDetail?: (path: ResultPath) => string | undefined; getContested?: (path: ResultPath) => readonly unknown[] | undefined; getClaimStatus?: (path: ResultPath) => ClaimStatusNote | undefined; onSelectEvidence?: (anchorId: string) => void; review?: ResultReview; getValueState?: (path: ResultPath) => ValueState | undefined }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const entries = Object.entries(value)
  const preview = firstStringValue(value)

  return (
    <div>
      <button
        type="button"
        aria-expanded={onNavigateTo ? undefined : expanded}
        className="-mx-2 grid w-[calc(100%+1rem)] cursor-pointer grid-cols-[14px_minmax(7rem,max-content)_minmax(0,1fr)] items-center gap-x-2 rounded-[3px] px-2 py-1.5 text-left transition-colors hover:bg-accent-ghost/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => onNavigateTo ? onNavigateTo(path) : setExpanded(v => !v)}
      >
        {onNavigateTo ? <span className="w-3.5 shrink-0" /> : <span className="flex w-3.5 shrink-0 items-center text-ink-faint"><CollapseArrow expanded={expanded} /></span>}
        <span className="font-mono text-content font-medium text-ink">{name}</span>
        <span className="flex min-w-0 items-center gap-2">
          {onNavigateTo && <EnterChevron />}
          {expanded ? (
            <span className="shrink-0 whitespace-nowrap rounded-full bg-accent px-2.5 py-0.5 font-sans text-overline font-semibold tracking-wide text-white">
              {entries.length} field{entries.length !== 1 ? 's' : ''}
            </span>
          ) : entries.length === 0 ? (
            <MissingBadge />
          ) : preview ? (
            <span className="min-w-0 flex-1 truncate text-content text-ink-muted">{preview}</span>
          ) : null}
        </span>
      </button>
      {expanded && (
        <div className="ml-3.5 mt-0.5 border-l border-line pl-3">
          {entries.length === 0 ? (
            <p className="py-1.5 text-content text-ink-muted">No fields returned.</p>
          ) : (
            entries.map(([key, child]) => (
              <ResultValue
                key={key}
                name={key}
                value={child}
                path={[...path, key]}
                onChange={onChange}
                onNavigateTo={onNavigateTo}
                defaultExpanded={onNavigateTo ? false : undefined}
                expandText={expandText}
                getEvidenceAnchorId={getEvidenceAnchorId}
                getEvidenceCheck={getEvidenceCheck}
                getEvidenceDetail={getEvidenceDetail}
                getContested={getContested}
                getClaimStatus={getClaimStatus}
                onSelectEvidence={onSelectEvidence}
                review={review}
                getValueState={getValueState}
                depth={depth + 1}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── ArraySection ──────────────────────────────────────────────────────────────

function ArraySection({
  name, value, path, onChange, depth, defaultExpanded = true, onNavigateTo, expandText, getEvidenceAnchorId, getEvidenceCheck, getEvidenceDetail, getContested, getClaimStatus, onSelectEvidence, review, getValueState,
}: { name: string; value: readonly unknown[]; path: ResultPath; onChange?: OnResultChange; depth: number; defaultExpanded?: boolean; onNavigateTo?: (path: string[]) => void; expandText?: boolean; getEvidenceAnchorId?: (path: ResultPath) => string | undefined; getEvidenceCheck?: (path: ResultPath) => string | undefined; getEvidenceDetail?: (path: ResultPath) => string | undefined; getContested?: (path: ResultPath) => readonly unknown[] | undefined; getClaimStatus?: (path: ResultPath) => ClaimStatusNote | undefined; onSelectEvidence?: (anchorId: string) => void; review?: ResultReview; getValueState?: (path: ResultPath) => ValueState | undefined }) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div>
      <button
        type="button"
        aria-expanded={onNavigateTo ? undefined : expanded}
        className="-mx-2 grid w-[calc(100%+1rem)] cursor-pointer grid-cols-[14px_minmax(7rem,max-content)_minmax(0,1fr)] items-center gap-x-2 rounded-[3px] px-2 py-1.5 text-left transition-colors hover:bg-accent-ghost/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => onNavigateTo ? onNavigateTo(path) : setExpanded(v => !v)}
      >
        {onNavigateTo ? <span className="w-3.5 shrink-0" /> : <span className="flex w-3.5 shrink-0 items-center text-ink-faint"><CollapseArrow expanded={expanded} /></span>}
        <span className="font-mono text-content font-medium text-ink">{name}</span>
        <span className="flex min-w-0 items-center gap-2">
          {onNavigateTo && <EnterChevron />}
          <span className="shrink-0 whitespace-nowrap rounded-full bg-surface-muted px-2.5 py-0.5 font-sans text-overline font-semibold text-ink-muted">
            {value.length} item{value.length !== 1 ? 's' : ''}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="ml-3.5 mt-0.5 border-l border-line pl-3">
          {value.length === 0 ? (
            <div className="py-1"><MissingBadge /></div>
          ) : (
            value.map((item, i) => (
              <ResultValue
                key={`${name}-${i}`}
                name={singularItemLabel(name, i)}
                value={item}
                path={[...path, String(i)]}
                onChange={onChange}
                onNavigateTo={onNavigateTo}
                depth={depth + 1}
                defaultExpanded={false}
                expandText={expandText}
                getEvidenceAnchorId={getEvidenceAnchorId}
                getEvidenceCheck={getEvidenceCheck}
                getEvidenceDetail={getEvidenceDetail}
                getContested={getContested}
                getClaimStatus={getClaimStatus}
                onSelectEvidence={onSelectEvidence}
                review={review}
                getValueState={getValueState}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

function ResultValue({ name, value, path = [], onChange, depth = 0, defaultExpanded, onNavigateTo, expandText, getEvidenceAnchorId, getEvidenceCheck, getEvidenceDetail, getContested, getClaimStatus, onSelectEvidence, review, getValueState }: ResultValueProps) {
  if (Array.isArray(value)) {
    return <ArraySection name={name} value={value} path={path} onChange={onChange} depth={depth} defaultExpanded={defaultExpanded} onNavigateTo={onNavigateTo} expandText={expandText} getEvidenceAnchorId={getEvidenceAnchorId} getEvidenceCheck={getEvidenceCheck} getEvidenceDetail={getEvidenceDetail} getContested={getContested} getClaimStatus={getClaimStatus} onSelectEvidence={onSelectEvidence} review={review} getValueState={getValueState} />
  }
  if (isRecord(value)) {
    return <ObjectSection name={name} value={value} path={path} onChange={onChange} depth={depth} defaultExpanded={defaultExpanded} onNavigateTo={onNavigateTo} expandText={expandText} getEvidenceAnchorId={getEvidenceAnchorId} getEvidenceCheck={getEvidenceCheck} getEvidenceDetail={getEvidenceDetail} getContested={getContested} getClaimStatus={getClaimStatus} onSelectEvidence={onSelectEvidence} review={review} getValueState={getValueState} />
  }
  return <PrimitiveRow name={name} value={value} path={path} onChange={onChange} expandText={expandText} evidenceAnchorId={getEvidenceAnchorId?.(path)} evidenceCheck={getEvidenceCheck?.(path)} evidenceDetail={getEvidenceDetail?.(path)} contested={getContested?.(path)} claimStatus={getClaimStatus?.(path)} onSelectEvidence={onSelectEvidence} review={review} state={getValueState?.(path)} />
}

/** A record's heading in a Catalog result: its label and the page its first Evidence names. */
export function RecordHeader({ label, page }: { label: string; page: number | null }) {
  return (
    <p className="flex items-baseline gap-2 px-2 pt-2 text-secondary font-semibold text-ink">
      <span>{label}</span>
      {page !== null && <span className="text-compact font-medium text-ink-muted">· page {page}</span>}
    </p>
  )
}

export default ResultValue
