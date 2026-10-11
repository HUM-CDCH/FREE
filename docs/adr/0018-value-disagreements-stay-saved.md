# 0018: Disagreeing readings stay saved as a Value Disagreement

Date: 2026-10-10. Status: proposed; amends
[0017](0017-durable-extraction-control-and-call-checkpoints.md) (Article
aggregation's explicit scalar proposals, review binding).

## Context

A bounded Article reads its one document root in several value contexts.
When contexts read different scalars at one place (the article's title in
one, a cited paper's title from the bibliography in another), the assembled
root held null there, the conflict was dropped before publication, and the
null was saved as an absent value. The field then read "No value was
extracted", review skipped it and export left it blank, although every
reading stayed in call history. 0017 promised explicit scalar proposals for
Article aggregation; within one run there were none.

## Decision

- **A disagreement is saved content, not absence.** A value whose readings
  differ at one place stays saved, with every distinct typed reading kept as
  an alternative beside it and where it was read. The place itself holds
  null; agreed siblings keep their values. A null reading never retracts.
- **FREE picks no winner.** No first, last or majority reading, no model
  arbitration, no grounding-based choice: support in a bibliography passage
  is not attribution to the article. Alternatives are shown as not checked.
- **The researcher decides, and a decision says what it saw.** Approving a
  Value Disagreement means choosing one alternative per place; an edit or a
  rejection also decides it. A decision still applies while its value fits,
  but finalizing a snapshot needs decisions saved against that snapshot's
  current alternatives. A later alternative in the same input selection leaves
  the decision shown and flagged, and blocks finalizing only the newer cut;
  after adoption adds one, a choice or rejection binds to the reviewed model
  version as 0017 requires and is made again.
- **Every publication carries it.** The disagreement lives in the retained
  value itself, not in snapshot diagnostics, so live, grounding-batch, final,
  completion-only and replayed publications keep it, and adoption keeps it
  unless the researcher reprocesses the value or its field changes meaning;
  the database validates it.
- **Exports stay honest.** A draft export marks an undecided value as such and
  lists its alternatives; it never fills the cell with one nobody chose.

## Consequences

- The retained value gains an optional `disagreement`; values without one keep
  their identity, digests and export bytes.
- Alternative identities depend only on the saved value they belong to, the
  place, its field meaning and the read value, so order of work, replay, resume
  and adoption never change them. Adoption keeps a carried disagreement open;
  explicit reprocessing still replaces it.
- Finalized Review requires decisions that cover current alternatives. Older
  finalized pairs stay valid.
- Grounding counts disagreeing places as unverified claims, so a run with one
  never reports grounding complete.
- Document-level fields, cited authors accumulating in lists, and reviewable
  cross-generation proposals are separate work.
- Rejected: keeping the first reading with a warning (it reaches review and
  export as the answer), a candidate ledger table (unneeded for one field's
  readings), and a diagnostics-only record (dropped by the completion
  publication and not reviewable).
