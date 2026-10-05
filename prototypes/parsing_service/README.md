# Parsing and extraction service

For extraction stage ownership, experimental method settings and reproducible
ablation commands, see [Extraction stages and controlled experiments](docs/extraction-experiments.md).

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
`free`, connected as the restricted `kei` role. Studio enqueues `convert` and
`deleteRuns` by name with portable JSON (contract and examples in
`tests/fixtures/contracts/`), and durable Extraction attempts
(`extractDurableV1`) with only their identities, on four lanes:
`kei-convert-large`, `kei-convert-small` (a document of at most 30 pages),
`kei-extract` (durable attempts, priority 1 interactive before 10 batch) and
`kei-gc`. Each lane's worker limit equals its
global limit, so a cancelled workflow whose native step is still running keeps
its slot until the step returns.

One worker per slot: it holds `KEI_RUNS/.worker-<slot>.lock` for its lifetime
(a second one on the same slot exits at once), reads the database clock as its
boot timestamp, then launches DBOS, which migrates `kei_dbos` and recovers the
slot's pending work (executor `kei-<slot>`). A crash re-executes the step that
was running and reuses every checkpointed one. A cancel or a deadline stops a
conversion at its next check (before model work, between pages while cutting); a
running native call finishes first. A durable attempt stops at its coordination
boundaries. Studio's `collectGarbage` names the conversions whose runs no
surviving revision and no durable head (tombstoned heads included) references,
and the kei history that may go. `deleteRuns` (`gc.py`, `boot.py`) deletes each
run only once its conversion can no longer write (not live, not stopped since
this worker booted), then that conversion's history; it also deletes the other
kei history Studio names. A deleted durable graph's history goes through
`deleteDurableHistoryV1` once its native calls are quiescent. A run waits until nothing in it was written
for 24 h. kei never reads Studio's schemas.

`KEI_RUNS` contains the runs' sources, canonical parse results and recipe
segmentations; durable Extraction results live in the coordination schema. It is durable service data: later Extractions need the original parse
generation. `KEI_SOURCE_INBOX` is where Studio stages source PDFs; kei only
reads it. Model weights under `/models` are a separate cache. Debug files are
never authoritative Evidence.

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
| `KEI_SLOT` | The worker's slot: its lock file and its DBOS executor `kei-<slot>` |
| `KEI_VLLM_URL` | OCR chat-completions endpoint, normally the `ocr_model` service |
| `KEI_OCR_MODEL` | Default OCR model of a parse that names none (default `surya`) |
| `KEI_OCR_REVISION` | Optional label of the OCR server's image and weights, named in every served parse's recipe; change it when they change, so earlier output is not reused |
| `KEI_EXTRACT_URL`, `KEI_EXTRACT_MODEL` | Extraction's instruction model server and the model it serves |
| `KEI_NUEXTRACT_URL`, `KEI_NUEXTRACT_MODEL` | NuExtract template extractor server and model; unset, every call goes to the instruction model |
| `KEI_GLIFORMER_URL` | Optional native GLiFormer service base URL; fields only, never selected by default. [Capabilities and deployment](model_servers/gliformer/README.md) |
| `KEI_EXTRACT_TIMEOUT` | Timeout of one extraction model call, seconds; default 1800 for full-source inventory |
| `KEI_CATALOG_CHUNKS` | Worker only: chunks a durable attempt plans a Catalog's entries in at once, 1 to 64; unset means 1 (the GPU overlay sets NuExtract's `--max-num-seqs`); a bad value stops the worker at boot |
| `KEI_MAX_UPLOAD_BYTES`, `KEI_MAX_PAGES` | Limits `convert` enforces on a staged source |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `FREE_TRACE_CAPTURE` | Worker only: optional model-call tracing to Phoenix and what it records ([development](../../docs/operations/local-development.md#model-call-traces-phoenix), [production](../../docs/operations/deployment.md#model-call-traces-phoenix)); unset, nothing is traced |

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
- Extraction runs only as durable attempts (`extractDurableV1`, below): the
  attempt reads its pinned selection and source from the coordination schema,
  and its saved values are retained there, never published beside the run or
  served by this API. A request may name
  `start_page`, the page the researcher is reading: the unified Catalog reads
  the records nearest it first and Article its bounded value contexts, the
  admitted source range unchanged.
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
  are always selectable. Native parsing is used when the PDF has text on every
  selected nonblank page and no substantial textless embedded artwork. When all
  selected nonblank pages have native text, substantial textless images or vector
  forms are OCR'd as crops while the surrounding prose stays native. Overlapping
  artwork becomes one crop; native captions outside it remain native. The result
  keeps both the native blocks and OCR crop transforms in page reading order:
  each crop reads before the next native block below it in its column (or
  after the last above it, and after any earlier column), and its crop's
  `order` is its rank in that reading order (its `crop` ordinal is discovery
  order, not reading order). Running headers and footers stay in the page file
  where Docling put them but never place a crop, and the page's Markdown drops
  them as Docling's native export does.
  Page-sized scans with a text overlay, mixed native/scanned documents and rotated
  textless artwork retain the scan path. A native table with no readable cells
  outside an OCR crop makes conversion incomplete; an incomplete OCR crop also
  makes its page and conversion incomplete.
  Automatic crops split only at gaps confirmed free of ink. A proposed boundary
  crossing printed content keeps its adjacent blocks together; other safe cuts remain. A page with only
  headers/footers accounting for at least 90% of its ink is transcribed whole, including its furniture.
- Extraction Evidence names canonical segments `p{page}_s{index}`. Page numbers
  are physical, one-based PDF pages; segment indexes are zero-based. Geometry
  uses PDF points measured from the top-left. Native Docling items retain their
  own boxes; coarse input boxes are marked explicitly.
- Results preserve the parse generation/digest, schema, options, model (the
  fields model), `models` per role, prompt version, fingerprint, records,
  Evidence and diagnostics. Ungrounded values
  remain explicit. `calls` lists every model call; a generic Catalog record
  call that looped on whitespace and was read on its one bounded-grammar retry
  is kept, failed, with `recovered: true`, and does not by itself make the
  result incomplete. Document-level fields are currently listed as `unverified`;
  `complete` applies to record values.
- The task scope is the schema's `recordScope` (`document` for Article, `records`
  for a Catalog; `tests/fixtures/contracts/record-scope.json`). A declared scope
  must match `options.strategy`; an undeclared one (CLI, harness) is the
  strategy's. A `document` result that is not exactly one record fails as
  `extraction_failed` (`record_scope_violation: ...`) and is never published;
  so does an Article whose root no value context answered
  (`article_root_unanswered: ...`) rather than publish an all-null root.
- Article extracts the document as one object (which may contain arrays): no
  identity inventory; the fields model reads every record field from the complete
  source (or, bounded, from each value context, whose answers are assembled with
  every array item kept, cross-context repeats flagged `possible_repeated_items`
  and disagreeing scalars null with a conflict). Its `inventory` holds the one
  document identity. Grounding sees the full source plus the root's fields, and
  never accepts an Article value solely because its string occurs once.
  `/tokenize` must report the serving context for both roles: each request
  reserves output tokens, and oversized input is reported rather than clipped.
  The root's reply may use the served context its counted input leaves (at
  least 4,096 tokens), since a long list is restated item by item; a bounded
  context keeps as many reply tokens as its request counts.
  Durable calls fit whole correction examples above that required reply floor,
  then allocate spare capacity to the reply. The captured request records its
  exact examples, tokenizer identity, effective ceiling and reply allowance;
  guidance edits never recompose a started call or unchanged-selection retry.
  `record_chars` and `discovery_chars` apply only to generic Catalog. Array-item
  recall and semantic correctness still need evaluation; `complete` is not a
  recall score.
  Field instructions include allowed labels explicitly: constrained decoding
  alone does not show those choices to the instruction model.
- `options.catalog = {recipe, input_tokens?, output_tokens?}` on a Catalog
  request selects a recipe, such as `numbered-catalogue-de@1`. It returns
  result version 2: structural segmentation with a coverage ledger, one bounded
  call per entry, and code-verified candidates (accepted, proposed, rejected)
  with code-point span Evidence. The worker runs its entries in
  `KEI_CATALOG_CHUNKS` chunks at once; the result records the count used as
  `chunks`, outside the fingerprint. Without a recipe, Catalog runs generic
  discovery (version 1). The extraction endpoint must count requests on vLLM's
  `/tokenize` and report its context size. Otherwise the request
  is refused before any call. See the
  [grounded catalogue design](docs/superpowers/specs/2026-09-23-grounded-catalogue-design.md).
- `options.unified = {defaults, input_tokens?, output_tokens?, overlap?, headings?,
  verification?}` runs the unified Catalog (`kie/extract/unified.py`,
  `discovery.py`): result version 3, no recipe and no character limits (a
  request naming either is refused). Every nonblank source line is accounted
  for in a ledger (`entry`, `other`, `unresolved`, `withheld`); discovery,
  entries, document fields, verification and arbitration all run in counted
  windows that read the whole admitted text, and a window that cannot be read
  leaves its range unresolved rather than clipped. Candidates are verified by a
  separate reasoning request; unverified, partial or conflicting values stay
  proposals. The internal result carries the execution record (pins and resolved
  budgets), the discovery record and each entry's work; nothing is written
  beside the run, and durable execution resumes only from its committed call
  outputs. A request the server refuses
  for itself (a non-transient HTTP error) fails only its window, which is halved
  or left failed and visible. A record the supplied source ends inside, with no
  unread text after it, ends `source_end` and does not make boundaries
  incomplete. A value printed in another cell of the table row whose cell the
  quote names is located in its own cell. Retained snapshots preserve the
  execution and discovery records as diagnostics, with each saved value's
  producing selection and source Evidence. Studio reads those snapshots
  through the durable repository; there is no extraction-artifact HTTP handoff.
  New admissions use it only where
  Studio's `FREE_CATALOG_METHOD=unified` gate is on.

The API is an internal processor and provides no researcher authentication.
Only Studio exposes researcher-facing operations and enforces ownership.
For canonical file details see the
[evidence specification](docs/superpowers/specs/2026-09-21-canonical-evidence-design.md).
The imported [job-backend study](docs/job-backend.md) records the worker-ownership
experiments; it is historical rationale, not the FREE deployment runbook.

## Code organization

`api.py` exposes the read-only HTTP operations; `runs.py` is a run's layout on
disk. `workflows/` is kei's DBOS application: its configuration and lanes
(`config.py`), the portable contracts (`contracts.py`), `convert`, the durable
Extraction workflows (`durable_extract.py`, `coordination.py`), `deleteRuns` with the boot boundary (`gc.py`, `boot.py`), the slot lock
(`slot.py`) and the `kei-worker` CLI (`cli.py`); `failures.py` classifies what a
step raised into a retry or a portable failure code. The OCR runner
lives in `kie/stages/ocr.py`, with native/Surya/VLM adapters in `transcription/`.
`models.py` holds lightweight OCR records for the API; `transcription/specs.py`
owns their Docling specifications. `kie/runner.py` orchestrates ingest and OCR;
`kie/ingest_cache.py` owns ingest generation reuse, recovery and publication;
`reuse.py` finds another run's result and ingest of the same recipe.
`result.py` publishes canonical pages and manifests; `pagefile.py` validates
their identities and hashes. `kie/passages.py` reads those artifacts as the
`Evidence`/`Passage` view shared by the recipe stages and extraction; it imports
neither. `kie/extract/` performs record discovery, structured extraction,
grounding and result publication. Its strategies and stages build their own
prompts and interpret their own replies; every model call they make goes through
`kie/extract/calls.py`, which routes it to its role's model, invokes the
`llm.py` adapter and records its `Call`. When supplied a counter (as in Article),
it also admits the request against the served context. Generic Catalog uses
character budgets and names the source text a budget cut from a call in a
`text_truncated` issue; recipe Catalog owns input-budget admission in
`grounded._Run.call`. The
[pipeline map](docs/extraction-experiments.md#pipeline-map) names the owner of
each step from the pinned request to the result Studio accepts.
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

## Durable interactive extraction candidate

Protocol 1's explicitly named `extractDurableV1`, `extractionCallV1` and
`deleteDurableHistoryV1` workflows run on the kei-extract and kei-gc lanes; with
`convert` and `deleteRuns` they are everything the worker registers. The
non-durable `extract` workflow, its artifact and progress routes and its stage
files were removed (ADR 0017, durable-only amendment). Studio admits new durable
Extractions directly. Admission commits the Extraction, its coordination head
and its dispatch workflow together. The current follow-up must pass its own
[release checks](../../openspec/changes/durable-only-extraction-review/tasks.md)
before deployment.

The worker uses a separate pool of at most four short routine calls against
`extraction_runtime`, through an explicit allowlist. Its restricted role cannot
read application or Studio DBOS tables, directly access coordination tables, or
invoke internal definer helpers. No pooled connection or transaction spans a
provider call. The pool closes at worker shutdown.

Calls capture effective models/settings, tokenizer/composer versions, complete
request bodies and guidance revisions before native execution. Successful
outputs are immutable reusable checkpoints; failed responses remain immutable
attempt-specific history and an unchanged-selection Retry uses the exact saved
request. Pause and Stop refuse new admissions while allowing reserved calls to
save. Fixed retained snapshots preserve producing inputs and correction history.
Historical Article contributions retain lineage; incompatible scalar contributions
remain explicit proposals for review.

Public deletion fences the runtime graph in the same transaction as the public
cascade. `deleteDurableHistoryV1` obtains only the fenced deleted graph through a
restricted routine, checks every linked attempt/call using the existing worker
boot clock, and deletes native histories only at quiescence. Studio releases the
retained graph and source references only after that proof. Cancellation alone
never establishes native quiescence; a cancelled call from this process retains
its references until it ends or a subsequent worker boot proves it cannot write.
