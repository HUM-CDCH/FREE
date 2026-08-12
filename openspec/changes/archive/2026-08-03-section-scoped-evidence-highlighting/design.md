## Context

Catalog extraction splits canonical Markdown into heading-derived sections and calls the model once per section. The backend then merges those responses into one result array. The current evidence shape preserves model-generated `value`, `snippet`, and `page`, but discards the exact Markdown range used for that model call. Highlighting therefore performs a second, document-wide inference from a non-unique snippet and a page number the model was asked to infer.

The parsing service already publishes canonical Markdown, per-block anchors, and table-cell coordinates. The change connects those deterministic parsing artifacts to the deterministic extraction section boundary instead of using global occurrence order as the identity between records and source content.

## Goals / Non-Goals

**Goals:**

- Bind every Catalog evidence leaf to the exact canonical Markdown section supplied to its extraction call.
- Prevent anchor and table matching from selecting locations outside that scope.
- Resolve independent record scopes concurrently while retaining deterministic draw, focus, and scroll order.
- Keep Article extraction supported through an explicit full-document scope.

**Non-Goals:**

- Make the LLM return parser anchor IDs or word-level coordinates.
- Restore document-wide PDF text-layer fallback matching.
- Change schema/result values, section-boundary detection, or the table extraction pipeline.
- Guarantee a highlight when an evidence snippet is absent, altered, ambiguous within its own scope, or unsupported by parser geometry.

## Decisions

### 1. Attach backend-generated `source_scope` to evidence, never to result or the model prompt

`runSectionedExtraction` already owns the authoritative `MarkdownSection` with `startOffset`, end offset, and access to the full canonical Markdown. It SHALL attach `{ markdown_start, markdown_end, start_page, end_page }` to every evidence leaf returned for that section after model output has been parsed. The model neither invents nor edits this metadata.

Article extraction SHALL attach one scope spanning the full canonical Markdown to every evidence leaf. Evidence leaves without provenance remain valid result evidence but are not eligible for scoped geometry highlighting.

Alternative considered: store section metadata once beside each `records[]` item. Rejected because nested schema arrays and individual evidence leaves need a uniform frontend contract, and a leaf-level scope avoids result/evidence path-specific inheritance rules.

### 2. Scope on canonical Markdown offsets; use page range only as a secondary table filter

The Markdown offset range is the authoritative boundary because a section can span pages and different sections can occupy one page. Anchor lookup SHALL search snippet occurrences only between `markdown_start` and `markdown_end`, then accept only overlapping anchors fully associated with that scope. Table lookup SHALL limit candidates to the inclusive page range and retain existing row/column resolution.

Alternative considered: page ranges alone. Rejected because they cannot distinguish two record sections sharing a page.

### 3. Resolve by scope concurrently, draw deterministically afterward

The highlight layer SHALL group leaves by identical source scope. Each group resolves its anchors/table cells independently with a bounded concurrency limit and shared page-viewport promise cache. The renderer SHALL wait for resolved entries, sort them by original result traversal order, refresh the position cache, and then draw. This avoids canvas races while preserving parallel latency benefits.

Alternative considered: concurrent tasks that draw as each finishes. Rejected because completion order would make opacity, focus, cache ordering, and screenshots nondeterministic.

### 4. Treat scope mismatch as unverified evidence

If no matching anchor or table cell exists inside the evidence scope, the system SHALL not draw a highlight. It must not widen to another section or use result traversal order to select a global occurrence. The Results value remains available to the researcher.

## Risks / Trade-offs

- **[Risk]** A model snippet may not occur verbatim inside its true section. → **Mitigation:** omit the highlight and keep the result/evidence visible for review; do not substitute a global guess.
- **[Risk]** Tables can span pages or lack a direct Markdown offset. → **Mitigation:** use the scope page range plus existing table header hints; return unverified when this remains ambiguous.
- **[Risk]** Adding metadata to every evidence leaf increases response size. → **Mitigation:** scopes are four small integers and repeated values can be normalized in a later optimization only after correctness is established.
- **[Risk]** Parallel PDF page access can duplicate work. → **Mitigation:** cache viewport promises by page number and bound group concurrency.

## Migration Plan

1. Deploy backend/frontend support together; frontend treats missing `source_scope` as unverified rather than attempting global matching.
2. New extraction responses gain scopes automatically. Existing in-memory results must be re-run to be highlightable.
3. Roll back by removing scoped resolution; result data remains backward compatible because provenance is evidence-only metadata.

## Open Questions

- Whether the Results UI should show a subtle per-field "location unavailable" indicator is deferred; the current scope only governs drawing behavior.
