# 05 — Review Generate Schema before applying it

Status: ready-for-agent
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

- [ ] Generated schema previews as a suggestion; approved schema unchanged until Apply
- [ ] Apply commits atomically via the shared handler; Reject discards without side effects
- [ ] Stale suggestions (epoch or revision mismatch) are refused with a visible stale state
- [ ] Approved schema remains visible during pending generation
- [ ] Demoable: generate → preview → apply/reject on a real parsed Source Document
- [ ] Focused tests added; test, lint, and build green

## Blocked by

- 03-rename-and-remove-schema-fields
- 04-extraction-results-revision-alignment
