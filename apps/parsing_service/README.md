# Parsing and extraction service

This directory holds FREE's Python document-processing service, called *kei*
in code (package `kei_exp`, settings `KEI_*`, worker `kei-worker`, database
role `kei`). FREE Studio owns authentication, Project Contexts, Extraction Schemas
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
`free`, connected as the restricted `kei` role. Studio uses the separate `free_kei_queue` login for its client in `kei_dbos`.
It enqueues `convert` and `deleteRuns` by name with portable JSON (contract and examples in
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
outside any lane limit. Each planned call starts at once, up to
`KEI_CATALOG_CHUNKS` per role, and the attempt is planned again as soon as one
ends; a Pause, Stop or failure is acknowledged only once every call it started
has ended. Attempts reach the coordination schema only through a
pool of at most four short calls to allowlisted `extraction_runtime` routines,
and no pooled connection or transaction spans a model call. After a crash,
recovery waits up to 40 s for the previous process's 30-second lease to expire:
a live owner keeps its epoch, stale attempts and other refusals fail at once,
and operators never edit lease timestamps. `deleteDurableHistoryV1` deletes a
deleted graph's history only once every linked attempt and call is quiescent by
this worker's boot clock; cancellation alone never proves that.

A schema-constrained instruction-model record reply that loops on whitespace
gets one separate durable recovery call with at most 16 whitespace characters
between JSON tokens. It keeps the original source, guidance and token budget;
both attempts stay in History. A failed bounded reply still halts the attempt;
Retry/Resume continues the bounded recovery and never repeats the original.

`KEI_RUNS` holds the runs' sources, canonical parse results; durable Extraction results live in the coordination schema. It is
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
| `KEI_OCR_REVISION` | Optional label of the OCR server's image and weights, named in the recipe of every parse that runs an OCR model; change it when they change, so earlier output is not reused |
| `KEI_EXTRACT_URL`, `KEI_EXTRACT_MODEL` | Extraction's instruction model server and the model it serves |
| `KEI_NUEXTRACT_URL`, `KEI_NUEXTRACT_MODEL` | NuExtract template extractor server and model; unset, every call goes to the instruction model |
| `KEI_GLIFORMER_URL` | Optional native GLiFormer service base URL; fields only, never selected by default. [Capabilities and deployment](model_servers/gliformer/README.md) |
| `KEI_EXTRACT_TIMEOUT` | Timeout of one extraction model call, seconds; default 1800 for full-source inventory |
| `KEI_CATALOG_CHUNKS` | Worker only: how many Catalog entries a durable attempt runs at once, how many unified Catalog discovery windows it asks at once, and how many calls of each role it runs at once, 1 to 64; unset means 1 (the GPU overlay sets NuExtract's `--max-num-seqs`); a bad value stops the worker at boot |
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
  Native text rule 5 checks a learned grid against positioned PDF words: words on
  one printed line must share a logical row, including rowspans. A contradictory
  grid with geometrically separated columns and populated cells on each line is
  rebuilt from the native lines;
  consistent multiline cells and spans are preserved. If the columns cannot be
  separated, or a continuation line is ambiguous, the table takes the existing
  unreadable-table path below.
- A PDF with text on every selected nonblank page parses natively. For this
  route decision, a non-whitespace character counts when its box meets the
  displayed page and its render mode is not 3 (invisible, such as a scan's
  search layer or a hidden note); clipping-only text (mode 7) still counts. A
  page holding only directly placed invisible text counts as blank, and a PDF
  of blank pages takes the scan path; a page without counting text but with any
  other object, including a form that wraps invisible text, sends the PDF to
  the scan path. Native parsing still reads invisible text. Substantial
  textless artwork on such pages is OCR'd as crops placed in the page's reading
  order, where a crop's `order` is its reading rank and its `crop` ordinal is
  discovery order. A native block whose text keeps an undecodable font glyph's
  control code (a minus or degree sign the font cannot map) is replaced the same
  way: its box is OCR'd as a `text` crop read in the block's place. A table so
  replaced loses its cells. Page-sized scans with a text overlay, mixed
  native/scanned documents and rotated textless artwork take the scan path, cut as
  [ingest-cuts.md](docs/ingest-cuts.md) describes. Large textless images on digital
  PDFs use artwork OCR; requests for book splitting retain
  the conservative large-image scan route. A native table with no
  readable cells outside an OCR crop (its text printed as small images or
  outlines, a blank grid, or contradictory geometry that cannot be resolved from
  native words) keeps its block for its caption, and a hybrid run
  OCRs its box as a `figure` crop read just after it. A caption that needs glyph
  repair is OCR'd as text in the block's place instead, the table crop still
  following it. The crop counts as read only with a letter or digit inside a
  table cell and no picture in its read. That crop unread, a box of the table
  overlapping OCR'd artwork by more than 5% of the box's area, or the table in
  a native run, which has no OCR, makes its page and the conversion
  incomplete, as does an incomplete OCR crop. Surya artwork that
  repeats identical empty,
  full-frame figures is interrupted and gets one recovery batch: only looping
  crops gain 24 pt of real page context. Other crop pixels stay unchanged.
  Context outside the original artwork is excluded; a text block crossing that
  boundary or another figure loop refuses publication. Scans and native-text
  replacement crops keep their existing retry policy. Any Surya input whose
  full-page generation produced looping or token-capped text and whose final
  recognition holds no text at all, read before artwork ownership filtering, is
  incomplete: lost text and a textless input are indistinguishable there. Text
  lost while other text survives is not detected.
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
  contexts, the admitted source range unchanged. Each call also asks its model
  server (when `KEI_PRIORITY_URLS` names it) with a vLLM priority: its page's
  distance from `start_page` in steps of 8 pages, 0 to 3; a call that reads no
  one page (discovery, the document's root) 0, and every call of a run without
  `start_page` (a batch member) 3. Changing the schema reruns Extraction
  without rerunning OCR.
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
  call. Catalog entry calls can retry a whitespace loop between JSON tokens once
  with a bounded grammar. Durable recovery preserves the original source,
  guidance and budgets. Retry reuses the saved recovery and completed entries.
- The task scope is the schema's `recordScope` (`document` for Article,
  `records` for a Catalog; `tests/fixtures/contracts/record-scope.json`). A
  declared scope must match `options.strategy`; an undeclared one (CLI,
  harness) is the strategy's. A `document` result that is not exactly one
  record fails (`record_scope_violation: ...`) and is never retained; so does an
  Article whose root no value context answered (`article_root_unanswered: ...`)
  rather than retain an all-null root.
- Article extracts the document as one object, which may contain arrays; `options.article` holds its settings.
  Article version 22 grounds in one call the claims that fit its input and reply budgets. A claim answers with its
  primary evidence; the context attributing a list item or nested object is asked once for that item's claims and
  retained on each of them, and a claim of the record itself carries none. The model's evidence stays primary: a word
  a hyphen splits at a page or column end is cited with its other half as context, whichever half was chosen, and a
  page end without a hyphen joins nothing. Complete structured replies are budgeted before admission; oversized
  batches split without truncating source evidence. Unanswered claims and malformed context replies remain
  incomplete; NONE is a completed rejection.
  Every Catalog uses unified (result version 3). An omitted Catalog settings object uses defaults version 12.
  `options.unified = {defaults, input_tokens?, output_tokens?, overlap?, candidates?, headings?}` runs the unified
  Catalog: result version 3, no recipe and no character limits (a request naming either is refused). Only defaults
  version 12 is accepted; the number is recorded as the execution's provenance, never read as a switch.
  Discovery reads records across physical pages within counted token budgets, discovers peer records according to
  the schema, identifies shared table qualifications, and pipelines children discovery for settled records. A child
  owns its lines and reads its enclosing record's remaining text as context. Durable runs save entries once their
  ranges and context are settled, while discovery continues over later windows. Later discoveries cannot change
  already captured calls. An entry's reply may use the served context its input leaves, with its reply reserve as
  the floor. Field instructions preserve complete source expressions and identifying qualifications, without
  field-specific cleanup.
  Each value is read once, and a value located in its record's own text is linked by rule (`lexical`): locality uses
  the record's owned ranges, not a list item's identifying anchor cell. A missing or unlocated quote stays a proposal
  without Evidence. Links keep record attribution context alongside value spans. A scalar located outside the
  record's owned ranges (inherited from a heading) requires an independent reading without the candidate value,
  using intervening source to expose superseded headings. That reading returns the field's value alone, or null,
  with no quote: only a candidate it equals receives Evidence (`verification`), at the place code located for the
  entry's own quote; a null or a different value rejects the candidate, and the check never substitutes a different
  value. Only the record's own text or its admitted context can supply that quote: intervening records are shown
  to judge supersession, not to supply inherited values. Records that share their earliest admitted heading are
  read in one call per field, up to 16 records at a time: the source from that heading to the last of them is shown
  once, each record under its own label, and each record's reading is still judged alone. With multiple inherited
  fields, sharing can require more calls than the individual check, which batches those fields per record. A child,
  a record whose context does not all precede it, and a shared reply that is not valid keep one call per record.
  Which records share a heading is known once discovery is complete: a durable run that reads entries earlier keeps
  such a value as a `verification_pending` proposal until then. A value whose own check cannot fit the verification
  budget (the source from its heading to the record is too long) stays a `verification_over_budget` proposal:
  final, so the record is saved and processing completes, with a `verification_over_budget` issue; only a failed or
  invalid reply (one that is not the value alone included) stays undecided, a `verification_unresolved` proposal.
  Disagreeing accepted values go to arbitration with their source.
  Known limits: a heading value reaches this check only when the entry model quotes the heading, although the
  entry prompt says CONTEXT is not part of the record; a model that obeys strictly leaves the field null. A list
  item's value quoted from a sibling item's text is still located, and linked, by rule. The independent reading
  names no source: when it agrees, nothing tells a value it took from another record's text from one it read at
  the admitted heading. The verification reserve (2048 tokens) can cut off a long inherited value's reading, which
  then stays an unresolved proposal.
  There is no verification switch: Studio's Pro mode (every value judged again) is retired, unmeasured on this
  version, and a request naming `verification` is refused. Studio admits defaults 12 for every new Catalog. The
  [pipeline map](docs/extraction-experiments.md#pipeline-map) traces each method's calls.

Limitations:

- Counted requests need each role's server to count them before the call:
  vLLM's `/tokenize` and its reported context size, or, for GLiFormer fields,
  the service's own `/tokenize` and the input ceiling its `/info` reports;
  otherwise the request is refused before any call. Oversized input is
  reported, never clipped.
- `complete` applies to record values and is not a recall score: array-item
  recall and semantic correctness still need evaluation. Document-level fields
  are listed as `unverified`.
- Field instructions include allowed labels explicitly: constrained decoding
  alone does not show those choices to the instruction model.
- The model judges heading applicability. A stale heading the model accepts can still be wrong.
  Standing headings can be omitted when requests have no room; long histories
  repeat context references and one omission row per range per entry in artifacts.
- Native word alignment constrains physical rows; it cannot infer a missing
  logical distinction when the learned grid is geometrically consistent. Shared
  qualification classification and complete field interpretation remain model
  decisions. Structural completion and locatable quotes do not prove semantic
  correctness.

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
`transcription/` and the layout cut in `cut.py`; `weights.py` keeps Docling's
weights where both read them without asking the Hugging Face hub. `models.py`
holds lightweight
OCR records for the API; `transcription/specs.py` owns their Docling
specifications. `kie/runner.py` orchestrates ingest and OCR;
`kie/ingest_cache.py` owns ingest generation reuse, recovery and publication;
`reuse.py` finds another run's result and ingest of the same recipe.
`result.py` publishes canonical pages and manifests; `pagefile.py` validates
their identities and hashes. `kie/passages.py` reads those artifacts as the
`Evidence`/`Passage` view used by extraction; it imports
neither. `kie/extract/` performs record discovery, structured extraction,
grounding and result publication; its
[ownership table](docs/extraction-experiments.md#ownership) names each
module's responsibility.
The designs under `docs/design/` are the contracts that code cites as
`spec N.N` or `design §N`.

## Codex extraction

`KEI_EXTRACT_PROVIDER=codex-cli` selects the deployment-owned Codex login for both extraction roles;
`KEI_EXTRACT_MODEL` must name an available Codex model. The root launcher's `compose.codex.yaml` maps
`KEI_CODEX_MODEL` to it and shares Studio's login volume. Use `FREE_GPU=off` so the default GPU extraction
servers do not start. The image contains the pinned standalone Codex executable; `KEI_CODEX_BINARY` can
select another executable for diagnostics. The extraction selectors discover the login's current Codex catalog
and offer every visible model that supports the low reasoning effort each call requests, for both roles. `KEI_EXTRACT_MODEL` remains the deployment default; explicit choices
are saved as `codex:<model-id>` and pinned by the normal durable execution path. Discovery runs only for the
listing, never inside a planning round.

Each captured call starts one ephemeral app-server thread in an empty directory, with its exact saved instructions,
source and JSON schema. Shell, network tools, apps, MCP servers and delegation are disabled; any tool request or
context compaction fails the call. There is no separate extraction, result or review path.

Codex does not provide preflight tokenization or a hard per-turn output limit. Policy `codex:utf8-budget-v1`
reserves the UTF-8 bytes of the request plus 12,288 tokens for framing, within a 65,536-token planning ceiling.
The capture labels this as `input_counting: upper_bound`, never an exact count. Returned input usage must fit the
reservation, the reported model window must cover the planning ceiling, and reported output usage must fit the
saved reply reserve; otherwise the call fails before publishing values. Output limits are checked after inference.
Small explicit method budgets may therefore be refused: use a bounded Article context of at least 32,768 and
increase counted Catalog input budgets beyond the framing allowance, or keep the default full Article mode.
The policy is pinned with every capture, so later changes require a new policy version. Discovery text may be
shown while generated, but only a validated completed reply becomes a checkpoint.

## Claude Code extraction

`KEI_EXTRACT_PROVIDER=claude-code` selects the deployment-owned Claude Code login for both extraction roles
([ADR 0025](../../docs/adr/0025-deployment-owned-claude-code-extraction.md)); `KEI_EXTRACT_MODEL` must name a
full model ID, such as the one `claude -p --output-format json` reports in `modelUsage`. The root launcher's
`compose.claude.yaml` maps `KEI_CLAUDE_MODEL` to it and passes `CLAUDE_CODE_OAUTH_TOKEN`. Use `FREE_GPU=off`.
The image contains the standalone `claude` executable at Studio's pinned version; `KEI_CLAUDE_BINARY` can select
another executable for diagnostics. The CLI has no model catalog, so the selectors offer the deployment model only,
reachable while `claude auth status` sees a credential.

Each captured call runs one `claude -p` process in an empty directory that is also its home and configuration
directory, with its exact saved instructions, source (on standard input) and JSON schema. It inherits only the
token, locale, proxy and certificate variables. Built-in tools, MCP servers, setting sources, skills and
non-essential traffic are disabled; the structured-output tool is the only one accepted. Any other tool, server
tool, compaction, or a usage report naming another model fails the call.

Policy `claude:utf8-budget-v1` reserves the UTF-8 bytes of the request plus 4,096 tokens for framing, within a
65,536-token planning ceiling, labelled `input_counting: upper_bound`. Reported input usage is the sum of
uncached, cache-read and cache-creation tokens. It must fit the reservation, the reported context window must cover
the ceiling, and output usage must fit the reply reserve. The CLI receives the reserve as
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` but continues a cut-off reply before failing, so the output check after inference
is what holds. Discovery streams the structured reply's partial JSON while it is generated.

## Verification

From the FREE root, install once with `pnpm --filter parsing-service install:python`.
All commands use this directory's locked Python environment. The service never runs
torch on a GPU (layout and native parsing use the CPU, OCR is a model server), so
on Linux x86_64, the image's platform, the lock takes torch, torchvision and
torchaudio from PyTorch's CPU index, without CUDA libraries; other platforms,
Linux aarch64 included, keep PyPI's wheels.

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
