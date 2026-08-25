import type { PendingSchemaProposal } from './useSchemaProposalReview'


export function ProposalReviewBar({
  proposal,
  canApply,
  onApply,
  onDiscard,
}: {
  proposal: PendingSchemaProposal
  canApply: boolean
  onApply: () => void
  onDiscard: () => void
}) {
  return (
    <div className="shrink-0 border-t border-line px-3.5 py-2.5">
      <div
        className="mb-2 text-[10px] leading-relaxed text-ink-muted"
        data-testid="schema-proposal-summary"
      >
        {proposal.changes.map((change) =>
          change.note ? <p key={`note-${change.id}`}>{change.note}</p> : null,
        )}
        {proposal.changes.map((change) =>
          change.outcome === 'unresolved' && change.reason ? (
            <p key={`reason-${change.id}`}>{change.reason}</p>
          ) : null,
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          className="cursor-pointer rounded-md border border-accent bg-accent px-3.5 py-1.5 font-sans text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108 disabled:cursor-default disabled:opacity-40"
          type="button"
          onClick={onApply}
          disabled={!canApply}
        >
          Apply changes
        </button>
        <button
          className="cursor-pointer rounded-md border border-line-strong bg-surface px-3 py-1.5 font-sans text-[11.5px] font-semibold text-ink-muted outline-none hover:text-accent"
          type="button"
          onClick={onDiscard}
        >
          Discard
        </button>
      </div>
    </div>
  )
}
