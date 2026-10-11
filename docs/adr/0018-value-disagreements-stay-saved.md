# 0018: Disagreeing readings stay saved as a Value Disagreement

Date: 2026-10-10; narrowed 2026-10-11. Status: proposed; amends
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

This decision deliberately narrows its first draft, which kept a decision
shown and flagged "New reading – review needed" after a later reading, gave
each alternative an identity and its reading origins, and merged carried and
new readings on adoption. Review found that machinery larger than the fix
needs and the source of its bugs.

## Decision

- **A disagreement is saved content, not absence.** A value whose readings
  differ at one place stays saved, with every distinct typed reading kept as
  an alternative beside it and the segments it was read in. The place itself
  holds null; agreed siblings keep their values. A null reading never
  retracts. A reading not of its field's type is dropped, with an issue,
  before readings are compared, so a valid reading beside it is the value.
- **FREE picks no winner.** No first, last or majority reading, no model
  arbitration, no grounding-based choice: support in a bibliography passage
  is not attribution to the article. Alternatives are shown as not checked.
- **The researcher decides, and a decision binds to what it reviewed.**
  Approving a Value Disagreement means choosing one alternative per place,
  saved as that choice with the value it makes; an edit or a rejection also
  decides it. A decision binds to the model value and, for a Value
  Disagreement, each place's set of alternative values, never where they
  were read: the same readings found in more places keep it, while a changed
  set moves it to history, as any decision that no longer fits its value,
  and the value is to be checked again before its snapshot can be finalized.
  An edit still applies while it fits its field, as for any value.
- **Adoption carries it unchanged.** A carried disagreement stays as it is
  until the value is reprocessed; any other new reading is a historical
  proposal, as for any value.
- **Every publication carries it.** The disagreement lives in the retained
  value itself, not in snapshot diagnostics, so live, grounding-batch, final,
  completion-only and replayed publications keep it; the database validates
  it.
- **Exports stay honest.** A draft export marks an undecided value as such and
  lists its alternatives; it never fills the cell with one nobody chose.

## Consequences

- The retained value gains an optional `disagreement`; values without one keep
  their digests and export bytes.
- Finalized Review requires decisions that fit the current readings. Older
  finalized pairs stay valid.
- Grounding counts disagreeing places as unverified claims, so a run with one
  never reports grounding complete.
- Document-level fields, cited authors accumulating in lists, reviewable
  cross-generation proposals and backfilling affected Extractions are separate
  work.
- Rejected: keeping the first reading with a warning (it reaches review and
  export as the answer), a candidate ledger table (unneeded for one field's
  readings), a diagnostics-only record (dropped by the completion
  publication and not reviewable), and choosing by an edit (it freezes the
  whole field, a growing list included, and can become model guidance).
