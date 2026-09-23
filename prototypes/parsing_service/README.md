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
root. Root Compose builds this directory once and uses that image for the API,
schema migration and worker. The API listens on port 8001 inside the Compose
network. Studio reaches it through `KEI_EXP_URL`.

The API and worker share a PostgreSQL job database, `KEI_SLOT` and `KEI_RUNS`.
Apply the job schema before starting either process. PostgreSQL/Procrastinate
own admission and job status. One worker holds an exclusive process lock per
slot and reconciles interrupted jobs when it starts; an API restart does not
stop that worker. Recovery reruns the job; page checkpoint/resume is not part of
this imported implementation.

`KEI_RUNS` contains uploaded sources, canonical parse results and extraction
results. It is durable service data: later Extractions need the original parse
generation. Keep this volume with the job database across restarts. Model
weights under `/models` are a separate cache. Debug files and live token
previews are never authoritative Evidence.

| Setting | Purpose |
| --- | --- |
| `KEI_DATABASE_URL` | Job database; supplied by root Compose |
| `KEI_RUNS` | Shared source/result directory; `/app/runs` in the image |
| `KEI_SLOT` | Shared API/worker queue and ownership slot |
| `KEI_VLLM_URL` | OCR chat-completions endpoint, normally the `ocr_model` service |
| `KEI_EXTRACT_URL`, `KEI_EXTRACT_MODEL` | Extraction endpoint and default model |
| `KEI_EXTRACT_TIMEOUT` | Timeout of one extraction model call, seconds |
| `KEI_ADMISSION_LIMIT` | Maximum unfinished parse/extraction jobs per slot |
| `KEI_MAX_UPLOAD_BYTES`, `KEI_MAX_PAGES` | Admission limits |

Root Compose owns model processes. The standalone `kei-dev` UI launcher and
CLI `--start-server` option are intentionally absent. A configured model server
is required for scanned OCR and Extraction; native parsing uses Docling locally.

## HTTP and evidence contract

- `POST /api/runs` accepts a PDF and returns 202 only after durable admission.
  `page_source` is `pdf` (single pages, the default) or `ingest` (two-page
  spreads). With `ingest`, an optional `ingest` JSON form field carries
  splitter settings such as gutter overrides; both are recorded in the parse
  recipe.
  `GET /api/runs/{id}` is the authoritative job status; `/events` supplies SSE.
- A completed parse exposes `/source.pdf`, `/result`, `/pages/{page}` and
  `/output.md` below `/api/runs/{id}`. The canonical result is version 4:
  a manifest plus hashed page files bound to one generation.
- `POST /api/runs/{id}/extract` accepts `{schema, options}` against a complete
  parse. `GET /api/runs/{id}/extractions/{extraction_id}` returns its status and
  final result. Changing the schema reruns Extraction without rerunning OCR.
- Extraction Evidence names canonical segments `p{page}_s{index}`. Page numbers
  are physical, one-based PDF pages; segment indexes are zero-based. Geometry
  uses PDF points measured from the top-left. Native Docling items retain their
  own boxes; coarse input boxes are marked explicitly.
- Results preserve the parse generation/digest, schema, options, model, prompt
  version, fingerprint, records, Evidence and diagnostics. Ungrounded values
  remain explicit. Document-level fields are currently listed as `unverified`;
  `complete` applies to record values.
- `options.catalog = {recipe, input_tokens?, output_tokens?}` on a Catalog
  request selects a recipe, such as `numbered-catalogue-de@1`. It returns
  result version 2: structural segmentation with a coverage ledger, one bounded
  call per entry, and code-verified candidates (accepted, proposed, rejected)
  with code-point span Evidence. Without it, Catalog runs generic discovery
  (version 1). The extraction endpoint must expose its tokenizer (Ollama
  `/api/show` or vLLM `/tokenize`) and its context size. Otherwise the request
  is refused before any call. See the
  [grounded catalogue design](docs/superpowers/specs/2026-09-23-grounded-catalogue-design.md).

The API is an internal processor and provides no researcher authentication.
Only Studio exposes researcher-facing operations and enforces ownership.
For canonical file details see the
[evidence specification](docs/superpowers/specs/2026-09-21-canonical-evidence-design.md).
The imported [job-backend study](docs/job-backend.md) records the worker-ownership
experiments; it is historical rationale, not the FREE deployment runbook.

## Code organization

`api.py` exposes HTTP operations; `jobs/` owns durable admission, workers and
events; `runs.py` projects job state and resolves run artifacts. The OCR runner
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
| `test:service` | Real native PDF through API + worker + PostgreSQL, with Docling models |
| `test:recovery` | Process/worker recovery; the conversion cases also load Docling models |

Database tiers require `PARSING_TEST_DATABASE_URL` naming an existing disposable
database: user `postgres`, loopback host, port 5432, database `free_test_*`.
The account must be able to create databases. The guard runs before connecting;
tests never fall back to the runtime `KEI_DATABASE_URL`. Tests create fresh
databases per case and remove only those databases in cleanup.

The database pause test is additionally opt-in: set
`PARSING_TEST_POSTGRES_CONTAINER` to a disposable container labelled
`free.test=parsing`. This must be an isolated test server: the test pauses and
unpauses the whole container. Without it only that outage case skips.

Most PDF inputs are generated within the test temporary directory. A few
upstream golden/replay and catalogue-layout cases require the exact original
`main.pdf` and `Beier1988_GAC_02_Catalogue7.pdf`. They remain optional and skip
when absent; set `PARSING_FIXTURE_DIR` to supply those originals. Their recorded
JSON and golden assertions are preserved unchanged. The service smoke uses the
generated eight-page native PDF by default, or `KEI_SMOKE_PDF` for a supplied
native document with at least two pages.

For direct diagnostics after configuring the database and run directory:

```bash
pnpm --filter parsing-service db:migrate
pnpm --filter parsing-service worker  # separate terminal/process
pnpm --filter parsing-service serve
```

The database-free conversion and extraction CLIs remain available through
`uv run --no-sync kei-exp --help` and
`uv run --no-sync python -m kei_exp.kie.extract.run --help` in this directory.
