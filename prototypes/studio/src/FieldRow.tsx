import pluralize from 'pluralize'
import type { SchemaNode } from 'extraction/schema'
import type { Change, ReplayOutcome } from '../shared/schemaChanges'
import { Pill } from './ui'
import { PencilIcon } from './ui/ResultValue'
import { fieldTypeWords } from './fieldTypeWords'

export type FieldRowProps = {
  node: SchemaNode
  isGroup: boolean
  expanded: boolean
  onToggleExpanded?: () => void
  change?: Change
  outcome?: ReplayOutcome
  impliedRemoved?: boolean
  acceptance?: { accepted: boolean; onToggle: (id: string) => void }
  readOnly: boolean
  editDisabled: boolean
  dragging: boolean
  /** Any field is being dragged: the actions stay hidden, so they never cover the "into" cue. */
  dragActive?: boolean
  intoGroup: boolean
  onStartDrag: (event: React.MouseEvent) => void
  onEdit: () => void
  /** The values pill: the edit form, focused on its allowed values. */
  onEditValues?: () => void
  onAddNote: () => void
  onDelete: () => void
  /** The row as a drop target. On the row itself, not around it: the slot above and the children below are their own
   *  targets, and the pointer moving from them onto this row must re-enter it. */
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  nodeRef?: (element: HTMLDivElement | null) => void
}

// Colours stay off the shared base: two utilities of one property resolve by stylesheet order, not class order.
const ACTION = 'grid size-7 cursor-pointer place-items-center rounded-[3px] outline-none transition-colors disabled:cursor-default disabled:opacity-40'
const ACTION_PLAIN = `${ACTION} text-ink-muted hover:bg-surface-muted hover:text-accent`
const ACTION_DANGER = `${ACTION} text-danger hover:bg-danger-soft`
/** The type and values pills' buttons: at least 24px tall around the pill. A type longer than its line ellipsizes. */
const PILL_BUTTON = 'inline-flex min-h-6 min-w-0 max-w-full cursor-pointer items-center rounded-full outline-none disabled:cursor-default disabled:opacity-60'
const PILL_FIT = 'min-w-0 max-w-full'
/** The actions overlay the right end of the row's first line (three 28px targets 4px apart after a 4px lead: 96px).
 *  Shown, and only then hit by a pointer, on hover and focus within the row; at rest a tap there reaches the row, never
 *  an unseen action. While a pill has keyboard focus the overlay steps aside as well. */
const ACTIONS = 'pointer-events-none absolute right-0 top-px flex items-center gap-1 rounded-[3px] bg-surface pl-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-has-[[data-row-pill]:focus-visible]:pointer-events-none group-has-[[data-row-pill]:focus-visible]:opacity-0'
/** The pills' line keeps the overlay's 96px clear on the right at every width, so the pills wrap before the actions'
 *  zone and a pointer on any part of a pill reaches the pill. The name, not a control, may still run under the actions:
 *  its cap is the whole line, and its full text is its title. */
const CLEAR_OF_ACTIONS = 'pr-[96px]'
const NAME_UNDER_ACTIONS = 'max-w-[calc(100%_+_96px)]'
const NOTE_INDENT = 'pl-[46px]'

function ChangeBadge({ change, outcome }: { change: Change | undefined; outcome?: ReplayOutcome }) {
  if (outcome === 'rejected') return (
    <span className="shrink-0 rounded bg-canvas px-1.5 py-0.5 text-overline font-semibold text-ink-muted">
      Rejected
    </span>
  )
  if (outcome === 'unresolved') return (
    <span
      className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-overline font-semibold text-danger"
      title={change?.outcome === 'unresolved'
        ? change.reason
        : 'This accepted change depends on another review decision that is not currently accepted.'}
    >
      Unresolved
    </span>
  )
  if (!change?.reason) {
    if (outcome !== 'conflict') return null
    return (
      <span
        className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-overline font-semibold text-danger"
        title="This proposal conflicts with a schema invariant."
      >
        Conflict
      </span>
    )
  }
  return (
    <span
      className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-overline font-semibold text-danger"
      title={change.reason}
    >
      Conflict
    </span>
  )
}

function AcceptanceControl({ id, name, accepted, onChange }: {
  id: string
  name: string
  accepted: boolean
  onChange: (id: string) => void
}) {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-1 text-overline font-semibold text-ink-muted">
      <input
        type="checkbox"
        className="cursor-pointer accent-accent"
        aria-label={`Accept change to ${name}`}
        checked={accepted}
        onChange={() => onChange(id)}
      />
      Accept
    </label>
  )
}

/** Never shrunk for its pills, which wrap under it instead; only a name longer than the whole line ellipsizes. */
const NAME = 'font-mono text-content font-semibold shrink-0 truncate'

function FieldChangeLabel({ node, change, impliedRemoved, underActions }: {
  node: SchemaNode
  change?: Change
  impliedRemoved?: boolean
  /** The row has the actions overlay, whose zone its pills keep clear of; the name may extend into it. */
  underActions: boolean
}) {
  if (change?.kind === 'modified' && change.before && change.after) {
    const nameChanged = change.before.name !== change.after.name
    const beforeType = fieldTypeWords(change.before)
    const afterType = fieldTypeWords(change.after)
    return (
      <>
        {nameChanged ? (
          <>
            <span className="min-w-0 truncate font-mono text-content font-semibold text-danger line-through">{change.before.name}</span>
            <span className="shrink-0 text-overline text-ink-faint" aria-hidden="true">→</span>
            <span className="min-w-0 truncate font-mono text-content font-semibold text-green">{change.after.name}</span>
          </>
        ) : (
          <span className={`${NAME} max-w-full text-ink`} title={change.after.name}>{change.after.name}</span>
        )}
        {beforeType !== afterType && (
          <>
            <span className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-overline text-danger line-through">{beforeType}</span>
            <span className="shrink-0 rounded bg-green-soft px-1.5 py-0.5 text-overline text-green">{afterType}</span>
          </>
        )}
      </>
    )
  }

  const tone = change?.kind === 'added'
    ? 'text-green'
    : change?.kind === 'removed' || impliedRemoved
      ? 'text-danger line-through'
      : 'text-ink'
  return <span className={`${NAME} ${underActions ? NAME_UNDER_ACTIONS : 'max-w-full'} ${tone}`} title={node.name}>{node.name}</span>
}

function CollapseArrow({ expanded }: { expanded: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
      <polygon points="0,0 8,4 0,8" />
    </svg>
  )
}

function NotePlusIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h9l3 3v9H4z" /><path d="M7 10h6M7 13h4" /><path d="M14 2v4h4" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M8 2a1 1 0 00-1 1v1H4a1 1 0 000 2h12a1 1 0 100-2h-3V3a1 1 0 00-1-1H8zM5 7a1 1 0 011 1v8a2 2 0 002 2h4a2 2 0 002-2V8a1 1 0 112 0v8a4 4 0 01-4 4H8a4 4 0 01-4-4V8a1 1 0 011-1z" clipRule="evenodd" />
    </svg>
  )
}

/** One schema field's row (§6): grip, disclosure, then the name with its type and values pills (wrapping under the name
 *  when the line is too narrow) and proposal badges; the actions overlay the right edge on hover and focus-within. A
 *  note renders below in full. The panel owns recursion, drag targets and edit forms. */
export default function FieldRow({ node, isGroup, expanded, onToggleExpanded, change, outcome, impliedRemoved, acceptance, readOnly, editDisabled, dragging, dragActive = false, intoGroup, onStartDrag, onEdit, onEditValues, onAddNote, onDelete, onMouseEnter, onMouseLeave, nodeRef }: FieldRowProps) {
  const diffStatus = change?.kind ?? (impliedRemoved ? 'removed' : null)
  const isDiff = diffStatus !== null
  const diffBg = diffStatus === 'added' ? 'bg-green-soft' : diffStatus === 'removed' ? 'bg-danger-soft' : diffStatus === 'modified' ? 'bg-stale-soft' : ''
  const count = node.children?.length ?? 0
  const typeWords = `${fieldTypeWords(node)}${isGroup && !expanded ? ` · ${count} field${count === 1 ? '' : 's'}` : ''}`
  const valuesWords = node.allowedValues ? pluralize('value', node.allowedValues.length, true) : ''
  // Not keyed on a drag: the pills would reflow under the pointer mid-drag. Only the overlay itself hides then.
  const hasActions = !isDiff && !readOnly
  // The note line sits inside the listitem, so the row's name, hover and focus reveal cover it too. The listitem bleeds
  // 8px each side (`-mx-2 px-2`); the panel's list carries the same bleed, so the row never overflows it. The note starts
  // where the name does: the 14px grip (or its spacer), 4px, the 24px disclosure (or its spacer), 4px: `NOTE_INDENT`.
  return (
    <div
      role="listitem"
      aria-label={node.name}
      tabIndex={0}
      ref={nodeRef}
      className={`group -mx-2 rounded-[3px] border px-2 outline-none transition-[background,border,opacity] duration-150 ${
        intoGroup || dragging ? 'border-accent' : 'border-transparent'
      } ${intoGroup ? 'bg-accent-ghost' : ''} ${dragging ? 'opacity-40' : ''} ${diffBg}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        // Opening and closing a group is reading, not editing: Space works in read-only and proposal views too.
        if (event.key === ' ' && isGroup) { event.preventDefault(); onToggleExpanded?.(); return }
        if (readOnly || isDiff) return
        if (event.key === 'Enter') { event.preventDefault(); onEdit() }
        else if (event.key === 'Delete') { event.preventDefault(); onDelete() }
      }}
    >
      <div className="relative flex min-h-[30px] items-start gap-1">
        {!isDiff && !readOnly ? (
          <span aria-hidden="true" className="flex h-[30px] w-3.5 shrink-0 cursor-grab select-none items-center justify-center text-sm leading-none text-ink-faint opacity-60" onMouseDown={onStartDrag}>⠿</span>
        ) : <span className="w-3.5 shrink-0" />}
        {isGroup ? (
          <button type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`} aria-expanded={expanded}
            className="mt-[3px] grid size-6 shrink-0 cursor-pointer place-items-center text-ink-faint outline-none hover:text-accent" onClick={onToggleExpanded}>
            <CollapseArrow expanded={expanded} />
          </button>
        ) : <span className="w-6 shrink-0" />}
        <div data-row-content className={`flex min-h-[30px] min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5 py-[3px] ${hasActions ? CLEAR_OF_ACTIONS : ''}`}>
          <FieldChangeLabel node={node} change={change} impliedRemoved={impliedRemoved} underActions={hasActions} />
          {!isDiff && (
            <button type="button" data-row-pill className={PILL_BUTTON}
              title={`Type: ${typeWords} — click to edit`} disabled={editDisabled || readOnly} onClick={onEdit}>
              <Pill tone="neutral" size="compact" className={PILL_FIT}><span className="truncate">{typeWords}</span></Pill>
            </button>
          )}
          {node.allowedValues && (isDiff ? (
            // A proposal row still shows the closed set it carries; it is reviewed, not edited, here.
            <Pill outline size="compact" className="shrink-0" title={`Allowed values: ${node.allowedValues.join(', ')}`}>
              {valuesWords}
            </Pill>
          ) : (
            <button type="button" data-row-pill className={PILL_BUTTON}
              title={`Allowed values — click to edit: ${node.allowedValues.join(', ')}`} disabled={editDisabled || readOnly} onClick={onEditValues ?? onEdit}>
              <Pill outline size="compact">{valuesWords}</Pill>
            </button>
          ))}
          <ChangeBadge change={change} outcome={outcome} />
          {intoGroup && !isDiff && (
            <span className="shrink-0 whitespace-nowrap rounded-full bg-accent px-2.5 py-0.5 font-sans text-overline font-semibold tracking-wide text-white">into {node.name}</span>
          )}
        </div>
        {change && acceptance && (
          <span className="flex h-[30px] shrink-0 items-center">
            <AcceptanceControl id={change.id} name={change.after?.name ?? node.name} accepted={acceptance.accepted} onChange={acceptance.onToggle} />
          </span>
        )}
        {hasActions && !dragActive && (
          <span data-row-actions className={ACTIONS}>
            <button type="button" className={ACTION_PLAIN} title={`Edit ${node.name}`} aria-label={`Edit ${node.name}`} disabled={editDisabled} onClick={onEdit}><PencilIcon /></button>
            <button type="button" className={ACTION_PLAIN} title="Add note" aria-label={`Add note to ${node.name}`} disabled={editDisabled} onClick={onAddNote}><NotePlusIcon /></button>
            <button type="button" className={ACTION_DANGER} title={`Delete ${node.name}`} aria-label={`Delete ${node.name}`} disabled={editDisabled} onClick={onDelete}><TrashIcon /></button>
          </span>
        )}
      </div>
      {node.description && !isDiff && (readOnly ? (
        <p className={`pb-1 ${NOTE_INDENT} text-secondary leading-snug text-ink-muted whitespace-pre-line`}>{node.description}</p>
      ) : (
        <button type="button" onClick={onAddNote} disabled={editDisabled}
          className={`inline-flex min-h-6 w-full cursor-text items-center pb-1 ${NOTE_INDENT} text-left text-secondary leading-snug text-ink-muted whitespace-pre-line outline-none hover:text-ink disabled:cursor-default disabled:hover:text-ink-muted`}>
          {node.description}
        </button>
      ))}
    </div>
  )
}
