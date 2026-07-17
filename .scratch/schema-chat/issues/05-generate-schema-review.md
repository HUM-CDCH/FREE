# 05 — Review Generate Schema before applying it

Status: resolved
Type: task
Blocked by: 03, 04

## What to build

Turn buffered Generate Schema output into a root-replacement Schema
Suggestion carrying `{ documentEpoch, baseRevision }`. Preview it in the
suggestion card without replacing the approved schema, which stays visible
while generation is pending. Apply and Reject route through the shared
freshness-aware App transition (compare epoch + revision, apply and validate,
commit and increment together, invalidate Extraction Results). A generation
that raced a manual edit fails the ordinary freshness check — no special
merge or warning flow. Generation state and pending-suggestion state stay
separate from approved schema state.

## Acceptance criteria

- [x] Generated schema previews as a suggestion; approved schema unchanged until Apply
- [x] Apply commits atomically via the shared handler; Reject discards without side effects
- [x] Stale suggestions (epoch or revision mismatch) are refused with a visible stale state
- [x] Approved schema remains visible during pending generation
- [x] Demoable: generate → preview → apply/reject on a real parsed Source Document
- [x] Focused tests added; test, lint, and build green

## Blocked by

- 03-rename-and-remove-schema-fields
- 04-extraction-results-revision-alignment

## Answer

Generate Schema now captures document epoch and schema revision before model work,
then buffers its root replacement as a Schema Suggestion whose ID is created by
the server endpoint. The approved Extraction Schema remains visible during
generation and while the suggestion card previews the proposed JSON. Apply routes
through the same freshness-aware App transition as manual Schema Changes,
atomically commits the validated schema, increments the revision, and invalidates
Extraction Results. Reject only clears the pending suggestion. Suggestions made
stale by a manual edit or document change are shown as stale and cannot be
applied. Focused Studio tests cover pending generation, review preview,
approved-schema visibility, server-owned identity, Apply/Reject transitions,
Extraction Result invalidation, and stale refusal. Studio test, lint, and build
pass.
