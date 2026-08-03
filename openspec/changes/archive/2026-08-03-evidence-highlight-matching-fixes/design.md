## Context

`EvidenceHighlightLayer.tsx` currently locates evidence in two ways: `findTableCellRects` (exact coordinates, for table-sourced evidence, via `ParsedTable.cells[].bbox` already computed by Camelot/Docling enrichment in `table_extraction.py`) and `findValueRects` (PDF text search via pdf.js, for everything else). The text-search path is the one with recall problems: it re-extracts the PDF's text layer independently of the parsing service's own extraction, and compares it against the model's `value`/`snippet` strings with no tolerance for normalization differences (typed-field values that aren't verbatim, dash-variant characters, etc.).

The parsing service already has a data-model slot for a better answer: `ParsedDocument.evidence_index: EvidenceIndex | None`, whose `anchors: list[dict[str, Any]]` field carries the comment *"no anchor producer exists yet"* (`app/models/parsed_document.py:234-238`). Reading `docling_core`'s DocTags serializer (installed in `parsing_service/.venv`) confirms every rendered element already gets a `<loc_x0><loc_y0><loc_x1><loc_y1>` location tag from `DocumentToken.get_location`/`get_location_token`, each token a normalized `round(500 * coord/page_dim)` integer, `0 ≤ val < 500`. `doctags_to_markdown.py`'s `strip_doctag_locations`/`_LOC_RE` (line 17, 49–50) is the only code in the entire parsing service that touches these tokens, and it only ever deletes them (grep confirms zero reverse-parsers exist anywhere in `app/`).

Page dimensions needed to convert normalized location tokens back to PDF points already exist in the pipeline: `orchestrator.build_parsed_document` computes `inspection = inspect_pdf(...)` (`PdfInspection.pages`, each a `PdfPageInspection` with `.page`/`.width_pt`/`.height_pt`) *before* calling Docling ingestion, and there is direct precedent for turning this into a `dict[int, float]` keyed by page number and threading it into a sibling converter: `_run_table_extraction` already receives `page_heights_pt = {page.page: page.height_pt for page in inspection.pages}`. Threading the same shape into the Markdown conversion call is a linear, three-function-signature plumbing change (`run_docling_ingestion` → `_convert_doctags` → `convert_doctags_to_markdown`), not a large one.

## Goals / Non-Goals

**Goals:**
- Preserve the per-block bounding boxes Docling already computes, instead of discarding them, and expose them through the existing (currently unused) `evidence_index.anchors` slot.
- Give `EvidenceHighlightLayer` a way to locate text evidence by looking up a snippet's position in the *same* canonical Markdown string the anchors were derived from, eliminating the PDF-text-re-extraction mismatch at its root for anything an anchor covers.
- Keep the existing PDF text-search path working, hardened with the matching-tolerance fixes from this change's original scope, as the fallback for documents/tasks without anchors (the bundled demo document, and any already-parsed task predating this change).
- Keep table evidence on its existing, already-precise cell-bbox path — anchors are for prose/text evidence, not a replacement for `tableCellMatch.ts`.

**Non-Goals:**
- Word-level anchor granularity. Anchors are per rendered-block (paragraph, heading, list item, etc.) — the same granularity Docling's own location tags already provide. Highlighting will be block-sized, not tightened to the exact words of a snippet within a block; that would require an additional in-block text-position step, deferred as a possible follow-up.
- Changing how table cell bounding boxes are computed or matched — `tableCellMatch.ts`'s exact-match tier is untouched; only its zero-candidate fallback gains tolerance (see the fallback-hardening decision below).
- Reconciling the `evidence-highlight-layer` spec's pre-existing drift (stale `focusValue`/double-draw description, missing table-cell-coordinate-matching content from the unarchived `table-evidence-coordinates` change) — out of scope, called out in the proposal.
- A schema/migration story for already-parsed tasks — old tasks simply have no anchors and fall back to text search, exactly as today; nothing needs to be re-parsed for this change to be safe to ship.

## Decisions

### 1. Location tokens are preserved via sentinels, not by restructuring the multi-pass regex pipeline

`doctags_to_markdown.py` renders Markdown as a chain of independent, whole-string regex substitutions (`_SECTION_HDR.sub(...)`, `_TEXT_BLOCK.sub(...)`, OTSL table rendering, list rendering, etc. — confirmed by reading the file; 26 existing hand-written test cases in `test_doctags_to_markdown.py` exercise this pipeline with no `<loc_...>` tokens in any of them today). Each pass changes the string's length, so any character offset computed against an earlier pass's output is invalid against the final string — recomputing offsets pass-by-pass would mean touching every renderer function and is a large, risky rewrite of a well-tested module.

Instead: before any other substitution runs, scan the raw doctags string for `<loc_a><loc_b><loc_c><loc_d>` quadruples (in document order) and replace each with a unique private-use-area sentinel (`ANCHOR{n}`), recording the quadruple's four raw normalized integers in a side list indexed by `n`. This follows the exact pattern the module already uses for `_PAGE_SENTINEL` and `_TABLE_RESTART` — a sentinel is inert with respect to every other regex in the file (none of them match ``/``), so it rides through every existing rendering pass completely unchanged, arriving in the *final* composed Markdown string at whatever position its surrounding text ended up at.

A final pass, run once at the very end (after `compose_page_markdown` has already assigned page numbers via its own, similarly sentinel-based, offset tracking), scans the finished Markdown left-to-right for `ANCHOR{n}` sentinels: each sentinel marks the start of the anchor's span (spanning to the next sentinel or end-of-string), its page comes from the existing page-span logic, its bbox comes from converting stored raw quadruple `n`'s normalized 0–500 values using that page's width/height, and the sentinel is then removed from the visible Markdown — with subsequent recorded offsets adjusted by the sentinel's own length, the same cumulative-cursor technique `compose_page_markdown` already uses when composing pages.

Net effect: none of the 26 existing tests change behavior (no sentinel is ever inserted when no `<loc_...>` tokens are present in their hand-written input), and the well-tested rendering passes themselves are untouched — only their input/output gains inert sentinel characters that a final pass resolves.

**Alternative considered**: restructure the converter into a single incremental parse-and-render pass that tracks output position directly, avoiding sentinels entirely. Rejected — a much larger rewrite of a stable, well-tested module, for a benefit (avoiding a sentinel round-trip) that doesn't matter given the sentinel approach already has working precedent in this exact file.

### 2. Anchors are scoped to whole-document prose, not table-internal content

Table cells already get precise bboxes from a separate, purpose-built pipeline (Camelot enrichment in `table_extraction.py`). The sentinelizing step above only replaces the *outermost* document-level `strip_doctag_locations` call (the one in `convert_doctags_to_markdown`'s main entry point); the two other existing call sites (inside OTSL cell-content and page-header/footer stripping) keep discarding location tokens exactly as they do today. This avoids any interaction between the new anchor system and the already-working table bbox pipeline.

### 3. Frontend anchor lookup keys on `snippet` only, never `value`

Because `snippet` is verbatim by construction (the model is instructed to make it so) while `value` may be a normalized/typed form (a reformatted number or date, for instance), `markdownAnchorMatch.ts` finds a field's position purely by locating `snippet` in the canonical Markdown and reading off the anchor(s) covering that character range — it never needs to search for `value` at all. This sidesteps the entire "value isn't a verbatim substring" problem class that motivates half of this change's original small-fix scope, for any field an anchor covers.

**Alternative considered**: keep searching for `value` first, only falling back to `snippet`+anchors. Rejected — `snippet`-based lookup is strictly more reliable here (it's what the anchors are actually keyed to) and simpler to reason about; there's no scenario where searching for `value` first would find something `snippet`-based lookup wouldn't also find via the anchor's already-known bbox.

### 4. Fallback-path hardening is retained, not discarded, from the original scope

Anchors won't exist for the bundled demo document (no live parsing task — `App.tsx` special-cases it to a static cached Markdown with `tables: []`, and by the same reasoning no anchors) or for any task parsed before this change ships. For those cases, `findValueRects`'s PDF text search remains the only path, so the original scope's two fixes still apply there: a length-preserving `normalizeForMatch` (dash-variant unification alongside the existing case-insensitive compare) and a snippet-location fallback (highlight the snippet's own matched PDF-text-layer position when the exact value can't be pinpointed within or near it). `tableCellMatch.ts`'s candidate matching similarly keeps its planned tolerant-substring fallback, gated on the exact tier finding nothing first, using a `min(a, b).length >= 4` containment guard (borrowed from this project's own prior, never-merged table-matching attempt in `_table_evidence.ts`'s `textsMatch`, rather than a hand-rolled word-boundary regex — simpler, and precedented in this codebase's own history).

## Risks / Trade-offs

- **[Risk]** The sentinel round-trip could interact badly with an existing sentinel-sensitive pass (e.g. the OTSL table-merge-across-page-breaks logic, which already relies on sentinels arriving at specific positions) → **Mitigation**: anchors are only sentinelized at the outermost document-level call site (Decision 2), not inside table-cell content, so they never appear inside an OTSL table's own sentinel-sensitive region.
- **[Risk]** Threading page dimensions through three function signatures (`run_docling_ingestion` → `_convert_doctags` → `convert_doctags_to_markdown`) touches code paths shared with table extraction → **Mitigation**: purely additive parameters with an established shape (`dict[int, float]`-style, matching `page_heights_pt`'s existing precedent); no existing parameter is removed or changed.
- **[Trade-off]** Block-level (not word-level) anchor granularity (Non-Goal above) means a highlight can be as large as a paragraph when only one phrase within it is the actual evidence — an improvement in *recall* (something is highlighted, and it's in the geometrically correct place) without necessarily improving highlight *tightness* for long blocks. Accepted for this change; word-level tightening is a follow-up, not a blocker.
- **[Risk]** Real Docling output's actual `<loc_...>` placement relative to each tag (immediately inside the opening tag vs. elsewhere) needs confirming against `test_docling_integration.py`'s real-PDF integration test, not just the hand-written unit tests (which have no location tokens to check against) → **Mitigation**: task list includes verifying the sentinel/quadruple regex against real Docling output from that integration test before relying on it in the hand-written unit tests.

## Migration Plan

No migration. `evidence_index.anchors` is an existing field that has always been an empty list; populating it is purely additive and every consumer (there are none yet outside this change) must already tolerate `[]`. Frontend anchor lookup degrades to the existing text-search path whenever anchors are absent, so nothing breaks for documents parsed before this change ships.

## Open Questions

- Whether word-level anchor tightening (Non-Goal above) is worth a follow-up change once block-level anchors are in production and their practical highlight-size impact can be observed — deferred, not blocking this change.
