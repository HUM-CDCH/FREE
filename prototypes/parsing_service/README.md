# Parsing and extraction service

This directory owns FREE's Python document-processing service. Its implementation
was imported from kei-exp commit `93b9435c2b9a01a5424758d917c058fc79bbc159`.
The Python package remains `kei_exp`; neither deployment nor tests require the
original repository. The obsolete `app/` Docling service has been replaced.

FREE Studio owns authentication, Project Contexts, Extraction Schemas and review.
This internal service owns PDF parsing, canonical Evidence, Article and Catalog
Extraction, and durable processing jobs. Studio is its only product UI.

## Runtime

Run the complete deployment with `pnpm dev` or `pnpm production` from the FREE
root. Root Compose builds this directory once and uses that image for the API
and the worker. The API listens on port 8001 inside the Compose network; Studio
reaches it through `KEI_EXP_URL`. The API has no database: it serves the model
listings and the files a run has published, and nothing else.

The worker (`kei-worker worker`) is kei's DBOS application: name `kei`,
application version `kei@1`, system schema `kei_dbos` in Studio's database
`free`, connected as the restricted `kei` role. Studio enqueues `convert`,
`extract` and `deleteRuns` by name with portable JSON (contract and examples in
`tests/fixtures/contracts/`) on four lanes: `kei-convert-large`,
`kei-convert-small` (a document of at most 30 pages), `kei-extract` (priority 1
interactive before 10 batch) and `kei-gc`. Each lane's worker limit equals its
global limit, so a cancelled workflow whose native step is still running keeps
its slot until the step returns.

One worker per slot: it holds `KEI_RUNS/.worker-<slot>.lock` for its lifetime
(a second one on the same slot exits at once), reads the database clock as its
boot timestamp, then launches DBOS, which migrates `kei_dbos` and recovers the
slot's pending work (executor `kei-<slot>`). A crash re-executes the step that
was running and reuses every checkpointed one. A cancel or a deadline stops a
step at its next check (before model work, between pages while cutting, between
Catalog entries and records); a running native call finishes first.
`deleteRuns` (`gc.py`, `boot.py`) deletes the runs of the conversions Studio
names and then those conversions' history, plus other kei history Studio names,
each only once no kei workflow that could still write it is live or stopped
since this worker booted. A run also waits until nothing in it was written for
24 h.

`KEI_RUNS` contains the runs' sources, canonical parse results and extraction
results. It is durable service data: later Extractions need the original parse
generation. `KEI_SOURCE_INBOX` is where Studio stages source PDFs; kei only
reads it. Model weights under `/models` are a separate cache. Debug files are
never authoritative Evidence.

| Setting | Purpose |
| --- | --- |
| `KEI_SYSTEM_DATABASE_URL` | Worker only: kei's DBOS system database (role `kei` on `free`); required |
| `KEI_RUNS` | Shared source/result directory; `/app/runs` in the image |
| `KEI_SOURCE_INBOX` | Staged source PDFs, written by Studio, read by the worker |
| `KEI_SLOT` | The worker's slot: its lock file and its DBOS executor `kei-<slot>` |
| `KEI_VLLM_URL` | OCR chat-completions endpoint, normally the `ocr_model` service |
| `KEI_OCR_MODEL` | Default OCR model of a parse that names none (default `surya`) |
| `KEI_EXTRACT_URL`, `KEI_EXTRACT_MODEL` | Extraction's instruction model server and the model it serves |
| `KEI_NUEXTRACT_URL`, `KEI_NUEXTRACT_MODEL` | NuExtract template extractor server and model; unset, every call goes to the instruction model |
| `KEI_EXTRACT_TIMEOUT` | Timeout of one extraction model call, seconds |
| `KEI_CATALOG_CHUNKS` | Worker only: chunks a grounded Catalog's entries run in at once, 1 to 64; unset means 1 (the GPU overlay sets NuExtract's `--max-num-seqs`) |
| `KEI_MAX_UPLOAD_BYTES`, `KEI_MAX_PAGES` | Limits `convert` enforces on a staged source |

Root Compose owns model processes. The standalone `kei-dev` UI launcher and
CLI `--start-server` option are intentionally absent. A configured model server
is required for scanned OCR and Extraction; native parsing uses Docling locally.

## HTTP and evidence contract

- `convert` takes `{source, source_sha256, source_name, page_source, ingest,
  model, layout_model, cut, debug}`: the staged PDF's path relative to
  `KEI_SOURCE_INBOX`, the SHA-256 `prepare_run` verifies its copy against, and
  the optional Ingestion Model Choice (`model` for OCR, `layout_model`; kei's
  defaults otherwise). `page_source` is `pdf` (single pages, the default) or
  `ingest` (two-page spreads), whose optional `ingest` object carries splitter
  settings such as gutter overrides; both are recorded in the parse recipe. It
  returns `{ok: true, run_id, generation, page_count, source_sha256,
  page_source}`; the run ID derives from the workflow ID. Every workflow fails
  as `{ok: false, code, reason, retryable}`.
- A completed parse exposes `/result` and `/pages/{page}` below `/api/runs/{id}`.
  The canonical result is version 5: a manifest plus hashed page files bound to
  one generation. Native Docling tables retain cells with row/column spans, raw
  parent-text offsets, and measured page boxes when available. Scan tables
  remain coarse until cell geometry has been independently evaluated.
- `extract` takes `{run_id, generation, request: {schema, options}}` against a
  complete parse of that generation and publishes its artifact at
  `extractions/<extraction id>/result.json`, the extraction ID being its
  workflow ID's suffix; `GET /api/runs/{id}/extractions/{extraction_id}` serves
  it, and answers 404 until it is published (its status is the workflow's).
  Changing the schema reruns Extraction without rerunning OCR.
- Extraction calls take one of two roles. `fields` reads values off the source
  (document, record and grounded entry calls); `reasoning` decides over labelled
  text (discovery, grounding, arbitration). `GET /api/extraction-models` lists
  the deployment's models (`instruct`, and `nuextract` when configured), the
  roles each may take, whether its server serves it now, and the default per
  role: NuExtract fills fields, the instruction model reasons.
  `options.models = {fields?, reasoning?}` chooses per run; a model that cannot
  take a role (NuExtract cannot reason) is refused before any call. NuExtract
  receives the reply schema as its template and the instructions only through
  the chat template's kwargs.
- `GET /api/ingestion-models` lists the OCR and layout models a new parse may
  run on, and the default per role (`KEI_OCR_MODEL`, default `surya`, and
  `layout_heron_101`); it is shaped like `/api/extraction-models`. An OCR model
  is `serving` only while the OCR server has it loaded, which is what the
  listing observed, not a promise. Layout detectors run inside this service and
  are always selectable. A page with a text layer uses neither.
- Extraction Evidence names canonical segments `p{page}_s{index}`. Page numbers
  are physical, one-based PDF pages; segment indexes are zero-based. Geometry
  uses PDF points measured from the top-left. Native Docling items retain their
  own boxes; coarse input boxes are marked explicitly.
- Results preserve the parse generation/digest, schema, options, model (the
  fields model), `models` per role, prompt version, fingerprint, records,
  Evidence and diagnostics. Ungrounded values
  remain explicit. Document-level fields are currently listed as `unverified`;
  `complete` applies to record values.
- `options.catalog = {recipe, input_tokens?, output_tokens?}` on a Catalog
  request selects a recipe, such as `numbered-catalogue-de@1`. It returns
  result version 2: structural segmentation with a coverage ledger, one bounded
  call per entry, and code-verified candidates (accepted, proposed, rejected)
  with code-point span Evidence. The worker runs its entries in
  `KEI_CATALOG_CHUNKS` chunks at once; the artifact records the count used as
  `chunks`, outside the fingerprint. Without a recipe, Catalog runs generic
  discovery (version 1). The extraction endpoint must count requests on vLLM's
  `/tokenize` and report its context size. Otherwise the request
  is refused before any call. See the
  [grounded catalogue design](docs/superpowers/specs/2026-09-23-grounded-catalogue-design.md).

The API is an internal processor and provides no researcher authentication.
Only Studio exposes researcher-facing operations and enforces ownership.
For canonical file details see the
[evidence specification](docs/superpowers/specs/2026-09-21-canonical-evidence-design.md).
The imported [job-backend study](docs/job-backend.md) records the worker-ownership
experiments; it is historical rationale, not the FREE deployment runbook.

## Code organization

`api.py` exposes the read-only HTTP operations; `runs.py` is a run's layout on
disk. `workflows/` is kei's DBOS application: its configuration and lanes
(`config.py`), the portable contracts (`contracts.py`), `convert`, `extract`,
`deleteRuns` with the boot boundary (`gc.py`, `boot.py`), the slot lock
(`slot.py`) and the `kei-worker` CLI (`cli.py`); `failures.py` classifies what a
step raised into a retry or a portable failure code. The OCR runner
lives in `kie/stages/ocr.py`, with native/Surya/VLM adapters in `transcription/`.
`result.py` publishes canonical pages and manifests; `pagefile.py` validates
their identities and hashes. `kie/extract/` reads those artifacts and performs
record discovery, structured extraction, grounding and result publication.
The recipe path is split across these files:
- `kie/recipe.py` and `kie/recipes/` hold the recipes;
- `kie/stages/{layout,route,segment}.py` produce lines, roles and blocks;
- `kie/segmentation.py` holds the artifact;
- `kie/extract/{grounded,tokens,locate}.py` do bounded extraction, token
  counting and span location;
- `kie/boundaries.py` handles boundary labels and block-F1
  (`python -m kei_exp.kie.boundaries report|prefill|score RUN_DIR`, read-only
  on the run).
The specifications under `docs/` retain the imported internal model contracts.

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
databases in cleanup.

Most PDF inputs are generated within the test temporary directory. A few
upstream golden/replay and catalogue-layout cases require the exact original
`main.pdf` and `Beier1988_GAC_02_Catalogue7.pdf`. They remain optional and skip
when absent; set `PARSING_FIXTURE_DIR` to supply those originals. Their recorded
JSON and golden assertions are preserved unchanged. The service smoke uses the
generated eight-page native PDF by default, or `KEI_SMOKE_PDF` for a supplied
native document.

For direct diagnostics, with the run directory and source inbox configured:

```bash
KEI_SYSTEM_DATABASE_URL=… pnpm --filter parsing-service worker  # separate terminal/process
pnpm --filter parsing-service serve
```

There is no migration command: `DBOS.launch()` migrates `kei_dbos`.

The database-free conversion and extraction CLIs remain available through
`uv run --no-sync kei-exp --help` and
`uv run --no-sync python -m kei_exp.kie.extract.run --help` in this directory.
