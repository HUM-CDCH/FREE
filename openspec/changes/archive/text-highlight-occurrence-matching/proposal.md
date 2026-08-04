## Why

Researchers report that an evidence highlight sometimes jumps to an unrelated location on the page or document instead of the value's actual source — a different failure mode from the two already tracked in `evidence-highlight-matching-fixes` (which are about highlights disappearing entirely when a value can't be matched at all). `EvidenceHighlightLayer.tsx`'s plain-text search (`rectsForQuery`, `searchValueAnchoredBySnippet`, `findValueRects`) locates a value or snippet with `String.prototype.indexOf`, which always returns the *first* occurrence of the query text in the searched text — with no check for whether that's the *correct* occurrence when the same (or a similar, truncated) string legitimately appears more than once in the document. When a value repeats (a common number, a recurring date, a short word sequence), or when the value-search fallback progressively shortens its query (first 5 words, then first 3), the first `indexOf` hit is frequently the wrong one, and it is drawn with full confidence — no highlight is more misleading to a researcher validating Extraction Results than a confident one pointing at the wrong evidence.

`EvidenceHighlightLayer.tsx` already computes exactly the information needed to resolve this: `computeOccurrenceIndices` (in `tableCellMatch.ts`) ranks each highlight by which occurrence it is among other highlights sharing the same field key, normalized value, and hint page. This is already used by the table-cell-coordinate path (`findTableCellRects` / `findTableCellMatch`) to disambiguate among multiple matching table cells. It is computed once per render pass (`EvidenceHighlightLayer.tsx`'s main effect) but is never passed to the plain-text search path (`findValueRects`) — the exact mechanism that already prevents this failure mode for tables simply isn't wired up for prose text.

## What Changes

- `EvidenceHighlightLayer.tsx`: pass the already-computed `occurrenceIndex` into `findValueRects` (currently only passed to `findTableCellRects`).
- `EvidenceHighlightLayer.tsx`: `rectsForQuery` and `searchValueAnchoredBySnippet` collect every matching occurrence of a query on a page (not just the first, as today), and select among them by `occurrenceIndex` when more than one is found, falling back to the first occurrence when the index is absent or out of range — mirroring `findTableCellMatch`'s existing hint-page-then-occurrence-index tiering.
- `findValueRects`'s progressive query-shortening fallback (first 5 words, then first 3) is scoped to the hint page first (already searched first) and only widens to the rest of the document if the hint page has no match at any tier, reducing (not eliminating) the chance a short, generic fragment coincidentally matches on an unrelated page before the correct page is ever tried at a more specific tier.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `evidence-highlight-layer`: plain-text value/snippet matching gains occurrence-index disambiguation when a query matches more than once, instead of unconditionally taking the first match. (Note: like the in-flight `evidence-highlight-matching-fixes` change, this proposal is written against the actual current code, not the pre-existing spec drift around `focusValue`/double-draw — see that change's design.md for the same caveat, not repeated here.)

## Impact

- Frontend: `prototypes/studio/src/EvidenceHighlightLayer.tsx` and its test file. `tableCellMatch.ts`'s `computeOccurrenceIndices` is reused as-is (no changes there) — it's already generic over any highlight-like value with `path`/`value`/`hintPage`.
- No backend, schema, or API changes — this is purely about how already-available evidence data (value, snippet, hint page) gets matched to on-page locations when more than one candidate location exists.
- Builds on, and is independent of, `evidence-highlight-matching-fixes` (dash-variant tolerance and snippet-location fallback for values that don't match *at all*) — that change's design.md explicitly scoped out "repeated-value ambiguity in plain prose text" as a non-goal; this proposal is that follow-up.
