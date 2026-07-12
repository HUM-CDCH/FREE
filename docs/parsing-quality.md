# Parsing quality policy

This document records the correctness decisions that govern canonical tables,
OCR evidence, geometry, and end-to-end evaluation. It replaces the temporary
adversarial review notes produced while the parsing service was implemented.

See [`parsing-service.md`](parsing-service.md) for the full ingestion flow.

## Canonical table policy

### Coverage

Canonical table coverage means every table detected in the source document.
One-row and two-row tables are valid; table size alone is not a reason to drop
them.

Docling's table inventory is the recall source because the required conversion
already exposes structured cells, explicit header roles, parser-proven spans,
cell geometry, and table provenance. Camelot stream extraction is an enrichment
and fallback mechanism, not the inventory oracle:

1. Convert all valid Docling inventory entries into canonical tables.
2. For suitable unrotated inventory areas, run Camelot stream extraction
   constrained to that page and area.
3. Use a Camelot candidate only when it safely matches and improves the
   inventory entry.
4. Keep the Docling structure when Camelot has no usable match.
5. If no Docling inventory is available, segment and reconcile Camelot's broad
   regions before publishing them.
6. Assign deterministic IDs from physical page and page-local reading order.
7. Record the actual `source_parser` for every emitted table.

A successful parser must not silently return only large tables or publish an
entire prose-contaminated region because part of it resembles a table.

### Cells, spans, and headers

- Every cell defaults to `rowspan=1` and `colspan=1`.
- A larger span requires parser metadata. An empty adjacent value is not evidence
  of a merge.
- Proven spans are accepted only when they remain inside the matrix, do not cover
  another non-empty cell, and do not overlap another accepted span.
- The default inferred structure has at most one header row. Multi-row headers
  require explicit parser structure rather than an all-text first data row.
- Broad Camelot regions are segmented into logical runs. Narrative prose and
  section boundaries terminate a candidate.
- Reconciled candidates are deduplicated by normalized content and same-page
  geometry before IDs are assigned.

### Rotated pages

Camelot coordinates are bottom-left-origin and cannot be published directly in
displayed post-rotation page space. Until transforms are independently verified
for every orientation, the safe behavior for non-zero page rotation is:

- preserve table text, shape, roles, and proven spans;
- set Camelot table and cell bounding boxes to `null`;
- emit one stable `rotated_table_geometry_suppressed` warning per affected page;
- never publish coordinates merely because they happen to fit inside page
  bounds.

Full displayed-space transforms for 90°, 180°, and 270° are a later enhancement
and require focused fixtures before activation.

## OCR evidence policy

OCR line evidence is accepted only when:

- text, confidence, and box arrays have matching lengths;
- the box contains exactly four finite, non-negative numeric coordinates;
- `x0 <= x1` and `y0 <= y1`;
- confidence is finite, then constrained to `[0, 1]`.

Invalid lines are omitted and add the stable
`ocr_line_geometry_unavailable` warning. Canonical confidence must always be
standards-compliant JSON; `NaN` and infinities must never reach an endpoint.

OCR fallback is page-local. Its text and evidence must remain associated with
the same physical page when merged into the Docling-derived document.

## End-to-end evaluation policy

The golden end-to-end test is a semantic oracle, not a snapshot of whatever the
current implementation emits. It exercises upload, task processing, real
Docling conversion, table extraction, canonical persistence, document retrieval,
and Markdown retrieval.

The checked-in oracle contains compact, manually reviewed facts:

- source hash and schema version;
- expected physical page count;
- expected table count and page assignment;
- stable table identity and parser provenance;
- normalized dimensions, first-column values, and header rows.

Invariant assertions run independently of the oracle payload:

- canonical tables cannot silently disappear;
- every published table and cell box is finite, monotonic, and inside displayed
  page dimensions;
- no two cells claim the same logical grid coordinate through overlapping spans;
- duplicate normalized table content with overlapping same-page geometry cannot
  be published twice; repeated content in distinct physical regions remains valid;
- known surrounding narrative prose cannot appear as table rows;
- generated Markdown contains one valid delimiter immediately after the header
  row.

Changing or regenerating the oracle must not disable these invariants. Expected
facts should change only after manual comparison with the source document.

## Focused regression coverage

Focused tests should continue to cover:

- 0°, 90°, 180°, and 270° pages, with content retained and Camelot geometry
  suppressed for rotated pages;
- ordinary missing values that remain unmerged cells;
- parser-proven merged cells and rejection of overlapping spans;
- an identifier/text table with one true header and an all-text first data row;
- multiple logical tables embedded in one broad region;
- tables split across pages;
- one-row and two-row tables;
- wrapped or continuation cell text;
- malformed, reversed, and non-finite OCR boxes and confidence values;
- standards-compliant endpoint serialization.

## Remaining hardening

These items are useful follow-ups, but they do not change the canonical policy:

1. **Rotated geometry transforms** — publish transformed Camelot geometry only
   after independent real and generated fixtures prove every orientation.
2. **Runtime budgets** — consider a dedicated Camelot timeout plus explicit
   table, cell, and output caps. Existing source, page, render, and storage
   limits bound the wider pipeline, but not Camelot independently.
3. **OCR dependency profiles** — validate clean CPU and GPU installations with
   real inference. Camelot, Docling, and PaddleOCR may install distributions that
   share the `cv2` namespace; isolate Camelot if one OpenCV provider cannot
   satisfy all supported profiles reliably.
4. **Typed OCR blocks** — `ParsedPage.blocks` remains
   `list[dict[str, Any]]`. Introduce a typed OCR block only through a deliberate
   versioned schema-contract change.

## Completion checks

A parsing change that affects these areas is complete when:

- focused table and OCR tests pass;
- the compact semantic end-to-end test passes without weakening invariants;
- the full backend suite passes with
  `uv run --no-sync python -m unittest discover -s tests`;
- changed Python files have no LSP/Pyright errors;
- rotated fixtures retain content without leaking Camelot geometry;
- the repository source document exposes the manually reviewed tables without
  narrative contamination or overlapping duplicates.

Clean-profile CPU OCR inference and CUDA-host GPU inference are operational
release checks when their respective profiles are being changed.
