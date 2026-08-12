## Why

Evidence snippets are useful provenance, but using them as the universal
highlight search term can leave a correct extracted result without a
highlight when the snippet is incomplete or normalized differently. At the
same time, matching result values across a whole PDF risks selecting duplicate
text from another record. The highlighter needs an explicit division of
responsibility between the displayed result and evidence metadata.

## What Changes

- Make an eligible verbatim string result the primary prose match term, while
  retaining the Evidence `source_scope` as the mandatory boundary for matching.
- Use the Evidence snippet as a conditional fallback or context check for
  verbatim-string matching; an unresolved scoped value must not widen into a
  document-wide search.
- Keep Evidence snippets as the primary locator for result types whose visible
  value may be normalized, summarized, formatted, or otherwise non-verbatim,
  including numbers, dates, and booleans.
- Resolve table highlights from the result value together with Evidence
  `row_header`, `column_header`, and `source_scope`, with the snippet available
  only as supporting context.
- Build deterministic segment-owned geometry from parsing-stage canonical
  spans, so prose anchors and table candidates cannot cross another segment
  that shares a page; model-provided page values are metadata, not selectors.
- Render one result across multiple PDF pages when its scoped prose match
  covers anchors on more than one page.
- Preserve Evidence as non-displayed provenance metadata and retain its
  existing location fields (`source_scope`, `page`, table headers, and
  `snippet`) for tracing and fallback decisions.

## Capabilities

### New Capabilities
- `result-first-evidence-matching`: defines how result value type and Evidence
  metadata determine the primary match term, fallback behavior, and table
  disambiguation.

### Modified Capabilities
- `evidence-highlight-layer`: resolve evidence highlights using the
  result-first strategy while retaining scoped, non-global matching guarantees.

## Impact

- Studio result/evidence normalization and highlight construction in
  `prototypes/studio/src/evidenceHighlights.ts`.
- Prose and table matchers plus paint de-duplication in
  `prototypes/studio/src/markdownAnchorMatch.ts`,
  `prototypes/studio/src/tableCellMatch.ts`, and
  `prototypes/studio/src/EvidenceHighlightLayer.tsx`.
- Extraction contracts and focused frontend tests for verbatim values,
  normalized values, table cells, duplicate text, and overlapping highlight
  rectangles.
