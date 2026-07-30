## 1. Backend: thread page dimensions into Markdown conversion

- [ ] 1.1 In `orchestrator.py`, build a page-dimensions lookup (`dict[int, tuple[float, float]]`, width/height in points) from `inspection.pages`, following the existing `page_heights_pt` pattern already used for `_run_table_extraction`
- [ ] 1.2 Thread this lookup as a new parameter through `run_docling_ingestion` → `_convert_doctags` (`docling_runner.py`) → `convert_doctags_to_markdown`/`doctags_to_markdown` (`doctags_to_markdown.py`)
- [ ] 1.3 Confirm no existing caller of these functions breaks (the new parameter should have a safe default or all call sites updated together)

## 2. Backend: preserve and resolve location tokens in `doctags_to_markdown.py`

- [ ] 2.1 Add a location-token scanner that finds `<loc_a><loc_b><loc_c><loc_d>` quadruples in the raw doctags string (in document order) and replaces each with a unique private-use-area sentinel, recording the four raw normalized integers per sentinel index — applied only at the whole-document entry point (`convert_doctags_to_markdown`), not at the two table-cell/header-footer `strip_doctag_locations` call sites, which keep discarding tokens unchanged
- [ ] 2.2 Add a final resolution pass, run after all existing rendering passes and after page-span computation: scan the fully-composed Markdown for anchor sentinels in order, resolve each to `{markdown_start, markdown_end, page, bbox}` (page via existing page-span logic, bbox via the page-dimensions lookup from task 1), remove the sentinel from the visible output, and adjust subsequent offsets by the sentinel's length (mirroring `compose_page_markdown`'s existing cumulative-cursor technique)
- [ ] 2.3 Extend `DocTagsMarkdownResult`/`convert_doctags_to_markdown`'s return shape with the resolved `anchors` list
- [ ] 2.4 Verify against `test_docling_integration.py`'s real-Docling-output integration test that `<loc_...>` tokens appear where expected relative to each tag, before relying on that placement in new hand-written unit tests (see design.md's noted risk)
- [ ] 2.5 Unit tests in `test_doctags_to_markdown.py`: a block with location tokens produces a correctly-resolved anchor; table-cell location tokens are still discarded (no anchor produced for them); the 26 existing test cases are unaffected (none contain location tokens, so their output must remain byte-for-byte identical)

## 3. Backend: wire anchors into `ParsedDocument`

- [ ] 3.1 In `orchestrator.py`, populate `ParsedDocument.evidence_index.anchors` from the conversion step's resolved anchors
- [ ] 3.2 Tighten `EvidenceIndex.anchors`'s type in `app/models/parsed_document.py` from `list[dict[str, Any]]` to a proper `Anchor` model (`markdown_start`, `markdown_end`, `page`, `bbox`), removing the now-stale "no anchor producer exists yet" comment
- [ ] 3.3 Tests in `test_canonical_ingestion.py` (and/or `test_docling_integration.py`): a real (or realistically hand-built) parse populates `evidence_index.anchors` with plausible entries; a document with no location tokens still produces a valid `ParsedDocument` with an empty anchors list

## 4. Frontend: parse and thread anchors

- [ ] 4.1 Add `EvidenceAnchor` type (`markdownStart`, `markdownEnd`, `page`, `bbox`) and a tolerant parser to `parsedDocument.ts`, mirroring the existing `ParsedTable`/`parseParsedTables` pattern
- [ ] 4.2 Extend whatever `api.ts` function currently fetches tables (`fetchParsedTables` or its containing document fetch) to also return anchors from the same `/tasks/{id}/document` response — no new endpoint needed
- [ ] 4.3 Thread anchors through `App.tsx` into `EvidenceHighlightLayer`, alongside the existing `documentTables`/`documentMarkdown`

## 5. Frontend: anchor-based lookup tier

- [ ] 5.1 New `markdownAnchorMatch.ts`: given the canonical Markdown, the anchors list, and a field's `snippet`, find the snippet's character range via `indexOf` in the Markdown and return the anchor(s) overlapping that range (union bboxes if the snippet spans more than one anchor)
- [ ] 5.2 Wire this as a new tier in `EvidenceHighlightLayer`'s render loop, after the existing table-cell-coordinate lookup and before the existing PDF text search — reuse the existing `bboxToRect`/`getPageViewportScale` machinery already built for table cells to convert the anchor's PDF-point bbox to viewport pixels
- [ ] 5.3 Confirm the fallback order: no anchors for the document → PDF text search (unchanged path); anchors present but snippet not found in Markdown → PDF text search; anchor found → draw directly, skip PDF text search for that field
- [ ] 5.4 Unit tests (new `markdownAnchorMatch.test.ts` and/or extended `EvidenceHighlightLayer.test.ts`): snippet resolves via a covering anchor; snippet spanning two adjacent anchors unions their bboxes; snippet not present in Markdown returns no match (caller falls back); empty anchors list returns no match

## 6. Frontend: fallback-path hardening (retained from original scope)

- [ ] 6.1 Add a length-preserving `normalizeForMatch` helper in `EvidenceHighlightLayer.tsx` (lowercase + dash-variant → plain hyphen substitution) and use it in place of the bare `.toLowerCase()` calls in `rectsForQuery`/`searchValueAnchoredBySnippet`, preserving existing character-position bookkeeping
- [ ] 6.2 Add a `rectsForItems` helper and use it so `searchValueAnchoredBySnippet` falls back to the snippet's own matched rects when the value can't be pinpointed within the snippet's sub-range or elsewhere on the page, instead of returning nothing
- [ ] 6.3 In `tableCellMatch.ts`, add a tolerant fallback tier to `collectCandidates` (dash/whitespace/punctuation normalization, then a `min(a,b).length >= 4`-gated substring containment check), attempted only when the exact tier finds zero candidates for a table
- [ ] 6.4 Unit tests: dash-variant equivalence in text search; snippet-found-but-value-not-pinpointable falls back correctly; table tolerant match on a formatting/unit difference; short numeric value does not spuriously match inside a longer number; exact-match behavior unchanged in both modules when it already works

## 7. Verification

- [ ] 7.1 Run the full `prototypes/parsing_service` test suite and the full `prototypes/studio` test suite, confirm no regressions
- [ ] 7.2 Manually verify against the Ellekilde example (via a live parsing task, not the bundled demo document, since anchors require one): a prose-text field's highlight now resolves via an anchor at the correct location; a table field with a row/column header hint now resolves via the existing table-cell path or the new tolerant fallback; the bundled demo document (no anchors) still highlights via the existing PDF text-search fallback
