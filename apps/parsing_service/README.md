# Parsing and extraction service

This directory holds FREE's Python document-processing service, package
`kei_exp`. FREE Studio owns authentication, Project Contexts, Extraction Schemas
and review. This internal service owns PDF parsing, canonical Evidence, Article
and Catalog Extraction, and durable processing jobs. Studio is its only product
UI.

[CONTEXT.md](CONTEXT.md) defines the ingest and evidence vocabulary.
[Extraction stages and controlled experiments](docs/extraction-experiments.md)
covers extraction stage ownership, method settings and the study tooling.

## Runtime

Run the complete deployment with `pnpm dev` or `pnpm production` from the FREE
root. Root Compose builds the API and the worker from this directory. The API
listens on port 8001 inside the Compose network; Studio reaches it through
`KEI_EXP_URL`. The API has no database: it serves the model listings and the
files a run has published, and nothing else.

The worker (`kei-worker worker`) is kei's DBOS application: name `kei`,
application version `kei@1`, system schema `kei_dbos` in Studio's database
`free`, connected as the restricted `kei` role. Studio enqueues `convert` and
`deleteRuns` by name with portable JSON (contract and examples in
`tests/fixtures/contracts/`), and durable Extraction attempts
(`extractDurableV1`) with only their identities, on four lanes:
`kei-convert-large`, `kei-convert-small` (a document of at most 30 pages),
`kei-extract` (durable attempts, priority 1 interactive before 10 batch) and
`kei-gc`. Each lane's worker limit equals its global limit, so a cancelled
workflow whose native step is still running keeps its slot until the step
returns.

One worker per slot: it holds `KEI_RUNS/.worker-<slot>.lock` for its lifetime
(a second one on the same slot exits at once), reads the database clock as its
boot timestamp, then launches DBOS, which migrates `kei_dbos` and recovers the
slot's pending work (executor `kei-<slot>`). The lock is the fence: a stopped
worker that resumes after its work was taken over overwrites published files,
so a replacement starts only once the previous process has exited, and a
stopped worker is the supervisor's to kill. A crash re-executes the step that
was running and reuses every checkpointed one. A cancel or a deadline stops a
conversion at its next check (before model work, between pages while cutting); a
running native call finishes first. A durable attempt stops at its coordination
boundaries.

Studio's `collectGarbage` names the conversions and other kei history that may
go; `deleteRuns` (`gc.py`, `boot.py`) deletes a conversion's run only once the
conversion can no longer write (not live, not stopped since this worker booted)
and nothing in the run was written for 24 h, then the conversion's history.
kei never reads Studio's schemas; the rules are in the spec's
[Deletion and garbage collection](../../docs/design/unified-durable-execution.md#deletion-and-garbage-collection).

The worker registers `convert`, `deleteRuns` and three durable Extraction
workflows: Studio enqueues `extractDurableV1` on `kei-extract` and
`deleteDurableHistoryV1` on `kei-gc`, and each attempt starts its
`extractionCallV1` children directly (ID `kei-call:<attempt>:<capture>`),
outside any lane limit. Attempts reach the coordination schema only through a
pool of at most four short calls to allowlisted `extraction_runtime` routines,
and no pooled connection or transaction spans a model call. After a crash,
recovery waits up to 40 s for the previous process's 30-second lease to expire:
a live owner keeps its epoch, stale attempts and other refusals fail at once,
and operators never edit lease timestamps. `deleteDurableHistoryV1` deletes a
deleted graph's history only once every linked attempt and call is quiescent by
this worker's boot clock; cancellation alone never proves that.

`KEI_RUNS` holds the runs' sources, canonical parse results and recipe
segmentations; durable Extraction results live in the coordination schema. It is
durable service data: later Extractions need the original parse generation.
`KEI_SOURCE_INBOX` is where Studio stages source PDFs; kei only reads it. Model
weights under `/models` are a separate cache. Debug files are never
authoritative Evidence.

A `convert` of PDF bytes another run already parsed with the same effective
settings reuses that work (`reuse.py`): it adopts the other run's complete
result whose recipe hashes to the same fingerprint, rewritten as a new
generation of this run whose manifest names it in `reused_from`, and for
`page_source=ingest` it hard-links the other run's proven ingest of the same
recipe. Every candidate is verified first, anything less is passed over and
the work is done; a run asking for a debug report reuses nothing. Reuse is as
fresh as the recipe, which names the settings, the docling, surya-ocr,
pypdfium2 and pillow versions, and the transcriber's text rules. Anything else
that changes the output for the same inputs must change the recipe, or later
runs keep the earlier output:

- a code change to what a transcriber kind writes: add or bump its entry in
  `TEXT_RULES` (`transcription/types.py`);
- a new image or new weights for the OCR model server under the same repo name:
  set a new `KEI_OCR_REVISION`;
- a change to what the ingest cuts: bump its `STAGE_VERSION`
  (`kie/stages/ingest.py`). The ingest's own fingerprint does not name the OCR
  recipe, so a re-OCR alone keeps the cut images.

Do not bump `RESULT_VERSION` to force a re-OCR: it is the manifest format, and
the reader refuses every result written at another version, so every earlier
run would lose its result.

| Setting | Purpose |
| --- | --- |
| `KEI_SYSTEM_DATABASE_URL` | Worker only: kei's DBOS system database (role `kei` on `free`); required |
| `KEI_RUNS` | Shared source/result directory; `/app/runs` in the image |
| `KEI_SOURCE_INBOX` | Staged source PDFs, written by Studio, read by the worker |
| `KEI_SLOT` | The worker's slot: its lock file and its DBOS executor `kei-<slot>`. A deployment runs one slot: `deleteRuns` trusts its own process's boot timestamp, which says nothing about another slot's running steps |
| `KEI_LOG_LEVEL` | Worker only: log level; default `INFO` |
| `KEI_VLLM_URL` | OCR chat-completions endpoint, normally the `ocr_model` service |
| `KEI_OCR_MODEL` | Default OCR model of a parse that names none (default `surya`) |
| `KEI_OCR_REVISION` | Optional label of the OCR server's image and weights, named in every served parse's recipe; change it when they change, so earlier output is not reused |
| `KEI_EXTRACT_URL`, `KEI_EXTRACT_MODEL` | Extraction's instruction model server and the model it serves |
| `KEI_NUEXTRACT_URL`, `KEI_NUEXTRACT_MODEL` | NuExtract template extractor server and model; unset, every call goes to the instruction model |
| `KEI_GLIFORMER_URL` | Optional native GLiFormer service base URL; fields only, never selected by default. [Capabilities and deployment](model_servers/gliformer/README.md) |
| `KEI_EXTRACT_TIMEOUT` | Timeout of one extraction model call, seconds; default 1800 for full-source inventory |
| `KEI_CATALOG_CHUNKS` | Worker only: chunks a durable attempt plans a Catalog's entries in at once, 1 to 64; unset means 1 (the GPU overlay sets NuExtract's `--max-num-seqs`); a bad value stops the worker at boot |
| `KEI_MAX_UPLOAD_BYTES`, `KEI_MAX_PAGES` | Limits `convert` enforces on a staged source; default 200 MiB and 2000 pages |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `FREE_TRACE_CAPTURE` | Worker only: Compose always exports model-call traces to Phoenix; content capture is optional ([development](../../docs/operations/local-development.md#model-call-traces-phoenix), [production](../../docs/operations/deployment.md#model-call-traces-phoenix)). Standalone processes trace only when an endpoint is set |

Root Compose runs the model servers. A configured model server is required for
scanned OCR and Extraction; native parsing uses Docling locally.

## HTTP and evidence contract

- `convert` takes `{source, source_sha256, source_name, page_source, ingest,
  model, layout_model, cut, debug}`: the staged PDF's path relative to
  `KEI_SOURCE_INBOX`, the SHA-256 `prepare_run` verifies its copy against, and
  the optional Ingestion Model Choice (`model` for OCR, `layout_model`; kei's
  defaults otherwise). `page_source` is `pdf` (single pages, the default) or
  `ingest` (two-page spreads), whose optional `ingest` object carries splitter
  settings such as gutter overrides; both are recorded in the parse recipe. It
  returns `{ok: true, run_id, generation, page_count, source_sha256,
  page_source}`; the run ID derives from the workflow ID. `convert` and
  `deleteRuns` fail as `{ok: false, code, reason, retryable}`;
  `extractDurableV1` acknowledges its outcome through the coordination schema,
  and `deleteDurableHistoryV1` returns `{removed}`.
- A completed parse exposes `/result` and `/pages/{page}` below `/api/runs/{id}`.
  The canonical result is version 5: a manifest plus hashed page files bound to
  one generation. Native Docling tables retain cells with row/column spans, raw
  parent-text offsets, and measured page boxes when available. Tables read by
  OCR stay coarse, without cells.
- A PDF with text on every selected nonblank page parses natively; substantial
  textless artwork on such pages is OCR'd as crops placed in the page's reading
  order, where a crop's `order` is its reading rank and its `crop` ordinal is
  discovery order. Page-sized scans with a text overlay, mixed native/scanned
  documents and rotated textless artwork take the scan path, cut as
  [ingest-cuts.md](docs/ingest-cuts.md) describes. A native table with no
  readable cells outside an OCR crop, or an incomplete OCR crop, makes its page
  and the conversion incomplete.
- `GET /api/ingestion-models` lists the OCR and layout models a new parse may
  run on, and the default per role (`KEI_OCR_MODEL`, default `surya`, and
  `layout_heron_101`); it is shaped like `/api/extraction-models`. An OCR model
  is `serving` only while the OCR server has it loaded, which is what the
  listing observed, not a promise. Layout detectors run inside this service and
  are always selectable. `GET /api/models` lists the OCR model records; Compose
  probes it as the API's health check.
- Extraction Evidence names canonical segments `p{page}_s{index}`: the
  physical, one-based PDF page and the zero-based segment position. Geometry
  uses PDF points measured from the top-left; coarse input boxes are marked
  explicitly.
- Extraction runs only as durable attempts: the attempt reads its pinned
  selection and source from the coordination schema, and its saved values are
  retained there, never published beside the run or served by this API. A
  request may name `start_page`, the page the researcher is reading: the unified
  Catalog reads the records nearest it first and Article its bounded value
  contexts, the admitted source range unchanged. Changing the schema reruns
  Extraction without rerunning OCR.
- Extraction calls take one of two roles. `fields` reads values off the source
  (document, record and grounded entry calls); `reasoning` decides over labelled
  text (discovery, grounding, arbitration). `GET /api/extraction-models` lists
  the deployment's models (`instruct`; `nuextract` when `KEI_NUEXTRACT_URL` is
  set; `gliformer`, fields only and never a default, when `KEI_GLIFORMER_URL`
  is set), the roles each may take, whether its server serves it now, and the
  default per role: NuExtract fills fields when configured, the instruction
  model reasons. `options.models = {fields?, reasoning?}` chooses per run; a
  model that cannot take a role (NuExtract cannot reason) is refused before any
  call.
- A result keeps ungrounded values explicit, and its `calls` lists every model
  call: a generic Catalog record call that looped on whitespace and was read on
  its one bounded-grammar retry is kept, failed, with `recovered: true`, and
  does not by itself make the result incomplete.
- The task scope is the schema's `recordScope` (`document` for Article,
  `records` for a Catalog; `tests/fixtures/contracts/record-scope.json`). A
  declared scope must match `options.strategy`; an undeclared one (CLI,
  harness) is the strategy's. A `document` result that is not exactly one
  record fails (`record_scope_violation: ...`) and is never retained; so does an
  Article whose root no value context answered (`article_root_unanswered: ...`)
  rather than retain an all-null root.
- Article extracts the document as one object, which may contain arrays;
  `options.article` holds its research settings. A Catalog without
  `options.catalog` or `options.unified` runs generic discovery (result
  version 1). `options.catalog = {recipe, input_tokens?, output_tokens?,
  factors?}` selects a recipe such as `numbered-catalogue-de@1`: result version
  2, with structural segmentation and code-verified span Evidence (see the
  [grounded catalogue design](docs/design/2026-09-23-grounded-catalogue-design.md)).
  `options.unified = {defaults, input_tokens?, output_tokens?, overlap?,
  headings?, verification?}` runs the unified Catalog: result version 3, no
  recipe and no character limits (a request naming either is refused). New
  admissions use it only where Studio's `FREE_CATALOG_METHOD=unified` gate is
  on. The [pipeline map](docs/extraction-experiments.md#pipeline-map) traces
  each method's calls.

Limitations:

- Counted requests need the extraction endpoint's vLLM `/tokenize` and its
  reported context size, for both roles; otherwise the request is refused before
  any call. Oversized input is reported, never clipped. Only generic Catalog
  uses character budgets instead (`record_chars`, `discovery_chars`), naming
  any source text a budget cut in a `text_truncated` issue.
- `complete` applies to record values and is not a recall score: array-item
  recall and semantic correctness still need evaluation. Document-level fields
  are listed as `unverified`.
- Field instructions include allowed labels explicitly: constrained decoding
  alone does not show those choices to the instruction model.

The API is an internal processor and provides no researcher authentication.
Only Studio exposes researcher-facing operations and enforces ownership. For
canonical file details see the
[evidence specification](docs/design/2026-09-21-canonical-evidence-design.md).

## Code organization

`api.py` exposes the read-only HTTP operations; `runs.py` is a run's layout on
disk. `workflows/` is kei's DBOS application: its configuration and lanes
(`config.py`), the portable contracts (`contracts.py`), the registration of
every workflow (`registered.py`), `convert` and its cooperative cancellation
checks (`cancel.py`), the durable Extraction workflows (`durable_extract.py`,
`coordination.py`), `deleteRuns` with the boot boundary (`gc.py`, `boot.py`),
the slot lock (`slot.py`) and the `kei-worker` CLI (`cli.py`); `failures.py`
classifies what a step raised into a retry or a portable failure code. The OCR
runner lives in `kie/stages/ocr.py`, with native/Surya/VLM adapters in
`transcription/` and the layout cut in `cut.py`. `models.py` holds lightweight
OCR records for the API; `transcription/specs.py` owns their Docling
specifications. `kie/runner.py` orchestrates ingest and OCR;
`kie/ingest_cache.py` owns ingest generation reuse, recovery and publication;
`reuse.py` finds another run's result and ingest of the same recipe.
`result.py` publishes canonical pages and manifests; `pagefile.py` validates
their identities and hashes. `kie/passages.py` reads those artifacts as the
`Evidence`/`Passage` view shared by the recipe stages and extraction; it imports
neither. `kie/extract/` performs record discovery, structured extraction,
grounding and result publication; its
[ownership table](docs/extraction-experiments.md#ownership) names each
module's responsibility.
The recipe path is split across these files:
- `kie/recipe.py` and `kie/recipes/` hold the recipes;
- `kie/stages/{layout,route,segment}.py` produce lines, roles and blocks;
- `kie/segmentation.py` holds the artifact;
- `kie/segmentation_run.py` reuses a validated artifact or computes and publishes it;
- `kie/extract/{grounded,tokens,locate}.py` do bounded extraction, token
  counting and span location;
- `kie/boundaries.py` handles boundary labels and block-F1
  (`python -m kei_exp.kie.boundaries report|prefill|score RUN_DIR`, read-only
  on the run).
The designs under `docs/design/` are the contracts that code cites as
`spec N.N` or `design §N`.

## Verification

From the FREE root, install once with `pnpm --filter parsing-service install:python`.
All commands use this directory's locked Python environment.

| Command after `pnpm --filter parsing-service` | Requirements and effects |
| --- | --- |
| `test` | Unit/contract checks; no PostgreSQL, container or model loading |
| `test:postgres` | Caller-provisioned disposable PostgreSQL; creates/drops guarded `free_test_parsing_*` databases |
| `test:live-model` | Real Docling/layout conversions; model weights may download; no PostgreSQL |
| `test:service` | A real native PDF through a `kei-worker` process and DBOS, read back over HTTP; PostgreSQL and Docling models |
| `test:recovery` | Worker process recovery (kill and restart, SIGSTOP, publication crashes); PostgreSQL |

Database tiers require `PARSING_TEST_DATABASE_URL` naming an existing disposable
database: user `postgres`, loopback host, port 5432, database `free_test_*`.
The account must be able to create databases. The guard runs before connecting;
tests never fall back to a runtime database URL. Tests create fresh databases
per case, launch a DBOS worker in the test process on each (the recovery and
service tiers spawn `kei-worker` processes instead), and remove only those
databases in cleanup. The opt-in database outage test also needs
`PARSING_TEST_POSTGRES_CONTAINER`, naming an isolated container labelled
`free.test=parsing`; it skips without it.

Most PDF inputs are generated within the test temporary directory. The golden
and replay cases run over the committed synthetic eight-page A4 text PDF
`tests/fixtures/synthetic-main.pdf`, whose sha256 the recorded run and the
goldens pin; it cannot be regenerated byte for byte, so replacing it means
updating those hashes. A few catalogue-layout cases need a scanned catalogue
spread; they skip unless `PARSING_FIXTURE_DIR` supplies one as `scan.pdf`. The
service smoke uses the generated eight-page native PDF by default, or
`KEI_SMOKE_PDF` for a supplied native document.

For direct diagnostics, with the run directory and source inbox configured:

```bash
KEI_SYSTEM_DATABASE_URL=… pnpm --filter parsing-service worker  # separate terminal/process
pnpm --filter parsing-service serve
```

There is no migration command: `DBOS.launch()` migrates `kei_dbos`.

The database-free conversion and extraction CLIs are
`uv run --no-sync kei-exp --help` and
`uv run --no-sync python -m kei_exp.kie.extract.run --help`, run in this
directory.
