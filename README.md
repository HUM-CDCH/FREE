# FREE

FREE lets an authenticated humanities researcher turn source documents into
structured, evidence-grounded extraction results and review them.

## Start

```bash
pnpm dev          # local:      Docker Compose + containerized nginx + mock OIDC
pnpm production   # production: Docker Compose behind the host-managed nginx
```

Both use the same base `compose.yaml`; the launcher adds the local
`compose.override.yaml` or production `compose.prod.yaml` and prepares the
host-only prerequisites. Local serves https://localhost:8443/free/.

FREE contains its parsing and extraction service in
[`prototypes/parsing_service`](prototypes/parsing_service/README.md). The
service incorporates kei-exp's API, durable workers, and canonical evidence
pipeline. No separate kei-exp checkout or host-run parser is required.

## Product contract

FREE's normative product and safety contract is:

1. **Authenticated ownership.** Every Project Context, source document,
   schema, extraction, evidence link, and review decision belongs to an
   authenticated Researcher Account. Reads and writes are scoped to that
   researcher. Static assets, health endpoints, and the OIDC
   login/callback/signed-out endpoints may be public.
2. **Real authentication paths.** Local development uses an isolated mock OIDC
   provider through the same authorization-code, session, and ownership path
   used with Microsoft Entra. Production uses a single-tenant Entra
   registration; the local mock cannot be enabled there.
3. **Schema-guided extraction.** A researcher creates a Project Context,
   ingests PDFs, defines and approves an extraction schema, and runs the
   canonical extraction path over the Project Context's source documents.
   Schema suggestion feeds this path; it is not a competing extraction mode.
4. **Evidence and review.** Every populated extraction value is paired with
   locatable source evidence or visibly marked ungrounded. Complete
   accept/reject/edit review decisions are validated and stored; partial or
   structurally invalid review cannot silently become authoritative.
   Partial review decisions are saved as versioned drafts in PostgreSQL;
   only a complete, validated review is finalized. Concurrent draft edits
   report conflicts instead of silently overwriting another view's changes.
   Revert all resets saved reviews to pending and restores extraction values;
   previous review revisions remain in history, and results use only the latest
   active review.
5. **Durable, versioned state.** Project Contexts, source documents and their
   representation revisions, schema revisions, extractions, and review decisions
   survive ordinary restarts. One Extraction record carries a run from admission
   to its outcome and on to its reviews; it stays pinned to the
   source-representation and schema revisions it used, and to the extraction
   method it was admitted with (its Extraction Model Choice and Extraction
   Method Settings), so newer revisions can make it stale without rewriting its
   history. Work in progress survives too:
   it runs as DBOS workflows inside Studio and the Parsing Service, which resume
   after a restart, and its status is derived from them rather than stored twice.
6. **Project lifecycle.** A researcher can create, list, rename, and
   permanently delete a Project Context. Deletion removes its owned database
   graph and removes filesystem artifacts only when no remaining Project
   Context references them.
7. **Model-provider surface.** Each Researcher Account owns its model
   configuration, stored in PostgreSQL: its Model Connections, the Assistant
   model (the Interaction Route) and the Schema Suggestion Route, the Extraction
   Model Choice and the Ingestion Model Choice. It also holds the account's
   Extraction Method Settings: per Extraction Strategy, how future Extractions
   run (the Model Configuration page's Advanced tab). Unset settings keep the
   Parsing Service's defaults; saved settings never edit an Extraction Schema
   and never hold a key. A Project Context uses its
   owner's configuration. The Model Configuration page supports Ollama, OpenAI,
   Anthropic, Google, vLLM and OpenAI-compatible connections. A researcher's API
   keys stay in their own browser; Studio holds a copy only in memory while it
   needs one, and never in PostgreSQL, on disk, in logs or in workflow history.
   The deployment's own model servers are read-only deployment connections that
   every researcher can use: its vLLM servers with the GPU overlay, and the
   Codex CLI and Claude Code providers when the operator enables them with
   `FREE_DEPLOYMENT_CLI_PROVIDERS`; those run on the server's own CLI login. An
   unset Assistant model runs on the deployment's instruction model, and an
   unset Schema Suggestion Route follows the Assistant model. The Ingestion
   Model Choice picks the Parsing Service's OCR and layout models for new
   ingestions and reprocessing only; existing revisions never change.
   Extraction execution is delegated to the included Parsing Service; FREE
   uses the configured provider directly for Schema Suggestion and Interaction.
   For those provider calls, output formatting is automatic: selecting a connection and model is sufficient.
   FREE uses the adapter's output support and
   falls back to prompt-only generation only after an explicit unsupported-format
   response, remembering that endpoint/model/route for the server session. Returned
   results are still validated. Output formatting has no route override. On a
   vLLM connection, Schema Suggestion uses the NuExtract protocol whenever the
   model is NuExtract; nothing selects it by hand. The configuration is
   validated whenever it is saved, so there is no reset.
8. **Safe startup.** Authored forward migrations finish before Studio becomes
   ready, both for a fresh database and an already-migrated one. Studio's
   entrypoint then creates the Parsing Service's restricted database role and
   schema, and each process migrates its own DBOS system schema (`dbos`,
   `kei_dbos`) when it launches. Normal startup never resets the database or
   seeds an account, Project Context, provider, route, or credential.
9. **Proxy parity.** Production keeps its host-managed nginx; local uses
   containerized nginx. Both render the same version-controlled proxy fragment
   for `/free` routing, forwarded headers, auth callbacks, security headers,
   upload limits, and timeouts.
10. **Secrets and destructive limits.** Deployment secrets — the session
    secret, database passwords, the Entra certificate, a CLI login — enter
    through the environment or mounted files, never committed files.
    Researchers' model keys never reach the server's storage, and FREE needs no
    operating-system secret store. Forward migration replay may target the
    configured deployment database. Reset is limited to `postgres` on loopback
    port 5432 database `free`. Disposable PostgreSQL checks are limited to
    `postgres` on loopback port 5432 databases named `free_test_*`. Production
    is never reset; the single exception is the one-time, pre-production
    cutover to durable execution ([runbook](docs/operations/deployment.md#cutover-to-durable-execution-one-time-clean-slate)).

Out of scope: backward compatibility with historical API shapes, competing
deployment paths, and speculative extensibility.

## Safety boundaries

- Production nginx is host-managed — never containerized. The rendered
  fragment for it comes from the same template local nginx consumes.
- `packages/db` enforces the reset and disposable-test target restrictions
  before opening an administrative connection.
- Session cookies are signed; API writes are origin-checked; uploads are
  validated (`application/pdf`, magic bytes, 100 MiB cap).

## Verification

The commands deliberately separate fast checks from infrastructure-backed and
mutating checks:

| Command | Scope and infrastructure |
| --- | --- |
| `pnpm test` | Fast unit/static checks only; no live stack, PostgreSQL, browser, or model |
| `pnpm test:safety` | Safety/configuration checks; no running FREE stack, but Docker is required for Compose rendering and a throwaway nginx config check; no database mutation |
| `pnpm test:postgres` | Studio's DBOS workflows, db, extraction and Parsing Service PostgreSQL checks against caller-provisioned disposable loopback `free_test_*` databases; the DBOS checks create and drop their own schemas |
| `pnpm test:e2e` | Playwright browser tests; creates and removes its own Docker PostgreSQL and mock-OIDC stack, migrates it, and starts Studio locally |
| `pnpm test:service` | Isolated authenticated FREE workflow using the real Python API/worker and native PDF parsing; scripts only the extraction model boundary; checks evidence, review, and restart persistence |
| `pnpm test:all` | All deterministic tiers: typecheck, lint, unit, safety, caller-provisioned PostgreSQL integration, E2E, and the real-service workflow |
| `pnpm test:all:node` | The deterministic tiers that need no Python environment: typecheck, lint, Node unit (`test:unit:node`), safety, db and extraction PostgreSQL (`test:postgres:node`), and E2E |
| `pnpm test:ci` | CI-only aggregate; verifies the fixed disposable CI targets, migrates them, and runs `test:all:node` when `FREE_SKIP_PYTHON=1` (GitHub's job), otherwise `test:all` |
| `pnpm test:live-model` | Real Ollama and Docling smoke checks; requires the configured Ollama model and may download Docling models |
| `pnpm test:system` | Black-box contract check against its own disposable Compose project; builds and restarts the stack, scripts the external extraction-model response, sweeps garbage after project deletion, and removes its project and volumes afterward |
| `pnpm typecheck` | TypeScript checks only; no services or data mutation |
| `pnpm lint` | ESLint over Studio (React hooks rules included); no services or data mutation |

`test:live-model` and `test:system` remain deliberately outside `test:all`
and `test:ci`: the former requires a live model, and the latter builds and
restarts a full Docker stack. GitHub's Linux `verify` job runs `test:ci` with `FREE_SKIP_PYTHON=1`:
it installs no Python environment (the CUDA PyTorch wheels do not fit the
hosted runner), so the Parsing Service tiers and `test:service` run locally,
as the dated records in `docs/validation/` show: the PostgreSQL tier against
a disposable database, the fast tier with none, and `test:service` against the
stack it starts itself. `FREE_SKIP_PYTHON=1` also makes `pnpm install` skip
the parsing service's `uv sync --frozen`; leave it unset on development and
deployment hosts.

`test:service` may download Docling layout weights on first use. Supply both
`FREE_REAL_EXTRACT_URL` (a chat-completions URL) and
`FREE_REAL_EXTRACT_MODEL` to run the same workflow against a real model.
`test:service` itself is outside CI now (it runs locally, inside `test:all`);
the real-model variant is outside `test:all` as well.

Detailed prerequisites, environment variables, and database target rules are
in the [local development runbook](docs/operations/local-development.md).

## Quickstart

With Node.js 24, pnpm 10.9, Docker Desktop (Compose v2.40.0+), and `mkcert`
(`mkcert -install` once):

```bash
pnpm install
```

```bash
pnpm dev
```

Then open **https://localhost:8443/free** and sign in through the local mock
OIDC identity provider. `pnpm dev` generates the mkcert certificate when missing,
builds the images, and stops Studio and the parsing API/worker before running
`docker compose up --watch`. A failed build leaves the running
application intact. Migrations finish before the replacement processes start.
Afterwards, a browser-code change reloads in place and a server-code change
restarts Studio (Compose Watch). The
first run builds the Python image and downloads the extraction model into a
persistent cache; this can take several minutes and substantial disk space.

Native PDFs and extraction work on CPU. The launcher enables
`compose.gpu.yaml` when Docker can expose an NVIDIA GPU; that overlay starts
the Surya OCR model server for scanned PDFs and gives the extraction model
server GPU access. Set `FREE_GPU=off` to use CPU or `FREE_GPU=required` to
require the GPU stack. DGX Spark needs a compatible ARM64 `VLLM_IMAGE`; see
the deployment runbook.

Variants:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | This device only (nginx on `127.0.0.1:8443`) |
| `pnpm dev:wifi` | Also reachable from the private Wi-Fi subnet (phone testing) |
| `pnpm dev:wifi:revoke` | Remove the Windows firewall rule again |
| `pnpm dev -- --entra` | Local Compose against a configured real Entra tenant |
| `pnpm dev -- --phoenix` | Also start Phoenix, the model-call trace dashboard, on http://localhost:6006 ([capture settings](docs/operations/local-development.md#model-call-traces-phoenix)) |

Detailed host, Entra, Wi-Fi, verification, and database
instructions:
[docs/operations/local-development.md](docs/operations/local-development.md).

## Deployment

Production is the same container stack behind the host-managed nginx:

```bash
node scripts/free.mjs production
```

This validates `.env`, renders the shared nginx behavior for the host nginx
into `.nginx/free-studio-locations.conf`, builds the images, and stops Studio
and the parsing API/worker before migration. It then starts the Compose stack
detached and waits for its configured health checks. Prerequisites, `.env`,
the host nginx include, proxy trust, cutover,
and certificate rotation:
[docs/operations/deployment.md](docs/operations/deployment.md). Entra
registration and rotation:
[docs/operations/entra-authentication.md](docs/operations/entra-authentication.md).

## Extraction execution

FREE sends the pinned schema and the Source Document's run ID to the included
Parsing Service for Article or Catalog extraction. The service owns extraction
and grounding; Studio stores the returned records, evidence and diagnostics
for review. Compose wires `KEI_EXP_URL` to its private API and, with GPU access,
starts a vLLM server with the `KEI_EXTRACT_MODEL` model (default
`Qwen/Qwen3.8-27B-FP8`). Model Connections and Capability Routes are not sent
to this separate execution endpoint. Instead, every single and Batch Extraction
is requested on the Extraction Model Choice saved on the Model Configuration
page: a field model and a reasoning model picked from the models the service
lists at `GET /api/extraction-models`; an unchosen role uses the service's
defaults, and each Extraction records the models its roles ran on. Every
single and Batch Extraction is admitted with the saved method its start view
shows ("Saved advanced settings"): the Extraction Model Choice and the
Extraction Method Settings for its strategy (Article; generic Catalog; a recipe
Catalog's budgets and factors — a Batch Extraction has no recipe). Admission
compares that method with the account's saved one under the configuration
row's lock and refuses a stale one, starting nothing; otherwise it pins the
method on the Extraction (and on the Batch Extraction and each member).
`runExtraction` sends only the pinned method, also after a restart; saving new
settings affects only later admissions. A repeated request with the same
Extraction ID and method replays its Extraction; the same ID with another
method is a conflict. Extraction details show the requested method beside the
options and protocol versions the Parsing Service reports; a run from before
methods were recorded shows "Not recorded". The Parsing Service remains the
authority on method rules and re-validates every request; Studio's copy of the
rules (`packages/extraction/src/extraction-method.ts`) is pinned to it by shared
fixtures in `prototypes/parsing_service/tests/fixtures/contracts/`. Schema
Suggestion and Interaction use the configured Capability Routes, and an unset
route runs on the deployment's instruction model. Each Extraction runs as a
durable workflow: Studio hands it to the Parsing Service's worker on its
extraction lane. Article inventories distinct records across the complete source
before extracting and grounding each one. Article and Catalog have three-hour
execution deadlines, counted from when the worker starts them. Cancelling an Extraction
records the cancellation and stops the Parsing Service's work too. A failed
extraction carries the Parsing Service's own reason. There is no targeted
Catalog retry; start a new Extraction to rerun.

## Pipeline reference

Studio owns Schema Suggestion and Interaction model calls; the Parsing Service
owns Extraction model calls and grounding. A Schema Revision identifies the
approved structure used by an Extraction. Edits create new immutable revisions:
the Extraction keeps its exact Schema Revision and Source Representation Revision
pins ([schema](packages/extraction/src/schema.ts), [Studio workflow](packages/extraction/src/workflows.ts)).
Neither model keys nor document content enter Studio's workflow inputs.

| Path | Source and prompt owner | Model selection and invocation | Interpretation and publication |
| --- | --- | --- | --- |
| Single Schema Suggestion | [`suggestSchemaWorkflow`](prototypes/studio/api/_schema_generation_workflow.ts) loads pinned Markdown at workflow scope. Past the `schema-suggestion-windows` DBOS patch it cuts the whole source into gap-free windows ([`schemaSourceWindows`](prototypes/studio/api/_schema.ts), at most 48,000 characters each) and sends each whole (`window: true`) through [`generateSchemaWithModel`](prototypes/studio/api/_schema_suggestion.ts) with `schemaPrompt` and the researcher's instruction; [`reduceSchemas`](prototypes/studio/api/_schema_reduction.ts) then folds the window suggestions level by level through [`combineSchemas`](prototypes/studio/api/_schema_suggestion.ts)' union instruction. Only the windows receive the researcher's instruction: read again at the union, a document-scope exclusion ("exclude the bibliography") removed per-entry fields in a real-model probe. A run started before the patch keeps its single `generateSchema` step, which excerpts every page with `schemaSourceExcerpts`. | [`resolveModelTarget`](prototypes/studio/api/_model_execution.ts) resolves the researcher's Schema Suggestion Route through [`resolveCapabilityRoute`](prototypes/studio/api/_provider.ts). [`executeSchemaSuggestion`](prototypes/studio/api/_model_execution.ts) calls the existing general adapter or NuExtract template-generation endpoint; key access, cancellation and explicit unsupported-format fallback stay at this execution seam. Each window and each combination request is its own step with its own ten-minute signal. An answer stopped for length is `model_output_truncated`, and an Ollama connection is sent `truncate: false` so a prompt over its context fails instead of being cut (vLLM already refuses one). | `generateSchemaWithModel` applies `parseTemplate` (valid JSON first, then outer framing and `jsonrepair` as needed) and requires a root record description. The `suggestWindow:<n>` and `reduce:<level>:<group>` steps checkpoint only templates, text and page count, never source text; the outcome declares complete source coverage (a pre-patch `generateSchema` outcome may declare the page ranges `schemaSourceExcerpts` left out). [`generate_schema.ts`](prototypes/studio/api/generate_schema.ts) maps the outcome for the researcher. Approval/saving a schema is a separate revision-creating action; the saved revision records the declaration in `SchemaRevision.modelAttribution`, and revisions edited from it inherit it. |
| Per-source Batch Schema Suggestion | [`suggestSchemaBatchWorkflow`](prototypes/studio/api/_batch_suggestion_workflow.ts) past the `batch-schema-suggestion-windows` DBOS patch gives each admitted Source Representation Revision a `suggestSource:<id>:window:<n>` step per window, each re-reading the pinned source, then folds its window suggestions (their union) in `suggestSource:<id>:reduce:<level>:<group>` steps. [`suggestBatchSource`](prototypes/studio/api/_schema_suggestion.ts) supplies the per-source instruction to `generateSchemaWithModel`. A run started before the patch keeps one excerpting `suggestSource:<id>` step per source. | The same researcher's Schema Suggestion Route and `executeSchemaSuggestion`, resolved when each call runs. | `suggestBatchSource` and [`combineBatchSchemas`](prototypes/studio/api/_schema_suggestion.ts) convert and check the editable definition with `parseBatchSuggestionDefinition`: ordinary schema validation plus repeated-sibling-name rejection. Each step checks its attempt first and checkpoints a window count and definition, or a sanitized failure, never source text or provider response; the source is declared read whole. |
| Batch merge | Past the patch, the checkpointed source definitions are intersected level by level by [`reduceSchemas`](prototypes/studio/api/_schema_reduction.ts), a `merge:reduce:<level>:<group>` step per request within the 48,000-character limit, so every suggestion is read; a group holding a suggestion without fields stays without fields, with no call. A run started before the patch keeps its single `merge` step: [`suggestBatchCommon`](prototypes/studio/api/_schema_suggestion.ts) serializes whole labelled suggestions in member order up to the limit and names the ones it left out. It does **not** replace per-source generation. | The same route/execution seam, in separate model calls. | The combination is validated as an editable definition and an empty one is heterogeneous. A suggestion that cannot fit one request fails the merge (`merge_input_too_large`) rather than being left out. The workflow checks the current attempt, then conditionally publishes READY/HETEROGENEOUS with each source's declaration (a pre-patch run may declare suggestions not combined), or a sanitized failure through [`workerSuggestionStore`](prototypes/studio/api/_batch_suggestion_workflow.ts). |
| Schema editing (Interaction) | [`proposeSchemaEdit`](prototypes/studio/api/_schema_edit.ts) prepares the pinned schema tree and optional source Markdown, builds the edit and bounded repair prompts. [`proposeSchemaEditWorkflow`](prototypes/studio/api/_schema_edit_workflow.ts) owns the pinned reads and step. | [`generateSchemaEditJson`](prototypes/studio/api/_schema_edit.ts) uses [`executeEditPrompt`](prototypes/studio/api/_model_execution.ts), which resolves the researcher's Interaction Route and shares general-adapter output negotiation and credential handling with suggestions. | `generateSchemaEditJson` rejects truncated output; `proposeSchemaEdit` uses the shared JSON parsing and repair path and validates field edits/additions, including the model retry for invalid entries. The edit workflow checkpoints its proposal; [`edit_schema.ts`](prototypes/studio/api/edit_schema.ts) maps its response, not a mutation of the pinned revision. |
| Article Extraction | [`keiExtractRequest`](packages/extraction/src/workflows.ts) sends the pinned executable schema and parse generation via [`KeiHandoff`](packages/extraction/src/kei-handoff.ts). Python [`extract_run`](prototypes/parsing_service/src/kei_exp/workflows/extract.py) validates the request; [`run.extract`](prototypes/parsing_service/src/kei_exp/kie/extract/run.py) loads canonical [`Evidence`/`Passage`](prototypes/parsing_service/src/kei_exp/kie/passages.py) and refuses a stale generation before any model call; [`article.extract`](prototypes/parsing_service/src/kei_exp/kie/extract/article.py) inventories identities across the full source, extracts records and grounds them. [`article.inventory_request`](prototypes/parsing_service/src/kei_exp/kie/extract/article.py) builds the identity-inventory prompt and reply schema; shared [`stages.extract_document`/`stages.record_request`](prototypes/parsing_service/src/kei_exp/kie/extract/stages.py) build document/record value prompts, with field guidance and reply schemas from [`schema.notes`/`schema.json_schema`](prototypes/parsing_service/src/kei_exp/kie/extract/schema.py). [`assembly.document_values`](prototypes/parsing_service/src/kei_exp/kie/extract/assembly.py) coordinates document calls, not their prompt construction; grounding prompts and reply schemas live in [`grounding.verify`](prototypes/parsing_service/src/kei_exp/kie/extract/grounding.py). | Every call goes through [`calls.complete`](prototypes/parsing_service/src/kei_exp/kie/extract/calls.py): [`models.Router`](prototypes/parsing_service/src/kei_exp/kie/extract/models.py) sends inventory/grounding to the reasoning model and document/record values to the fields model, [`tokens`](prototypes/parsing_service/src/kei_exp/kie/extract/tokens.py) counts each request on the serving endpoint's `/tokenize`, and [`OpenAIChat`/`NuExtractChat`](prototypes/parsing_service/src/kei_exp/kie/extract/llm.py) invoke the configured extraction endpoints, **not** Studio Capability Routes. | `calls.complete` decodes each reply with `llm.parse_json`, fails a cut-off or unreadable reply without repair and records every attempt as a `Call`. Python schema conformance and grounding precede atomic [`publish_extraction`](prototypes/parsing_service/src/kei_exp/kie/extract/run.py). Studio [`acceptKeiArtifact`](packages/extraction/src/kei-artifact.ts) verifies artifact identity, schema and evidence anchors before [`runExtractionWorkflow`](packages/extraction/src/workflows.ts) settles the Extraction. The [pipeline map](prototypes/parsing_service/docs/extraction-experiments.md#pipeline-map) lists every call purpose. |
| Generic Catalog Extraction | The same pinned handoff and canonical Evidence load. Without `options.catalog.recipe`, [`run.extract`](prototypes/parsing_service/src/kei_exp/kie/extract/run.py) dispatches to [`catalog.extract`](prototypes/parsing_service/src/kei_exp/kie/extract/catalog.py): chunked labelled-block discovery, per-record source slices, values and grounding. [`catalog.discover`](prototypes/parsing_service/src/kei_exp/kie/extract/catalog.py) builds the boundary-discovery prompt and reply schema; record values delegate to shared [`stages.extract_record`/`stages.record_request`](prototypes/parsing_service/src/kei_exp/kie/extract/stages.py), and document values to `stages.extract_document`. Field guidance and reply schemas come from [`schema`](prototypes/parsing_service/src/kei_exp/kie/extract/schema.py). | The same `calls.complete`: `models.Router` assigns discovery/grounding to reasoning and record/document values to fields; character budgets (`discovery_chars`, `record_chars`) stand in for token counting; `llm.py` sends the calls. | `catalog.discover` reads the record boundaries, `schema.conform` conforms values and `grounding.verify` links them to their slice's passages; `publish_extraction` writes the version-1 result; `acceptKeiArtifact` verifies it before Studio settles. A recipe is **optional** and distinct: `options.catalog.recipe` dispatches to [`grounded.extract`](prototypes/parsing_service/src/kei_exp/kie/extract/grounded.py), with segmentation, token-budgeted entry calls through the same `calls.complete` and version-2 span Evidence. It does not replace generic Catalog. |

These are different validation boundaries, not equivalent schema validators:
[`parseSchemaDefinition`](packages/extraction/src/schema.ts) accepts an editable
TypeScript tree (including zero fields); batch suggestions additionally use
`parseBatchSuggestionDefinition` to forbid repeated sibling field names. At
execution, Python [`Schema`](prototypes/parsing_service/src/kei_exp/kie/extract/schema.py)
requires at least one field and unique sibling names and builds strict call
schemas; [`acceptKeiArtifact`](packages/extraction/src/kei-artifact.ts) validates
the returned artifact. Historical Schema Revisions remain pinned, readable
research records, not retroactively revalidated or rewritten to match a
later executable-input rule.

## More

See [CONTEXT.md](CONTEXT.md) for domain language and [docs/](docs/) for current
decisions and parsing contracts.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how we work together.
