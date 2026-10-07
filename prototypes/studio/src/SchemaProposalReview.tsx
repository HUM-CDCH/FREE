import { Button } from './ui'
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
        className="mb-2 text-compact leading-relaxed text-ink-muted"
        data-testid="schema-proposal-summary"
      >
        {proposal.changes.map((change) =>
          change.outcome === 'unresolved' && change.reason ? (
            <p key={`reason-${change.id}`}>{change.reason}</p>
          ) : null,
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="positive" onClick={onApply} disabled={!canApply}>
          Apply changes
        </Button>
        <Button variant="danger" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  )
}
