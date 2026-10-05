# 0016: Review Decisions may be drafted on a running Extraction

Date: 2026-10-04. Status: superseded on 2026-10-05 by the durable-only
amendment of [ADR 0017](0017-durable-extraction-control-and-call-checkpoints.md):
the path/anchor Review Draft, its settlement reconciliation and the settled
attempt's review authority were deleted with the non-durable execution path.
Previously accepted; supersedes in part the Constraints of
[the view-ordered streaming design](../superpowers/specs/2026-10-02-view-ordered-streaming-extraction-design.md)
("review, finalize and export read the settled attempt only") and its client
plan's "the partial view offers no review controls". Spec:
[2026-10-04-results-review-redesign-design.md](../superpowers/specs/2026-10-04-results-review-redesign-design.md)
(§5).

## Context

An Extraction streams its records as kei reads them (streaming design, Part A
implemented), but a Review Draft could only be saved once the attempt settled:
`saveStoredReviewDraft` requires `reviewable`, which the artifact reader sets at
settlement, and the partial view was specified without review controls. A
catalogue of fifty records keeps the researcher waiting for the last record
before the first can be decided on, although a finished entry is write-once
and its values and Evidence links no longer change.

The researcher decided on 2026-10-04: "Extraction can take a really long time,
so user should be able to review the partial values extracted on the go."

## Decision

- **A record kei has finished is reviewable at once.** Its grounded values (a
  link exists) take Review Decisions while the run goes on. Values still being
  read or checked, and candidates, never do: a candidate is never shown as a
  value and never decided on.
- **Decisions during a run are a Review Draft, keyed by result path and
  Evidence Anchor.** Studio prepares them from the partial view's links and the
  pinned document, in the same shape as the settled attempt's prepared
  decisions. The server accepts a draft on an Extraction that has not settled
  (`outcome IS NULL`) and validates it against the pinned document and the
  pinned Schema Revision only, never against kei's progress files, which are a
  best-effort view.
- **The settled attempt stays the record of truth for saving and export.** The
  review cannot be finalized until the attempt settles. At settlement a draft
  decision is kept only when the settled result has an Evidence link at the
  same result path with the same anchor; the rest are reported as dropped on
  read and their values return to "to check", marked "changed after you
  reviewed it". Finalization validates against the settled Evidence exactly as
  before.
- **Saving is a researcher's act.** The review finalizes on the decision that
  leaves nothing to check, on "Approve the rest", or on "Save review"; never on
  settlement, a reload or a reconnect.
- **No workflow step changes.** The settlement write is untouched; the draft
  version continues across settlement; reconciliation happens on read.

## Consequences

- Reviewing overlaps extraction: a long run no longer serialises the
  researcher's work behind kei's.
- A draft can hold decisions the settled result will not keep (an entry refused
  at the end, a link that changed). They are visible as dropped once, then
  replaced by the next draft save; the researcher is told how many.
- The server validates a running draft without knowing which entries kei has
  finished, so it may store a decision kei never produced; reconciliation drops
  it and finalization cannot admit it. Nothing unverified reaches a Feedback
  Set.
- The partial view and the settled view are one list in Studio; the client plan
  for Part B is replaced where it built a separate one.
- Article results are reviewable only from their grounding phase, when links
  exist; nothing changes for them earlier.

## Durable interactive Extraction amendment (2026-10-04)

[ADR 0017](0017-durable-extraction-control-and-call-checkpoints.md) explicitly
extends this decision for admission-disabled durable interactive Extractions.
The pre-production candidate adds no historical extraction compatibility layer.
Durable interactive execution keeps one
visible Extraction across linked attempts, preserves immutable producing input
selections and exact captured calls, and reviews saved typed values independently
of execution completion or grounding. Compatible ungrounded corrections may be
Project guidance with optional own-source Evidence. Fixed retained snapshots
support partial/failed/stopped exports and explicit finalization; an approval or
rejection cannot silently transfer to changed model output. The review redesign
is reused where compatible; path/anchor reconciliation is not applied
to durable correction history. Neither existing DBOS application versions nor
existing workflow step sequences change. Release admissions remain disabled.

## Durable-only supersession (2026-10-05)

The pre-production durable-only follow-up deleted the non-durable `runExtraction`
execution, the Review Draft routes and store, settlement reconciliation and
finalization of a settled attempt. Reviewing saved values while work continues
remains a product decision, now provided only by durable corrections of stable
saved values (ADR 0017). The decisions above describe removed code.
