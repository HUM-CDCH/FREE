# Producer review: reviewed continuation boundary

This note records the producer facts used by the runtime continuation
evaluator. It is a narrow capture review, not a general table-merging rule.

## Observed facts

- Docling table records are page-local and carry one physical page, dimensions,
  optional geometry, producer-local cell row/column offsets, roles, and spans.
- Document-local `self_ref` values are opaque producer observations. They are
  retained only inside table-cell observations and are not canonical IDs.
- Missing or malformed geometry is allowed and remains absent. Geometry is
  never copied between physical pages.
- Physical-page DocTags are exported per page. The runtime checks the OTSL
  matrix against the producer table cells before it can admit continuation.
- PaddleOCR produces page-local generic text blocks when Docling leaves a page
  unresolved. It does not invent semantic table structure.

## Positive reviewed boundary

The checked-in `producer_review_observations.json` fixture contains a positive
6→7 boundary: the first page-local fragment is header-bearing, the next is
body-only with the same observed column count, OTSL matrices match the records,
and only page furniture/page breaks intervene. The runtime emits one derived
logical table while retaining each cell's physical page and producer offsets.

## Fail-closed boundaries

The evaluator keeps records separate for narrative interstitial content, a new
header row, a caption, malformed observations, missing OTSL evidence, and the
ambiguous 10→11 split-row case. Adjacency, repeated text, matching geometry,
generated IDs, or a capture digest are never sufficient evidence.

## Canonical Evidence shape

Each published cell has exactly one `TableCellEvidenceAnchor`:

```text
kind, anchor_id, content_sha256, preprocess_id,
logical_table_id, cell_id, canonical_row, canonical_column,
producer_observation { page_number, producer_ref?, row_offset,
  column_offset, row_span, column_span, bbox? }
```

The canonical cell keeps text, role, and canonical row/column/span data. Page
spans keep page/range/producer identity only. No fragment ID, cell-location
collection, copied geometry, or inferred character range is published.
