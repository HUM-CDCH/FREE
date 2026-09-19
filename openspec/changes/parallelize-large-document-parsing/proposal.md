## Why

Parsing a single large PDF runs as one sequential `DocumentConverter.convert()`
call in one worker thread (`app/tasks.py`), so wall-clock time scales linearly
with page count and there is no way to shorten it for one document today.
Large documents near the service's page ceiling are the slowest case users
actually feel, and Docling already exposes a `page_range` option on `convert()`
that lets independent page ranges of the same source be converted separately —
making page-range parallelism viable without forking Docling internals.

## What Changes

- Split a document's pages into contiguous page-range partitions, using
  PyMuPDF's `page.find_tables()` on the prepared PDF as a cheap geometric
  signal to prefer split points that fall between detected tables rather than
  inside one.
- Convert each partition independently and concurrently in worker processes,
  each calling `DocumentConverter.convert(source, page_range=...)` against the
  same uploaded PDF, using its own reusable `DoclingParser`/`DocumentConverter`
  instance.
- Merge partial `DoclingDocument` results into one `parsed_document.v2`
  payload: namespace each partition's Docling `self_ref` values before
  deriving `block_id`/`anchor_id` (those IDs are a deterministic hash of
  `content_sha256` + `preprocess_id` + `ref`, and raw refs restart at zero in
  every independent `convert()` call, so they would otherwise collide across
  partitions), then concatenate pages/blocks/tables/anchors in page order.
- When a table still ends up split across a partition boundary despite the
  avoidance pass, detect it at merge time by geometric alignment (matching
  column count and column x-boundaries between the last table on one
  partition and the first table on the next, both flush against the
  boundary) and stitch the two Docling-produced table fragments into one
  logical `table_id`, dropping a duplicated header row from the continuation
  fragment. This reuses Docling's own cell content — PyMuPDF only supplies
  the geometric signal that triggers the stitch, the same enrichment-only
  role Camelot already has for table geometry.
- A table or paragraph that still can't be confidently stitched (alignment
  check fails) is published as two separate items, with a new diagnostic
  code marking the boundary so reviewers can see where a partition split may
  have separated related content.
- Only large documents are partitioned; small documents keep the current
  single-call path unchanged.
- The task lifecycle (queue, admission capacity, cancellation, single Uvicorn
  process) is unchanged — a task still occupies one queue slot and completes
  or fails as one unit; only the parsing step behind it fans out internally.
- Out of scope: increasing overall service throughput / running multiple
  different documents concurrently (a separate, lower-risk change); stitching
  a paragraph/narrative block split across a boundary (only tables get
  geometric stitching, since only tables have clean structural alignment
  signals to verify against).

## Capabilities

### New Capabilities

- `parallel-page-range-parsing`: partitioning a large document's pages,
  converting partitions concurrently, and merging the results into one
  `parsed_document.v2` payload with collision-free IDs and boundary
  diagnostics.

### Modified Capabilities

- `parsed-document-v2`: the "Parser and table authority" requirement
  currently states a PyMuPDF text fallback "SHALL NOT be introduced by this
  change" (singular, referring to the change that landed the requirement).
  This change adds a narrower, explicit carve-out: PyMuPDF MAY be used
  internally for partition split-point selection and boundary-table-
  continuation detection — geometry signals only, never published as
  canonical table or text content, and never a substitute for Docling's
  table semantics or PaddleOCR's text fallback. The scenario-level behavior
  (Camelot-only geometry enrichment, PaddleOCR-only text fallback, no
  canonical content from any other parser) is unchanged.

## Impact

- `prototypes/parsing_service/app/docling_parser.py`: partitioning
  (including the `find_tables()`-based split-point avoidance pass), per-
  partition `page_range` conversion, ref-namespacing, boundary-table
  detection/stitching, and result merging.
- `prototypes/parsing_service/app/tasks.py`: dispatch to a worker process pool
  instead of a single `asyncio.to_thread` call, and await all partitions
  before completing a task.
- New worker-process pool lifecycle (startup/shutdown) alongside the existing
  FastAPI lifespan, each process holding its own `DocumentConverter` — GPU/CPU
  memory now scales with partition-worker count, so pool size needs a bound.
- New dependency: PyMuPDF, used only for `find_tables()` geometry (page
  bounding boxes, column x-boundaries) — not for text extraction.
- `prototypes/parsing_service/README.md`: update the "one in-process worker"
  description once partitioned parsing lands.
- Tests in `prototypes/parsing_service/tests/` covering `docling_parser.py`
  and `tasks.py`.
