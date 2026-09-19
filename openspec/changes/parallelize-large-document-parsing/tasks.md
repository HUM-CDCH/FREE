## 1. Dependencies and configuration

- [ ] 1.1 Add PyMuPDF as a dependency of `prototypes/parsing_service`
      (`pyproject.toml` / `uv.lock`), used only for `find_tables()` geometry.
- [x] 1.2 Add `PARALLEL_PARSE_MIN_PAGES` and `PARALLEL_PARSE_MAX_WORKERS`
      configuration (env-var backed, with defaults that keep today's
      single-call path active until explicitly lowered).
- [x] 1.3 Add a target-partition-size setting and a split-point search-radius
      setting, both referenced from `design.md`'s Open Questions.

## 2. Split-point selection (prevention layer)

- [x] 2.1 Implement a PyMuPDF-backed helper that returns detected table
      bounding boxes for a given page of the `prepared` PDF.
- [x] 2.2 Implement candidate even-page-count boundary computation over
      `len(slices)` (the prepared page count), gated by
      `PARALLEL_PARSE_MIN_PAGES`.
- [x] 2.3 Implement boundary-shifting: for each candidate boundary, check
      adjacent pages for a straddling detected table and shift to the
      nearest table-free gap within the search radius; fall back to the
      original boundary when no gap is found.
- [x] 2.4 Unit tests: boundary avoids a table that starts before and ends
      after a naive split point; boundary is left unshifted when no table
      straddles it; boundary falls back to the naive split when no gap
      exists within the search radius.

## 3. Partition conversion and worker pool

- [x] 3.1 Extract the existing single-partition pipeline (`convert` with
      `page_range` → `_restore_physical_pages` → `_Publisher.publish()`) into
      a function callable independently per partition, taking a
      partition-qualified ref-namespace prefix. (`DoclingParser.prepare()` +
      `DoclingParser.parse(page_range=..., ref_prefix=..., prepared=...)` in
      `app/docling_parser.py`.)
- [x] 3.2 Thread the partition-qualified prefix through `_deterministic_id`
      and the anchor/occurrence-id builders so `block_id`/`anchor_id`/
      `table_id`/`cell_id`/`occurrence_id` stay globally unique across
      partitions. Also had to relax `_Publisher._physical_pages()` and
      `_validate_publication`'s page-completeness checks, which assumed
      "starts at page 1" — a partition fragment legitimately covers a
      sub-range like 11..20 (see `app/docling_parser.py`).
- [x] 3.3 Create a bounded `ProcessPoolExecutor` (sized by
      `PARALLEL_PARSE_MAX_WORKERS`) in the FastAPI lifespan, alongside the
      existing `TaskManager` startup, with each worker process lazily
      building and keeping its own `DoclingParser`. (`app/worker_pool.py`'s
      `PartitionWorkerPool`, wired in `app/main.py::create_app`.)
- [x] 3.4 Dispatch one partition-conversion call per partition to the pool
      and await all results before proceeding to merge.
      (`PartitionWorkerPool.convert_partitions` /
      `worker_pool.parse_large_document`.)
- [x] 3.5 Unit/integration tests: a document under `PARALLEL_PARSE_MIN_PAGES`
      still takes the existing single-call path unchanged; a document over
      the threshold is dispatched as multiple partitions; a partition
      failure fails the whole task with no partial merged document
      published. (`tests/test_worker_pool.py`,
      `tests/test_partitioned_task_lifecycle.py` — using an in-process fake
      pool rather than real subprocesses, since a real worker process would
      need actual Docling models loaded, same reason `test_docling_smoke.py`
      is gated behind `RUN_DOCLING_SMOKE=1`. The "partition failure fails
      the whole task" case rides on `TaskManager`'s existing exception
      handling in `_run()`, unchanged and already covered by
      `test_task_lifecycle.test_parser_exception_becomes_a_failed_public_task`.)

## 4. Merge: pages, IDs, and Markdown

- [x] 4.1 Implement merge of `pages`, `content_stream`, `tables`,
      `evidence_index.anchors`, `diagnostics`, `parser_runs`, and `warnings`
      across partition fragments, sorted by page order, with recomputed
      `page_count`. (`parallel_parsing.merge_fragments`.)
- [x] 4.2 Implement Markdown concatenation with byte-span shifting: shift
      every `start`/`end` in a partition's `page_spans`/block
      `markdown_span`/anchor `markdown_span` by the cumulative UTF-8 byte
      length of previously appended partitions. (Same function.)
- [x] 4.3 Re-run `_validate_publication` once over the merged document
      before publishing. (`worker_pool._revalidate_merged_document`, which
      also asserts the merged whole starts at page 1 and covers
      `1..page_count` contiguously — a partition fragment's own validation
      only requires its own sub-range, so this is the one place that checks
      the full-document invariant.)
- [x] 4.4 Unit tests: merged document has complete contiguous physical-page
      coverage; no duplicate `block_id`/`anchor_id`/`table_id`/`cell_id`/
      `occurrence_id`; every anchor's markdown span round-trips against the
      final merged Markdown text. (`tests/test_parallel_parsing.py`,
      `tests/test_docling_partitioning.py`, `tests/test_worker_pool.py`.)

## 5. Boundary-table stitching (safety-net layer)

- [x] 5.1 Implement the alignment check: flush adjacency to the partition
      boundary, matching column count, and aligned column x-boundaries
      (reusing `find_tables()` geometry where already computed in task 2.1).
      Implemented using each partition's own published cell `bbox` values
      instead of re-deriving geometry from PyMuPDF at merge time — Docling
      has already published exact cell coordinates by this point, so this is
      more accurate than an independent PyMuPDF pass and needs no PDF access
      during merge. `find_tables()` stays scoped to the prevention layer
      (task 2.1).
- [x] 5.2 Implement duplicate-header detection on the continuation
      fragment's first row and drop it when it matches the earlier
      fragment's header.
- [x] 5.3 Implement the stitch: re-own the continuation fragment's cells
      onto the earlier `table_id`, renumber `row` offsets to continue after
      the earlier fragment's last row, rewrite each moved cell's anchor to
      the surviving `table_id`, and mark `continuation: derived_continuation`.
- [x] 5.4 Implement the fallback: when the alignment check fails, leave both
      tables published separately and attach the
      `partition_boundary_table_not_stitched` diagnostic to both.
- [x] 5.5 Unit tests: aligned adjacent tables stitch into one `table_id`
      with the duplicated header dropped and rows renumbered correctly;
      misaligned tables (different column count, misaligned x-boundaries,
      or not flush) remain separate with the diagnostic; a stitched table's
      cell anchors all resolve to the surviving `table_id`.

## 6. Boundary text diagnostics

- [x] 6.1 Implement detection of non-table content blocks whose provenance
      falls within the partition boundary margin.
- [x] 6.2 Attach the `partition_boundary_may_be_split` diagnostic to those
      blocks without altering their content or placement.
- [x] 6.3 Unit test: a paragraph adjacent to a partition boundary is
      published unchanged with the diagnostic attached.

## 7. Task lifecycle integration

- [x] 7.1 Update `TaskManager._run()` / `_parse` in `app/tasks.py` to call
      the new partitioned-or-single-call entry point instead of always
      calling `DoclingParser.parse()` directly, preserving today's
      admission/cancellation/completion semantics. `_parse` only engages
      `worker_pool.parse_large_document` when both a pool is configured and
      the injected parser exposes `.prepare()` (i.e. a real `DoclingParser`)
      — every fake parser used elsewhere in the test suite takes the exact
      path it always has, unchanged.
- [x] 7.2 Verify cancellation behavior when partitions are in flight: a
      cancelling task still discards its result on completion, matching
      today's cooperative-cancellation contract (conversions already in
      progress finish but their result is discarded). No `tasks.py` change
      was needed — partitioned parsing still runs inside the one
      `asyncio.to_thread` call per task, so the existing cooperative-
      cancellation path in `_run()`/`_complete()` already covers it; verified
      by test below.
- [x] 7.3 Integration test: an end-to-end task over the partition threshold
      completes with a valid merged `parsed_document.v2`, and a cancelled
      in-flight partitioned task is discarded correctly.
      (`tests/test_partitioned_task_lifecycle.py`.)

## 8. Documentation and rollout

- [x] 8.1 Update `prototypes/parsing_service/README.md`'s "one in-process
      worker" description to cover the worker-process pool and its
      resource-bound configuration.
- [x] 8.2 Document `PARALLEL_PARSE_MIN_PAGES`, `PARALLEL_PARSE_MAX_WORKERS`,
      and related settings, including the multiplied memory/GPU footprint.
- [x] 8.3 Confirm defaults keep the feature effectively off (threshold above
      `MAX_NUM_PAGES` or pool disabled) until a benchmark-informed rollout
      value is chosen, per `design.md`'s Migration Plan.
      `parallel_parsing.DEFAULT_MIN_PAGES = 10_000`, far above
      `tasks.MAX_NUM_PAGES = 100` — no document accepted by this service can
      trigger partitioning until an operator explicitly sets
      `PARALLEL_PARSE_MIN_PAGES` below 100.
