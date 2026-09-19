## Context

Today `TaskManager._run()` (`app/tasks.py`) makes exactly one
`asyncio.to_thread(self._parse, ...)` call per task, which lands in
`DoclingParser.parse()` (`app/docling_parser.py`). That method already does a
"prepare" pass — `_prepare_scanned_columns` rewrites scanned four-column
spreads into a `prepared` PDF with more (virtual) pages than the original,
tracked as `slices: list[tuple[_PageGeometry, float]]` — then makes **one**
`self._converter.convert(prepared, **convert_options)` call over the whole
prepared document, then `_restore_physical_pages(document, slices)` maps
Docling's prepared-page coordinates back to original physical pages, then
`_Publisher.publish()` turns the Docling object into the flat
`parsed_document.v2` JSON (blocks, tables, evidence anchors, canonical
Markdown with byte spans) and validates it (`_validate_publication`).

Two facts, verified against the installed `docling` package in this service's
`.venv` (not assumed), make page-range partitioning viable:

- `DocumentConverter.convert()` already accepts a `page_range: PageRange`
  argument (`document_converter.py:450`), which is threaded down to the PDF
  backend.
- Page numbers are **not renumbered** when a `page_range` is given — the PDF
  backend's `_resolve_threaded_page_numbers` (`docling_parse_backend.py:361-380`)
  returns the literal `range(start_page, clipped_end_page + 1)`, so a
  `page_range=(11, 20)` conversion produces `document.pages` keyed `11..20`
  and `prov.page_no` values in that same range, exactly like a full-document
  conversion would for those pages.

What is **not** free: Docling's internal `self_ref` values (e.g.
`#/texts/0`) are assigned per `DoclingDocument` instance and restart at zero
on every independent `convert()` call, and this service's own
`block_id`/`anchor_id`/`table_id`/`cell_id` are deterministic hashes of
`content_sha256 + preprocess_id + ref` (`docling_parser.py:572`, `:709`,
`:777`, `:782`). Two partitions converted independently will each produce a
`#/texts/0`, and naively publishing both would collide IDs. And a table that
happens to straddle a partition boundary is, from each partition's own point
of view, two unrelated single-page tables — Docling never sees the whole
table in one call, so it can't itself recognize the continuation the way it
does for a table split across pages within a single `convert()` call.

## Goals / Non-Goals

**Goals:**
- Cut end-to-end wall-clock time for one large PDF by converting independent
  page ranges concurrently across worker processes.
- Keep the `parsed_document.v2` contract fully intact for the merged output —
  same schema, same ID-uniqueness/page-coverage/byte-span guarantees,
  verified by the existing `_validate_publication` unchanged.
- Recover clean table continuity across a partition boundary whenever the
  geometry supports it, instead of always accepting a split.
- Bound the added resource cost (worker-process count, and therefore
  duplicated Docling model memory/GPU usage) behind explicit configuration.

**Non-Goals:**
- Increasing overall service throughput or admitting more than the current
  two concurrent tasks — the queue/admission model in `TaskManager` is
  unchanged; this only parallelizes the work *behind* one task.
- Reconstructing a narrative paragraph split across a partition boundary.
  Only tables get geometric stitching, because only tables have a clean
  structural signal (column count, column x-boundaries) to verify a stitch
  against; a split paragraph is diagnosed, not stitched.
- Cost-aware or content-aware partitioning of *non-table* content (e.g.
  weighting by page density). Partitions are even page-count chunks, only
  nudged to avoid landing inside a detected table.
- Changing `_prepare_scanned_columns`'s column-detection heuristic, or making
  PyMuPDF a canonical content source for text or tables.

## Decisions

### Partition on the *prepared* page space, computed once

`_prepare_scanned_columns` runs once, in the coordinating process, exactly as
it does today, producing the `prepared` PDF and the full `slices` list.
Partition boundaries are chosen over `len(slices)` (the prepared page count),
not the original upload's page count.

*Alternative considered:* partition on the original PDF's page numbers and
run `_prepare_scanned_columns` independently inside each worker. Rejected —
every worker would redundantly re-run the rendering-based scan-detection over
pages outside its own partition just to reproduce the same `slices` list, and
`_restore_physical_pages`'s offset math is already keyed to prepared-page
numbers, so partitioning in that same space is the natural fit.

### Split-point selection avoids detected tables (prevention layer)

Before dispatching partitions, run PyMuPDF's `page.find_tables()` over the
`prepared` PDF's pages near each candidate even-page-count split point (not
the whole document — only the pages adjacent to each candidate boundary need
checking). If a detected table's bounding box straddles a candidate boundary,
shift that boundary to the nearest page gap outside any detected table
(bounded search radius; if no clean gap exists within the radius, fall back
to the original even split and rely on the merge-time stitching layer
below). PyMuPDF's output here is only a bounding-box signal used to place the
cut — it is never published, and it does not participate in producing any
table cell content.

### Merge at the `parsed_document.v2` JSON layer, not the Docling object layer

Each partition runs the **entire existing pipeline** independently, inside
its own worker process, against the shared `prepared` file: `convert(prepared,
page_range=partition_range)` → `_restore_physical_pages` (using the full
shared `slices` list) → `_Publisher.publish()`. Each partition therefore
produces its own self-contained, already-validated `parsed_document.v2`
fragment scoped to its page range. The coordinator's merge step concatenates
flat, already-public structures: `pages`, `content_stream`, `tables`,
`evidence_index.anchors`, `diagnostics`, `parser_runs`/`warnings`, recomputes
`page_count`, applies the boundary-table stitch pass below, and re-runs
`_validate_publication` once over the combined document.

*Alternative considered:* splice partial `DoclingDocument` object graphs
together before publishing (concatenate `.texts`/`.tables`/`.pictures`
arrays, renumber every internal `self_ref`, and fix up parent/child and
table-cell `RefItem` back-references so `iterate_items()` and
`cell.ref.resolve(document)` keep working across the merged tree). Rejected —
this requires consistently rewriting a Docling-internal ref graph we don't
own, which is materially riskier than concatenating our own already-flat,
already-validated output schema, for the same end result.

### Boundary-table stitching (safety-net layer)

After merge, for every adjacent partition pair, compare the last published
table on the earlier partition's last page against the first published table
on the later partition's first page. Stitch them into one logical `table_id`
when all of:
- both tables' bounding boxes are flush against the partition boundary (last
  table's bbox reaches the bottom margin of its page; first table's bbox
  starts at the top margin of its page — the same margin tolerance already
  used elsewhere in this module, e.g. `_top_left_bbox`);
- both tables report the same column count and matching column x-boundaries
  (within a small tolerance), derived from each partition's own already-
  published cell `bbox` values (grouped by column) rather than a second
  PyMuPDF pass — by merge time Docling has already published exact cell
  coordinates, which is more accurate than an independent geometry pass and
  needs no PDF file access during merge. PyMuPDF stays scoped to the
  prevention layer (split-point selection), which necessarily runs before
  Docling has produced anything;
- the later table's first row duplicates the earlier table's header row
  (compares as a plausible re-detected header, e.g. same cell count and
  matching header-role cells) — that row is dropped from the continuation
  fragment before stitching, since Docling re-ran its table model on that
  page in isolation and re-recognized the (repeated) header as this
  fragment's own header.

Stitching keeps Docling's own cell content and geometry entirely — it
relabels the continuation fragment's cells onto the earlier `table_id`
(renumbering `row` offsets to continue after the earlier fragment's last row,
rewriting each moved cell's `evidence_anchor_id`-bearing anchor to point at
the surviving `table_id`) and marks the merged table's `continuation` as
`derived_continuation`, matching the shape Docling already produces for a
table split across pages within a single `convert()` call.

When the alignment check fails (column count/x-boundary mismatch, or no
flush adjacency), the two tables are left as separate published tables, with
a new diagnostic code (e.g. `partition_boundary_table_not_stitched`) marking
both `table_id`s. A boundary *paragraph* (non-table text) is always left
separate, tagged with a lighter diagnostic (e.g.
`partition_boundary_may_be_split`) — there is no equivalent structural
alignment check for narrative text.

*Alternative considered:* always leave boundary tables split, with a
diagnostic only. Rejected per explicit direction — tables have a verifiable
geometric/structural signal (column alignment, flush adjacency, duplicated
header) that makes a correct stitch decidable, unlike narrative text, so
this is worth engineering rather than always degrading.

### Markdown is concatenated with shifted byte spans

Each partition's `_render_markdown` produces Markdown text and byte spans
relative to that partition's own byte 0. The coordinator concatenates
partition Markdown strings in page order and shifts every `start`/`end` in
that partition's `page_spans`/block `markdown_span`/anchor `markdown_span` by
the cumulative UTF-8 byte length of the partitions already appended, before
the boundary-table stitch pass rewrites the affected anchors' spans onto the
surviving table.

### IDs are namespaced by partition, not by page number

Partition workers pass a partition-qualified ref (e.g. `f"p{index}:{ref}"`)
into `_deterministic_id` and the anchor/occurrence-id builders in place of the
raw Docling `self_ref`, so `block_id`/`anchor_id`/`table_id`/`cell_id`/
`occurrence_id` stay globally unique across partitions. No adjustment is
needed for `page_number` fields themselves, since those are already correct
per the page-numbering behavior confirmed above. A stitched table keeps the
earlier partition's `table_id` and drops the later partition's `table_id`
entirely (its cells are re-owned, not aliased).

### Bounded worker pool, threshold-gated

A `ProcessPoolExecutor` is created alongside the existing FastAPI lifespan,
sized by a configurable `PARALLEL_PARSE_MAX_WORKERS` (default small, e.g. 4).
Each worker process lazily builds and keeps its own `DoclingParser` the same
way `TaskManager.start()` does today, just once per worker process rather
than once per service process. Only documents whose prepared page count
exceeds a configurable `PARALLEL_PARSE_MIN_PAGES` threshold are split into
partitions (target partition size configurable, e.g. ~10 pages, capped by
pool size); documents at or under the threshold keep today's single
`asyncio.to_thread` call unchanged.

### All-or-nothing task failure

If any partition's `convert()` raises or returns a non-success status, the
whole task fails, matching today's single-call failure semantics. No partial
retry of just the failed partition in this version.

## Risks / Trade-offs

- **[Risk]** Each worker process loads Docling's layout/OCR/table models
  independently, so memory (and GPU memory, if enabled) scales with pool
  size. → **Mitigation:** bound pool size via `PARALLEL_PARSE_MAX_WORKERS`,
  default conservative, document the multiplied footprint in `README.md`.
- **[Risk]** The boundary-table stitch is a new, hand-written geometric
  alignment check; a false-positive stitch would silently merge two
  genuinely unrelated tables, which is worse than leaving them split. →
  **Mitigation:** require *all* of flush adjacency, column-count match, and
  aligned column x-boundaries (not any one signal alone) before stitching;
  when uncertain, fail closed to "leave separate + diagnostic", never to "
  stitch anyway".
- **[Risk]** PyMuPDF's `find_tables()` is a new dependency and a second,
  independent table-detection signal alongside Docling's own TableFormer —
  scope creep risk if it were to start influencing published table content.
  → **Mitigation:** its output is used only for split-point placement and
  the stitch decision predicate; it never contributes cell text or
  structure, and this is called out explicitly as a `parsed-document-v2`
  spec amendment (see proposal) rather than left implicit.
- **[Risk]** Page-count partitioning assumes roughly uniform per-page cost;
  a partition with dense tables or scanned OCR runs longer than a sparse-text
  partition, so the achieved speedup is bounded by the slowest partition, not
  a clean `1/N`. → **Mitigation:** accepted as a first-version limitation;
  revisit with cost-aware partitioning only if measured skew is large.
- **[Risk]** A hand-written Markdown byte-span shift (plus the stitch pass's
  span rewrites) is new surface area for off-by-one or ordering bugs. →
  **Mitigation:** the existing `_validate_publication`/`_validate_byte_span`
  checks already re-verify every span against the final merged Markdown
  length after merge and after stitching, so a bug here fails the task
  closed instead of publishing a corrupt span.
- **[Risk]** A worker process can crash mid-partition (e.g. OOM on one
  partition). → **Mitigation:** `ProcessPoolExecutor` already restarts a
  crashed worker transparently for future work; a crashed partition surfaces
  as a normal task failure, matching today's single-call failure path.

## Migration Plan

- Ship behind `PARALLEL_PARSE_MIN_PAGES` (and `PARALLEL_PARSE_MAX_WORKERS`),
  defaulting the threshold high enough (or the feature off) that existing
  behavior is unchanged until validated.
- Roll out by lowering the threshold in one environment first; documents at
  or under threshold always use today's single-call path, so the change is
  reversible at any time by raising the threshold above `MAX_NUM_PAGES`.
- No data migration: `parsed_document.v2` schema, stored artifacts, and task
  metadata shape are unchanged — only the internal parsing execution path
  changes.

## Open Questions

- What are good default values for `PARALLEL_PARSE_MIN_PAGES`, target
  partition size, `PARALLEL_PARSE_MAX_WORKERS`, and the split-point search
  radius/tolerances used by `find_tables()`? Needs a benchmark against
  representative large PDFs, especially under GPU, before picking production
  defaults.
- What tolerance should the column x-boundary alignment check use, and
  should it be validated against a corpus of real multi-page tables before
  shipping the stitch as default-on?
- Should a "force single-call parse" override be exposed for documents where
  even the stitching layer isn't trusted enough for a specific case?
- Should the boundary diagnostics (stitched or not) record the specific
  neighboring partition/table id to make manual review easier?
