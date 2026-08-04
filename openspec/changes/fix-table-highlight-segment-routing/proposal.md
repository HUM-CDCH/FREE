## Why

Table-cell highlights still only work reliably for the first catalog segment.
We will fix this by trying five focused steps in order, verifying after each one.

## What Changes

1. Add diagnostics/tests for the full route:
   `source_scope.segment_id` -> segment geometry -> owned tables -> matched cell
   bbox -> drawn highlight rect.
2. Fix backend table-to-Markdown linking for repeated table views on the same
   page, using table/page reading order instead of dropping repeated views.
3. Change frontend table ownership from strict full containment to best-overlap,
   so small section/table offset drift does not make a later segment lose its
   table.
4. Add a fallback for tables with missing canonical offsets: use the evidence
   segment's page range and table reading order as scoped candidates.
5. Check `EvidenceHighlightLayer` consumption last: each segment should resolve
   from its own geometry, and later segment matches must not be collapsed or
   ignored after the first segment works.

## Capabilities

### New Capabilities

- `table-segment-routing`: route parsed table geometry to the correct evidence
  segment, with scoped fallbacks when canonical offsets are incomplete.

### Modified Capabilities

- `evidence-highlight-layer`: table-cell highlights must work for later
  sectioned extraction segments, not only the first segment.
- `table-cell-coordinate-matching`: table candidate selection must remain scoped
  to the evidence segment while accepting routed fallback candidates.
- `source-document-ingestion`: parsed tables should be linked to canonical
  Markdown deterministically even when table Markdown views repeat on a page.

## Impact

- Backend: `table_markdown_links.py`.
- Frontend: `segmentGeometry.ts`, `tableCellMatch.ts`,
  `EvidenceHighlightLayer.tsx`.
- Tests should prove each of the five steps independently.
