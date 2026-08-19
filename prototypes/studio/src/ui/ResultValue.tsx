import { useState } from 'react'
import pluralize from 'pluralize'

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
  onSelectEvidence?: (anchorId: string) => void
}

// ── Shared UI atoms ───────────────────────────────────────────────────────────

function MissingBadge() {
  return (
    <span className="rounded-full border border-line-strong bg-surface-muted px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-faint">
      Missing
    </span>
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
    <span className="shrink-0 text-[15px] font-bold leading-none text-ink-muted">›</span>
  )
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor">
      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
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
  name, value, path, onChange, expandText, evidenceAnchorId, onSelectEvidence,
}: { name: string; value: unknown; path: ResultPath; onChange?: OnResultChange; expandText?: boolean; evidenceAnchorId?: string; onSelectEvidence?: (anchorId: string) => void }) {
  const missing = value === null || value === undefined || value === ''
  const text = missing ? '' : String(value)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(false)
  const long = !expandText && text.length > 80

  function startEdit() { setDraft(text); setEditing(true) }
  function save() { onChange?.(path, draft); setEditing(false) }
  function cancel() { setEditing(false) }

  if (editing) {
    return (
      <div className="my-0.5 flex items-center gap-1.5 rounded-lg border border-accent bg-accent-ghost px-2.5 py-2">
        <span className="w-2 shrink-0" />
        <span className="shrink-0 font-mono text-[13.5px] font-medium text-ink">{name}</span>
        <input
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-ink outline-none focus-visible:border-accent"
          value={draft}
          autoFocus
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
        />
        <button
          className="shrink-0 cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1 text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108"
          type="button"
          onClick={save}
        >Save</button>
        <button
          className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink-muted outline-none hover:text-accent"
          type="button"
          onClick={cancel}
        >✗</button>
      </div>
    )
  }

  if (expandText && !missing) {
    return (
      <div className="-mx-2 group rounded-md px-2 pb-2 pt-1.5 transition-colors hover:bg-accent-ghost/30">
        <div className="flex items-center gap-2">
          <span className="w-2 shrink-0" />
          <span className="shrink-0 font-mono text-[13.5px] font-medium text-ink">{name}</span>
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
          {evidenceAnchorId && onSelectEvidence && (
            <button
              className="shrink-0 cursor-pointer rounded-full border border-accent/40 bg-accent-ghost px-2 py-0.5 text-[10.5px] font-bold text-accent outline-none hover:border-accent"
              type="button"
              aria-label={`View Evidence for ${name}`}
              onClick={() => onSelectEvidence(evidenceAnchorId)}
            >
              Evidence
            </button>
          )}
        </div>
        <div className="pl-4 pt-0.5 text-[13px] leading-relaxed text-ink-muted wrap-anywhere whitespace-pre-wrap">
          {text}
        </div>
      </div>
    )
  }

  return (
    <div className="-mx-2 group rounded-md px-2 transition-colors hover:bg-accent-ghost/30">
      <div className="flex items-center gap-2 py-1.5">
        <span className="w-2 shrink-0" />
        <span className="shrink-0 truncate font-mono text-[13.5px] font-medium text-ink">
          {name}
        </span>
        {missing ? (
          <MissingBadge />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted">
            {text}
          </span>
        )}
        {long && !missing && (
          <button
            className="shrink-0 cursor-pointer text-[11px] font-bold text-accent outline-none hover:underline"
            type="button"
            onClick={() => setExpanded(v => !v)}
          >
            {expanded ? 'Less' : 'More'}
          </button>
        )}
        {evidenceAnchorId && onSelectEvidence && (
          <button
            className="shrink-0 cursor-pointer rounded-full border border-accent/40 bg-accent-ghost px-2 py-0.5 text-[10.5px] font-bold text-accent outline-none hover:border-accent"
            type="button"
            aria-label={`View Evidence for ${name}`}
            onClick={() => onSelectEvidence(evidenceAnchorId)}
          >
            Evidence
          </button>
        )}
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
      </div>
      {expanded && !missing && (
        <div className="pb-2 pl-6 text-[13px] leading-relaxed text-ink wrap-anywhere whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  )
}

// ── ObjectSection ─────────────────────────────────────────────────────────────

function ObjectSection({
  name, value, path, onChange, depth, defaultExpanded = true, onNavigateTo, expandText, getEvidenceAnchorId, onSelectEvidence,
}: { name: string; value: Record<string, unknown>; path: ResultPath; onChange?: OnResultChange; depth: number; defaultExpanded?: boolean; onNavigateTo?: (path: string[]) => void; expandText?: boolean; getEvidenceAnchorId?: (path: ResultPath) => string | undefined; onSelectEvidence?: (anchorId: string) => void }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const entries = Object.entries(value)
  const preview = firstStringValue(value)

  return (
    <div>
      <div
        className="-mx-2 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent-ghost/30"
        onClick={() => onNavigateTo ? onNavigateTo(path) : setExpanded(v => !v)}
      >
        {onNavigateTo ? <span className="w-2 shrink-0" /> : <span className="shrink-0 text-ink-faint"><CollapseArrow expanded={expanded} /></span>}
        <span className="shrink-0 truncate font-mono text-[13.5px] font-medium text-ink">{name}</span>
        {onNavigateTo && <EnterChevron />}
        {expanded ? (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-accent px-2.5 py-0.5 font-sans text-[10px] font-semibold tracking-wide text-white">
            {entries.length} field{entries.length !== 1 ? 's' : ''}
          </span>
        ) : (
          preview
            ? <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted">{preview}</span>
            : <MissingBadge />
        )}
      </div>
      {expanded && (
        <div className="ml-3.5 mt-0.5 border-l border-line pl-3">
          {entries.length === 0 ? (
            <p className="py-1.5 text-[13px] text-ink-muted">No fields returned.</p>
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
                onSelectEvidence={onSelectEvidence}
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
  name, value, path, onChange, depth, defaultExpanded = true, onNavigateTo, expandText, getEvidenceAnchorId, onSelectEvidence,
}: { name: string; value: readonly unknown[]; path: ResultPath; onChange?: OnResultChange; depth: number; defaultExpanded?: boolean; onNavigateTo?: (path: string[]) => void; expandText?: boolean; getEvidenceAnchorId?: (path: ResultPath) => string | undefined; onSelectEvidence?: (anchorId: string) => void }) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div>
      <div
        className="-mx-2 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent-ghost/30"
        onClick={() => onNavigateTo ? onNavigateTo(path) : setExpanded(v => !v)}
      >
        {onNavigateTo ? <span className="w-2 shrink-0" /> : <span className="shrink-0 text-ink-faint"><CollapseArrow expanded={expanded} /></span>}
        <span className="min-w-0 truncate font-mono text-[13.5px] font-medium text-ink">{name}</span>
        {onNavigateTo && <EnterChevron />}
        <span className="shrink-0 whitespace-nowrap rounded-full bg-surface-muted px-2.5 py-0.5 font-sans text-[10.5px] font-semibold text-ink-muted">
          {value.length} item{value.length !== 1 ? 's' : ''}
        </span>
      </div>
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
                onSelectEvidence={onSelectEvidence}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

function ResultValue({ name, value, path = [], onChange, depth = 0, defaultExpanded, onNavigateTo, expandText, getEvidenceAnchorId, onSelectEvidence }: ResultValueProps) {
  if (Array.isArray(value)) {
    return <ArraySection name={name} value={value} path={path} onChange={onChange} depth={depth} defaultExpanded={defaultExpanded} onNavigateTo={onNavigateTo} expandText={expandText} getEvidenceAnchorId={getEvidenceAnchorId} onSelectEvidence={onSelectEvidence} />
  }
  if (isRecord(value)) {
    return <ObjectSection name={name} value={value} path={path} onChange={onChange} depth={depth} defaultExpanded={defaultExpanded} onNavigateTo={onNavigateTo} expandText={expandText} getEvidenceAnchorId={getEvidenceAnchorId} onSelectEvidence={onSelectEvidence} />
  }
  return <PrimitiveRow name={name} value={value} path={path} onChange={onChange} expandText={expandText} evidenceAnchorId={getEvidenceAnchorId?.(path)} onSelectEvidence={onSelectEvidence} />
}

export default ResultValue
