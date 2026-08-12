## 1. Highlight Instruction Construction

- [x] 1.1 Extend frontend Highlight construction to traverse result, Evidence,
  and schema leaves together; retain non-empty primitive result leaves with
  usable scoped Evidence.
- [x] 1.2 Add an explicit `result-primary` / `snippet-primary` match strategy:
  use result-primary only for non-empty `verbatim-string` results, and
  snippet-primary for all other primitive result types.
- [x] 1.3 Add unit coverage for verbatim strings, numbers, booleans, nested
  values, and missing or malformed Evidence/source scopes.

## 2. Scoped Source Resolution

- [x] 2.1 Update prose anchor matching to search result-primary terms inside
  source scope first, then use a unique scoped Evidence snippet as conditional
  fallback without any global or PDF text-layer search.
- [x] 2.2 Keep snippet-primary prose matching scoped to Evidence source scope,
  and verify inconclusive primary and fallback candidates produce no highlight.
- [x] 2.3 Persist canonical Markdown spans for reconciled tables in the parsing
  service and build segment-owned table candidates from those spans.
- [x] 2.4 Thread match strategy and segment geometry through
  `EvidenceHighlightLayer`; scoped table resolution must ignore model page
  hints while retaining result value and row/column header matching.
- [x] 2.5 Add matcher coverage for unique verbatim results, duplicate results,
  normalized non-verbatim values, same-page segments, and ambiguous table
  source placement.

## 3. Canvas Paint De-duplication

- [x] 3.1 Add a traversal-order-preserving coalescing helper for resolved
  entries with equal page, rectangle geometry, and color.
- [x] 3.2 Apply the helper to both initial canvas painting and focus redraw
  while retaining every logical result-path entry for scroll and focus.
- [x] 3.3 Add tests proving coincident same-color rectangles are painted once
  without changing result-path focus behavior.
- [x] 3.4 Render scoped prose matches crossing PDF pages as per-page fragments,
  while preserving result-path focus and deterministic draw order.

## 4. Verification

- [x] 4.1 Run focused Studio API/frontend tests and `pnpm build`; run
  `pnpm lint` and record any unrelated existing failures.
- [ ] 4.2 Manually verify the bundled document through a live or cached parsing
  task: populated results highlight their own source, scoped duplicates do not
  cross records, and repeated geometry retains normal transparency.
