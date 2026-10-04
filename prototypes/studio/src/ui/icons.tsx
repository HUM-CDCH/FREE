import type { ReactNode } from 'react'
import type { ReviewDecision, ReviewDecisionInput } from '../../shared/extraction.contract'

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

// Explicit streaming states suppress unverified previews. Undefined keeps settled ungrounded previews;
// the partial view always supplies an explicit state, including for missing metadata (Ruling 8).
export function StatusDot({ decision, touched, label, tone }: { decision: ReviewDecision | ReviewDecisionInput | undefined; touched: boolean; label: string; tone: 'success' | 'stale' | 'danger' }) {
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


/** A 16px stroke glyph in the current colour (the rail's glyphs, results review redesign §1). */
function Glyph({ children, className = '', strokeWidth = 1.6 }: { children: ReactNode; className?: string; strokeWidth?: number }) {
  return (
    <svg aria-hidden="true" className={`size-4 shrink-0 ${className}`} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
  )
}

export const ToCheckGlyph = ({ className = 'text-ink-faint' }: { className?: string }) => <Glyph className={className}><circle cx="8" cy="8" r="5" /></Glyph>
export const ApprovedGlyph = ({ className = 'text-green' }: { className?: string }) => <Glyph className={className} strokeWidth={2}><path d="M3 8.5l3.2 3L13 4.5" /></Glyph>
export const EditedGlyph = ({ className = 'text-ink' }: { className?: string }) => <Glyph className={className}><path d="M10.5 3.5l2 2L6 12H4v-2z" /></Glyph>
export const RejectedGlyph = ({ className = 'text-danger' }: { className?: string }) => <Glyph className={className} strokeWidth={2}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Glyph>
export const NotReviewableGlyph = () => <Glyph className="text-ink-faint"><circle cx="8" cy="8" r="5" strokeDasharray="2 2" /></Glyph>
export const MissingGlyph = () => <Glyph className="text-ink-faint" strokeWidth={2}><path d="M4.5 8h7" /></Glyph>
export const ContestedGlyph = () => <Glyph className="text-ink-faint"><path d="M3.5 6h9M3.5 10h9M10 3.5l-4 9" /></Glyph>
/** Spins only where motion is allowed; still, it keeps its text equivalent beside it. */
export const SpinnerGlyph = ({ className = 'text-ink' }: { className?: string }) => <Glyph className={`motion-safe:animate-spin ${className}`} strokeWidth={2}><path d="M8 2a6 6 0 016 6" /></Glyph>
export const EvidenceGlyph = ({ className = 'text-ev' }: { className?: string }) => <Glyph className={`size-3 ${className}`}><path d="M4 2.5h5l3 3v8H4z" /></Glyph>
export const DoubtGlyph = () => <Glyph className="text-ev"><path d="M2.5 13h11" /><path d="M2.5 9.5h3M7 9.5h3M11.5 9.5h2" /></Glyph>
export const InfoGlyph = () => <Glyph><circle cx="8" cy="8" r="6" /><path d="M8 7.2v4M8 5v.01" /></Glyph>
export const MoreGlyph = () => <svg aria-hidden="true" className="size-4" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
export const OneByOneGlyph = () => <Glyph><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><path d="M7 6.5l2.5 1.5L7 9.5z" fill="currentColor" /></Glyph>
export const ListGlyph = () => <Glyph strokeWidth={1.5}><path d="M3 4h10M3 8h10M3 12h10" /></Glyph>
export const UndoGlyph = () => <Glyph><path d="M5.5 4L3 6.5 5.5 9M3 6.5h6.5a3.5 3.5 0 010 7H7" /></Glyph>
export const CloseGlyph = () => <Glyph strokeWidth={1.8}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Glyph>
export const DisclosureGlyph = ({ open }: { open: boolean }) => <Glyph className={`transition-transform motion-reduce:transition-none ${open ? '' : '-rotate-90'}`}><path d="M4.5 6.5l3.5 3.5 3.5-3.5" /></Glyph>
