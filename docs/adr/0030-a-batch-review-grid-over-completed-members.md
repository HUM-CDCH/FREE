# 0030: A batch review grid over completed members

Date: 2026-11-10. Status: accepted.

## Context

A Batch Extraction's members are reviewed one document at a time in the document workspace. Durable-only admission
([0017](0017-durable-extraction-control-and-call-checkpoints.md#durable-only-amendment)) removed the earlier batch
review grid together with the non-durable review path it read, and the product contract then said there was no
batch-wide review grid. Researchers checking a pilot or a small batch want to compare the same field across documents,
which one document at a time does not show.

## Decision

- **A grid view of one Batch Extraction** (`/projects/:id/extractions/:batch/review`, *Review in grid* on its document
  list): one row per record of each member, one column per top-level field of the pinned Template Revision, a
  document field shown once across its records. It reads each member's latest durable results through the same reader
  as the document review; no new endpoint.
- **Completed members only.** A member joins once it is completed with saved values; a running, paused, failed or
  stopped one stays a row that opens its document, since its values can still change.
- **Each decision saves at once** as a revisioned correction of one value, with the same body as the document review
  and bound to the value's latest revision, so a concurrent decision is refused as a conflict. There is no grid draft.
  Setting a decided value back to To check saves a `PENDING` correction.
- **Bulk Approve** (a row's, a column's, or *Approve remaining*) approves only values still To check with one reading,
  across every loaded member; edits, rejections and Value Disagreements stay as they are. Each click is a researcher's
  decision on the values it names.
- **Finalizing stays per member.** Each document's *Save review* finalizes that member's shown result snapshot and
  Decision Version, refused until every saved value there is decided.
- A Value Disagreement can be edited or rejected in the grid; choosing a reading opens its document.

## Consequences

- The grid reads one member's values per request, at most four at once; a large batch loads row by row.
- Bulk Approve can decide many values in one click; the decisions are ordinary corrections, each undoable in the grid
  or the document.
- Schema-issue flags and the pilot "ready to approve" signal of the earlier grid are not part of this one.
