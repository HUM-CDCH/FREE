# Adversarial Review Issues

Recorded before inspecting the new end-to-end test.

## Confirmed issues to check against the E2E test

1. **Rotated Camelot geometry (blocker)**
   - `prototypes/parsing_service/app/parsing/table_extraction.py:287-293`
   - `prototypes/parsing_service/app/parsing/orchestrator.py:705-709`
   - Camelot coordinates are not transformed fully into displayed post-rotation page space. A generated 90°/270° PDF produced negative table bounding-box coordinates.
   - Expected coverage: rotated source documents; assertions that table and cell boxes are ordered and remain within displayed page dimensions.

2. **Fabricated merged-cell spans (high)**
   - `prototypes/parsing_service/app/parsing/table_extraction.py:200-218,328-360`
   - Empty neighboring values are treated as proof of row/column merging and can create overlapping spans.
   - Expected coverage: missing-value cells remain `rowspan=1`, `colspan=1` unless parser metadata proves a merge; no two emitted cells cover the same grid coordinate.

3. **Polluted and duplicate table candidates (high)**
   - `prototypes/parsing_service/app/parsing/table_extraction.py:430-446`
   - On the repository sample, extracted tables include surrounding narrative prose; overlapping page-5 candidates duplicate rows.
   - Expected coverage: exact or bounded expected tables/content, exclusion of known prose rows, and no materially overlapping/duplicate candidates. A loop over returned tables is insufficient because it passes for zero results.

4. **Header-row misclassification (medium)**
   - `prototypes/parsing_service/app/parsing/table_extraction.py:221-230,334-344`
   - A first data row such as `K1 | Rome | Temple` can be classified as a second header row; generated Markdown then places its separator after two rows.
   - Expected coverage: identifier/text table with one true header and an all-text first data row; role and Markdown assertions.

5. **Malformed OCR evidence geometry (medium)**
   - `prototypes/parsing_service/app/parsing/ocr_fallback.py:91-114`
   - Reversed/non-finite boxes and NaN confidence are accepted; malformed boxes may be discarded without warning. NaN can make Starlette JSON serialization fail.
   - Expected coverage: reject or warn for malformed, non-finite, and non-monotonic boxes; endpoint JSON remains standards-compliant.

6. **OpenCV namespace collision (medium dependency risk, not a reproduced runtime failure)**
   - `prototypes/parsing_service/pyproject.toml` and `uv.lock`
   - `opencv-python`, `opencv-python-headless`, and `opencv-contrib-python` claim the same `cv2` files; the current environment resolves the actual files to headless OpenCV 5. PaddleOCR import succeeds, but real OCR inference compatibility was not established.
   - Expected coverage: clean-environment dependency/profile smoke checks, ideally actual OCR inference for supported CPU/GPU profiles. This may belong outside an HTTP E2E test.

7. **Pyright diagnostics (low)**
   - Nine static errors were reported in `table_extraction.py` and `test_table_extraction.py` around tuple narrowing and collection invariance.
   - Expected coverage: static diagnostics/type-check command, not runtime E2E.

## Optional hardening, not an immediate confirmed correctness failure

1. **Camelot runtime/output budgets and global-lock duration**
   - Camelot has no dedicated timeout or table/cell/output caps and runs under the canonical store lock.
   - Existing 50 MB source, 100-page, and render budgets mean the pipeline is not literally unbounded.
   - Expected coverage: separate timeout/resource tests or operational benchmarks rather than ordinary E2E correctness assertions.

2. **Typed OCR block contract**
   - `ParsedPage.blocks` remains `list[dict[str, Any]]`.
   - A typed model would improve validation but should be considered deliberately against the versioned schema contract.

## Coverage of the added golden E2E test

`prototypes/parsing_service/tests/test_golden_e2e.py` successfully exercises the real HTTP lifecycle, Docling conversion, Camelot extraction, canonical persistence, parsed-document endpoint, and Markdown endpoint for the repository sample. It passed locally in 28.352 seconds.

It does **not** currently catch the confirmed issues as correctness failures:

- The sample has only rotation `0`, so rotated geometry is untested.
- The checked-in golden file records the existing fabricated spans, including overlapping cell coverage; it therefore treats the bug as expected output.
- The golden records all six polluted Camelot candidates, including overlapping page-5 candidates and duplicated rows.
- The golden records multiple rows as headers and the resulting malformed Markdown table header layout.
- The source has native text and does not invoke PaddleOCR. Moreover, `normalize()` excludes page `quality` and `blocks`, so OCR geometry would not be compared even with an OCR fixture.
- The test runs only the already-installed environment. It does not validate clean OCR profiles or shared `cv2` ownership.
- Runtime E2E does not run static diagnostics.
- There is no timeout or performance assertion.

The golden file is a snapshot of current behavior, not an independent oracle. Regeneration with `UPDATE_GOLDEN=1` can bless incorrect output. Semantic invariants and manually curated expected table content are needed before it can guard these issues.

## Additional research finding

The already-required Docling conversion exposes `document.tables` directly. On the same sample it produced 14 structured tables with clean row matrices, explicit header flags, real row/column spans, per-cell top-left bounding boxes, and table provenance. This includes small tables that Camelot's `min_rows=4` filter misses. The current Camelot port came from `FREE-technical/core/table_extraction.py`, which contains the same unsupported empty-cell merge and header heuristics and has no table-focused tests. That reference is ancestry, not a correctness oracle.

## Decisions taken

Recorded on 2026-07-10.

1. **Canonical table coverage means all detected source tables.**
   - Do not preserve `FREE-technical`'s `min_rows=4` exclusion.
   - One-row and two-row tables are valid canonical tables and must not be discarded solely because of their size.
   - A successful table parser must not silently return only the larger tables from a source document.

2. **Rotated-page Camelot geometry is initially suppressed.**
   - For any page whose effective rotation is not `0`, preserve extracted table content but emit no Camelot table or cell bounding boxes.
   - Record a stable warning explaining that rotated table geometry was intentionally withheld.
   - Do not publish coordinates merely because they happen to fall inside page bounds.
   - Full 90°, 180°, and 270° transforms are a later enhancement and require independent fixtures for every orientation before activation.

3. **The E2E test becomes a semantic oracle.**
   - Keep real upload, task processing, canonical persistence, parsed-document retrieval, and Markdown retrieval.
   - Replace generated current-output approval with compact, manually reviewed expected facts and invariant assertions.
   - Golden regeneration must not be able to erase invariant failures.

4. **Retain the `FREE-technical` Camelot-stream direction, but do not inherit its defects as required behavior.**
   - The reference implementation informs parser choice and general long-form shape.
   - Unsupported merge/header heuristics and whole-region filtering must be replaced or constrained by evidence-backed logic.

## Future implementation details

### A. Establish failing tests before production changes

1. Replace the full generated golden with a compact semantic fixture containing manually reviewed:
   - expected table count;
   - page assignment and stable table identity;
   - normalized row matrices, including one-row and two-row tables;
   - the single true header row where present;
   - parser provenance;
   - rounded geometry only for unrotated pages.
2. Add E2E invariants that are always evaluated independently of the golden payload:
   - every emitted bbox is finite, monotonic, and within its displayed page;
   - no two emitted cells claim the same logical grid coordinate through overlapping spans;
   - no duplicate normalized table content exists on the same page;
   - materially overlapping same-page candidates are rejected or reconciled;
   - known narrative prose surrounding the sample tables is absent;
   - Markdown has one valid delimiter immediately after its header row;
   - expected tables cannot silently collapse to an empty list.
3. Add focused fixtures/tests for:
   - real Camelot extraction at 0°, 90°, 180°, and 270°;
   - missing values that must remain ordinary empty cells rather than become spans;
   - an all-text identifier table whose first data row must not become a header;
   - multiple tables embedded in one Camelot region;
   - tables split across pages;
   - one-row and two-row tables;
   - wrapped/continuation cell text;
   - malformed, reversed, and non-finite OCR geometry through JSON serialization.

### B. Meet the all-tables contract

The default Camelot scan is not sufficient by itself: on the researched sample it returned 11 broad regions and the current filter kept 6, while Docling identified 14 actual tables, including small tables for which Camelot returned no clean standalone candidate.

Implementation must therefore use an explicit table inventory/recall strategy rather than simply lowering `min_rows`:

1. Use Docling's already-produced table inventory and provenance as the recommended recall source.
2. For each inventoried table area, attempt Camelot stream extraction constrained to that page/area when doing so improves the structured result.
3. Segment any broad Camelot region into logical table runs; never publish the full region merely because one sub-run looks matrix-like.
4. If Camelot cannot produce a usable candidate for an inventoried table, convert the Docling table cells as the completeness fallback rather than dropping the table.
5. Record the actual `source_parser` per table (`camelot_stream` or Docling fallback) and make page arbitration reflect what was emitted.
6. Assign deterministic table IDs from physical page plus page-local reading order after reconciliation, not from incidental raw-candidate enumeration.

This hybrid inventory/enrichment detail is necessary to reconcile the chosen Camelot-stream direction with the separate decision that canonical coverage includes all tables.

### C. Replace unsupported table heuristics

1. Segment regions using credible table starts:
   - explicit dense header rows;
   - or sustained identifier/data-row runs for headerless continuations.
2. Stop a segment at narrative prose, section boundaries, or a new table start.
3. Split multiple logical tables found inside one raw Camelot region.
4. Reconstruct wrapped continuation text into the preceding logical cell while unioning only evidence-backed geometry.
5. Deduplicate reconciled candidates using normalized cell-content fingerprints plus same-page geometric overlap.
6. Default every cell to `rowspan=1` and `colspan=1`.
7. Emit larger spans only when parser boundary/span metadata proves them; empty neighboring strings are not proof.
8. Default to one header row. Multi-row headers require explicit structural evidence.

### D. Apply the rotated-page fail-safe

1. Pass page rotation alongside displayed dimensions into table conversion.
2. When rotation is non-zero:
   - set table bbox to `None`;
   - set all cell bboxes to `None`;
   - preserve text, rows, columns, roles, and proven spans;
   - add one deduplicated warning such as `rotated_table_geometry_suppressed`.
3. Add assertions that no rotated Camelot bbox leaks into the canonical document.
4. Defer full transforms until generated and real fixtures demonstrate correct displayed-space coordinates for 90°, 180°, and 270°.

### E. Harden OCR evidence separately

1. Reject boxes that do not contain exactly four finite numeric coordinates.
2. Reject non-monotonic boxes where `x0 > x1` or `y0 > y1`.
3. Reject non-finite confidence values before averaging.
4. Add the existing geometry-unavailable warning whenever any line is rejected.
5. Constrain canonical OCR confidence to finite `[0, 1]` and verify Starlette endpoint serialization.
6. Consider a typed OCR block model only as a deliberate schema-contract follow-up.

### F. Resolve dependency and static-validation risks

1. Investigate a stream-only Camelot installation strategy that does not install a third competing OpenCV provider.
2. If one shared OpenCV distribution cannot satisfy Docling, Camelot, and PaddleOCR safely, isolate Camelot in a subprocess environment.
3. Validate a clean `ocr-cpu` environment with actual inference, not import alone.
4. Validate `ocr-gpu` on a CUDA host when available.
5. Fix all Pyright diagnostics in the changed production and test files.

### G. Completion checks

- Focused table and OCR tests pass.
- Compact semantic E2E passes without golden regeneration.
- Full backend suite passes with `uv run --no-sync python -m unittest discover -s tests`.
- LSP/Pyright reports no errors in changed files.
- Clean CPU OCR profile completes a real smoke inference.
- Rotated fixtures contain table content and no Camelot geometry.
- The sample exposes all manually reviewed tables without narrative contamination or duplicate candidates.
