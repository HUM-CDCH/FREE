## 1. Evidence Provenance Contract

- [x] 1.1 Add a typed `source_scope` shape to Studio evidence handling, including canonical Markdown offsets and inclusive page bounds.
- [x] 1.2 Extend evidence splitting/normalization so `source_scope` survives in evidence only and cannot appear in `result`.
- [x] 1.3 Add unit coverage proving nested evidence leaves preserve their matching scopes without changing result values.

## 2. Sectioned Extraction Metadata

- [x] 2.1 In `runSectionedExtraction`, derive each section's end offset and page bounds from canonical Markdown and attach the scope to every valid Evidence leaf after parsing model output.
- [x] 2.2 Attach an explicit full-document scope to valid Article-mode Evidence leaves.
- [x] 2.3 Verify parallel section completion and empty-section filtering retain result/evidence/scope alignment by record index.

## 3. Scoped Highlight Resolution

- [x] 3.1 Thread `source_scope` from evidence leaves into frontend `Highlight` values.
- [x] 3.2 Update Markdown anchor lookup to search only within the scope offset range and reject anchors outside the scope.
- [x] 3.3 Update table-cell matching inputs to restrict candidates to the scope page range while retaining row/column header matching.
- [x] 3.4 Remove global occurrence-order selection from scoped prose resolution; unresolved scoped evidence must produce no highlight.

## 4. Concurrent Rendering Pipeline

- [x] 4.1 Group highlights by identical source scope and resolve independent groups with a bounded concurrency limit.
- [x] 4.2 Add a per-render PDF viewport promise cache keyed by page number.
- [x] 4.3 Collect resolved entries before painting, then cache and draw them in original result traversal order.
- [x] 4.4 Preserve focus-path scrolling and dimming behavior for concurrently resolved entries.

## 5. Verification

- [x] 5.1 Add frontend tests for identical snippets in separate scopes, two scopes sharing one page, missing in-scope evidence, and deterministic draw order after out-of-order resolution.
- [x] 5.2 Add API tests for Catalog and Article evidence scopes, including section page-offset handling and filtered empty sections.
- [x] 5.3 Run targeted Studio API/frontend tests, `pnpm build`, and `pnpm lint`; record unrelated pre-existing lint failures separately if they remain. (`pnpm lint` remains blocked by eight pre-existing errors in App, EvidenceHighlightLayer ref assignments, ResultsTab, SchemaPanel, and schemaOps.)
- [ ] 5.4 Manually verify the bundled document through a live parsing task: correct record-to-source highlights, no cross-record highlight, and no fallback PDF text-layer search.
