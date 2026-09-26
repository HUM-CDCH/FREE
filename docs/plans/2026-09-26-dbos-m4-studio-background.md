# DBOS M4: Studio's Background Work on DBOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: **done 2026-09-26** on `feat/dbos-m2-m6`. Verification: [2026-09-26-dbos-m4-verification.md](../validation/2026-09-26-dbos-m4-verification.md).

**Goal:** Deliver milestone M4 of the DBOS plan on `feat/dbos-m2-m6`: DBOS runs inside the Studio process; Extraction, Batch Extraction, Batch Schema Suggestion, ingestion and reprocessing run as named DBOS workflows admitted atomically with their domain rows or started workflow-first; Studio hands conversions and extractions to kei's DBOS worker through portable enqueues on kei's lanes; execution status is derived from DBOS; `ExtractionJob`, `BatchExtractionMember`, ingestion keys, the lease worker, the suggestion pump and Studio's HTTP kei submission are deleted; `pnpm test:e2e`, `pnpm test:service` and every component tier end green.

**Architecture:** `server/dbos.ts` configures and launches Studio's DBOS application (`studio`, schema `dbos`, `studio@1`) once per process from `server/host.ts` and `server/developmentHost.ts`, reads the database-clock boot timestamp first, registers the `studio` and `suggest` queues and holds two clients (admission as `studio`, handoff as `kei` on `kei_dbos`). Every workflow is registered by an explicit registration function with an explicit `name`, never at module import. Row-backed admission (Extraction, batch, suggestion attempt) inserts the domain rows and calls `DBOSClient.enqueueInTransaction` on one checked-out `pg` client that Prisma Next's facade is bound to; no-row admission (ingestion, reprocess) enqueues by name with the admission client. Workflows reach kei with `submitToKei` / `pollKei` steps (`packages/extraction/src/kei-handoff.ts`), fetch results over kei's read API, and publish through one conditional terminal write whose predicate (no outcome yet / still the current attempt) makes every replay, cancel race and late completion a no-op. Reads derive status from the row's outcome, else one `listWorkflows` call.

**Tech Stack:** Studio (TypeScript, React 19, Vite 8, Hono, Zod 4, Vitest 4, Playwright), `@dbos-inc/dbos-sdk` 5.1.10, `packages/db` (Prisma Next 0.16, `pg` 8.22.0, `tsx --test`), `packages/extraction` (`tsx --test`), kei (`kei_exp.workflows`, Python 3.13, `dbos` 3.1.0; only started by the real-service tier), Docker Compose.

**Spec:** [docs/plans/2026-09-24-unified-durable-execution.md](2026-09-24-unified-durable-execution.md). Read *Decisions*, *Rules*, *Target architecture*, *Workflows* (all of it: Admission, Status and ownership, Studio → kei handoff), *Background work* (all of it), *Cancellation*, *Deletion and garbage collection* (what admission/publication must not break: `preprocessId`, `keiRunId`, staged-file names), *Queues, deadlines and upgrades*, *Public contract changes*, the M4 section (from "**M4: Studio background work on DBOS.**" through its *Acceptance* list, ending before "**M5: interactive work on DBOS.**") and *Verification*. Evidence this plan builds on: [m0r/README.md](2026-09-24-unified-durable-execution-evidence/m0r/README.md) (items 2 and 3 and PLAN IMPACT 1–3), [probe.mjs](2026-09-24-unified-durable-execution-evidence/probe.mjs) (Prisma/DBOS atomicity), [admission-races.mjs](2026-09-24-unified-durable-execution-evidence/admission-races.mjs), the M3 plan's *Deferred to M4 and later* ([2026-09-26-dbos-m3-kei-on-dbos.md](2026-09-26-dbos-m3-kei-on-dbos.md)) and the PR #140 design ([2026-09-25-superseded-revision-admission-design.md](2026-09-25-superseded-revision-admission-design.md)).

## Rulings (controller, 2026-09-26)

1. **Ruling: Studio reads kei's run ID; it never computes it.** A conversion's run ID comes from kei's `convert` output (`ConvertOk.run_id`), and an Extraction's from its pinned revision's `preprocessId` (`kei-exp:<run>:<generation>`, written from that output at ingestion). `runs.run_id_for` (kei `runs.py`) is kei's private rule. — *Why:* one owner per identity. — *Cost if wrong:* a kei change to its derivation silently breaks Studio.
2. **Ruling: node:test checks the shared contract fixtures** in `prototypes/parsing_service/tests/fixtures/contracts/*.json` and pins `queues.json`'s `small_document_pages: 30` against Studio's `SMALL_DOCUMENT_PAGES`. — *Why:* M3 Ruling 4. — *Cost if wrong:* contract drift appears only at the full-stack gate.
3. **Ruling: one constant priority on the conversion lanes, `kei-extract` priority 1 interactive / 10 batch.** Conversions are sent at priority 1 (the fixture's value; Python refuses 0). — *Why:* each conversion lane has one slot; priority matters only on `kei-extract`.
4. **Ruling: deadlines.** Conversion `workflowTimeoutMS = max(600_000, 3 × (20_000 + 6_300 × pages))`; extraction 600 000 ms (Article) / 10 800 000 ms (Catalog); both measured from kei's dequeue. — *Why:* M0R 4, M3 Ruling 3.
5. **Ruling: IDs are matched with full-match regular expressions** (`^…$` with no `m` flag; JavaScript's `$` does not match before a trailing newline).
6. **Ruling: kei's environment.** `KEI_SYSTEM_DATABASE_URL` is the worker's only database setting; kei's role and `kei_dbos` schema are created by Studio's entrypoint (`packages/db/src/kei-role.ts`, `FREE_KEI_POSTGRES_PASSWORD`, M2 Task 3). Studio's kei client connects with Studio's own `DATABASE_URL` and `systemDatabaseSchemaName: 'kei_dbos'`.
7. **Ruling: the `source-inbox` volume arrives in M4 with its first writer** (Studio rw, `parsing_worker` ro).
8. **Ruling: `api/schema_revisions.ts`'s import of `../src/schemaChanges.js` moves to `shared/`** before DBOS launches once per process (the development watch hot-reloads `src/` without a restart).
9. **Ruling: the key wrapper composes `DBOS.stepStatus.cancelSignal` in M4 for the batch suggestion steps**, and batch suggestion wires the explicit key resend on a typed `model_key_required` outcome (M2 ruling).
10. **Ruling: PR #140 survives the admission rewrite.** A new identity on a superseded Source Representation Revision is refused with 409 `source_representation_superseded` (only after replay resolution); admission and reprocess publication take `lockSourceDocumentRow(transaction, id)`; batch admission locks members in sorted order. Deferred follow-ups folded in: the Catalog recipe on a failed attempt's retry (Task 7) and the client refresh on a reprocess refusal (Task 7).
11. **Ruling: the baseline is edited in place** (`packages/db/migrations/app/20260925T2356_baseline`): Task 6 drops `ExtractionJob` (with `retryOfId`) and `BatchExtractionMember` and gives `Extraction` its admission inputs, nullable outcome, batch/source uniqueness and cascading composite pins; Task 9 gives suggestions `attempt` and a nullable terminal outcome, drops per-source execution/result columns and transient phases, and cascades membership; Task 10 drops ingestion keys and their uniqueness (keeping project/content uniqueness). `ChatTurn` is M5. In a checkout without the gitignored ref snapshots, run `npx prisma-next ref delete db --no-interactive` before `migration plan`.
12. **Ruling: M4 ends with `pnpm test:e2e`, `pnpm test:service` and every component tier green.** After M3 the kei HTTP submission routes are gone, so `test:service` is red until Task 13 rewrites the real-service harness. `pnpm test:e2e` drives the handoff with a **TypeScript kei stand-in** (a DBOS application named `kei` on `kei_dbos`, portable `convert`/`extract` workflows, kei's four lanes and its read API) because the GitHub job runs with `FREE_SKIP_PYTHON=1` and cannot start the real worker; `pnpm test:service` drives it with **the real kei worker** (`kei-worker worker`) as the restricted `kei` role. The spec's M6 *Test wiring* item for `e2e/realService.ts` moves into M4 (Task 13) because M4's own acceptance needs it.

## Code facts this plan relies on (verified at 83b2918 and 33941bf)

- **DBOS 5.1.10** (read from an installed copy, `dist/src/*.d.ts` and `client.js`):
  - `DBOSConfig` keys used: `name`, `systemDatabaseUrl`, `systemDatabaseSchemaName`, `systemDatabasePoolSize`, `applicationVersion`, `executorID`, `enablePatching`, `enableOTLP`, `logLevel`. `DBOS.launch()` a second time resolves silently (M0R 2); `DBOS.isInitialized()` reports a launch.
  - `DBOS.registerWorkflow(fn, { name, maxRecoveryAttempts?, serialization? })`; `DBOS.runStep(fn, { name, retriesAllowed, intervalSeconds, maxAttempts, backoffRate, shouldRetry, timeoutMS })` — `backoffRate: 1` gives a constant interval; `DBOS.stepStatus?.cancelSignal` fires about 1 s after a cancel; `DBOS.registerQueue(name, { globalConcurrency, workerConcurrency, minPollingIntervalMs })` after launch.
  - `DBOSClient.create({ systemDatabaseUrl, systemDatabaseSchemaName, systemDatabasePoolSize, applicationName })` only constructs the client and runs no query (`client.js:68-71`), so Studio can create the kei client before kei has migrated `kei_dbos`.
  - `enqueue(options, ...args)` supports `duplicationPolicy: 'return-existing'` (outside a caller transaction); `enqueueInTransaction(client, options, ...args)` throws `DBOSError` for `'return-existing'` before any SQL (`client.js:211-215`); `enqueuePortable(options, positionalArgs)` sets portable serialization itself (`client.js:165-176`). Options (`EnqueueWorkflowOptions`): `queueName`, `workflowName`, `workflowID`, `workflowTimeoutMS` (from dequeue), `deduplicationID`, `priority`, `attributes`, `authenticatedUser`, `applicationName`; reusing an existing `workflowID` returns the existing workflow (default `workflowIDReusePolicy`).
  - `cancelWorkflow(id)` is `UPDATE … SET status='CANCELLED', updated_at=now() … WHERE workflow_uuid = ANY($2) AND status NOT IN ('SUCCESS','ERROR')` (`system_database.js:1321-1328`): a missing ID is a no-op, but a repeated cancel of a `CANCELLED` row moves `updated_at` (M0R README), so repeated cancels must target live statuses only.
  - `listWorkflows({ workflowIDs, workflow_id_prefix, attributes, status, loadInput, loadOutput, limit, sortDesc })` → `WorkflowStatus { workflowID, status, queueName, input, output, error, priority, timeoutMS, deadlineEpochMS, updatedAt, attributes, authenticatedUser, … }`; a client's listing defaults to its own application's rows.
  - `ClientHandle.getResult(options?: PollingOptions)` has no timeout, so Studio waits on workflows with its own bounded polling (Task 1, `awaitWorkflowOutcome`).
- **Prisma Next 0.16** (`@prisma-next/postgres/runtime`, `@prisma-next/driver-postgres`):
  - `postgres({ contractJson, pg })` accepts `Pool | Client`; the binding is chosen by duck typing (`isPgClient`: `escapeIdentifier` and `escapeLiteral`), so a `pg.PoolClient` binds as `pgClient`.
  - A `pgClient` binding calls `directClient.connect()` and ignores the "already connected" error (`normalize-error-*.mjs:70-78`), and its `close()` calls `directClient.end()` (`driver-postgres/dist/runtime.mjs:319-324`): **a facade bound to a pooled client must never be closed**.
  - `verifyMarker?: 'onFirstUse' | false`; `where({ column: null })` filters `IS NULL` (used by `project-store.ts:1782-1788`); `.updateAll()` keeps its guards in the `UPDATE` and returns the updated rows, whereas `.update()` selects an id first (`project-store.ts:1781`).
  - `packages/db/src/prisma/db.ts:5-8` builds `db` from a `url`, which buries the pool inside the driver; Task 2 makes `db.ts` own the `pg.Pool`.
- **kei at 33941bf:** workflows `convert`, `extract`, `deleteRuns`, portable, `max_recovery_attempts=5` (`workflows/convert.py`, `extract.py`, `gc.py`); queues `kei-convert-large` 1/1, `kei-convert-small` 1/1, `kei-extract` 2/2, `kei-gc` 1/1 (`config.py`); `ConvertInput {source (relative to KEI_SOURCE_INBOX), source_sha256, source_name, page_source, ingest, model, layout_model, cut, debug}`, `ConvertOk {ok, run_id, generation, page_count, source_sha256, page_source}`, `ExtractInput {run_id, generation, request: {schema, options}}`, `ExtractOk {ok, run_id, extraction_id, generation, artifact_sha256, model, models}`, `Failure {ok:false, code, reason, retryable}` with `code` in `failures.CODES` (`contracts.py`, `failures.py`); `extraction_id_of('kei-extract:<id>')`; the artifact is published at `extractions/<extraction id>/result.json` and, after M3 Task 10, served file-only by `GET /api/runs/{id}/extractions/{xid}` (404 until published). Fixtures: `convert.input.json` (queue `kei-convert-small`, priority 1, `workflow_id` `kei-convert:ingest:<project>:<attempt>`, `source` `<project>/<attempt>.pdf`), `convert.output.{ok,failed}.json`, `extract.input.json`, `extract.output.{ok,failed}.json`, `deadlines.json`, `queues.json`, `deleteRuns.{input,output}.json`.
- **Extraction today** (`packages/extraction/src/postgres-persistence.ts`, P):
  - `Extraction` has no `catalogRecipe`; `outcome`, `diagnostics` and `reviewable` are NOT NULL (`contract.prisma:293-332`). `complete()` hard-codes `outcome: 'SUCCEEDED'` (P:1158-1208); failed and cancelled runs never get an `Extraction` row (integration tests 881, 1242).
  - Ownership of every read and review goes through `ExtractionJob.projectContextId` (`ownsResearcherJob`, P:802-826); `ownsResearcherDocument` (P:864-889) already routes through `SourceDocument.projectContextId`.
  - Single admission `scheduleInteractiveExtraction` (P:391-448): existing-row replay (`jobIdentityMatches`, P:325-344) **before** the PR #140 check (P:413-425, `lockSourceDocumentRow` then the highest `revisionNumber`); `SUPERSEDED_MESSAGE` (P:20); a unique violation re-runs the function (P:441-444).
  - Batch admission `scheduleBatch` (P:1577-1716) locks members in `canonicalIds` order (P:97-99, loop P:1625-1637) and pins each member's head revision under the lock; replay only on the batch primary key (P:1693-1715). Suggested batches (`postgres-suggested-batch.ts:13-173`) keep the suggestion's saved pins without a lock (PR #140's documented exemption).
  - `cancelInteractiveExtraction` (P:828-862) cancels INTERACTIVE jobs only and answers `'not-found'` otherwise; Studio maps that to 404 "That Extraction is not active." (`api/extractions.ts:144-153`).
  - `loadDocumentExtractions` (P:450-504): candidates are interactive attempts of any status plus completed ones of any kind; "latest reviewed" spans the revision history (integration test 1194).
  - `loadBatch` (P:506-593) never reports a FAILED batch; `project-store.ts:993-1129` (`listProjectContexts`' `runningBatch`) joins `BatchExtractionMember` to `ExtractionJob`; `postgres-test-helpers.ts:8,14` hard-codes `'ExtractionJob'`.
  - `createExtractionJobExecutor` (`module.ts:196-303`) maps a kei artifact to a `TerminalExtraction`; `createKeiExpClient.extract` (`kei-exp.ts`) POSTs `…/extract` and polls the envelope — both routes are gone after M3 Task 10.
- **Suggestions today** (`packages/db/src/project-store.ts`): `createBatchSchemaSuggestion` 1641-1710 (replays on `selectionKey` 23505, 1688-1709), `updateBatchSchemaSuggestionDraft` 1752-1803 (CAS on `draftVersion`), `retryBatchSchemaSuggestion` 1804-1863 (no status guard; selective per-source retry), worker lease methods 2109-2302, `projectContextOwner` 2105-2108; the pump `api/_project_operations.ts` (`kick()` at `batch_schema_suggestions.ts:136,149,168,266`, two of them GETs); `BatchSchemaSuggestionSource.sourceRepresentationRevision` is `onDelete: Restrict` (`contract.prisma:286`), so deleting any pinned source fails with 23503 (`fk-probe.mts`).
- **Ingestion today:** `api/source_documents.ts` validates the form (604-661), then parses synchronously through `POST /api/runs` + status polling (`submittedRun` 274-324, `completedRun` 337-390, `acceptedResult` 393-440, `parseSourceDocument` 456-581) with `DEFAULT_MODEL`/`KEI_EXP_MODEL` (38, 472); `store.ingestSourceDocument` (`project-store.ts:1407-1520`) replays by ingestion key, then by content. `ReprocessSourceDocumentInput = IngestSourceDocumentInput & {…}` (`project-store.ts:279`) carries the reprocess request key as `input.ingestionKey`, and the browser sends `requestKey: source.ingestionKey` (`ProjectContextsProvider.tsx:305`) minted per action (350); `project-navigation.spec.ts:327` asserts that a Retry re-sends the identical reprocess body.
- **Studio process today:** `server/host.ts:62,110-131` runs and closes `extractionRuntime`; `server/developmentHost.ts:34-60` loads `/api/_extraction_runtime.ts` and restarts it on recomposition; `vite.config.test.ts:172-466` tests that; `server/api-dispatcher.ts:65-72` eagerly imports every `api/[a-z]*.ts` (underscore modules are never routes), and `server/app.test.ts`, `server/api-dispatcher.test.ts`, `api/model_auth.test.ts` and `server/host.test.ts` evaluate those modules unmocked — so no module may register a workflow or open a connection at import. `studioProcess` (`api/_model_keys.ts:149-152`) holds the boot ID and key cache; `STUDIO_BOOT_HEADER` is stamped on every `/api` response (`server/app.ts:384-398`); `requestModelKeyResend` (`src/auth/authenticatedFetch.ts:35`) is module-private; `ensureModelKeysSent` (`src/modelKeys/modelKeyHandoff.ts:62`).
- **Model calls:** `generateSchemaWithModel(caller, { document, instruction, temperature, signal }, target?, dependencies?)` (`api/_model.ts:137-146`); the key wrapper reads keys with the call's `abortSignal` (`keyedModel`, `api/_provider.ts:562-581`; `requireModelKey`, `api/_model_keys.ts:132-143`, whose comment says M4/M5 compose `cancelSignal` into it); `sourceSuggestionFailure` keeps `model_key_required` (`api/_batch_schema_suggestions.ts:19-36`).
- **Tests and CI:** only `e2e/canonical-evidence-lifecycle.spec.ts` starts the fake kei (HTTP on `FREE_PLAYWRIGHT_KEI_EXP_URL`, 41750; 41753 under `playwright.base-path.config.ts`) and it seeds Source Documents directly (`ingestionKey` column at 253-260, 319-326), queries `ExtractionJob` at 827-842, and is skipped unless `DATABASE_URL === EXTRACTION_TEST_DATABASE_URL`; `e2e/realService.ts` starts `kei_exp.jobs.cli` (deleted by M3); CI (`.github/workflows/verify.yml`, `scripts/test-ci.mjs`) provisions `free_test_extraction` (= `DATABASE_URL`) and `free_test_project_store` and runs `test:all:node` with `FREE_SKIP_PYTHON=1`.

## Global Constraints

- **Worktree and branch:** `/home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6` on `feat/dbos-m2-m6`. Other agents write under `docs/plans/2026-09-24-unified-durable-execution-evidence/m0r*/`: never touch, stage or commit anything there. Stage explicit paths, never `git add -A .` at the root.
- **Preconditions:** M2 is complete (its Task 15 recorded). Before Task 3 the controller merges M3 (through its Task 13) into `feat/dbos-m2-m6`; Tasks 1–2 need only M2. Verify with `ls prototypes/parsing_service/tests/fixtures/contracts/queues.json prototypes/parsing_service/src/kei_exp/workflows/cli.py` and `grep -c kei_exp.jobs prototypes/parsing_service/src -r` (0).
- **Pins:** `@dbos-inc/dbos-sdk` exactly `5.1.10` (no caret) in `prototypes/studio` `dependencies` (Task 1), `packages/db` `devDependencies` (Task 2) and `packages/extraction` `dependencies` (Task 3). After each install `pnpm why @dbos-inc/dbos-sdk` must list one version: two copies would be two DBOS singletons in one process. `prototypes/studio/vite.server.config.ts` keeps `ssr: { external: ['@dbos-inc/dbos-sdk', '@dbos-inc/vercel-ai'] }` (M0R PLAN IMPACT 1; `vercel-ai` is installed in M5). Install with `FREE_SKIP_PYTHON=1 pnpm install`.
- **Names (fixed):** Studio application `studio`, system schema `dbos`, version `studio@1`, executor `studio`, `enablePatching: true`; queues `studio` (`minPollingIntervalMs: 100`) and `suggest` (`globalConcurrency: 1`); admission client `applicationName: 'studio'`, kei client `applicationName: 'kei'` on `kei_dbos`; workflows `runExtraction` (`extract:<extractionId>`), `suggestSchemaBatch` (`suggest:<batchSchemaSuggestionId>:<attempt>`), `ingestSource` (`ingest:<projectContextId>:<attemptId>`), `reprocessSource` (`reprocess:<sourceDocumentId>:<requestKey>`); kei children `kei-convert:<parent workflow ID>` and `kei-extract:<extractionId>`. Every workflow has an explicit `name` (bundlers mangle function names: M0R 2) and is registered only by `registerStudioWorkflows()` during `launchStudioDbos()`, never at module import.
- **No compatibility aliases** (spec, *Public contract changes*): no `ingestionKey`, no job/member IDs, no `SOURCES`/`MERGING`, no per-source progress fields, no old status fields kept "for now". Update schemas, handlers, browser consumers and tests together.
- **Never print secrets.** No test or script prints a database URL with its password or `FREE_KEI_POSTGRES_PASSWORD`. Workflow inputs carry IDs only: no PDF, page or artifact bytes and no keys enter DBOS history (spec *Rules*; the Studio step outputs listed in each task are IDs, descriptors and definitions only).
- **Deletions:** implementer subagents may not run `git rm` without the user's authorization. Run plain `rm` / `rm -r`, then `git add -A <those exact paths>`.
- **Python:** only Task 13 starts Python, with `prototypes/parsing_service/.venv/bin/python` (as `realService.ts` does today). Never `pip`; never `uv sync` in M4.
- **Test tiers (exact commands):**
  - Studio: `pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test`; one file: `pnpm --filter studio exec vitest run <path>`; browser tests start with `// @vitest-environment jsdom`.
  - Studio PostgreSQL (new in Task 1): `pnpm --filter studio test:postgres` with `DATABASE_URL` and `EXTRACTION_TEST_DATABASE_URL` exported and equal; one file: `pnpm --filter studio exec vitest run --config vitest.postgres.config.ts <path>`.
  - db: `pnpm --filter db typecheck && pnpm --filter db test`; `pnpm --filter db test:postgres` with `PROJECT_STORE_POSTGRES_URL` exported.
  - extraction: `pnpm --filter extraction typecheck && pnpm --filter extraction test`; `pnpm --filter extraction test:postgres` with `EXTRACTION_TEST_DATABASE_URL` exported.
  - E2E: `pnpm --filter studio test:e2e`; one spec `pnpm --filter studio exec playwright test e2e/<name>.spec.ts`; base path `pnpm --filter studio test:e2e:base-path`.
  - Real service: `pnpm test:service` (Docling weights; the parsing `.venv`).
  - Safety and scripts: `pnpm test:safety` (Docker renders Compose), `node --test scripts/free.test.mjs scripts/test-ci.test.mjs`.
  - Whole repository: `pnpm typecheck && pnpm lint && pnpm test:unit:node && pnpm test:safety && pnpm test:postgres:node && pnpm test:e2e && pnpm test:service`.
- **Disposable databases only** (README #10): user `postgres`, loopback, explicit port 5432, databases `free_test_*`; the guards refuse anything else. Reuse the M1–M3 container; never stop it or any other service. Every task that edits `contract.prisma` recreates its databases (a from-null baseline does not apply to a database signed by the previous one):
  ```bash
  docker ps --filter name=free-m1-pg --format '{{.Names}}'   # prints free-m1-pg when it is running
  # Only if it is not running and port 5432 is free (never stop another service to free it):
  docker run --rm -d --name free-m1-pg --mount type=tmpfs,destination=/var/lib/postgresql/data \
    -p 127.0.0.1:5432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=m1-disposable-only \
    -e POSTGRES_DB=free_test_parsing postgres:17
  for name in free_test_m4_store free_test_m4_extraction; do
    docker exec free-m1-pg dropdb -U postgres --if-exists --force "$name"
    docker exec free-m1-pg createdb -U postgres "$name"
  done
  export PROJECT_STORE_POSTGRES_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_m4_store
  export EXTRACTION_TEST_DATABASE_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_m4_extraction
  export DATABASE_URL=$EXTRACTION_TEST_DATABASE_URL          # the Studio PostgreSQL tier requires DATABASE_URL === EXTRACTION_TEST_DATABASE_URL, as CI sets it
  DATABASE_URL=$PROJECT_STORE_POSTGRES_URL pnpm --filter db db:init
  pnpm --filter db db:init
  ```
  If `free-m1-pg` was started with another password, ask the controller rather than restarting it. `project-store.postgres.check.ts` requires an empty database, so recreate both before each `pnpm --filter db test:postgres` run. DBOS-backed tests create their own system schemas (`dbos_t_<hex>`, `kei_dbos_t_<hex>`) and drop them in `after`/`afterAll`.
- **Baseline regeneration (Tasks 6, 9, 10):**
  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6/packages/db
  export CONTRACT_URL=postgresql://contract:emit@127.0.0.1:5432/free       # never dialled
  DATABASE_URL=$CONTRACT_URL pnpm contract:emit
  rm -r migrations/app/*_baseline
  DATABASE_URL=$CONTRACT_URL npx prisma-next ref delete db --no-interactive   # required when refs/*.contract.* are absent; harmless otherwise
  DATABASE_URL=$CONTRACT_URL npx prisma-next migration plan --name baseline --no-interactive
  cat migrations/app/*_baseline/migration.json                              # note the "to" hash; "from" must be null
  DATABASE_URL=$CONTRACT_URL npx prisma-next ref set db <the "to" hash> --no-interactive
  DATABASE_URL=$CONTRACT_URL npx prisma-next migration check --no-interactive # prints "All checks passed"
  ```
  `src/prisma/contract.{d.ts,json}` and `migrations/app/refs/*.contract.*` are generated and gitignored; commit the baseline directory and `migrations/app/refs/db.json`.
- **Development database:** after Tasks 6, 9 and 10 an existing `pnpm dev` stack's `postgres-data` volume carries the previous baseline and `db:init` refuses it. Do not reset it yourself; tell the controller that the developer must recreate it once (M4's cutover is the spec's clean slate).
- **Commits:** one per task, conventional prefix, message ending with the session's attribution line. Never `git stash`, `reset` or `commit --amend` another task's work.

## Test tiers at the M4 seam

| Tier | Tasks 1–5 | Task 6 on | Task 10 on | Task 13 on |
|---|---|---|---|---|
| Studio, db, extraction unit; typecheck; lint | green | green | green | green |
| db, extraction, Studio PostgreSQL | green | green | green | green |
| `pnpm test:e2e` (kei stand-in from Task 6) | green | green | green | green |
| `pnpm test:safety`, scripts | green | green | green | green |
| `pnpm test:service` | **red** (M3 seam: `realService.ts` starts the deleted `kei_exp.jobs.cli`) | red | red | green |
| `pnpm dev` extraction | broken (M3 removed `POST …/extract`) | works | works | works |
| `pnpm dev` ingestion / reprocess | broken (M3 removed `POST /api/runs`) | broken | works (Task 10 / 11) | works |

Never deploy the middle state (spec *Milestones*: M2–M4 are one integration boundary).

## Plan decisions (not settled by the spec; settled here — the ones marked ★ need the controller's confirmation)

1. **Registration is explicit, never at import.** Each workflow module exports `register…Workflow(ports)`, which calls `DBOS.registerWorkflow(fn, { name })` once; `server/workflows.ts` `registerStudioWorkflows()` calls them all, and only `launchStudioDbos()` calls it, before `DBOS.launch()`. *Why:* the dispatcher and four unmocked test files evaluate every `api/*.ts` at import, and the development host re-evaluates modules on recomposition; a registration at import would throw `DBOSConflictingRegistrationError` after launch (M0R 2).
2. **Handlers start Studio workflows by name through the admission client, never with a function handle:** `enqueueInTransaction` for row-backed admission, `enqueue` (with `duplicationPolicy: 'return-existing'` for ingestion) for workflow-first starts. ★ `reprocessSource` is therefore enqueued on the unrestricted `studio` queue (the spec's queue table lists only `runExtraction`, `chatTurn` and `ingestSource` there). *Why:* a recomposed module has no registered handle, and the `studio` queue imposes no cap (M0R 3: ~55 ms p50 dequeue). *Cost if wrong:* none beyond that latency.
3. **The development host keeps recomposition, drops the runtime reload and launches DBOS once** through an identity-guarded `ssrLoadModule('/server/dbos.ts')` before the first composition. Registered workflow closures keep the module instances they were registered from until the process restarts; Compose restarts Studio on every server edit (M2 Task 3, `sync+restart`), and a host-side `pnpm --filter studio dev` needs a manual restart after a workflow edit (logged once per change of a file under `api/_*_workflow.ts`, `server/workflows.ts` or `packages/extraction/src/workflows.ts`).
4. **`db.ts` owns the pool, and one helper binds a transaction to a pooled client** (`withPoolClientTransaction`, Task 2). Prisma Next releases a bound object that exposes `release`, so the helper binds a client view without that method and owns the real client's release. On any thrown error the client is released with `release(true)` (destroyed), so a connection in an unknown transaction state is never reused; the facade is never closed.
5. **The pure status derivation lives in `packages/db`** (`execution-status.ts`: `executionOf`, `WorkflowStatuses`, `INTERRUPTED_FAILURE`), because `packages/db` (suggestions, `runningBatch`) and `packages/extraction` both need it and `extraction` depends on `db`, not the reverse. `server/dbos.ts` supplies the `listWorkflows` implementation (`workflowStatusesOf`). The spec puts "status-derivation helpers" in `server/dbos.ts`; only the pure mapping moves.
6. **Failed, cancelled and interrupted attempts keep today's wire shape:** `executionStatus: 'FAILED'`, `outcome: null`, `failure: {code, message, phase}`, no diagnostics or result — exactly what the browser reads today, because no failed `Extraction` row existed before. The row stores `outcome FAILED|CANCELLED` and `diagnostics null`. `extractionAttemptSchema`'s COMPLETED-with-FAILED/CANCELLED branch (`extraction.contract.ts:318-343`) becomes unreachable and is deleted (Task 7). An interrupted attempt's failure is `{ code: 'interrupted', message: 'This work stopped before it finished. Start it again.', phase: 'extracting' }`.
7. **`Extraction.createdAt` becomes admission time**, and "latest attempt" ordering follows admission. No `settledAt` column is added (nothing reads one).
8. **Batch member IDs:** `stableUuid('batch-member-extraction', stableJson([batchExtractionId, sourceDocumentId]))` (`project-store.ts:426-431`), so a replayed batch admission reproduces its members.
9. **kei handoff constants:** `pollKei` reads the kei workflow every 2 s for at most 30 s per step (a 50-member batch then costs 25 status reads per second, not 50); `submitToKei` retries only kei-not-ready errors (`42P01`, `3F000`, `57P03`, `ECONNREFUSED`, `ECONNRESET` anywhere in the cause chain) every 5 s up to 120 attempts (10 min: kei starts after Studio is healthy); a PDF pdf.js cannot count is budgeted as 2000 pages (kei's `KEI_MAX_PAGES`); kei child attributes are the parent's attributes.
10. **kei failures map to today's Studio codes:** `stale_generation` → `invalid_source_representation`; `model_unavailable` → `model_unavailable`; `cancelled` → `cancelled`; every other kei code → `extraction_failed` with kei's reason ("A failed extraction carries kei-exp's own reason", README). kei `CANCELLED` past its deadline → `extraction_failed` "The Extraction did not finish within its time limit (10 minutes for Article, 3 hours for Catalog)."; `CANCELLED` otherwise → `cancelled`; `ERROR`, `MAX_RECOVERY_ATTEMPTS_EXCEEDED` or a missing child → `extraction_failed` "The Parsing Service stopped this Extraction." For conversions every failure is 422 `source_ingestion_failed` "The Source Document could not be parsed: <reason>" (at most 512 characters), except a deadline, which is 504 `source_ingestion_timeout`.
11. **Staged sources:** ingestion writes `<FREE_SOURCE_INBOX>/<projectContextId>/<attemptId>.pdf` in the request (temporary file, then rename); reprocessing writes `<FREE_SOURCE_INBOX>/<projectContextId>/reprocess-<sourceDocumentId>-<requestKey>.pdf` in the workflow's first step from the canonical package. Both names map back to their workflow ID for M6's garbage collection. Studio's default inbox is `join(envPaths('FREE Studio').data, 'source-inbox')`; Compose sets `FREE_SOURCE_INBOX=/var/lib/free/source-inbox` on Studio and `KEI_SOURCE_INBOX=/app/source-inbox` (read-only) on `parsing_worker`.
12. **Ingestion waits at most thirty minutes for its workflow** by polling the workflow status every 500 ms (`awaitWorkflowOutcome`, Task 1), because `ClientHandle.getResult` cannot time out and would keep polling after a 504. A 504 detaches; nothing is cancelled. The response contract is unchanged apart from the missing key.
13. **Suggestion attempts:** new enum `SuggestionAttemptOutcome { SUCCEEDED FAILED }`; `phase` becomes a nullable `{READY, HETEROGENEOUS}` describing the retained proposal; `failure` is the current attempt's. An attempt is *active* while it has no outcome and its workflow is live; an attempt with no outcome whose workflow is terminal or gone reads as FAILED `interrupted` and counts as terminal for retry. Retry body `{ expectedAttempt }`; a later attempt answers 409 `attempt_conflict`; an active attempt, a confirmed suggestion or an empty selection answers 409 `operation_not_ready`.
14. **Reprocess retry in the browser:** a Retry after an uncertain failure (a network error, or an unmarked 502, 503 or 504) re-sends the same `requestKey`; a response with `X-FREE-Reprocess-Terminal: 1` or another confirmed 4xx mints a new one (spec *Client IDs*). Upload items get a client-only `itemId` that is never sent.
15. **Extraction cancel keeps its routes and statuses:** 202 `{extractionId}` when the cancel wrote the outcome, 404 "That Extraction is not active." otherwise; batch members still cannot be cancelled one by one. After the commit it cancels `extract:<id>` and `kei-extract:<id>` if live; a failure there is logged, never surfaced (the row is authoritative; M6's `collectGarbage` repairs a missed cancel).
16. ★ **Deletion records the interruption in M4.** `deleteSourceDocument` locks the affected suggestion rows in sorted order and writes `outcome FAILED, failure interrupted` on an active attempt (proposal, draft and `draftVersion` untouched) in the deletion transaction, then cancels the deleted scope's live Studio workflows and their kei children after commit (best effort). The spec lists the interruption write under M6 (*Milestones → M6 → Garbage collection*), but M4's acceptance ("late success/failure cannot overwrite an interrupted attempt") cannot be met without it. M6 keeps the scheduled repair of a missed cancel and all garbage collection.
17. **Test infrastructure:**
    - **kei stand-in** (`packages/extraction/src/testing/kei-stand-in.ts`, exported as `extraction/kei-stand-in`): a TypeScript DBOS application named `kei` (version `kei@1`, its own schema) that registers portable `convert` and `extract` with kei's names, kei's four lanes with kei's limits, and serves kei's read routes (`/api/models`, `/api/extraction-models`, `/api/ingestion-models`, `/api/runs/{id}/result`, `/api/runs/{id}/pages/{n}`, `/api/runs/{id}/extractions/{xid}`). Each workflow asks a `decide` callback, inside a step, how to finish. It runs in-process where no other DBOS application runs (the Playwright worker of the canonical e2e spec) and as a child process (`kei-stand-in-cli.ts`, controlled over HTTP) in the handoff test and wherever Studio's DBOS runs in the test process.
    - **Studio PostgreSQL tier** (`prototypes/studio/vitest.postgres.config.ts`, files `**/*.postgres.test.ts`, `fileParallelism: false`, `pool: 'forks'`) on `EXTRACTION_TEST_DATABASE_URL`, with one DBOS schema per test file; added to `test:postgres:node`, so CI runs it with no new environment.
    - **Crash harness** (`prototypes/studio/test/support/workflowChild.ts` + `crash.ts`): a `node --import tsx` child launches Studio's DBOS with scenario ports whose publication function SIGKILLs the process right after its commit on the first run; the parent restarts it with the same executor and schemas and waits for recovery.

## Review Focus

1. **A pooled connection is ended or leaked by the Prisma Next binding** (a `bound.close()`, a missing `release`, or a release after a failed `ROLLBACK`). Expected: after many admissions, rollbacks and SQL errors the pool holds live clients and serves queries. Pinned by Task 2 `the pool keeps serving after twenty admissions, rollbacks and SQL errors, and no committed admission ended its client`.
2. **A cancel, a replayed step or a late kei completion writes a second outcome** — cancel racing publication, a kill between publication and checkpoint, or an interrupted suggestion attempt that finishes anyway. Expected: exactly one terminal write per Extraction or attempt. Pinned by Task 6 `cancel racing completion has one winner`, Task 6/9/10/11 kill tests, Task 12 `a late success or failure of the interrupted attempt changes nothing`.
3. **A row without an outcome whose workflow is gone reads as running forever** (Studio restarted after a crash, history deleted, a workflow that returned SUCCESS without publishing). Expected: FAILED `interrupted`, never perpetual RUNNING. Pinned by Task 2 `execution-status` cases and Task 6 `a SUCCESS workflow over a row without an outcome reads as interrupted after the re-read`.
4. **A same-content upload races or re-arrives** (two tabs, a reload after a 504, completion between the precheck and the enqueue). Expected: one conversion, one Source Document, the loser's staging file removed, the active attempt's file never removed. Pinned by Task 10's four race tests.
5. **A kei child keeps running after its Studio parent stopped caring** (the parent failed unexpectedly after `submitToKei`, the Extraction was cancelled, the source was deleted). Expected: the child is cancelled (best effort, repaired in M6). Pinned by Task 5 `an unexpected failure after submission cancels the kei child before rethrowing`, Task 6 `cancel writes the cancelled outcome and stops the Studio workflow and its kei child`, Task 12 `after deletion commits, the deleted source's live Studio workflows and their kei children are cancelled`.

---

### Task 1: DBOS in the Studio process: configuration, one launch, clients, queues, boot timestamp; the Studio PostgreSQL tier and crash harness

**Files:**
- Modify: `prototypes/studio/package.json` (dependency `"@dbos-inc/dbos-sdk": "5.1.10"`; script `test:postgres`), `pnpm-lock.yaml`, `package.json` (root `test:postgres:node`)
- Modify: `prototypes/studio/vite.server.config.ts`, `prototypes/studio/vitest.config.ts`, `prototypes/studio/tsconfig.node.json` (`include` gains `"test/support"`)
- Create: `prototypes/studio/vitest.postgres.config.ts`, `prototypes/studio/server/dbos.ts`, `prototypes/studio/server/dbos.test.ts`, `prototypes/studio/server/dbos.postgres.test.ts`, `prototypes/studio/server/workflows.ts`, `prototypes/studio/server/workflows.test.ts`, `prototypes/studio/vite.server.config.test.ts`
- Create: `prototypes/studio/test/support/postgres.ts`, `prototypes/studio/test/support/crash.ts`, `prototypes/studio/test/support/workflowChild.ts`, `prototypes/studio/test/support/scenarios/lifecycle.ts`
- Modify: `prototypes/studio/server/host.ts`, `server/host.test.ts`, `server/developmentHost.ts`, `server/developmentHost.test.ts`, `vite.config.ts` (comment at 82-87), `vite.config.test.ts` (172-466)
- Move: `prototypes/studio/src/schemaChanges.ts` → `prototypes/studio/shared/schemaChanges.ts` (and its test, if `src/schemaChanges.test.ts` exists); update `api/schema_revisions.ts:8` and every `src/` importer (`grep -rn "schemaChanges" prototypes/studio/src prototypes/studio/api`)

**Interfaces:**
- Consumes: nothing from earlier M4 tasks.
- Produces (`server/dbos.ts`):
  ```ts
  export const STUDIO_APPLICATION = 'studio', STUDIO_SCHEMA = 'dbos', STUDIO_VERSION = 'studio@1', STUDIO_EXECUTOR = 'studio'
  export const STUDIO_QUEUE = 'studio', SUGGEST_QUEUE = 'suggest', KEI_APPLICATION = 'kei', KEI_SCHEMA = 'kei_dbos'
  export type StudioDbosOptions = Readonly<{ databaseUrl: string; register: () => void; schema?: string; keiSchema?: string; executorId?: string }>
  export type StudioDbos = Readonly<{ bootTimestampMs: number; admission: DBOSClient; kei: DBOSClient }>
  export function studioDbosConfig(options: Pick<StudioDbosOptions, 'databaseUrl' | 'schema' | 'executorId'>): DBOSConfig
  export function launchStudioDbos(options: StudioDbosOptions): Promise<StudioDbos>
  export function studioDbos(): StudioDbos                       // throws before launch
  export function shutdownStudioDbos(): Promise<void>
  export function databaseClockMs(databaseUrl: string): Promise<number>
  export type AwaitedWorkflow<T> = { state: 'finished'; output: T } | { state: 'stopped'; status: string } | { state: 'timed-out' }
  export function awaitWorkflowOutcome<T>(client: Pick<DBOSClient, 'listWorkflows'>, workflowId: string, options: { timeoutMs: number; signal?: AbortSignal; intervalMs?: number; now?: () => number }): Promise<AwaitedWorkflow<T>>
  ```
  `server/workflows.ts`: `export function registerStudioWorkflows(): void` and `export const STUDIO_WORKFLOW_NAMES: readonly string[]` (empty here; Tasks 6, 9, 10 and 11 each append one name and one registration).
  Test support: `disposableDatabaseUrl(): string`, `testSchemas(): { schema; keiSchema; executorId }`, `dropSchemas(url, ...names)`, `runWorkflowChild(scenario, env): Promise<{ code; signal; output }>`; scenario contract `export async function run(context: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void>`.

- [ ] **Step 1: Install and pin DBOS; keep it external to the server bundle**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  FREE_SKIP_PYTHON=1 pnpm --filter studio add --save-exact @dbos-inc/dbos-sdk@5.1.10
  pnpm why @dbos-inc/dbos-sdk          # one version: 5.1.10
  ```
  In `vite.server.config.ts` add inside `defineConfig({ … })`, beside `build`:
  ```ts
  // DBOS cannot be bundled (its lazy optional requires fail the build), and a bundled copy would be a second DBOS
  // singleton. Studio declares it, so Vite keeps it external; this line pins that choice (M0R PLAN IMPACT 1).
  ssr: { external: ['@dbos-inc/dbos-sdk', '@dbos-inc/vercel-ai'] },
  ```

- [ ] **Step 2: Move `schemaChanges` out of `src/`**

  Copy `prototypes/studio/src/schemaChanges.ts` (and its test, if present) to `prototypes/studio/shared/`, then `rm` the originals and stage both paths with `git add -A <old> <new>` (no `git rm`/`git mv`: Global Constraints). Fix its imports (`'../shared/schemaEdit.contract'` becomes `'./schemaEdit.contract'`) and every importer. Then `grep -rn "\.\./src/" prototypes/studio/api prototypes/studio/server prototypes/studio/shared --include=*.ts | grep -v "\.test\.ts"` must print nothing: no browser module is left in the server's module graph, so a hot-reloaded `src/` edit never re-evaluates server code.

- [ ] **Step 3: Write the failing unit tests**

  `server/dbos.test.ts` (`vi.mock('@dbos-inc/dbos-sdk')` with `DBOS.{setConfig, launch, isInitialized, registerQueue, shutdown}` and `DBOSClient.create` as spies that append to one shared `calls: string[]`; `vi.mock('pg', () => ({ default: { Client, Pool }, Client, Pool }))` — `server/dbos.ts` imports `pg`'s default export and `db.ts` its named ones — whose `Client.query` returns `{ rows: [{ ms: '1789000000000' }] }` and appends `clock`; `vi.resetModules()` in `beforeEach` so each test imports a fresh module):
  - `configures Studio's DBOS application: studio in schema dbos, version studio@1, executor studio, patching on` — `studioDbosConfig({ databaseUrl: 'postgresql://x' })` deep-equals `{ name: 'studio', systemDatabaseUrl: 'postgresql://x', systemDatabaseSchemaName: 'dbos', applicationVersion: 'studio@1', executorID: 'studio', enablePatching: true, enableOTLP: false, logLevel: 'info' }`.
  - `reads the boot timestamp from the database clock, then registers workflows, then launches, then registers the queues` — `calls` equals `['clock', 'register', 'setConfig', 'launch', 'registerQueue:studio', 'registerQueue:suggest', 'client:studio:dbos', 'client:kei:kei_dbos']`; `bootTimestampMs === 1789000000000`.
  - `registers the studio queue with a 100 ms polling floor and suggest with one global slot` — `registerQueue` called with `('studio', { minPollingIntervalMs: 100 })` and `('suggest', { globalConcurrency: 1 })`.
  - `creates the admission client as studio on dbos and the kei client as kei on kei_dbos` — `DBOSClient.create` called with `{ systemDatabaseUrl, systemDatabaseSchemaName: 'dbos', systemDatabasePoolSize: 2, applicationName: 'studio' }` and `{ …, systemDatabaseSchemaName: 'kei_dbos', systemDatabasePoolSize: 4, applicationName: 'kei' }`; neither client's `registerQueue` is ever called (kei owns its lanes).
  - `launches once per process: a second call returns the first launch and never launches again` — two calls return the same promise; `DBOS.launch` and `register` called once each.
  - `refuses to launch when DBOS was launched elsewhere in this process` — `DBOS.isInitialized` returns true → throws `/launched outside launchStudioDbos/` and never calls `setConfig`.
  - `studioDbos() throws before launch and returns the clients after it`.
  - `shutdown stops DBOS and destroys both clients once; a second shutdown does nothing`.
  - `awaitWorkflowOutcome returns a finished workflow's output and a stopped workflow's status, and times out without waiting past its deadline` — a fake `listWorkflows` scripted `[[{ status: 'PENDING' }], [{ status: 'SUCCESS', output: { ok: true } }]]` with `intervalMs: 1` → `{ state: 'finished', output: { ok: true } }`; a `CANCELLED` row → `{ state: 'stopped', status: 'CANCELLED' }`; an always-`PENDING` row with `timeoutMs: 5` → `{ state: 'timed-out' }`; an aborted signal rejects with its reason.

  `server/workflows.test.ts` (`vi.mock('@dbos-inc/dbos-sdk')` recording `registerWorkflow(fn, config)`):
  - `registers every Studio workflow once, each under its explicit name` — calling `registerStudioWorkflows()` twice records `STUDIO_WORKFLOW_NAMES.length` registrations, each with a `config.name`, whose names equal `STUDIO_WORKFLOW_NAMES` in order.
  - `importing the application registers no workflow` — `await import('./app.js')`; `registerWorkflow` was not called.

  `vite.server.config.test.ts`: `the server bundle keeps the DBOS packages external` — `(await import('./vite.server.config.ts')).default.ssr?.external` equals `['@dbos-inc/dbos-sdk', '@dbos-inc/vercel-ai']`.

  `server/host.test.ts`: extend `serves the shared app and shuts runtime plus listener down once on signal` with a `dbos: { launch, shutdown }` dependency: `launch` resolves before `serve` is called; one signal calls `shutdown` once, after the listener closed.

  `server/developmentHost.test.ts` and `vite.config.test.ts`: replace the runtime tests at `vite.config.test.ts:248-466` with
  - `loads /server/dbos.ts and /server/workflows.ts once and launches DBOS before the first composition` (the stub `ssrLoadModule` records paths; the `launchStudioDbos` spy is called once with `{ databaseUrl, register }`, `register === workflows.registerStudioWorkflows`);
  - `recomposes the application after a server module changes without launching DBOS again`;
  - `logs a restart hint once when a workflow module changes` (a change to `api/_ingestion_workflow.ts` gives one `logger.warn` containing `restart Studio`);
  - `shuts DBOS down when the HTTP server closes`;
  - keep `recomposes after a server module fails to evaluate`.
  Until Task 6 the extraction runtime keeps its own start and stop exactly as today.

  Run: `pnpm --filter studio exec vitest run server/dbos.test.ts server/workflows.test.ts server/host.test.ts server/developmentHost.test.ts vite.config.test.ts vite.server.config.test.ts`. Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `server/dbos.ts` and `server/workflows.ts`**

  ```ts
  import { setTimeout as delay } from 'node:timers/promises'
  import { DBOS, DBOSClient, type DBOSConfig } from '@dbos-inc/dbos-sdk'
  import pg from 'pg'

  export const STUDIO_APPLICATION = 'studio'
  export const STUDIO_SCHEMA = 'dbos'
  /** Fixed: a change to a workflow's step sequence uses DBOS.patch(); a new version only after draining (spec, *Versions*). */
  export const STUDIO_VERSION = 'studio@1'
  /** Recovery takes PENDING rows of the same executor and version only (M0R 2), and Studio is one process. */
  export const STUDIO_EXECUTOR = 'studio'
  export const STUDIO_QUEUE = 'studio'
  export const SUGGEST_QUEUE = 'suggest'
  export const KEI_APPLICATION = 'kei'
  export const KEI_SCHEMA = 'kei_dbos'
  const TERMINAL = new Set(['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'])

  export type StudioDbosOptions = Readonly<{
    databaseUrl: string
    /** Registers every Studio workflow (registerStudioWorkflows); called once, before DBOS.launch(). */
    register: () => void
    /** Tests give each file its own system schemas and executor; production uses the defaults. */
    schema?: string
    keiSchema?: string
    executorId?: string
  }>

  export type StudioDbos = Readonly<{
    /** The database clock (ms since the epoch) read before launch, after the previous Studio process exited. M6 deletes
     *  cancelled Studio history only when it was updated before this (spec, *Cancelled Studio history*). */
    bootTimestampMs: number
    /** Enqueues Studio's own workflows by name: in a caller's transaction for row-backed admission, or not. */
    admission: DBOSClient
    /** Enqueues, reads and cancels kei's workflows in kei_dbos. It never registers a queue: a client's registerQueue
     *  defaults to always_update and would overwrite kei's lane limits (spec, *Ownership*). */
    kei: DBOSClient
  }>

  export function studioDbosConfig(options: Pick<StudioDbosOptions, 'databaseUrl' | 'schema' | 'executorId'>): DBOSConfig {
    return {
      name: STUDIO_APPLICATION,
      systemDatabaseUrl: options.databaseUrl,
      systemDatabaseSchemaName: options.schema ?? STUDIO_SCHEMA,
      applicationVersion: STUDIO_VERSION,
      executorID: options.executorId ?? STUDIO_EXECUTOR,
      enablePatching: true,
      enableOTLP: false,
      logLevel: 'info',
    }
  }

  let launching: Promise<StudioDbos> | undefined
  let launched: StudioDbos | undefined

  /**
   * Launches DBOS once per process. A second DBOS.launch() resolves silently and ignores its configuration, and a
   * workflow registered after launch throws (M0R 2), so this is the only launcher: a repeated call returns the first
   * launch, and a DBOS launched by anyone else is refused.
   */
  export function launchStudioDbos(options: StudioDbosOptions): Promise<StudioDbos> {
    if (launching) return launching
    if (DBOS.isInitialized())
      throw new Error('DBOS was launched outside launchStudioDbos; Studio launches it once per process.')
    launching = start(options).then((dbos) => (launched = dbos))
    launching.catch(() => {
      launching = undefined
    })
    return launching
  }

  async function start(options: StudioDbosOptions): Promise<StudioDbos> {
    const bootTimestampMs = await databaseClockMs(options.databaseUrl)
    options.register()
    DBOS.setConfig(studioDbosConfig(options))
    await DBOS.launch()
    // Queues live in the system database, so they are registered after launch.
    await DBOS.registerQueue(STUDIO_QUEUE, { minPollingIntervalMs: 100 }) // p50 ~55 ms dequeue, not ~0.5 s (M0R 3)
    await DBOS.registerQueue(SUGGEST_QUEUE, { globalConcurrency: 1 })
    const admission = await DBOSClient.create({
      systemDatabaseUrl: options.databaseUrl,
      systemDatabaseSchemaName: options.schema ?? STUDIO_SCHEMA,
      systemDatabasePoolSize: 2, // a transactional enqueue writes through the caller's own client
      applicationName: STUDIO_APPLICATION,
    })
    const kei = await DBOSClient.create({
      // Studio's own role: kei's restricted role owns kei_dbos, and the database owner may use it. Creating a client
      // runs no query (client.js:68-71), so Studio starts before kei has migrated its schema.
      systemDatabaseUrl: options.databaseUrl,
      systemDatabaseSchemaName: options.keiSchema ?? KEI_SCHEMA,
      systemDatabasePoolSize: 4,
      applicationName: KEI_APPLICATION,
    })
    return { bootTimestampMs, admission, kei }
  }

  export function studioDbos(): StudioDbos {
    if (!launched) throw new Error('Studio has not launched DBOS in this process.')
    return launched
  }

  export async function shutdownStudioDbos(): Promise<void> {
    const current = await launching?.catch(() => undefined)
    launching = undefined
    launched = undefined
    if (!current) return
    await DBOS.shutdown()
    await Promise.all([current.admission.destroy(), current.kei.destroy()])
  }

  export async function databaseClockMs(databaseUrl: string): Promise<number> {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      const { rows } = await client.query<{ ms: string }>(
        'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms',
      )
      return Number(rows[0]!.ms)
    } finally {
      await client.end()
    }
  }

  export type AwaitedWorkflow<T> =
    | { state: 'finished'; output: T }
    | { state: 'stopped'; status: string }
    | { state: 'timed-out' }

  /** Waits for a workflow without ClientHandle.getResult, which cannot time out and would keep polling after the caller
   *  gave up. Reads the status every `intervalMs` until it is terminal, the deadline passes or `signal` aborts. */
  export async function awaitWorkflowOutcome<T>(
    client: Pick<DBOSClient, 'listWorkflows'>,
    workflowId: string,
    options: { timeoutMs: number; signal?: AbortSignal; intervalMs?: number; now?: () => number },
  ): Promise<AwaitedWorkflow<T>> {
    const now = options.now ?? Date.now
    const deadline = now() + options.timeoutMs
    for (;;) {
      options.signal?.throwIfAborted()
      const [status] = await client.listWorkflows({ workflowIDs: [workflowId], loadInput: false, loadOutput: true })
      if (!status) return { state: 'stopped', status: 'MISSING' }
      if (status.status === 'SUCCESS') return { state: 'finished', output: status.output as T }
      if (TERMINAL.has(status.status)) return { state: 'stopped', status: status.status }
      const remaining = deadline - now()
      if (remaining <= 0) return { state: 'timed-out' }
      await delay(Math.min(options.intervalMs ?? 500, remaining), undefined, { signal: options.signal })
    }
  }
  ```
  `server/workflows.ts`:
  ```ts
  /** Every Studio workflow's explicit name. A bundler renames unnamed functions (M0R 2: `job$1`), and a workflow started
   *  under one build must be recoverable by another. */
  export const STUDIO_WORKFLOW_NAMES: readonly string[] = []

  let registered = false

  /** Registers every Studio workflow. Only launchStudioDbos calls it, once, before DBOS.launch(); no module registers a
   *  workflow at import, because the API dispatcher and several tests import every handler module. */
  export function registerStudioWorkflows(): void {
    if (registered) return
    registered = true
  }
  ```

- [ ] **Step 5: Launch from the production host and the development host**

  `server/host.ts`: `StudioHostDependencies` gains `dbos?: { launch(): Promise<unknown>; shutdown(): Promise<void> }`, defaulting to
  ```ts
  {
    launch: () => launchStudioDbos({ databaseUrl: requiredDatabaseUrl(), register: registerStudioWorkflows }),
    shutdown: shutdownStudioDbos,
  }
  ```
  with `requiredDatabaseUrl()` throwing `"DATABASE_URL must name Studio's database."` when unset. In `startStudioServer`, `await dbos.launch()` before `serveApplication(...)` (a failed launch fails startup, so the Compose healthcheck never passes and `parsing_worker`, which waits for it, never starts); in `shutdown()`, `await closeServer(server)` first, then `await Promise.all([dbos.shutdown(), runtime.close().then(() => running), providerRuntime.close()])`.

  `server/developmentHost.ts`: when `server.httpServer` exists, before the first composition load `/server/dbos.ts` and `/server/workflows.ts` once and `await dbos.launchStudioDbos({ databaseUrl, register: workflows.registerStudioWorkflows })` (same `DATABASE_URL` error); keep that module object to call `shutdownStudioDbos()` from the existing `httpServer.once('close')` hook. `composition()` awaits the launch before `startExtractionRuntime().then(compose)`. In `scheduleRecomposition`, when the changed file matches `/(^|\/)(api\/_[a-z_]*_workflow\.ts|server\/workflows\.ts|packages\/extraction\/src\/workflows\.ts)$/`, log `server.config.logger.warn('A DBOS workflow module changed: restart Studio to run the new workflow code (Compose restarts it on every server edit).')` once for that change. Update the comment at `vite.config.ts:82-87`: DBOS launches once per process; recomposition re-evaluates handlers only.

- [ ] **Step 6: The Studio PostgreSQL tier and its helpers**

  `vitest.postgres.config.ts`:
  ```ts
  import { configDefaults, defineConfig } from 'vitest/config'

  // DBOS is one singleton per process: each file runs alone, in its own fork, with its own system schemas.
  export default defineConfig({
    test: {
      include: ['**/*.postgres.test.ts'],
      exclude: [...configDefaults.exclude, 'e2e/**'],
      pool: 'forks',
      fileParallelism: false,
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  })
  ```
  `vitest.config.ts` adds `'**/*.postgres.test.ts'` to `exclude`; `package.json` gains `"test:postgres": "vitest run --config vitest.postgres.config.ts"`; the root `test:postgres:node` becomes `"pnpm --filter db test:postgres && pnpm --filter extraction test:postgres && pnpm --filter studio test:postgres"` (CI already exports `DATABASE_URL` equal to `EXTRACTION_TEST_DATABASE_URL` and migrates it, so `scripts/test-ci.mjs` and `verify.yml` need no change).

  `test/support/postgres.ts`:
  ```ts
  import { randomBytes } from 'node:crypto'
  import pg from 'pg'
  import { validateDisposableTestDatabaseTarget } from 'db/database-url'

  /** The Studio PostgreSQL tier runs on CI's extraction database; DATABASE_URL (read by `db` at import) must name it. */
  export function disposableDatabaseUrl(): string {
    const url = process.env.EXTRACTION_TEST_DATABASE_URL
    if (!url || process.env.DATABASE_URL !== url)
      throw new Error('Export EXTRACTION_TEST_DATABASE_URL and DATABASE_URL, equal, naming a disposable free_test_* database.')
    validateDisposableTestDatabaseTarget(url)
    return url
  }

  export function testSchemas(hex = randomBytes(4).toString('hex')) {
    return { schema: `dbos_t_${hex}`, keiSchema: `kei_dbos_t_${hex}`, executorId: `studio-t-${hex}` }
  }

  export async function dropSchemas(url: string, ...schemas: string[]): Promise<void> {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      for (const schema of schemas) {
        if (!/^(dbos|kei_dbos)_t_[0-9a-f]{8}$/.test(schema)) throw new Error(`Refusing to drop schema ${schema}.`)
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      }
    } finally {
      await client.end()
    }
  }
  ```
  `test/support/crash.ts` spawns `process.execPath` with `['--import', 'tsx', 'test/support/workflowChild.ts', scenario]` in `prototypes/studio` with `env: { ...process.env, ...env }` (the `node --import tsx` form, because the `tsx` CLI forks a child that a SIGKILL of the CLI would leave running: M0R 2), collects stdout and stderr, and resolves `{ code, signal, output }` when the child exits (after 120 s it kills the child and rejects). `test/support/workflowChild.ts`:
  ```ts
  import { existsSync, writeFileSync } from 'node:fs'

  const name = process.argv[2]
  if (!name || !/^[a-z-]+$/.test(name)) throw new Error('Name a scenario in test/support/scenarios/.')
  const marker = process.env.FREE_CRASH_MARKER
  if (!marker) throw new Error('FREE_CRASH_MARKER must name a file the first run creates.')
  const firstRun = !existsSync(marker)
  if (firstRun) writeFileSync(marker, 'first run\n')
  const scenario = (await import(`./scenarios/${name}.ts`)) as {
    run(context: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void>
  }
  await scenario.run({ firstRun, env: process.env })
  process.exit(0)
  ```
  Every scenario reads `DATABASE_URL`, `FREE_TEST_DBOS_SCHEMA`, `FREE_TEST_KEI_SCHEMA` and `FREE_TEST_EXECUTOR`, launches with `launchStudioDbos({ databaseUrl, schema, keiSchema, executorId, register })`, and on its first run starts its work and dies at its crash point with `process.kill(process.pid, 'SIGKILL')`; on the second run it only waits for the workflow (`awaitWorkflowOutcome`, 60 s) and then calls `shutdownStudioDbos()`.

  `test/support/scenarios/lifecycle.ts`: its `register` calls `DBOS.registerWorkflow(probe, { name: 'lifecycleProbe' })`, where `probe(file)` runs step `a` (append `a`), step `b` (append `b-start`, then on the first run SIGKILL, else append `b-end`) and step `c` (append `c`), each through `DBOS.runStep(…, { name })` with `appendFileSync`; the first run enqueues it with `studioDbos().admission.enqueue({ queueName: 'studio', workflowName: 'lifecycleProbe', workflowID: 'lifecycle-probe' }, file)`.

  `server/dbos.postgres.test.ts` (`disposableDatabaseUrl()`, `testSchemas()`; `shutdownStudioDbos()` then `dropSchemas` in `afterAll`):
  - `launch creates its own schema and stores the studio queue with a 100 ms polling floor and suggest with one global slot` — after `launchStudioDbos` with a no-op `register`, `information_schema.schemata` lists the schema; `(await studioDbos().admission.retrieveQueue('studio'))!.minPollingIntervalMs === 100`; the `suggest` queue's global limit is 1 (`concurrency`, the field `WorkflowQueue` exposes).
  - `the boot timestamp is the database clock taken before launch` — a `clock_timestamp()` read before the call ≤ `bootTimestampMs` ≤ one read after it.
  - `a workflow killed mid-step recovers on the next launch with the same executor and version, without re-running finished steps` — `runWorkflowChild('lifecycle', env)` ends with `signal === 'SIGKILL'`; a second run exits 0; the file reads `a`, `b-start`, `b-start`, `b-end`, `c`.

- [ ] **Step 7: Run the tiers**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio test:postgres            # DATABASE_URL = EXTRACTION_TEST_DATABASE_URL (Global Constraints)
  pnpm --filter studio test:e2e                 # the Vite dev server now launches DBOS on the Playwright database
  pnpm --filter studio build && grep -c '@dbos-inc/dbos-sdk' prototypes/studio/dist/server/index.js
  ```
  Expected: all pass; the grep counts at least one external `import … from "@dbos-inc/dbos-sdk"`.

- [ ] **Step 8: Commit**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add package.json pnpm-lock.yaml prototypes/studio/package.json prototypes/studio/vite.server.config.ts \
    prototypes/studio/vite.server.config.test.ts prototypes/studio/vitest.config.ts prototypes/studio/vitest.postgres.config.ts \
    prototypes/studio/tsconfig.node.json prototypes/studio/vite.config.ts prototypes/studio/vite.config.test.ts \
    prototypes/studio/server prototypes/studio/test/support prototypes/studio/shared prototypes/studio/src \
    prototypes/studio/api/schema_revisions.ts
  git commit -m "feat(studio): launch DBOS once per Studio process with its queues, clients and boot timestamp"
  ```

### Task 2: One transaction for domain rows and DBOS enqueues; the status derivation

**Files:**
- Modify: `packages/db/src/prisma/db.ts`, `packages/db/src/index.ts`, `packages/db/package.json` (`devDependencies` `"@dbos-inc/dbos-sdk": "5.1.10"`; `test:postgres` gains the new check), `pnpm-lock.yaml`
- Create: `packages/db/src/pool-client-transaction.ts`, `packages/db/src/pool-client-transaction.postgres.check.ts`, `packages/db/src/execution-status.ts`, `packages/db/src/execution-status.test.ts`

**Interfaces:**
- Consumes: nothing from earlier M4 tasks.
- Produces:
  ```ts
  // packages/db/src/prisma/db.ts
  export const pool: import('pg').Pool                         // the one domain pool; `db` runs on it
  // packages/db/src/pool-client-transaction.ts
  export type AdmittedWorkflow = Readonly<{ workflowName: string; workflowID: string; queueName: string; authenticatedUser: string; attributes: Readonly<Record<string, unknown>> }>
  export type TransactionalEnqueue = (client: PoolClient, workflow: AdmittedWorkflow, input: unknown) => Promise<void>
  export function withPoolClientTransaction<T>(work: (transaction: DatabaseTransaction, client: PoolClient) => Promise<T>, source?: Pool): Promise<T>
  export function isUniqueViolation(error: unknown, constraint?: string): boolean
  // packages/db/src/execution-status.ts
  export type WorkflowStatuses = (workflowIds: readonly string[]) => Promise<ReadonlyMap<string, string>>
  export function workflowStatusesOf(listWorkflows: (input: { workflowIDs: string[]; loadInput: false; loadOutput: false }) => Promise<readonly { workflowID: string; status: string }[]>): WorkflowStatuses
  export type UnsettledExecution = 'QUEUED' | 'RUNNING' | 'REREAD' | 'INTERRUPTED'
  export function executionOf(status: string | undefined): UnsettledExecution
  export const LIVE_WORKFLOW_STATUSES: ReadonlySet<string>          // ENQUEUED, DELAYED, PENDING
  export const INTERRUPTED_FAILURE: Readonly<{ code: 'interrupted'; message: string }>
  ```
  All exported from `db`.

- [ ] **Step 1: Write the failing tests**

  `packages/db/src/execution-status.test.ts` (node:test):
  - `maps ENQUEUED and DELAYED to QUEUED, PENDING to RUNNING, SUCCESS to a re-read, and every other status or a missing workflow to interrupted` — table over `ENQUEUED`, `DELAYED`, `PENDING`, `SUCCESS`, `ERROR`, `CANCELLED`, `MAX_RECOVERY_ATTEMPTS_EXCEEDED`, `undefined`, and an unknown `'RETRIED'` (→ `INTERRUPTED`).
  - `reads every status with one listWorkflows call per 500 IDs and never asks for inputs or outputs` — a spy receives `{ workflowIDs, loadInput: false, loadOutput: false }` once for 3 IDs and three times for 1 001; the map holds what the spy returned; an empty list makes no call.
  - `the interrupted failure names no workflow and tells the researcher to start again` (`INTERRUPTED_FAILURE.code === 'interrupted'`, message has no `extract:`/`suggest:`/`ingest:`).

  `packages/db/src/pool-client-transaction.postgres.check.ts` (style of `model-configuration.postgres.check.ts`: top-level `test`, throws when `PROJECT_STORE_POSTGRES_URL` is unset, `validateDisposableTestDatabaseTarget`, sets `process.env.DATABASE_URL` before dynamic imports; creates its own accounts and deletes them in `after`). It launches DBOS once to migrate a throwaway schema, with no workflows, so an enqueued row stays `ENQUEUED`:
  ```ts
  const hex = randomBytes(4).toString('hex')
  const schema = `dbos_check_${hex}`
  DBOS.setConfig({ name: 'free-db-check', systemDatabaseUrl: url, systemDatabaseSchemaName: schema,
    applicationVersion: 'check@1', executorID: `db-check-${hex}`, enableOTLP: false, logLevel: 'error' })
  await DBOS.launch()
  const client = await DBOSClient.create({ systemDatabaseUrl: url, systemDatabaseSchemaName: schema, applicationName: 'studio' })
  const enqueue: TransactionalEnqueue = async (pgClient, workflow, input) => {
    await client.enqueueInTransaction(pgClient, { ...workflow, attributes: { ...workflow.attributes } }, input)
  }
  // after: await client.destroy(); await DBOS.shutdown(); DROP SCHEMA "<schema>" CASCADE; delete the accounts
  ```
  Sub-tests (each creates `ResearcherAccount` rows with `randomUUID()` identities inside the transaction):
  - `a rollback after domain writes and an enqueue leaves neither the row nor the workflow` (throw a sentinel after `enqueue`; afterwards `ResearcherAccount.first({ id })` is null and `client.getWorkflow(workflowID)` is `undefined`).
  - `a commit makes the row and the ENQUEUED workflow visible together, owned by studio` (`status === 'ENQUEUED'`, `applicationName === 'studio'`, `authenticatedUser` and `attributes` as sent).
  - `a unique violation inside the transaction rolls back its enqueue, and a new transaction can replay it` (insert an account, then in a second transaction insert the same `id` after enqueueing another workflow ID: the call rejects with `isUniqueViolation(error) === true`; that second workflow does not exist; a third transaction reads the first account).
  - `the pool keeps serving after twenty admissions, rollbacks and SQL errors, and no committed admission ended its client` (wrap `pool.connect` to count `end` events on the clients it hands out: after 20 committed admissions the count is 0 and `pool.totalCount <= 10`; after 5 rollbacks and 5 SQL errors `await pool.query('SELECT 1')` still succeeds).
  - `two concurrent admissions of one primary key: one commits, the other fails with a unique violation and leaves no workflow`.

  Add the check to `packages/db/package.json`'s `test:postgres`, after `kei-role.postgres.check.ts`. Install the dev dependency: `FREE_SKIP_PYTHON=1 pnpm --filter db add --save-dev --save-exact @dbos-inc/dbos-sdk@5.1.10`, then `pnpm why @dbos-inc/dbos-sdk` (one version).

  Run: `pnpm --filter db test` and `pnpm --filter db test:postgres` (fresh databases). Expected: FAIL (modules missing).

- [ ] **Step 2: Let `db.ts` own the pool**

  ```ts
  import { Pool } from 'pg'
  import postgres from '@prisma-next/postgres/runtime'
  import type { Contract } from './contract.d'
  import contractJson from './contract.json' with { type: 'json' }

  /** Studio's one domain pool. `db` runs on it, and withPoolClientTransaction checks one client out of it per
   *  admission. The timeouts are the ones Prisma Next's `url` binding gives its own pool. A pool connects on first use. */
  export const pool = new Pool({
    connectionString: process.env['DATABASE_URL'],
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 30_000,
  })

  export const db = postgres<Contract>({ contractJson, pg: pool })
  ```
  Keep the `Database`, `DatabaseOrm` and `DatabaseTransaction` types unchanged.

- [ ] **Step 3: The binding**

  ```ts
  import type { Client, Pool, PoolClient } from 'pg'
  import postgres from '@prisma-next/postgres/runtime'
  import type { Contract } from './prisma/contract.d'
  import contractJson from './prisma/contract.json' with { type: 'json' }
  import { pool as sharedPool, type DatabaseTransaction } from './prisma/db.js'

  /** A Studio workflow to enqueue inside a domain transaction (DBOSClient.enqueueInTransaction's options, by name). */
  export type AdmittedWorkflow = Readonly<{
    workflowName: string
    workflowID: string
    queueName: string
    /** The Project Context owner's Researcher Account; locates the scope, never authorizes it. */
    authenticatedUser: string
    attributes: Readonly<Record<string, unknown>>
  }>

  /** The enqueue half of a row-backed admission: writes the workflow row through `client`, inside its open
   *  transaction, so the row and the workflow commit or roll back together. Studio implements it with its admission
   *  client; `packages/db` imports no DBOS runtime. */
  export type TransactionalEnqueue = (client: PoolClient, workflow: AdmittedWorkflow, input: unknown) => Promise<void>

  /**
   * Runs `work` in one transaction on one client checked out of the shared pool, and hands it both Prisma Next's
   * transaction context and that client, so an ORM write and DBOSClient.enqueueInTransaction(client, …) share the
   * transaction (spec, *Admission → Binding*; proved with Prisma Next 0.16 and DBOS 5.0.2/5.1.10).
   *
   * Prisma Next releases a bound object with `release` after a transaction and calls `end` after a failed rollback.
   * Bind a view without `release` and with no-op `connect`/`end`; the helper alone releases the pooled client.
   * After a commit the client goes back to the pool; after any failure it is destroyed.
   */
  export async function withPoolClientTransaction<T>(
    work: (transaction: DatabaseTransaction, client: PoolClient) => Promise<T>,
    source: Pool = sharedPool,
  ): Promise<T> {
    const client = await source.connect()
    let failed = false
    try {
      const bound = postgres<Contract>({ contractJson, pg: clientView(client), verifyMarker: false })
      return await bound.transaction((transaction) => work(transaction, client))
    } catch (error) {
      failed = true
      throw error
    } finally {
      client.release(failed)
    }
  }

  function clientView(client: PoolClient): Client {
    return {
      escapeIdentifier: (value: string) => client.escapeIdentifier(value),
      escapeLiteral: (value: string) => client.escapeLiteral(value),
      connect: async () => {},
      end: async () => {},
      query: client.query.bind(client),
    } as unknown as Client
  }

  /** A PostgreSQL unique violation (23505), optionally on one named constraint; the error Prisma Next surfaces keeps the
   *  driver's `code` and `constraint` on itself or its cause. */
  export function isUniqueViolation(error: unknown, constraint?: string): boolean {
    for (let current = error; current && typeof current === 'object'; current = (current as { cause?: unknown }).cause) {
      const candidate = current as { code?: unknown; sqlState?: unknown; constraint?: unknown }
      if (candidate.code === '23505' || candidate.sqlState === '23505')
        return constraint === undefined || candidate.constraint === constraint
    }
    return false
  }
  ```
  `verifyMarker: false`: the shared `db` verifies the migration marker on first use, and the implemented helper triggers that read before its first shared-pool admission. A facade per admission would otherwise repeat the marker query. The implemented helper also attaches an error listener to its checked-out client until release. If the typecheck rejects `DatabaseTransaction` as the bound facade's transaction type, the two are the same generic instance (`PostgresTransactionContext<Contract>`); cast the callback's parameter, do not widen the type. Reuse `uniqueConstraint` from `project-store.ts:166-173` by replacing its body with a call to `isUniqueViolation`.

- [ ] **Step 4: The status derivation**

  ```ts
  /** The DBOS statuses of named workflows; a workflow DBOS no longer holds is absent. */
  export type WorkflowStatuses = (workflowIds: readonly string[]) => Promise<ReadonlyMap<string, string>>

  const CHUNK = 500

  /** One listWorkflows call per 500 IDs (spec: list endpoints read statuses in one call), without inputs or outputs. */
  export function workflowStatusesOf(
    listWorkflows: (input: { workflowIDs: string[]; loadInput: false; loadOutput: false }) =>
      Promise<readonly { workflowID: string; status: string }[]>,
  ): WorkflowStatuses {
    return async (workflowIds) => {
      const statuses = new Map<string, string>()
      for (let start = 0; start < workflowIds.length; start += CHUNK)
        for (const status of await listWorkflows({
          workflowIDs: workflowIds.slice(start, start + CHUNK), loadInput: false, loadOutput: false,
        }))
          statuses.set(status.workflowID, status.status)
      return statuses
    }
  }

  export const LIVE_WORKFLOW_STATUSES: ReadonlySet<string> = new Set(['ENQUEUED', 'DELAYED', 'PENDING'])

  export type UnsettledExecution = 'QUEUED' | 'RUNNING' | 'REREAD' | 'INTERRUPTED'

  /**
   * How work stands while its row has no outcome (spec, *Status and ownership*). An outcome on the row always wins, so
   * callers ask only for rows without one. SUCCESS means the workflow wrote its outcome just now: re-read the row, and a
   * row that still has none is interrupted, never perpetually running. ERROR, CANCELLED, MAX_RECOVERY_ATTEMPTS_EXCEEDED
   * and a workflow gone after retention are interrupted too.
   */
  export function executionOf(status: string | undefined): UnsettledExecution {
    switch (status) {
      case 'ENQUEUED':
      case 'DELAYED':
        return 'QUEUED'
      case 'PENDING':
        return 'RUNNING'
      case 'SUCCESS':
        return 'REREAD'
      default:
        return 'INTERRUPTED'
    }
  }

  /** What a researcher reads for work that stopped without an outcome. */
  export const INTERRUPTED_FAILURE = {
    code: 'interrupted',
    message: 'This work stopped before it finished. Start it again.',
  } as const
  ```
  Export all of it, `pool`, `withPoolClientTransaction`, `isUniqueViolation`, `AdmittedWorkflow` and `TransactionalEnqueue` from `packages/db/src/index.ts`. A DBOS or store outage makes `WorkflowStatuses` reject; callers let it reach the handlers, which answer 503 (`persistenceUnavailable`), never a fabricated status.

- [ ] **Step 5: Run the tiers**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test
  pnpm --filter db test:postgres          # fresh databases (Global Constraints)
  pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck && pnpm --filter studio test && pnpm --filter studio test:postgres
  ```
  Expected: all pass (every existing caller of `db` runs on the owned pool unchanged).

- [ ] **Step 6: Commit**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/db/src/prisma/db.ts packages/db/src/index.ts packages/db/src/project-store.ts packages/db/package.json \
    packages/db/src/pool-client-transaction.ts packages/db/src/pool-client-transaction.postgres.check.ts \
    packages/db/src/execution-status.ts packages/db/src/execution-status.test.ts pnpm-lock.yaml
  git commit -m "feat(db): commit domain rows and DBOS enqueues in one pooled-client transaction; derive unsettled status"
  ```

### Task 3: The kei handoff, the contract fixtures under node:test, and the kei stand-in

**Precondition:** M3 is merged (Global Constraints). This task reads `prototypes/parsing_service/tests/fixtures/contracts/*.json`.

**Files:**
- Modify: `packages/extraction/package.json` (`dependencies` `"@dbos-inc/dbos-sdk": "5.1.10"`; `exports` `./kei-handoff`, `./kei-stand-in`, `./kei-stand-in-client`; `test` adds `src/kei-handoff.test.ts`; `test:postgres` adds `src/kei-handoff.postgres.test.ts`), `pnpm-lock.yaml`
- Create: `packages/extraction/src/kei-handoff.ts`, `packages/extraction/src/kei-handoff.test.ts`, `packages/extraction/src/kei-handoff.postgres.test.ts`
- Create: `packages/extraction/src/testing/kei-stand-in.ts`, `packages/extraction/src/testing/kei-stand-in-cli.ts`, `packages/extraction/src/testing/kei-stand-in-client.ts`

**Interfaces:**
- Consumes: kei's contract (fixtures) and `KeiExpArtifact` / `keiExpArtifact` (`kei-exp.ts`, `kei-exp-fixture.ts`).
- Produces (`extraction/kei-handoff`):
  ```ts
  export const KEI_APPLICATION = 'kei'
  export const KEI_QUEUE: { convertLarge: 'kei-convert-large'; convertSmall: 'kei-convert-small'; extract: 'kei-extract'; gc: 'kei-gc' }
  export const KEI_PRIORITY: { interactive: 1; batch: 10 }
  export const CONVERSION_PRIORITY = 1
  export const SMALL_DOCUMENT_PAGES = 30
  export const UNCOUNTED_PAGE_BUDGET = 2000
  export const EXTRACTION_TIMEOUT_MS: { ARTICLE: 600_000; CATALOG: 10_800_000 }
  export const KEI_RUN_ID: RegExp
  export type ConversionLane = 'kei-convert-large' | 'kei-convert-small'
  export function conversionLane(pages: number | null): ConversionLane
  export function conversionTimeoutMs(pages: number | null): number
  export function keiConvertWorkflowId(parentWorkflowId: string): string       // kei-convert:<parent>
  export function keiExtractWorkflowId(extractionId: string): string           // kei-extract:<extractionId>
  export const keiConvertInputSchema, keiConvertOkSchema, keiExtractInputSchema, keiExtractOkSchema, keiFailureSchema  // zod
  export type KeiConvertInput, KeiConvertOk, KeiExtractInput, KeiExtractOk, KeiFailureCode
  export type KeiSubmission = Readonly<{ workflow: 'convert' | 'extract'; workflowId: string; queueName: string; priority: number; timeoutMs: number; request: KeiConvertInput | KeiExtractInput; authenticatedUser: string; attributes: Readonly<Record<string, unknown>> }>
  export type KeiPoll = { state: 'live' } | { state: 'missing' } | { state: 'SUCCESS'; output: unknown } | { state: 'ERROR' | 'CANCELLED' | 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'; deadlinePassed: boolean }
  export type KeiHandoff = Readonly<{ submit(s: KeiSubmission): Promise<void>; poll(workflowId: string, signal?: AbortSignal): Promise<KeiPoll>; cancel(workflowId: string): Promise<void> }>
  export function createKeiHandoff(client: Pick<DBOSClient, 'enqueuePortable' | 'listWorkflows' | 'cancelWorkflow'>, options?: { pollWindowMs?: number; pollIntervalMs?: number; now?: () => number }): KeiHandoff
  export type KeiOutcome<T> = { ok: true; value: T } | { ok: false; code: KeiFailureCode | 'deadline_exceeded' | 'stopped' | 'invalid_output'; reason: string; retryable: boolean }
  export function settleKei<T>(poll: Exclude<KeiPoll, { state: 'live' }>, okSchema: z.ZodType<T>): KeiOutcome<T>
  export function keiNotReady(error: unknown): boolean
  export const SUBMIT_TO_KEI_RETRY: StepConfig                                  // retries only keiNotReady, 5 s × 120
  ```
  `extraction/kei-stand-in`: `launchKeiStandIn(options: { databaseUrl: string; schema: string; port: number; script: KeiStandInScript; executorId?: string }): Promise<{ readUrl: string; close(): Promise<void> }>`; `KeiStandInScript = { convert?(request, workflowId): Promise<StandInDecision<StandInConversion>>; extract?(request, workflowId): Promise<StandInDecision<{ artifact: unknown }>> }`; `StandInDecision<T> = { output: T } | { failure: { code: KeiFailureCode; reason: string; retryable: boolean } }`; `StandInConversion = { runId: string; manifest: Record<string, unknown>; pages: ReadonlyMap<number, Uint8Array> }`.
  `extraction/kei-stand-in-client`: `spawnKeiStandIn(options: { databaseUrl: string; schema: string; port?: number; fixture?: string }): Promise<{ url: string; policy(p: StandInPolicy): Promise<void>; held(): Promise<HeldWork[]>; answer(workflowId: string, answer: StandInAnswer): Promise<void>; kill(signal?: NodeJS.Signals): Promise<void>; stop(): Promise<void> }>` with `StandInPolicy = { convert?: 'auto' | 'hold' | { failure }; extract?: 'auto' | 'hold' | { failure } }`, `HeldWork = { workflowId: string; workflow: 'convert' | 'extract'; request: unknown }`, `StandInAnswer = { artifact: unknown } | { failure } | { convert: 'auto' }`.

- [ ] **Step 1: Write the failing contract test (node:test)**

  `packages/extraction/src/kei-handoff.test.ts`:
  ```ts
  import assert from 'node:assert/strict'
  import { readFileSync } from 'node:fs'
  import test from 'node:test'
  import * as handoff from './kei-handoff.js'

  const FIXTURES = new URL('../../../prototypes/parsing_service/tests/fixtures/contracts/', import.meta.url)
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))
  ```
  - `every contract fixture parses with Studio's schema and round-trips`: `keiConvertInputSchema.parse(fixture('convert.input').request)` deep-equals the fixture request; the same for `keiExtractInputSchema` on `extract.input`, `keiConvertOkSchema` on `convert.output.ok`, `keiExtractOkSchema` on `extract.output.ok`, `keiFailureSchema` on both `*.output.failed`.
  - `Studio's lanes, priorities, prefixes and small-document threshold are the fixture's`: `fixture('queues')` has `small_document_pages === SMALL_DOCUMENT_PAGES` (30), `priorities` equal `KEI_PRIORITY`, `application_name === KEI_APPLICATION`, `Object.keys(queues)` equal the four `KEI_QUEUE` values, `workflow_id_prefixes.convert` / `.extract` equal the prefixes `keiConvertWorkflowId('')` / `keiExtractWorkflowId('')` produce; `convert.input`'s `enqueue.priority === CONVERSION_PRIORITY` and its `workflow_id === keiConvertWorkflowId('ingest:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222')`.
  - `the conversion budget is deadlines.json's formula at every listed page count`: for each `[pages, ms]` in `fixture('deadlines').convert.cases`, `conversionTimeoutMs(pages) === ms`; `conversionTimeoutMs(null) === conversionTimeoutMs(2000)`.
  - `extraction deadlines are ten minutes for Article and three hours for Catalog`: `EXTRACTION_TIMEOUT_MS` equals `{ ARTICLE: fixture('deadlines').extract.article, CATALOG: fixture('deadlines').extract.catalog }`.
  - `30 pages convert on kei-convert-small, 31 and an uncounted PDF on kei-convert-large`.
  - `run and extraction IDs must fully match one path component`: `KEI_RUN_ID` accepts `run-0123456789abcdef01234567`, a UUID and `x-1`, and refuses `../x`, `a/b`, `.hidden`, `x\n`, `` (empty) and `x y`; `keiConvertOkSchema` refuses an output whose `run_id` is `run/../x`.
  - `a finished kei workflow settles by its output; cancelled, errored, exhausted, missing and malformed ones settle as typed failures`: `settleKei({ state: 'SUCCESS', output: fixture('convert.output.ok') }, keiConvertOkSchema)` is `{ ok: true, value }`; the failed fixture gives `{ ok: false, code: 'source_mismatch', … }`; `{ state: 'CANCELLED', deadlinePassed: true }` → `deadline_exceeded`; `deadlinePassed: false` → `cancelled`; `ERROR` → `stopped` not retryable; `MAX_RECOVERY_ATTEMPTS_EXCEEDED` → `stopped` retryable; `{ state: 'SUCCESS', output: { ok: true } }` → `invalid_output`.
  - `kei-not-ready errors are a missing table or schema, a starting server, and a refused or reset connection, anywhere in the cause chain`: true for `{ code: '42P01' }`, `{ code: '3F000' }`, `{ code: '57P03' }`, `Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })`; false for `{ code: '23505' }`, a plain `Error`, `undefined`.
  - `a poll reads the child until it is terminal or its window ends, and a cancel touches only a live child` (fake client: `listWorkflows` scripted `PENDING`, `PENDING`, `SUCCESS`; `pollIntervalMs: 1`; a window of 0 with `PENDING` returns `{ state: 'live' }`; `cancel` on a `SUCCESS` or missing child never calls `cancelWorkflow`, on `ENQUEUED` calls it once).
  - `submit enqueues the child portably by name, as kei's application, with its lane, priority, deadline, owner and the parent's attributes` (fake `enqueuePortable` records `(options, args)`: `options` equal `{ workflowName: 'extract', queueName: 'kei-extract', workflowID: 'kei-extract:x', priority: 10, workflowTimeoutMS: 10_800_000, applicationName: 'kei', authenticatedUser: 'owner', attributes: { projectContextId: 'p' } }`, `args` equal `[request]`).

  Run: `pnpm --filter extraction exec tsx --test src/kei-handoff.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 2: Implement `kei-handoff.ts`**

  Install first: `FREE_SKIP_PYTHON=1 pnpm --filter extraction add --save-exact @dbos-inc/dbos-sdk@5.1.10` and `pnpm why @dbos-inc/dbos-sdk` (one version).
  ```ts
  import { setTimeout as delay } from 'node:timers/promises'
  import type { DBOSClient, StepConfig } from '@dbos-inc/dbos-sdk'
  import { z } from 'zod'

  /** kei's lanes, priorities and identities (prototypes/parsing_service/src/kei_exp/workflows/config.py and contracts.py;
   *  pinned by tests/fixtures/contracts/). kei registers the queues; Studio only names one. */
  export const KEI_APPLICATION = 'kei'
  export const KEI_QUEUE = {
    convertLarge: 'kei-convert-large', convertSmall: 'kei-convert-small', extract: 'kei-extract', gc: 'kei-gc',
  } as const
  export const KEI_PRIORITY = { interactive: 1, batch: 10 } as const
  /** A conversion lane runs one job at a time, so every conversion goes at one constant priority (kei refuses 0). */
  export const CONVERSION_PRIORITY = KEI_PRIORITY.interactive
  /** At most this many pages convert on kei-convert-small, beside a book on kei-convert-large (decision 14). */
  export const SMALL_DOCUMENT_PAGES = 30
  /** kei's page limit (KEI_MAX_PAGES): the budget of a PDF whose pages pdf.js could not count. */
  export const UNCOUNTED_PAGE_BUDGET = 2000
  /** Measured from kei's dequeue; Studio's parents have no deadline and end with their child. */
  export const EXTRACTION_TIMEOUT_MS = { ARTICLE: 600_000, CATALOG: 10_800_000 } as const
  const CONVERT_PREFIX = 'kei-convert:'
  const EXTRACT_PREFIX = 'kei-extract:'
  /** One path component, kei's runs.COMPONENT; `$` without the m flag matches only at the very end in JavaScript. */
  export const KEI_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

  export type ConversionLane = typeof KEI_QUEUE.convertLarge | typeof KEI_QUEUE.convertSmall

  /** The lane is fixed at admission from the page count and recorded in the workflow input, so recovery keeps it. A PDF
   *  pdf.js cannot open (null) goes to the large lane; kei's PDFium still decides whether it is readable. */
  export function conversionLane(pages: number | null): ConversionLane {
    return pages !== null && pages <= SMALL_DOCUMENT_PAGES ? KEI_QUEUE.convertSmall : KEI_QUEUE.convertLarge
  }

  /** M0R 4: max(10 min, 60 s + 18.9 s × pages), provisional until the ~2000-page Spark run. */
  export function conversionTimeoutMs(pages: number | null): number {
    return Math.max(600_000, 3 * (20_000 + 6_300 * (pages ?? UNCOUNTED_PAGE_BUDGET)))
  }

  export const keiConvertWorkflowId = (parentWorkflowId: string) => `${CONVERT_PREFIX}${parentWorkflowId}`
  export const keiExtractWorkflowId = (extractionId: string) => `${EXTRACT_PREFIX}${extractionId}`

  const runId = z.string().regex(KEI_RUN_ID)
  const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
  const pageSource = z.enum(['pdf', 'ingest'])
  export const keiConvertInputSchema = z.object({
    source: z.string().min(1), source_sha256: sha256, source_name: z.string().min(1).max(512), page_source: pageSource,
    ingest: z.record(z.string(), z.unknown()).nullable(), model: z.string().min(1).nullable(),
    layout_model: z.string().min(1).nullable(), cut: z.enum(['auto', 'none']), debug: z.boolean(),
  }).strict()
  export const keiConvertOkSchema = z.object({
    ok: z.literal(true), run_id: runId, generation: z.string().min(1), page_count: z.number().int().positive(),
    source_sha256: sha256, page_source: pageSource,
  }).strict()
  export const keiExtractInputSchema = z.object({
    run_id: runId, generation: z.string().min(1),
    request: z.object({ schema: z.record(z.string(), z.unknown()), options: z.record(z.string(), z.unknown()) }).strict(),
  }).strict()
  export const keiExtractOkSchema = z.object({
    ok: z.literal(true), run_id: runId, extraction_id: runId, generation: z.string().min(1), artifact_sha256: sha256,
    model: z.string().min(1), models: z.record(z.string(), z.string()),
  }).strict()
  export const KEI_FAILURE_CODES = [
    'invalid_request', 'source_missing', 'source_mismatch', 'source_unreadable', 'too_many_pages', 'model_unavailable',
    'conversion_failed', 'conversion_incomplete', 'no_result', 'stale_generation', 'extraction_failed', 'cancelled',
  ] as const
  export const keiFailureSchema = z.object({
    ok: z.literal(false), code: z.enum(KEI_FAILURE_CODES), reason: z.string(), retryable: z.boolean(),
  }).strict()
  export type KeiConvertInput = z.infer<typeof keiConvertInputSchema>
  export type KeiConvertOk = z.infer<typeof keiConvertOkSchema>
  export type KeiExtractInput = z.infer<typeof keiExtractInputSchema>
  export type KeiExtractOk = z.infer<typeof keiExtractOkSchema>
  export type KeiFailureCode = (typeof KEI_FAILURE_CODES)[number]

  export type KeiSubmission = Readonly<{
    workflow: 'convert' | 'extract'
    workflowId: string
    queueName: string
    priority: number
    timeoutMs: number
    request: KeiConvertInput | KeiExtractInput
    authenticatedUser: string
    /** The parent's attributes, so a scope's kei work is found like its Studio work. */
    attributes: Readonly<Record<string, unknown>>
  }>
  export type KeiPoll =
    | { state: 'live' }
    | { state: 'missing' }
    | { state: 'SUCCESS'; output: unknown }
    | { state: 'ERROR' | 'CANCELLED' | 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'; deadlinePassed: boolean }
  export type KeiHandoff = Readonly<{
    /** Enqueues the child; reusing its deterministic ID returns the existing workflow in every state (M0 #1). */
    submit(submission: KeiSubmission): Promise<void>
    /** Reads the child every pollIntervalMs for at most pollWindowMs (M0 #2); an aborted signal rejects at once. */
    poll(workflowId: string, signal?: AbortSignal): Promise<KeiPoll>
    /** Cancels the child only while it is live: a repeated cancel moves a cancelled workflow's updated_at (M0R 4). */
    cancel(workflowId: string): Promise<void>
  }>

  const LIVE = new Set(['ENQUEUED', 'DELAYED', 'PENDING'])
  const STOPPED = new Set(['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'])

  export function createKeiHandoff(
    client: Pick<DBOSClient, 'enqueuePortable' | 'listWorkflows' | 'cancelWorkflow'>,
    options: { pollWindowMs?: number; pollIntervalMs?: number; now?: () => number } = {},
  ): KeiHandoff {
    const windowMs = options.pollWindowMs ?? 30_000
    const intervalMs = options.pollIntervalMs ?? 2_000
    const now = options.now ?? Date.now
    const status = async (workflowId: string, loadOutput: boolean) =>
      (await client.listWorkflows({ workflowIDs: [workflowId], loadInput: false, loadOutput }))[0]
    return {
      async submit(submission) {
        await client.enqueuePortable(
          {
            workflowName: submission.workflow,
            queueName: submission.queueName,
            workflowID: submission.workflowId,
            priority: submission.priority,
            workflowTimeoutMS: submission.timeoutMs,
            applicationName: KEI_APPLICATION, // unowned rows could be dequeued by any application (M0R 3)
            authenticatedUser: submission.authenticatedUser,
            attributes: { ...submission.attributes },
          },
          [submission.request],
        )
      },
      async poll(workflowId, signal) {
        const deadline = now() + windowMs
        for (;;) {
          signal?.throwIfAborted()
          const current = await status(workflowId, true)
          if (!current) return { state: 'missing' }
          if (current.status === 'SUCCESS') return { state: 'SUCCESS', output: current.output }
          if (STOPPED.has(current.status))
            return {
              state: current.status as 'ERROR' | 'CANCELLED' | 'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
              // kei stamps a deadline cancel with the database clock (M0R 4); a live parent reads it right after.
              deadlinePassed: current.deadlineEpochMS !== undefined && (current.updatedAt ?? now()) >= current.deadlineEpochMS,
            }
          const remaining = deadline - now()
          if (remaining <= 0) return { state: 'live' }
          await delay(Math.min(intervalMs, remaining), undefined, { signal })
        }
      },
      async cancel(workflowId) {
        const current = await status(workflowId, false)
        if (current && LIVE.has(current.status)) await client.cancelWorkflow(workflowId)
      },
    }
  }

  export type KeiOutcome<T> =
    | { ok: true; value: T }
    | { ok: false; code: KeiFailureCode | 'deadline_exceeded' | 'stopped' | 'invalid_output'; reason: string; retryable: boolean }

  export function settleKei<T>(poll: Exclude<KeiPoll, { state: 'live' }>, okSchema: z.ZodType<T>): KeiOutcome<T> {
    if (poll.state === 'SUCCESS') {
      const ok = okSchema.safeParse(poll.output)
      if (ok.success) return { ok: true, value: ok.data }
      const failed = keiFailureSchema.safeParse(poll.output)
      if (failed.success)
        return { ok: false, code: failed.data.code, reason: failed.data.reason, retryable: failed.data.retryable }
      return { ok: false, code: 'invalid_output', reason: 'The Parsing Service answered outside its contract.', retryable: false }
    }
    if (poll.state === 'CANCELLED')
      return poll.deadlinePassed
        ? { ok: false, code: 'deadline_exceeded', reason: 'The Parsing Service stopped the work at its deadline.', retryable: false }
        : { ok: false, code: 'cancelled', reason: 'The Parsing Service work was cancelled.', retryable: false }
    return {
      ok: false, code: 'stopped', reason: 'The Parsing Service stopped this work.',
      retryable: poll.state === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
    }
  }

  const NOT_READY = new Set(['42P01', '3F000', '57P03', 'ECONNREFUSED', 'ECONNRESET'])

  /** kei has not migrated kei_dbos yet (it starts after Studio is healthy), or the database is restarting. */
  export function keiNotReady(error: unknown): boolean {
    let current: unknown = error
    for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
      const code = (current as { code?: unknown }).code
      if (typeof code === 'string' && NOT_READY.has(code)) return true
      current = (current as { cause?: unknown }).cause
    }
    return false
  }

  /** submitToKei retries until kei has migrated kei_dbos (spec, *Target architecture*): 5 s apart, for 10 minutes. */
  export const SUBMIT_TO_KEI_RETRY: StepConfig = {
    retriesAllowed: true, intervalSeconds: 5, backoffRate: 1, maxAttempts: 120, shouldRetry: keiNotReady,
  }
  ```
  Run the node:test file again: PASS.

- [ ] **Step 3: The kei stand-in**

  `src/testing/kei-stand-in.ts` (test-only; nothing in the runtime imports it). It plays kei at the contract: a DBOS application named `kei`, version `kei@1`, in the schema it is given, with kei's four lanes and limits and portable workflows `convert` and `extract` that each run one step (`convert_run`, `extract_run`) asking `script` how to finish. A held decision blocks inside the step, as a native step does, so a cancel leaves the step running and the lane occupied exactly as in kei.
  ```ts
  import { createHash } from 'node:crypto'
  import { createServer } from 'node:http'
  import { DBOS } from '@dbos-inc/dbos-sdk'
  import {
    KEI_QUEUE, keiConvertInputSchema, keiExtractInputSchema, keiExtractWorkflowId, KEI_RUN_ID,
    type KeiConvertInput, type KeiExtractInput, type KeiFailureCode,
  } from '../kei-handoff.js'

  export type StandInDecision<T> = { output: T } | { failure: { code: KeiFailureCode; reason: string; retryable: boolean } }
  export type StandInConversion = { runId: string; manifest: Record<string, unknown>; pages: ReadonlyMap<number, Uint8Array> }
  export type KeiStandInScript = {
    convert?(request: KeiConvertInput, workflowId: string): Promise<StandInDecision<StandInConversion>>
    extract?(request: KeiExtractInput, workflowId: string): Promise<StandInDecision<{ artifact: unknown }>>
  }
  const LANES = { [KEI_QUEUE.convertLarge]: 1, [KEI_QUEUE.convertSmall]: 1, [KEI_QUEUE.extract]: 2, [KEI_QUEUE.gc]: 1 }

  export async function launchKeiStandIn(options: {
    databaseUrl: string; schema: string; port: number; script: KeiStandInScript; executorId?: string
  }) {
    if (DBOS.isInitialized()) throw new Error('The kei stand-in needs a process without another DBOS application.')
    const results = new Map<string, { manifest: Record<string, unknown>; pages: ReadonlyMap<number, Uint8Array> }>()
    const artifacts = new Map<string, Uint8Array>() // `${runId}/${extractionId}`
    const fail = (code: KeiFailureCode, reason: string) => ({ ok: false, code, reason, retryable: false })
    DBOS.registerWorkflow(async (raw: unknown) => {
      const workflowId = DBOS.workflowID!
      return DBOS.runStep(async () => {
        const request = keiConvertInputSchema.safeParse(raw)
        if (!request.success) return fail('invalid_request', request.error.message)
        const decision = await options.script.convert?.(request.data, workflowId)
        if (!decision) return fail('conversion_failed', 'The stand-in has no conversion script.')
        if ('failure' in decision) return { ok: false, ...decision.failure }
        const { runId, manifest, pages } = decision.output
        if (!KEI_RUN_ID.test(runId)) throw new Error(`Invalid run ID ${runId}`)
        results.set(runId, { manifest, pages })
        return { ok: true, run_id: runId, generation: String(manifest.generation), page_count: pages.size,
                 source_sha256: request.data.source_sha256, page_source: request.data.page_source }
      }, { name: 'convert_run' })
    }, { name: 'convert', serialization: 'portable' })
    DBOS.registerWorkflow(async (raw: unknown) => {
      const workflowId = DBOS.workflowID!
      return DBOS.runStep(async () => {
        const extractionId = workflowId.slice(keiExtractWorkflowId('').length)
        const request = keiExtractInputSchema.safeParse(raw)
        if (!request.success || !KEI_RUN_ID.test(extractionId))
          return fail('invalid_request', 'The extract input or workflow ID is outside the contract.')
        const decision = await options.script.extract?.(request.data, workflowId)
        if (!decision) return fail('extraction_failed', 'The stand-in has no extraction script.')
        if ('failure' in decision) return { ok: false, ...decision.failure }
        const bytes = new TextEncoder().encode(JSON.stringify(decision.output.artifact))
        artifacts.set(`${request.data.run_id}/${extractionId}`, bytes)
        const artifact = decision.output.artifact as { generation: string; model: string; models: Record<string, string> }
        return { ok: true, run_id: request.data.run_id, extraction_id: extractionId, generation: artifact.generation,
                 artifact_sha256: createHash('sha256').update(bytes).digest('hex'), model: artifact.model, models: artifact.models }
      }, { name: 'extract_run' })
    }, { name: 'extract', serialization: 'portable' })
    DBOS.setConfig({ name: 'kei', systemDatabaseUrl: options.databaseUrl, systemDatabaseSchemaName: options.schema,
      applicationVersion: 'kei@1', executorID: options.executorId ?? 'kei-stand-in', enableOTLP: false, logLevel: 'error' })
    await DBOS.launch()
    for (const [name, limit] of Object.entries(LANES))
      await DBOS.registerQueue(name, { globalConcurrency: limit, workerConcurrency: limit, minPollingIntervalMs: 100 })
    // kei's read routes (M3 Task 10): listings, a run's manifest and pages, and a published extraction artifact.
    const server = createServer((request, response) => { /* see below */ })
    await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    return {
      readUrl: `http://127.0.0.1:${port}`,
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await DBOS.shutdown()
      },
    }
  }
  ```
  The server answers `GET /api/models` (`200 {}`), `GET /api/extraction-models` (`{ defaults: { fields: 'instruct', reasoning: 'instruct' }, models: [{ key: 'instruct', repo: 'fixture/nuextract', roles: ['fields', 'reasoning'], reachable: true, serving: true }] }`, the canonical spec's listing), `GET /api/ingestion-models` (`{ defaults: { ocr: 'surya', layout: 'layout_heron_101' }, models: { ocr: [{ key: 'surya', label: 'Surya', serving: true }], layout: [{ key: 'layout_heron_101', label: 'Heron 101', serving: true }] } }`), `GET /api/runs/{run}/result` (the manifest JSON), `GET /api/runs/{run}/pages/{n}` (the page bytes as `application/json`) and `GET /api/runs/{run}/extractions/{xid}` (the artifact bytes), each `404` when absent; `{run}` and `{xid}` must match `KEI_RUN_ID` or answer 404. Everything else is 404. Tests mount other routes on the same server through `control` (below), never through a second port.

  `src/testing/kei-stand-in-cli.ts` runs the stand-in in a child process (a test process whose own DBOS is Studio's cannot host it) and adds a control API under `/control/` on the same server:
  - env: `KEI_STAND_IN_DATABASE_URL`, `KEI_STAND_IN_SCHEMA`, `KEI_STAND_IN_PORT` (0 = any; the chosen port is printed as `kei stand-in serving <port>` once launched), `KEI_STAND_IN_FIXTURE` (a directory with a v5 `result.json` and `pages/<n>.json`, default Studio's `prototypes/studio/test/fixtures/kei-exp`).
  - policy (default `{ convert: 'auto', extract: 'auto' }`), `POST /control/policy`: `'auto'` answers at once, `'hold'` parks the decision until `POST /control/answer`, `{ failure }` answers with that failure.
  - `'auto'` conversion: run ID `stand-in-` + the first 16 hex digits of SHA-256 of the workflow ID (the stand-in plays kei, so it picks its own rule; Studio reads it from the output), the fixture manifest with `recipe.source_sha256` set to the request's `source_sha256`, the fixture pages.
  - `'auto'` extraction: `keiExpArtifact({ run_id, generation, strategy, schema, options: { model: null, models: null, ...options }, model: 'fixture/nuextract', models: { fields: 'fixture/nuextract', reasoning: 'fixture/nuextract' }, complete: true, records: [], evidence: [], ungrounded: [] })` from `kei-exp-fixture.ts`, taking `strategy`, `schema` and `options` from the request.
  - `GET /control/held` → `[{ workflowId, workflow, request }]`; `POST /control/answer { workflowId, artifact } | { workflowId, failure } | { workflowId, convert: 'auto' }` releases one held decision (404 when none).
  - SIGTERM closes the stand-in and exits 0.

  `src/testing/kei-stand-in-client.ts` spawns it with `process.execPath` and `['--import', 'tsx', <path of kei-stand-in-cli.ts>]`, waits for the `serving` line (30 s), and wraps the control routes; `kill(signal = 'SIGKILL')` kills it (a kei crash), `stop()` sends SIGTERM and waits.

- [ ] **Step 4: Write the PostgreSQL handoff test**

  `packages/extraction/src/kei-handoff.postgres.test.ts` (throws when `EXTRACTION_TEST_DATABASE_URL` is unset; `validateDisposableTestDatabaseTarget`; schemas `kei_dbos_t_<hex>` dropped in `after`). It spawns the stand-in child on its own schema, then drives it through `createKeiHandoff(await DBOSClient.create({ systemDatabaseUrl, systemDatabaseSchemaName, applicationName: 'kei' }), { pollWindowMs: 3_000, pollIntervalMs: 100 })`:
  - `submitting a child twice enqueues one kei workflow on its lane with its priority, deadline, owner and the parent's attributes` (after two `submit`s of `extract.input.json`'s request under `kei-extract:<uuid>` with policy `hold`: `listWorkflows({ workflow_id_prefix: 'kei-extract:' })` has one row with `queueName: 'kei-extract'`, `priority: 1`, `timeoutMS: 10_800_000`, `applicationName: 'kei'`, the `authenticatedUser` and `attributes`).
  - `a poll returns live within its window while kei works, then the finished output` (held → `{ state: 'live' }` after ~3 s; `answer` with `keiExpArtifact({ run_id, generation })` → the next poll is `SUCCESS` and `settleKei(…, keiExtractOkSchema)` is `ok` with `extraction_id` equal to the UUID and `artifact_sha256` equal to the SHA-256 of `GET <url>/api/runs/<run>/extractions/<uuid>`).
  - `cancel stops a live kei workflow and leaves a finished one untouched` (a held child is `CANCELLED` after `cancel`; a finished child's `updatedAt` is unchanged after `cancel`).
  - `a cancelled child's lane stays occupied until its step returns` (on `kei-convert-small` with policy `hold`: cancel the first child, submit a second; the second stays `ENQUEUED` until the first's held step is answered; mirrors M0R 4 at the contract).
  - `submitting before kei has migrated its schema fails with a kei-not-ready error` (a client on a schema no application launched: `submit` rejects and `keiNotReady(error)` is true).
  - `a convert fixture request converts on the lane named in its fixture and returns its run ID` (policy `auto`: the output parses with `keiConvertOkSchema`, and `GET <url>/api/runs/<run_id>/result` is the fixture manifest with the request's `source_sha256`).

  Run: `pnpm --filter extraction test:postgres`. Expected: PASS.

- [ ] **Step 5: Run the tiers and commit**

  ```bash
  pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck && pnpm --filter studio test
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/extraction/package.json pnpm-lock.yaml packages/extraction/src/kei-handoff.ts \
    packages/extraction/src/kei-handoff.test.ts packages/extraction/src/kei-handoff.postgres.test.ts packages/extraction/src/testing
  git commit -m "feat(extraction): hand work to kei's DBOS lanes by contract, with a kei stand-in for tests"
  ```

### Task 4: The page counter, the source inbox and its Compose volume

**Files:**
- Create: `prototypes/studio/api/_pdf_pages.ts`, `prototypes/studio/api/_pdf_pages.test.ts`, `prototypes/studio/api/_pdf_pages.destroy.test.ts`, `prototypes/studio/api/_source_inbox.ts`, `prototypes/studio/api/_source_inbox.test.ts`
- Modify: `packages/db/src/artifact-store.ts` (export `studioDataRoot()`; `packageRoot()` uses it), `packages/db/src/index.ts`
- Modify: `compose.yaml` (the `x-parsing-runtime` environment, `parsing_worker`, `studio`, `volumes`), `tests/safety.test.mjs` (`assertOwnedParsingTopology`)

**Interfaces:**
- Consumes: nothing from earlier M4 tasks.
- Produces:
  ```ts
  // api/_pdf_pages.ts
  export function countPdfPages(bytes: Uint8Array): Promise<number | null>
  // api/_source_inbox.ts
  export function sourceInboxRoot(environment?: NodeJS.ProcessEnv): string          // FREE_SOURCE_INBOX, else <studio data>/source-inbox
  export function uploadSourcePath(projectContextId: string, attemptId: string): string                           // <project>/<attempt>.pdf
  export function reprocessSourcePath(projectContextId: string, sourceDocumentId: string, requestKey: string): string // <project>/reprocess-<document>-<key>.pdf
  export function stageSource(root: string, relative: string, bytes: Uint8Array): Promise<void>
  export function removeStagedSource(root: string, relative: string): Promise<void>
  // packages/db
  export function studioDataRoot(): string                                          // envPaths('FREE Studio').data
  ```

- [ ] **Step 1: Write the failing tests**

  `api/_pdf_pages.test.ts` (real pdf.js), with a PDF builder in the test:
  ```ts
  /** A valid PDF of `pages` blank pages with a correct cross-reference table. */
  function blankPdf(pages: number): Uint8Array {
    const kids = Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(' ')
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
      ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'),
    ]
    let body = '%PDF-1.4\n'
    const offsets = objects.map((object, index) => {
      const offset = Buffer.byteLength(body)
      body += `${index + 1} 0 obj\n${object}\nendobj\n`
      return offset
    })
    const xref = Buffer.byteLength(body)
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return new TextEncoder().encode(body)
  }
  ```
  - `counts the pages of a PDF without rendering them` (1, 30 and 31 pages).
  - `answers null, never an exception, for bytes pdf.js cannot open` (`%PDF-1.7\n` followed by 200 bytes of `0x00`; an empty `%PDF-`).
  - `leaves the caller's bytes intact` (the input's `byteLength` and first bytes are unchanged afterwards).

  `api/_pdf_pages.destroy.test.ts` (`vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument }))` with `getDocument` returning `{ promise, destroy: vi.fn(async () => {}) }`):
  - `destroys the loading task after a count and after a failure to open` (`destroy` called once in each case; the failure answers null).

  `api/_source_inbox.test.ts` (a temporary directory root):
  - `stages an upload atomically under <project>/<attempt>.pdf` (the file has the bytes; the directory holds no `*.tmp` afterwards).
  - `identical bytes in two projects stage two independent files` (two paths; removing one leaves the other).
  - `a failed write leaves neither the staged file nor its temporary sibling` (stage into a root whose project directory is a regular file: rejects; nothing new exists).
  - `staging the same name again replaces the file` (a re-executed staging step).
  - `refuses identifiers that are not canonical lowercase UUIDs` (`../x`, `A…` uppercase, empty: `uploadSourcePath` and `reprocessSourcePath` throw before touching the disk).
  - `names a reprocess source by its document and request key` (`reprocessSourcePath(p, d, k) === `${p}/reprocess-${d}-${k}.pdf``).
  - `the inbox is FREE_SOURCE_INBOX, else source-inbox under Studio's data directory`.

  `tests/safety.test.mjs`, in `assertOwnedParsingTopology`:
  ```js
  // Studio stages source PDFs that kei's worker reads: one volume, written by Studio, read-only for kei, absent from
  // the API (M4). Both processes name the same files by their path relative to the volume.
  const inbox = (service) => (service.volumes ?? []).find(({ source }) => source === 'source-inbox')
  assert.ok(config.volumes['source-inbox'])
  assert.equal(inbox(services.studio)?.target, services.studio.environment.FREE_SOURCE_INBOX)
  assert.notEqual(inbox(services.studio)?.read_only, true)
  assert.equal(inbox(services.parsing_worker)?.target, services.parsing_worker.environment.KEI_SOURCE_INBOX)
  assert.equal(inbox(services.parsing_worker)?.read_only, true)
  assert.equal(inbox(services.parsing_service), undefined)
  ```
  Run: `pnpm --filter studio exec vitest run api/_pdf_pages.test.ts api/_pdf_pages.destroy.test.ts api/_source_inbox.test.ts` and `pnpm test:safety`. Expected: FAIL.

- [ ] **Step 2: Implement**

  `api/_pdf_pages.ts` (it deliberately does not reuse `api/_pdf.ts`, which opens outside its error handling and renders every page, `_pdf.ts:71-78`):
  ```ts
  import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

  /**
   * The page count of a PDF, or null when pdf.js cannot open it. It opens the document without loading a page and
   * destroys the loading task whatever happens. It never rejects: the count only picks kei's conversion lane, and kei's
   * PDFium still decides whether the PDF is readable, so an uncounted PDF converts on the large lane rather than being
   * refused (spec, *Studio → kei handoff → Unknown count*).
   */
  export async function countPdfPages(bytes: Uint8Array): Promise<number | null> {
    const loadingTask = pdfjsLib.getDocument({
      data: bytes.slice(), // pdf.js may transfer the buffer; the caller still stages and hashes its bytes
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    })
    try {
      return (await loadingTask.promise).numPages
    } catch {
      return null
    } finally {
      await loadingTask.destroy().catch(() => undefined)
    }
  }
  ```
  `api/_source_inbox.ts`:
  ```ts
  import { randomUUID } from 'node:crypto'
  import { mkdir, open, rename, rm } from 'node:fs/promises'
  import { dirname, join } from 'node:path'
  import { studioDataRoot } from 'db'
  import { canonicalUuidSchema } from '../shared/projectContext.contract.js'

  /** Where Studio stages source PDFs for kei's worker, which mounts the same volume read-only (KEI_SOURCE_INBOX). */
  export function sourceInboxRoot(environment: NodeJS.ProcessEnv = process.env): string {
    return environment.FREE_SOURCE_INBOX ?? join(studioDataRoot(), 'source-inbox')
  }

  function uuid(value: string, what: string): string {
    if (!canonicalUuidSchema.safeParse(value).success) throw new Error(`${what} must be a canonical lowercase UUID.`)
    return value
  }

  /** kei's `source` for an upload attempt. Files are named by project and attempt, never by content alone, so no two
   *  workflows share a file and garbage collection maps a file back to its workflow (spec, *Staged uploads*). */
  export function uploadSourcePath(projectContextId: string, attemptId: string): string {
    return `${uuid(projectContextId, 'projectContextId')}/${uuid(attemptId, 'attemptId')}.pdf`
  }

  /** kei's `source` for a reprocess attempt, staged from the canonical package by the workflow's first step. */
  export function reprocessSourcePath(projectContextId: string, sourceDocumentId: string, requestKey: string): string {
    return `${uuid(projectContextId, 'projectContextId')}/reprocess-${uuid(sourceDocumentId, 'sourceDocumentId')}-${uuid(requestKey, 'requestKey')}.pdf`
  }

  /** Writes `bytes` at `relative` atomically: a temporary sibling, fsync, rename, so kei never reads a partial file.
   *  An existing file of that name is replaced: a re-executed staging step writes the same bytes. */
  export async function stageSource(root: string, relative: string, bytes: Uint8Array): Promise<void> {
    const target = join(root, relative)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(target), { recursive: true })
      const handle = await open(temporary, 'wx', 0o644)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  export async function removeStagedSource(root: string, relative: string): Promise<void> {
    await rm(join(root, relative), { force: true })
  }
  ```
  `packages/db/src/artifact-store.ts`: `export function studioDataRoot(): string { return envPaths('FREE Studio').data }` and `packageRoot()` returns `join(studioDataRoot(), 'source-representations')`; export `studioDataRoot` from `packages/db/src/index.ts`.

  `compose.yaml` (as M3 Task 12 left it):
  - `x-parsing-runtime.environment` gains `KEI_SOURCE_INBOX: /app/source-inbox` with the comment `# Studio's staged source PDFs (the source-inbox volume); only the worker mounts it, read-only.`
  - `parsing_worker` gains a `volumes:` list — a service-level list replaces the anchor's, so restate it: `parsing-runs:/app/runs`, `parsing-models:/models`, `source-inbox:/app/source-inbox:ro`.
  - `studio.environment` gains `FREE_SOURCE_INBOX: /var/lib/free/source-inbox` and `studio.volumes` gains `- source-inbox:/var/lib/free/source-inbox` with the comment `# Source PDFs staged for kei's worker (M4); the worker mounts it read-only.`
  - the top-level `volumes:` gains `source-inbox:`.
  `compose.override.yaml` and `compose.prod.yaml` need no change (their per-service maps merge with the base across files); confirm with `pnpm test:safety`.

- [ ] **Step 3: Run the tiers and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter db typecheck && pnpm --filter db test
  pnpm test:safety
  docker compose -f compose.yaml -f compose.override.yaml config --quiet
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/api/_pdf_pages.ts prototypes/studio/api/_pdf_pages.test.ts prototypes/studio/api/_pdf_pages.destroy.test.ts \
    prototypes/studio/api/_source_inbox.ts prototypes/studio/api/_source_inbox.test.ts packages/db/src/artifact-store.ts \
    packages/db/src/index.ts compose.yaml tests/safety.test.mjs
  git commit -m "feat(studio): count PDF pages for kei's lanes and stage sources in a volume kei reads"
  ```

### Task 5: `runExtraction` as steps over ports, and kei artifact acceptance as a pure function

Nothing is registered or wired here: the workflow body and the artifact mapping are written against ports and unit-tested, so Task 6 only connects them.

**Files:**
- Create: `packages/extraction/src/kei-artifact.ts`, `packages/extraction/src/kei-artifact.test.ts`, `packages/extraction/src/workflows.ts`, `packages/extraction/src/workflows.test.ts`
- Modify: `packages/extraction/src/kei-exp.ts` (the artifact schemas and types move to `kei-artifact.ts`; `kei-exp.ts` imports them), `packages/extraction/src/module.ts` (`createExtractionJobExecutor`'s mapping, 196-303, becomes a call to `acceptKeiArtifact`; the executor stays until Task 6), `packages/extraction/src/module.test.ts` (the `kei-exp extraction relay` cases at 65-404 move to `kei-artifact.test.ts` against `acceptKeiArtifact`), `packages/extraction/package.json` (`test` adds both new files; `exports` `./workflows`)

**Interfaces:**
- Consumes: Task 3's `KeiHandoff`, `settleKei`, `keiExtractOkSchema`, `SUBMIT_TO_KEI_RETRY`, `KEI_QUEUE`, `KEI_PRIORITY`, `EXTRACTION_TIMEOUT_MS`, `keiExtractWorkflowId`, `KEI_RUN_ID`.
- Produces:
  ```ts
  // kei-artifact.ts
  export const anyArtifactSchema, versionOneSchema, groundedArtifactSchema   // moved from kei-exp.ts unchanged
  export type KeiExpAnyArtifact, KeiExpArtifact, KeiExpGroundedArtifact
  export type ArtifactPins = Readonly<{ extractionId: string; sourceDocumentId: string; sourceRepresentationRevisionId: string; schemaRevisionId: string; strategy: ExtractionStrategy; batchExtractionId: string | null }>
  export function acceptKeiArtifact(pins: ArtifactPins, document: ParsedDocument, raw: unknown, request: KeiExtractInput): TerminalExtraction   // throws ExtractionError
  // workflows.ts
  export const RUN_EXTRACTION = 'runExtraction'
  export type WorkflowSteps = Readonly<{ step<T>(name: string, run: () => Promise<T>, config?: StepConfig): Promise<T>; cancelSignal(): AbortSignal | undefined }>
  export const dbosSteps: WorkflowSteps
  export type AdmittedExtraction = Readonly<{ extractionId: string; owner: string; projectContextId: string; sourceDocumentId: string; sourceRepresentationRevisionId: string; schemaRevisionId: string; extractionSchemaId: string; strategy: ExtractionStrategy; catalogRecipe: string | null; requestedModels: ExtractionModelChoice | null; batchExtractionId: string | null; preprocessId: string; schemaTree: unknown }>
  export type SettledExtraction = { outcome: 'SUCCEEDED'; extraction: TerminalExtraction } | { outcome: 'FAILED' | 'CANCELLED'; failure: ExtractionFailure }
  export type ExtractionStore = Readonly<{
    loadAdmitted(extractionId: string): Promise<AdmittedExtraction | null>
    readPinnedDocument(sourceRepresentationRevisionId: string): Promise<unknown | null>
    settle(extractionId: string, settled: SettledExtraction): Promise<'settled' | 'already-settled' | 'missing'>
  }>
  export type ExtractionWorkflowPorts = Readonly<{ steps: WorkflowSteps; store: ExtractionStore; kei: KeiHandoff; readArtifact(runId: string, extractionId: string, signal?: AbortSignal): Promise<Uint8Array> }>
  export function keiRunOf(preprocessId: string): { runId: string; generation: string } | null
  export function extractionAttributes(admitted: Pick<AdmittedExtraction, 'projectContextId' | 'sourceDocumentId' | 'sourceRepresentationRevisionId' | 'extractionSchemaId' | 'batchExtractionId' | 'preprocessId'>): Record<string, string>
  export function runExtractionWorkflow(extractionId: string, ports: ExtractionWorkflowPorts): Promise<void>
  export function registerExtractionWorkflow(ports: () => ExtractionWorkflowPorts): void   // DBOS.registerWorkflow(…, { name: 'runExtraction' })
  export function extractionFailureOf(outcome: Extract<KeiOutcome<unknown>, { ok: false }>, strategy: ExtractionStrategy): ExtractionFailure
  export function isWorkflowCancellation(error: unknown): boolean            // DBOSWorkflowCancelledError / DBOSAwaitedWorkflowCancelledError
  export const ARTIFACT_READ_RETRY: StepConfig                                // reused by Tasks 10 and 11
  ```

- [ ] **Step 1: Move the artifact mapping, test-first**

  Create `kei-artifact.test.ts` by moving the relay cases of `module.test.ts:65-404` and pointing them at `acceptKeiArtifact(pins, document, artifact, request)` instead of the executor with a fake `keiExp.extract`: the same fixtures (`kei-exp-fixture.ts`), the same assertions (evidence anchors, table-cell anchors that must belong to the pinned representation, version 2 grounded diagnostics, `models`, attribution). Add:
  - `refuses an artifact produced for other inputs` (another `run_id`, `generation`, `strategy`, `schema`, recipe or `options.models` than `request` → `ExtractionError('invalid_model_output')`), moving the check from `kei-exp.ts`'s `extract` (`artifact.data.run_id !== request.runId || …`).
  - `refuses an artifact outside kei's schema` (`anyArtifactSchema` fails → `invalid_model_output`).
  Implement `kei-artifact.ts` by moving the schemas (`callSchema` … `anyArtifactSchema`) out of `kei-exp.ts` and the mapping body out of `module.ts:215-296`; `createExtractionJobExecutor` now calls `keiExp.extract`, decodes the document and returns `acceptKeiArtifact(...)`. Run `pnpm --filter extraction test`: PASS, with `module.test.ts` keeping only its non-relay cases.

- [ ] **Step 2: Write the failing workflow tests**

  `workflows.test.ts` (node:test) runs `runExtractionWorkflow` with fake ports: `steps.step` runs the function at once and records `name` and `config`; `kei` records calls and answers scripted polls; `store` keeps one in-memory row; `readArtifact` returns the bytes of a scripted artifact.
  - `submits an interactive Extraction to kei-extract at priority 1 and a batch member at 10, each with its strategy's deadline` (ARTICLE interactive → `priority 1`, `timeoutMs 600_000`; CATALOG member → `priority 10`, `timeoutMs 10_800_000`; `workflowId === 'kei-extract:<id>'`; `authenticatedUser === admitted.owner`; `attributes` equal `extractionAttributes(admitted)`, which include `keiRunId`).
  - `builds kei's extract request from the admitted pins, recipe and model choice` (`{ run_id, generation, request: { schema, options: { strategy: 'catalog', models: { fields: 'x' }, catalog: { recipe: 'numbered-catalogue-de@1' } } } }`; no `models` key when the choice is null; no `catalog` key for ARTICLE).
  - `the submit step retries only while kei is not ready` (its `config` is `SUBMIT_TO_KEI_RETRY`).
  - `polls in bounded steps until kei finishes, then publishes the accepted artifact once` (two `live` polls then `SUCCESS`: three `pollKei` steps, one `settle` with `outcome: 'SUCCEEDED'`).
  - `a replayed publication finds the Extraction settled and writes nothing new` (`settle` answers `already-settled`; no second write; no throw).
  - `an Extraction deleted or settled before it runs submits nothing` (`loadAdmitted` → null: no `submitToKei` step).
  - `a representation that names no kei run fails with invalid_source_representation and submits nothing` (`preprocessId: 'docling:x:y'`).
  - `maps kei's failures to Studio's failure codes` (table: `stale_generation` → `invalid_source_representation`; `model_unavailable` → `model_unavailable`; `cancelled` → `cancelled`; `no_result` → `extraction_failed` with message `kei-exp could not complete the Extraction: <reason>`; `invalid_output` → `invalid_model_output`; `stopped` → `extraction_failed` `The Parsing Service stopped this Extraction.`).
  - `a kei deadline becomes extraction_failed naming the time limit` (CATALOG → `… within its time limit (3 hours).`; ARTICLE → `(10 minutes).`).
  - `an artifact whose bytes do not hash to kei's artifact_sha256 fails with invalid_model_output`.
  - `kei's output must name this Extraction, its run and its generation` (another `extraction_id`, `run_id` or `generation` in `ExtractOk` → `invalid_model_output`).
  - `an unexpected failure after submission cancels the kei child before rethrowing` (`settle` throws a plain `Error('db down')`: a `cancelKeiChild` step runs `kei.cancel('kei-extract:<id>')`, then the workflow rejects with that error).
  - `a workflow cancellation propagates without another step` (a step throws `new DBOSErrors.DBOSWorkflowCancelledError('extract:x')`: no `cancelKeiChild` step, the same error rejects).
  - `an aborted poll under a cancelled workflow rethrows without cancelling the child` (the `pollKei` step rejects with an `AbortError` and the fake `steps.step` throws `DBOSWorkflowCancelledError` for the `cancelKeiChild` call, as DBOS does after a cancel: `kei.cancel` is never called and the cancellation error propagates).
  - `the poll step waits on the step's cancel signal` (`kei.poll` receives `steps.cancelSignal()`).
  - `keiRunOf reads kei-exp:<run>:<generation> and nothing else` (full match; `kei-exp:run/x:g`, `kei-exp:run:`, `other:run:g` → null).
  Run: `pnpm --filter extraction exec tsx --test src/workflows.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `workflows.ts`**

  ```ts
  import { createHash } from 'node:crypto'
  import { DBOS, Error as DBOSErrors, type StepConfig } from '@dbos-inc/dbos-sdk'
  import { decodeParsedDocument } from './parsed-document.js'
  import { ExtractionError } from './errors.js'
  import { acceptKeiArtifact } from './kei-artifact.js'
  import {
    EXTRACTION_TIMEOUT_MS, KEI_PRIORITY, KEI_QUEUE, KEI_RUN_ID, keiExtractOkSchema, keiExtractWorkflowId, settleKei,
    SUBMIT_TO_KEI_RETRY, type KeiExtractInput, type KeiHandoff, type KeiOutcome, type KeiPoll,
  } from './kei-handoff.js'
  import { modelChoice } from './model-choice.js'
  import { parseExtractionSchema } from './schema.js'
  import type { TerminalExtraction } from './dependencies.js'
  import type { ExtractionFailure, ExtractionModelChoice, ExtractionStrategy } from './types.js'

  export const RUN_EXTRACTION = 'runExtraction'

  /** The DBOS surface a workflow body uses, so its sequence is testable without DBOS. */
  export type WorkflowSteps = Readonly<{
    step<T>(name: string, run: () => Promise<T>, config?: StepConfig): Promise<T>
    /** DBOS.stepStatus.cancelSignal inside a step (it fires about 1 s after a cancel); undefined outside one. */
    cancelSignal(): AbortSignal | undefined
  }>
  export const dbosSteps: WorkflowSteps = {
    step: (name, run, config) => DBOS.runStep(run, { ...config, name }),
    cancelSignal: () => DBOS.stepStatus?.cancelSignal,
  }

  /** A read of a published artifact that another attempt may get through (kei's API restarting). Ingestion and
   *  reprocessing reuse it for their manifest and page reads. */
  export const ARTIFACT_READ_RETRY: StepConfig = {
    retriesAllowed: true, intervalSeconds: 5, backoffRate: 2, maxAttempts: 3,
    shouldRetry: (error) => error instanceof TypeError || (error as { transient?: unknown })?.transient === true,
  }

  const KEI_PREPROCESS = /^kei-exp:([A-Za-z0-9][A-Za-z0-9._-]*):([^:\s]+)$/

  /** The kei run and parse generation a Source Representation Revision was made from (`kei-exp:<run>:<generation>`,
   *  written by ingestion from kei's convert output). Studio reads the run ID; it never derives one. */
  export function keiRunOf(preprocessId: string): { runId: string; generation: string } | null {
    const match = KEI_PREPROCESS.exec(preprocessId)
    return match && KEI_RUN_ID.test(match[1]!) ? { runId: match[1]!, generation: match[2]! } : null
  }

  export function extractionAttributes(admitted: Pick<AdmittedExtraction,
    'projectContextId' | 'sourceDocumentId' | 'sourceRepresentationRevisionId' | 'extractionSchemaId' | 'batchExtractionId' | 'preprocessId'>,
  ): Record<string, string> {
    const run = keiRunOf(admitted.preprocessId)
    return {
      projectContextId: admitted.projectContextId,
      sourceDocumentId: admitted.sourceDocumentId,
      sourceRepresentationRevisionId: admitted.sourceRepresentationRevisionId,
      extractionSchemaId: admitted.extractionSchemaId,
      ...(admitted.batchExtractionId === null ? {} : { batchExtractionId: admitted.batchExtractionId }),
      // The run this Extraction hands to kei: M6's collectGarbage protects it while this workflow lives (*Late handoffs*).
      ...(run === null ? {} : { keiRunId: run.runId }),
    }
  }

  function keiExtractRequest(admitted: AdmittedExtraction): KeiExtractInput | ExtractionFailure {
    const run = keiRunOf(admitted.preprocessId)
    if (run === null)
      return { code: 'invalid_source_representation', message: 'The pinned Source Representation does not name a kei-exp parse generation.', phase: 'loading' }
    const models = modelChoice(admitted.requestedModels)
    const recipe = admitted.strategy === 'CATALOG' ? admitted.catalogRecipe : null
    return {
      run_id: run.runId,
      generation: run.generation,
      request: {
        schema: parseExtractionSchema(admitted.schemaTree) as unknown as Record<string, unknown>,
        options: {
          strategy: admitted.strategy === 'CATALOG' ? 'catalog' : 'article',
          ...(models === null ? {} : { models }),
          ...(recipe === null ? {} : { catalog: { recipe } }),
        },
      },
    }
  }

  export function extractionFailureOf(outcome: Extract<KeiOutcome<unknown>, { ok: false }>, strategy: ExtractionStrategy): ExtractionFailure {
    const phase = 'extracting' as const
    switch (outcome.code) {
      case 'stale_generation': return { code: 'invalid_source_representation', message: outcome.reason.slice(0, 512), phase }
      case 'model_unavailable': return { code: 'model_unavailable', message: outcome.reason.slice(0, 512), phase }
      case 'cancelled': return { code: 'cancelled', message: 'The Extraction was cancelled.', phase }
      case 'deadline_exceeded':
        return { code: 'extraction_failed', message: `The Extraction did not finish within its time limit (${strategy === 'CATALOG' ? '3 hours' : '10 minutes'}).`, phase }
      case 'stopped': return { code: 'extraction_failed', message: 'The Parsing Service stopped this Extraction.', phase }
      case 'invalid_output': return { code: 'invalid_model_output', message: outcome.reason.slice(0, 512), phase }
      default: return { code: 'extraction_failed', message: `kei-exp could not complete the Extraction: ${outcome.reason}`.slice(0, 512), phase }
    }
  }

  export function isWorkflowCancellation(error: unknown): boolean {
    return error instanceof DBOSErrors.DBOSWorkflowCancelledError || error instanceof DBOSErrors.DBOSAwaitedWorkflowCancelledError
  }

  /**
   * `runExtraction(extractionId)` (spec, *Background work*): load the admitted pins, submit to kei-extract, poll in
   * bounded steps, then fetch, validate and publish the artifact in one step. Every terminal write is `store.settle`,
   * which writes only while the row has no outcome: a replayed step, a cancel that won, or a deleted row makes it a
   * no-op, never a second result and never a failure of surviving batch members.
   */
  export async function runExtractionWorkflow(extractionId: string, ports: ExtractionWorkflowPorts): Promise<void> {
    const { steps, store, kei } = ports
    const admitted = await steps.step('loadAdmitted', () => store.loadAdmitted(extractionId))
    if (admitted === null) return
    const request = keiExtractRequest(admitted)
    if ('code' in request) {
      await steps.step('publishFailure', () => store.settle(extractionId, { outcome: 'FAILED', failure: request }))
      return
    }
    const child = keiExtractWorkflowId(extractionId)
    await steps.step('submitToKei', () => kei.submit({
      workflow: 'extract',
      workflowId: child,
      queueName: KEI_QUEUE.extract,
      priority: admitted.batchExtractionId === null ? KEI_PRIORITY.interactive : KEI_PRIORITY.batch,
      timeoutMs: EXTRACTION_TIMEOUT_MS[admitted.strategy],
      request,
      authenticatedUser: admitted.owner,
      attributes: extractionAttributes(admitted),
    }), SUBMIT_TO_KEI_RETRY)
    try {
      let polled: KeiPoll
      do polled = await steps.step('pollKei', () => kei.poll(child, steps.cancelSignal()))
      while (polled.state === 'live')
      const settled = settleKei(polled, keiExtractOkSchema)
      if (!settled.ok) {
        const failure = extractionFailureOf(settled, admitted.strategy)
        await steps.step('publishFailure', () => store.settle(extractionId, { outcome: 'FAILED', failure }))
        return
      }
      await steps.step('publishResult', async () => {
        const ok = settled.value
        const invalid = (message: string) => store.settle(extractionId, {
          outcome: 'FAILED', failure: { code: 'invalid_model_output', message, phase: 'persisting' },
        })
        if (ok.extraction_id !== extractionId || ok.run_id !== request.run_id || ok.generation !== request.generation)
          return invalid('kei-exp reported an extraction of other inputs.')
        const bytes = await ports.readArtifact(ok.run_id, extractionId, steps.cancelSignal())
        if (createHash('sha256').update(bytes).digest('hex') !== ok.artifact_sha256)
          return invalid('The published extraction artifact does not match the one kei-exp reported.')
        const raw = await store.readPinnedDocument(admitted.sourceRepresentationRevisionId)
        if (raw === null) return 'missing' as const // the revision was deleted: nothing to publish into
        let extraction: TerminalExtraction
        try {
          extraction = acceptKeiArtifact(admitted, decodeParsedDocument(raw), JSON.parse(new TextDecoder().decode(bytes)), request)
        } catch (error) {
          if (!(error instanceof ExtractionError) && !(error instanceof SyntaxError)) throw error
          return store.settle(extractionId, {
            outcome: 'FAILED',
            failure: { code: error instanceof ExtractionError ? error.code : 'invalid_model_output', message: error.message.slice(0, 512), phase: 'persisting' },
          })
        }
        return store.settle(extractionId, { outcome: 'SUCCEEDED', extraction })
      }, ARTIFACT_READ_RETRY)
    } catch (error) {
      if (isWorkflowCancellation(error)) throw error
      // A parent that fails unexpectedly after submitToKei cancels its kei child before rethrowing (spec, *Studio → kei*).
      await steps.step('cancelKeiChild', () => kei.cancel(child))
      throw error
    }
  }

  export function registerExtractionWorkflow(ports: () => ExtractionWorkflowPorts): void {
    DBOS.registerWorkflow(async (extractionId: string) => runExtractionWorkflow(extractionId, ports()), { name: RUN_EXTRACTION })
  }
  ```
  `ExtractionFailure` (`types.ts:177-181`) and `TerminalExtraction` (`dependencies.ts:35-50`) are unchanged. If `decodeParsedDocument` throws for the pinned package, map it to `invalid_source_representation` exactly as `module.ts`'s `decodeCanonical` does (reuse that function by exporting it from `module.ts` or moving it to `parsed-document.ts`).

- [ ] **Step 4: Run and commit**

  ```bash
  pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck && pnpm --filter studio test
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/extraction/package.json packages/extraction/src/kei-artifact.ts packages/extraction/src/kei-artifact.test.ts \
    packages/extraction/src/workflows.ts packages/extraction/src/workflows.test.ts packages/extraction/src/kei-exp.ts \
    packages/extraction/src/module.ts packages/extraction/src/module.test.ts
  git commit -m "feat(extraction): write runExtraction's steps against kei's contract and accept artifacts in one function"
  ```

### Task 6: Extraction on DBOS: one row from admission through review, `runExtraction` wired, the lease worker deleted

The largest task: the schema, the persistence, the registration, Studio's glue and the canonical e2e spec change together, because the job tables and the HTTP kei path disappear at once. Every tier is green at its commit; typecheck is red only inside the task. Use a high-effort implementer.

**Files:**
- Modify: `packages/db/src/prisma/contract.prisma`; regenerate the baseline (Global Constraints); `packages/db/src/project-store.ts` (`listProjectContexts` 921-1164: `runningBatch` from Extraction rows; `createResearcherProjectStore` gains `options?: { workflowStatuses?: WorkflowStatuses }`), `packages/db/src/project-store.test.ts` (723-753), `packages/db/src/postgres-test-helpers.ts` (8, 14: `'ExtractionJob'` → `'Extraction'`), `packages/db/src/project-store.postgres.check.ts` (if it seeds jobs)
- Modify: `packages/extraction/src/postgres-persistence.ts` (rewrite of admission, reads, cancel; new `ExtractionStore` for the workflow), `postgres-suggested-batch.ts` (member rows + enqueue in one pooled-client transaction), `dependencies.ts` (job types out, `ExtractionExecution` in), `module.ts` (`createExtractionJobExecutor` out), `types.ts` (`ExtractionRuntime` out), `index.ts`, `kei-exp.ts` (`extract` and its envelope/acknowledgement schemas out; `readExtractionArtifact` in), `kei-exp-fixture.ts` (`keiExpEnvelope`, `keiExpAccepted` out), `package.json` (`test` drops `job-worker.test.ts`)
- Delete: `packages/extraction/src/job-worker.ts`, `job-worker.test.ts`, `runtime.ts`
- Rewrite: `packages/extraction/src/extraction-module.integration.test.ts`; create `packages/extraction/src/testing/dbos-test-app.ts`
- Studio: delete `api/_extraction_runtime.ts` and `api/_extraction_runtime.test.ts`; create `api/_extractions.ts`, `api/_extractions.test.ts`; modify `api/extractions.ts`, `api/batch_extractions.ts`, `api/document_reopen.ts`, `api/extraction_models.ts`, `api/ingestion_models.ts`, `api/batch_schema_suggestions.ts` and their tests' `vi.mock` paths (`extractions.test.ts:9-22`, `batch_extractions.test.ts:10-16`, `durable_operations.test.ts:9-16`, `extraction_models.test.ts:6-7`, `ingestion_models.test.ts:6-7`, `server/researcher-project-ownership.test.ts:51-65`), `server/workflows.ts` + `server/workflows.test.ts` (register `runExtraction`), `server/app.ts` (the researcher store gets `workflowStatuses`), `server/host.ts`, `server/developmentHost.ts` and their tests (the extraction runtime goes), `vite.config.test.ts`
- Studio PostgreSQL: create `api/extraction_workflow.postgres.test.ts`, `test/support/research.ts`, `test/support/scenarios/extraction-publish.ts`
- E2E: modify `prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts` (the fake kei on `FREE_PLAYWRIGHT_KEI_EXP_URL` becomes the kei stand-in; 827-842 read `Extraction`), `e2e/schema-order-lifecycle.spec.ts` only if it seeds jobs

**Interfaces:**
- Consumes: Task 2 (`withPoolClientTransaction`, `TransactionalEnqueue`, `WorkflowStatuses`, `executionOf`, `INTERRUPTED_FAILURE`, `isUniqueViolation`, `LIVE_WORKFLOW_STATUSES`, `workflowStatusesOf`), Task 3 (`createKeiHandoff`, `keiExtractWorkflowId`, `launchKeiStandIn`, `spawnKeiStandIn`), Task 5 (`registerExtractionWorkflow`, `extractionAttributes`, `ExtractionStore`, `ExtractionWorkflowPorts`, `RUN_EXTRACTION`, `dbosSteps`), Task 1 (`studioDbos`, `STUDIO_QUEUE`, the crash harness).
- Produces:
  ```ts
  // packages/extraction
  export type ExtractionExecution = Readonly<{ enqueue: TransactionalEnqueue; statuses: WorkflowStatuses; cancel(extractionId: string): Promise<void> }>
  export const EXTRACTION_QUEUE = 'studio'                         // equals server/dbos.ts STUDIO_QUEUE (asserted in server/workflows.test.ts)
  export function createResearcherExtractionPersistence(researcherAccountId: string, execution: ExtractionExecution, infrastructure?: { database?: Database; packages?: CanonicalPackageStore }): ExtractionPersistence
  export function createExtractionStore(infrastructure?: { database?: Database; packages?: CanonicalPackageStore }): ExtractionStore
  export function createExtractions(researcherAccountId: string, execution: ExtractionExecution): ExtractionModule
  // KeiExpClient gains: readExtractionArtifact(runId: string, extractionId: string, signal?: AbortSignal): Promise<Uint8Array>
  // Studio api/_extractions.ts
  export const keiExpClient: KeiExpClient
  export function extractionExecution(): ExtractionExecution           // from studioDbos(); lazily, per call
  export function extractionWorkflowPorts(): ExtractionWorkflowPorts   // db, canonicalPackageStore, keiExpClient, the kei handoff
  export function createResearcherExtractions(researcherAccountId: string): ExtractionModule
  export function extractionAttemptDto(extraction: ExtractionAttemptSnapshot)   // moved from _extraction_runtime.ts unchanged
  ```
  `ExtractionModule`'s method names and snapshot types are unchanged here (Task 7 changes the batch snapshot and the attempt contract); `runSingle(input)` loses its unused signal argument; `cancelSingle` keeps `CancellationResult`.

- [ ] **Step 1: Edit the baseline**

  In `contract.prisma`:
  1. Delete `enum ExtractionJobKind`, `model ExtractionJob`, `model BatchExtractionMember` and the relation fields that name them: `ProjectContext.extractionJobs`, `SourceRepresentationRevision.batchMembers` and `.extractionJobs`, `SchemaRevision.extractionJobs`, `BatchExtraction.members` and `.extractionJobs`, `Extraction.batchMember`. Keep `enum ProjectOperationStatus` (suggestions still use it until Task 9).
  2. Replace the head of `model Extraction` with:
  ```prisma
  // One Extraction from admission through review (spec, *Background work*). Admission writes the pins, the requested
  // models and Catalog recipe, and the optional batch; `outcome` stays null until the one terminal write (success,
  // failure or cancellation), which only succeeds while it is null. Execution status is never stored: it is the
  // outcome, or else the `extract:<id>` workflow's DBOS status. A batch's pending rows are its intended selection.
  model Extraction {
    id                             Uuid                         @id @default(uuid())
    sourceDocumentId               Uuid
    schemaRevisionId               Uuid
    sourceRepresentationRevisionId Uuid
    strategy                       String
    // The numbered-catalogue recipe (`id@version`) a Catalog Extraction segments by; null for generic Catalog and Article.
    catalogRecipe                  String?
    // The Extraction Model Choice requested at admission; null keeps kei-exp's defaults. The models each role ran on are
    // in `diagnostics.models`; `modelAttribution` names the fields model.
    requestedModels                Json?
    outcome                        ExtractionOutcome?
    complete                       Boolean?
    modelAttribution               Json?
    diagnostics                    Json?
    failure                        Json?
    resultPayload                  Json?
    evidenceLinks                  Json?
    reviewable                     Boolean                      @default(false)
    batchExtractionId              Uuid?
    // Admission time: attempts are ordered by it.
    createdAt                      Timestamptz6                 @default(now())
  ```
  keeping `reviewedAt`, `reviewDraft`, `reviewDraftVersion`, `schemaRevision`, `batchExtraction` (composite `[batchExtractionId, schemaRevisionId, strategy]`, `onDelete: Cascade`, `map: "extraction_batch_pin_fkey"`), `sourceRepresentationRevision` (composite, `onDelete: Cascade`), `reviews`, the indexes and `@@unique([id, sourceDocumentId])`, and adding `@@unique([batchExtractionId, sourceDocumentId], map: "extraction_batch_source_key")` (NULL batches do not collide: single Extractions are unaffected).
  Regenerate the baseline and recreate the databases (Global Constraints). Open the new `migration.ts`: it creates no `extractionJob` or `batchExtractionMember` table, `extraction.outcome` is nullable, and `extraction_batch_source_key` exists.

- [ ] **Step 2: Write the failing PostgreSQL tests (`extraction-module.integration.test.ts`, rewritten)**

  Setup (`src/testing/dbos-test-app.ts`): launch DBOS in the test process as Studio does — `name: 'studio'`, `applicationVersion: 'studio@1'`, schema `dbos_t_<hex>`, executor `studio-t-<hex>`, queue `studio` with `minPollingIntervalMs: 100` — registering `runExtraction` with ports whose `kei` is either a scripted in-memory `KeiHandoff` (most tests) or `createKeiHandoff` over a spawned stand-in (the `through kei's contract` group); an admission `DBOSClient` (`applicationName: 'studio'`) implements `ExtractionExecution.enqueue` with `enqueueInTransaction`. Reuse the current helpers that seed accounts, projects, documents, revisions (`addRepresentation`, 353) and schema revisions; their revisions carry `preprocessId: 'kei-exp:<run>:<generation>'`. Keep the review, draft and export tests (952-1194) unchanged apart from producing results through `runExtraction` instead of the worker. Delete the lease tests (1259-1377, 1493-1582) and 1888 (it tests the pump; Task 9 replaces it).

  New and carried tests:
  - `admits an Extraction row and its runExtraction workflow in one transaction` (after `runSingle`: the row has `outcome: null`, `catalogRecipe` and `requestedModels` as sent; `extract:<id>` exists with `queueName: 'studio'`, `authenticatedUser` = the owner, attributes `{ projectContextId, sourceDocumentId, sourceRepresentationRevisionId, extractionSchemaId, keiRunId }`).
  - `a failure after the enqueue rolls back both the row and the workflow` (an `ExtractionExecution.enqueue` that enqueues, then throws: no row, no workflow).
  - `replays an identical request and refuses a changed one with extraction_id_conflict` (carried from 674-684).
  - `refuses a new Extraction on a superseded Source Representation Revision and writes no row` (carried from 652, PR #140).
  - `admits a new Extraction on the current Source Representation Revision` (664).
  - `replays an identical request after a reprocess instead of refusing it` (674).
  - `refuses a run that was admitted while a reprocess published a newer revision` (719, `withHeldSourceDocumentLock`).
  - `an identical request that waited behind a reprocess replays the Extraction admitted before it` (new: request A admits and commits while request B, same ID, waits on the document lock held by a reprocess; after the reprocess commits, B replays A instead of answering superseded — PR #140's known three-way limit, closed by re-reading the identity under the lock).
  - `a batch admitted behind a reprocess pins the newly published revision` (745) and `a batch and a reprocess of one of its members both finish` (775).
  - `batch admission locks members in sorted order and creates one pending Extraction per member with a deterministic ID` (IDs equal `stableUuid('batch-member-extraction', stableJson([batchId, sourceDocumentId]))`; one `extract:<id>` workflow per member).
  - `a batch rerun creates new Extraction identities` (`repetition: 'create-new'` twice: disjoint member IDs).
  - `pending Extractions count as batch members but do not displace the latest reviewed result on reopen` (review a result on document D; admit a batch including D; `readBatch` counts D as QUEUED; `readDocumentExtractions({ sourceDocumentId: D })` still returns the reviewed Extraction as `latestReviewed` and as the latest attempt).
  - `derives QUEUED, RUNNING and interrupted from DBOS and never reports a settled row as running` (a held kei: QUEUED before dequeue, RUNNING while polling; after `DBOS.cancelWorkflow('extract:<id>')` with no outcome: FAILED `interrupted`; a row with an outcome reads from the row even when its workflow is still PENDING).
  - `a SUCCESS workflow over a row without an outcome reads as interrupted after the re-read`.
  - `cancel racing completion has one winner` (20 iterations of `Promise.all([cancelSingle(id), store.settle(id, succeeded)])`: exactly one of the two wrote; the row's outcome is that one's; no second write).
  - `a replay of a failed Extraction returns its failure, even after its workflow history was deleted, and enqueues nothing` (settle FAILED; `DBOS.deleteWorkflows(['extract:<id>'])`; `runSingle` with the same input → `replayed`, `executionStatus: 'FAILED'`; `listWorkflows({ workflowIDs: ['extract:<id>'] })` is empty).
  - `cancel writes the cancelled outcome and stops the Studio workflow and its kei child` (held kei; `cancelSingle` → `'cancellation-requested'`; row `outcome: 'CANCELLED'`, `failure.code: 'cancelled'`; `extract:<id>` CANCELLED; `ExtractionExecution.cancel` called with the ID; a second cancel → `'not-found'`).
  - `a batch member cannot be cancelled on its own, and its ID posted as an interactive Extraction answers extraction_id_conflict`.
  - `an Extraction deleted while it runs publishes nothing and fails no surviving member` (delete the source document of one member while kei holds it; answer kei; `settle` → `'missing'`; the other members complete).
  - `runExtraction records keiRunId from the pinned revision`.
  - `a ready suggestion hands its saved pins to one replayable batch of pending member Extractions` (carried from 1727: `persistSuggestedBatch` creates the batch, one Extraction row and one `extract:<id>` workflow per saved pin in one transaction, on the suggestion's saved revisions without a lock; a repeat is `replayed` with no new rows or workflows; 1817's invalid-draft refusal is carried too).
  - `through kei's contract: an Extraction runs end to end on the stand-in and publishes the artifact kei published` (spawned stand-in, `extract` policy `auto`; the attempt completes with the stand-in's artifact; the kei workflow `kei-extract:<id>` ran on `kei-extract` at priority 1).
  Run: `pnpm --filter extraction test:postgres`. Expected: FAIL.

- [ ] **Step 3: Rewrite the persistence**

  The admission of one interactive Extraction (replacing `scheduleInteractiveExtraction`, P:391-448):
  ```ts
  async function admitInteractiveExtraction(
    database: Database, execution: ExtractionExecution, researcherAccountId: string, input: RunSingleInput, attempt = 0,
  ): Promise<'created' | 'replayed' | 'conflict' | 'superseded' | 'missing'> {
    try {
      return await withPoolClientTransaction(async (transaction, client) => {
        const pins = await resolveAdmission(transaction, researcherAccountId, input)   // was resolveScheduledJob, P:346-389
        if (pins === null) return 'missing'
        const identity = () => transaction.orm.public.Extraction.select(
          'sourceDocumentId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe',
          'requestedModels', 'batchExtractionId',
        ).first({ id: input.extractionId })
        // Replay resolution comes first: an identical repeat replays even when its revision is superseded now (PR #140).
        const existing = await identity()
        if (existing) return sameAdmission(existing, pins) ? 'replayed' : 'conflict'
        if (!(await lockSourceDocumentRow(transaction, pins.sourceDocumentId))) return 'missing'
        // A request with this ID may have committed while this one waited for the document lock.
        const raced = await identity()
        if (raced) return sameAdmission(raced, pins) ? 'replayed' : 'conflict'
        const current = await transaction.orm.public.SourceRepresentationRevision.where({
          sourceDocumentId: pins.sourceDocumentId,
        }).select('id').orderBy((revision) => revision.revisionNumber.desc()).first()
        if (!current) return 'missing'
        if (current.id !== pins.sourceRepresentationRevisionId) return 'superseded'
        await transaction.orm.public.Extraction.create({
          id: input.extractionId,
          sourceDocumentId: pins.sourceDocumentId,
          sourceRepresentationRevisionId: pins.sourceRepresentationRevisionId,
          schemaRevisionId: pins.schemaRevisionId,
          strategy: pins.strategy,
          catalogRecipe: pins.catalogRecipe,
          requestedModels: pins.requestedModels,
          batchExtractionId: null,
        })
        await execution.enqueue(client, {
          workflowName: RUN_EXTRACTION,
          workflowID: `extract:${input.extractionId}`,
          queueName: EXTRACTION_QUEUE,
          authenticatedUser: pins.owner,
          attributes: extractionAttributes({ ...pins, batchExtractionId: null }),
        }, input.extractionId)
        return 'created'
      })
    } catch (error) {
      // A concurrent first request committed this primary key: reload and compare, in a new transaction (spec, *Replays*).
      if (attempt === 0 && isUniqueViolation(error)) return admitInteractiveExtraction(database, execution, researcherAccountId, input, 1)
      throw error
    }
  }
  ```
  `resolveAdmission` returns `{ owner, projectContextId, sourceDocumentId, sourceRepresentationRevisionId, schemaRevisionId, extractionSchemaId, strategy, catalogRecipe (CATALOG only), requestedModels: modelChoice(input.models), preprocessId }` or null when any pin is foreign or missing. `sameAdmission` compares the pins, strategy, recipe, `isDeepStrictEqual(modelChoice(row.requestedModels), pins.requestedModels)` and `row.batchExtractionId === null` (a batch member's ID is a conflict). The caller maps `'missing'` → null (`not_found`), `'conflict'` → `extraction_id_conflict`, `'superseded'` → `source_representation_superseded` with `SUPERSEDED_MESSAGE`, as today.

  Batch admission (`scheduleBatch`, P:1577-1716) keeps its identity, validation and the sorted lock loop verbatim, runs in `withPoolClientTransaction`, and replaces the job and member inserts by one row and one enqueue per member:
  ```ts
  const id = stableUuid('batch-member-extraction', stableJson([batchExtractionId, member.sourceDocumentId]))
  await orm.public.Extraction.create({ id, sourceDocumentId: member.sourceDocumentId,
    sourceRepresentationRevisionId: member.sourceRepresentationRevisionId, schemaRevisionId: input.schemaRevisionId,
    strategy: input.strategy, catalogRecipe: null, requestedModels: modelChoice(input.models), batchExtractionId })
  await execution.enqueue(client, { workflowName: RUN_EXTRACTION, workflowID: `extract:${id}`, queueName: EXTRACTION_QUEUE,
    authenticatedUser: owner, attributes: extractionAttributes({ …member pins, extractionSchemaId, batchExtractionId, preprocessId }) }, id)
  ```
  Its replay (the batch primary key) compares the batch with its member Extraction rows. `persistSuggestedBatch` (`postgres-suggested-batch.ts:113-133`) does the same inside `withPoolClientTransaction`, on the suggestion's saved pins, without a lock (PR #140's documented exemption).

  The terminal write, used by the workflow and by cancel:
  ```ts
  /** The one terminal write of an Extraction. The no-outcome predicate lives in the UPDATE (updateAll keeps its guards;
   *  update selects an id first), so completion, failure and cancellation race to one winner, a replayed step finds the
   *  outcome written, and a deleted row updates nothing. */
  async function settleExtraction(database: Database, extractionId: string, settled: SettledExtraction) {
    const fields = settled.outcome === 'SUCCEEDED'
      ? {
          outcome: 'SUCCEEDED' as const, complete: settled.extraction.complete, modelAttribution: settled.extraction.modelAttribution,
          diagnostics: settled.extraction.diagnostics, failure: null, resultPayload: settled.extraction.result,
          evidenceLinks: settled.extraction.evidence, reviewable: settled.extraction.reviewable,
        }
      // A failed or cancelled Extraction carries its failure and nothing else (Task 7's contract relies on it).
      : { outcome: settled.outcome, failure: settled.failure, complete: null, modelAttribution: null, diagnostics: null,
          resultPayload: null, evidenceLinks: null, reviewable: false }
    const updated = await database.orm.public.Extraction.where({ id: extractionId, outcome: null }).updateAll(fields)
    if (updated.length === 1) return 'settled' as const
    return (await database.orm.public.Extraction.select('id').first({ id: extractionId })) ? 'already-settled' as const : 'missing' as const
  }
  ```
  Cancel (replacing P:828-862):
  ```ts
  async function cancelInteractiveExtraction(database: Database, execution: ExtractionExecution, researcherAccountId: string, extractionId: string) {
    if (!(await ownsResearcherExtraction(database, researcherAccountId, extractionId))) return 'not-found' as const
    const row = await database.orm.public.Extraction.select('batchExtractionId').first({ id: extractionId })
    if (!row || row.batchExtractionId !== null) return 'not-found' as const   // interactive Extractions only, as today
    const written = await settleExtraction(database, extractionId, {
      outcome: 'CANCELLED', failure: { code: 'cancelled', message: 'Extraction cancelled.', phase: 'extracting' },
    })
    if (written !== 'settled') return 'not-found' as const
    // The outcome is recorded first: a cancelled workflow cannot record its own (spec, *Rules*). Stopping the Studio
    // workflow and its kei child is best effort; M6's collectGarbage cancels any live work whose row is settled.
    await execution.cancel(extractionId).catch((error: unknown) =>
      console.warn('The cancelled Extraction\'s workflows could not be stopped now; they stop at their next check.', error instanceof Error ? error.message : ''))
    return 'cancellation-requested' as const
  }
  ```
  `ownsResearcherExtraction` joins `extraction → sourceDocument → projectContext` on `researcherAccountId` (the shape of `ownsResearcherDocument`, P:864-889); it replaces `ownsResearcherJob` everywhere (reads, drafts, reviews, finalize's conflict path).

  Reads derive execution (replacing `loadExtractionAttempt`, P:250-311, and the job gates at P:236-248, 1429-1447): read the rows; call `execution.statuses` once with `extract:<id>` of every row without an outcome; `executionOf` each; re-read the `REREAD` ones; map: `SUCCEEDED` → the full snapshot with `executionStatus: 'COMPLETED'`; `FAILED`/`CANCELLED` → `executionStatus: 'FAILED'`, `outcome: null`, the row's `failure`, every result field null, `reviewable: false` (decision 6); unsettled `QUEUED`/`RUNNING` → that status with every result field null; `INTERRUPTED` → `FAILED` with `{ ...INTERRUPTED_FAILURE, phase: 'extracting' }`. `readExtraction`/`prepareReview` require `outcome === 'SUCCEEDED'` instead of a COMPLETED job. `loadDocumentExtractions` takes as candidates the interactive rows of any state and the succeeded rows of any kind, ordered by `createdAt desc, id desc`; `latestReviewed` is the newest `reviewedAt` row whose outcome is `SUCCEEDED`. `loadBatch` lists members from `Extraction where batchExtractionId` ordered by `sourceDocumentId`; a member's `executionStatus` and `failureMessage` come from its row or its derived status, `latestExtraction` is the row when it succeeded, else null; `startedAt`/`finishedAt` are null (Task 7 removes them); the batch is QUEUED when every member is QUEUED, COMPLETED when every member is settled or interrupted, else RUNNING. `loadResults` counts QUEUED/RUNNING members as pending, FAILED (including interrupted) as failed and CANCELLED as cancelled.

  The workflow's store (`createExtractionStore`): `loadAdmitted` reads the row with `outcome: null` joined to its document's project (owner, `projectContextId`), its revision (`preprocessId`) and its schema revision (`extractionSchemaId`, `schemaTree`), else null; `readPinnedDocument` reads the revision's canonical package (`packages.read(descriptor, 'source')`, parsed JSON) or null; `settle` is `settleExtraction`.

  `listProjectContexts`' `runningBatch` (`project-store.ts:993-1129`): read `Extraction.select('id', 'batchExtractionId', 'outcome')` for the listed batches instead of members and jobs; a member is completed when it has an outcome or `executionOf(status) === 'INTERRUPTED'`; statuses come from `options.workflowStatuses` (one call for the unsettled rows); without it an unsettled member counts as running.

- [ ] **Step 4: Delete the lease worker and the HTTP kei path; wire Studio**

  ```bash
  rm packages/extraction/src/job-worker.ts packages/extraction/src/job-worker.test.ts packages/extraction/src/runtime.ts
  rm prototypes/studio/api/_extraction_runtime.ts prototypes/studio/api/_extraction_runtime.test.ts
  ```
  In `kei-exp.ts` delete `extract`, `acceptedSchema`, `envelopeSchema`, `retryAfterMs`, `KeiExpEnvelope`, `KeiExpStatus`, `KeiExpRequest`, and add
  ```ts
  /** GET /api/runs/{run}/extractions/{id}: the artifact kei published, byte for byte (file-only since M3; 404 until then). */
  async readExtractionArtifact(runId, extractionId, signal) {
    if (!KEI_RUN_ID.test(runId) || !KEI_RUN_ID.test(extractionId)) throw new ExtractionError('invalid_model_output', 'kei-exp named an invalid run or extraction.')
    const response = await fetchRequest(`${root}/api/runs/${runId}/extractions/${extractionId}`, {
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    })
    if (response.status >= 500) throw Object.assign(new Error(await httpFailure(response)), { transient: true })
    if (!response.ok) throw new ExtractionError('invalid_model_output', await httpFailure(response))
    return new Uint8Array(await response.arrayBuffer())
  }
  ```
  Studio `api/_extractions.ts`:
  ```ts
  import { canonicalPackageStore, LIVE_WORKFLOW_STATUSES, workflowStatusesOf } from 'db'
  import { createExtractions, createExtractionStore, createKeiExpClient, dbosSteps, type ExtractionExecution,
           type ExtractionModule, type ExtractionWorkflowPorts } from 'extraction'
  import { createKeiHandoff, keiExtractWorkflowId } from 'extraction/kei-handoff'
  import { studioDbos } from '../server/dbos.js'

  export const keiExpClient = createKeiExpClient({ url: process.env.KEI_EXP_URL ?? 'http://127.0.0.1:8001' })

  /** Built per call from the launched DBOS: a module imported before launch (the dispatcher's eager glob) holds nothing. */
  export function extractionExecution(): ExtractionExecution {
    const { admission, kei } = studioDbos()
    const handoff = createKeiHandoff(kei)
    return {
      enqueue: async (client, workflow, input) => {
        await admission.enqueueInTransaction(client, { ...workflow, attributes: { ...workflow.attributes } }, input)
      },
      statuses: workflowStatusesOf((input) => admission.listWorkflows(input)),
      async cancel(extractionId) {
        const studioId = `extract:${extractionId}`
        const [studio] = await admission.listWorkflows({ workflowIDs: [studioId], loadInput: false, loadOutput: false })
        if (studio && LIVE_WORKFLOW_STATUSES.has(studio.status)) await admission.cancelWorkflow(studioId)
        await handoff.cancel(keiExtractWorkflowId(extractionId))
      },
    }
  }

  export function extractionWorkflowPorts(): ExtractionWorkflowPorts {
    return {
      steps: dbosSteps,
      store: createExtractionStore({ packages: canonicalPackageStore }),
      kei: createKeiHandoff(studioDbos().kei),
      readArtifact: (runId, extractionId, signal) => keiExpClient.readExtractionArtifact(runId, extractionId, signal),
    }
  }

  export function createResearcherExtractions(researcherAccountId: string): ExtractionModule {
    return createExtractions(researcherAccountId, extractionExecution())
  }
  ```
  (`extractionAttemptDto` moves here unchanged; keep its `VITE_KEI_EXP_URL` fallback only if a caller still sets it — `grep -rn VITE_KEI_EXP_URL prototypes` decides.) `api/_extractions.test.ts` (the DTO cases move from `extractions.test.ts:550-583`; a mocked `studioDbos()` supplies fake clients): `the execution enqueues through the admission client in the caller's transaction`, `cancel stops the Studio workflow only while it is live, then its kei child`, `status reads use one listWorkflows call without inputs or outputs`.
  `server/workflows.ts` registers the workflow and names it:
  ```ts
  export const STUDIO_WORKFLOW_NAMES: readonly string[] = [RUN_EXTRACTION]
  // in registerStudioWorkflows(), after the guard:
  registerExtractionWorkflow(extractionWorkflowPorts)
  ```
  and `server/workflows.test.ts` adds `the extraction queue is Studio's studio queue` (`EXTRACTION_QUEUE === STUDIO_QUEUE`).
  `server/host.ts` and `server/developmentHost.ts` drop `extractionRuntime`, `StudioRuntime`, `runtime.run/close` and `startExtractionRuntime`/`stopExtractionRuntime` (`developmentHost.ts:34-60`); `vite.config.test.ts` and `server/host.test.ts` drop the runtime assertions. `server/app.ts` creates the researcher store with `{ workflowStatuses: (ids) => workflowStatusesOf((input) => studioDbos().admission.listWorkflows(input))(ids) }` (lazy: app tests never launch DBOS and never list projects through a real store).
  `api/extractions.ts`: `runSingle(input)` (no signal); map a rejected `WorkflowStatuses`/admission (anything not an `ExtractionError`) to 503 `persistenceUnavailable` in `read` and `create`, instead of 500; keep the 409s (`asTransportError`, 38-64) and the cancel statuses (202 / 404 "That Extraction is not active.").

- [ ] **Step 5: The canonical e2e spec drives the kei stand-in**

  In `e2e/canonical-evidence-lifecycle.spec.ts` replace the HTTP fake (`createServer`, 125-199) by
  ```ts
  const keiUrl = new URL(process.env.FREE_PLAYWRIGHT_KEI_EXP_URL!)
  const kei = await launchKeiStandIn({
    databaseUrl: process.env.DATABASE_URL!, schema: 'kei_dbos', port: Number(keiUrl.port),
    executorId: `kei-e2e-${keiUrl.port}`,
    script: { extract: (request) => extractFor(request) },
  })
  // finally: await kei.close()
  ```
  where `extractFor` keeps the spec's switches: `failNextValues` answers `{ failure: { code: 'extraction_failed', reason: 'Deterministic extraction failure.', retryable: false } }`; `blockNextValues`/`blockNextResult` await their gate before answering; the artifact is the one the spec built before (`keiExpArtifact({ … })` with `records`, evidence or `ungrounded` per `omitGrounding`/`incompleteNextResult`), with `run_id`, `generation`, `strategy`, `schema` and `options` taken from `request` (`request.run_id`, `request.generation`, `request.request.schema`, `request.request.options`). The stand-in runs in the Playwright worker, which runs no other DBOS application (the spec is serial, and it is the only spec that starts one); Studio's kei client and the stand-in share the Playwright database's `kei_dbos`. At 827-842 read `db.orm.public.Extraction.select('id').first({ batchExtractionId })` instead of `ExtractionJob`, keep the re-POST's expected 409 and poll `GET /api/extractions/<id>` until `COMPLETED`. Keep every visible wording assertion (`Running extraction…`, `Queued extraction…`, `Extraction cancelled`, `Extraction failed`, …).

- [ ] **Step 6: The Studio kill test**

  `test/support/research.ts`: `seedResearch(url)` creates, through `db`'s ORM, an account, a project, a Source Document, revision 1 with the canonical package of `test/fixtures/kei-exp` translated as ingestion does (so its `preprocessId` is `kei-exp:<run>:<generation>`), an Extraction Schema and a revision; returns their IDs. `test/support/scenarios/extraction-publish.ts`: launches with `register: () => registerExtractionWorkflow(() => ({ ...extractionWorkflowPorts(), store: killAfterSettle(createExtractionStore({ packages: canonicalPackageStore })) }))`, where `killAfterSettle` wraps `settle` to SIGKILL right after a `'settled'` result on the first run; the kei client uses `FREE_TEST_KEI_SCHEMA`, served by a stand-in the parent spawned (`spawnKeiStandIn`, policy `auto`); the first run admits one Extraction through `createExtractions(accountId, extractionExecution())`. `api/extraction_workflow.postgres.test.ts`:
  - `an Extraction published before a kill is not published again after recovery`: the first child run dies with SIGKILL after the commit; the second run finishes; the row has one outcome `SUCCEEDED` whose `resultPayload` equals the stand-in's artifact records; the row's `xmin`, read after the killed run, is unchanged after recovery (the replayed `settle` updated nothing); and `kei-extract:<id>` exists once.
  - `a Studio restart with an Extraction in flight resumes polling the same kei child` (kill the child while the stand-in holds the extraction; restart; answer; the Extraction completes; `listWorkflows({ workflow_id_prefix: 'kei-extract:' })` on the kei schema has one row).

- [ ] **Step 7: Run every tier and commit**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test && pnpm --filter db test:postgres        # fresh databases
  pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e && pnpm --filter studio test:e2e:base-path
  grep -rnE "ExtractionJob|BatchExtractionMember|job-worker|claim\(|renew\(|wakeAfter|extractionRuntime|_extraction_runtime|keiExpEnvelope|keiExpAccepted|retryOfId" \
    packages prototypes/studio --include=*.ts --include=*.tsx --include=*.prisma --exclude-dir=node_modules
  ```
  Expected: all pass; the grep prints only the 422 request-body test in `prototypes/studio/api/extractions.test.ts` (`retryOfId` posted as an unknown field) and `shared/extraction.contract.test.ts`'s refusal of it.
  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add -A packages/extraction/src/job-worker.ts packages/extraction/src/job-worker.test.ts packages/extraction/src/runtime.ts \
    prototypes/studio/api/_extraction_runtime.ts prototypes/studio/api/_extraction_runtime.test.ts
  git add packages/db packages/extraction prototypes/studio/api prototypes/studio/server prototypes/studio/test \
    prototypes/studio/vite.config.test.ts prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts
  git commit -m "feat(extraction)!: run Extractions as DBOS workflows admitted with their row, and delete the lease worker"
  ```

### Task 7: Extraction and batch contracts without job-era fields; a failed Catalog attempt reruns its recipe; a superseded refusal keeps the workspace

**Files:**
- Modify: `packages/extraction/src/types.ts` (`BatchExtractionMemberSnapshot` loses `startedAt`, `finishedAt`; `BatchExtractionSnapshot` loses `failureMessage`, `startedAt`, `finishedAt`; `ExtractionAttemptSnapshot` gains `catalogRecipe: string | null`), `postgres-persistence.ts` (fill `catalogRecipe`; stop producing the removed fields)
- Modify: `prototypes/studio/shared/extraction.contract.ts` (`extractionAttemptSchema` 294-390), `shared/batchExtraction.contract.ts` (37-76, `batchExtractionProgress` 132-167), their tests, `api/_extractions.ts` (`extractionAttemptDto`), `api/batch_extractions.ts` (`batchDto` 33-65), their tests
- Modify (browser): `src/useExtraction.ts` (405-424), `src/App.tsx` (526-558, 633-685), `src/AppFrame.tsx` (the reopen loader behind `openDocument`), `src/projectContexts/BatchExtractionScreens.tsx` (128-168), `src/projectContexts/BatchExtractionFinishedDialog.tsx` (148-170), `src/projectContexts/batchExtractionStatus.ts`, and their tests (`useExtraction.test.tsx`, `App.test.tsx`, `BatchExtractionsPanel.test.tsx`, `batchExtractions.test.ts`, `ResultsTab.test.tsx`)
- Modify (e2e fixtures): `e2e/batch-extraction-export.spec.ts` (member and batch fixtures at 55-92, 360-376, 796-897 lose the removed fields), `e2e/project-navigation.spec.ts` (887, 893)

**Interfaces:**
- Consumes: Task 6's derived snapshots.
- Produces: the public contracts below; `useExtraction` option `onSuperseded?: () => void`.

- [ ] **Step 1: Write the failing tests**

  `shared/extraction.contract.test.ts`:
  - `a COMPLETED attempt is a succeeded result with its evidence and diagnostics`.
  - `a failed, cancelled or interrupted attempt is FAILED with a failure and no result` (the three failure codes `extraction_failed`, `cancelled`, `interrupted` parse; the same shape with `executionStatus: 'COMPLETED'` and `outcome: 'FAILED'` is refused).
  - `an attempt names its Catalog recipe, or null` (`catalogRecipe` required, `catalogRecipeSchema.nullable()`; non-null only for `CATALOG`).
  `shared/batchExtraction.contract.test.ts` (create it if absent): `a batch and its members carry derived status and no job timing` (`startedAt`, `finishedAt`, `executionFailureMessage` on the batch are refused by the strict schema; a member keeps `executionStatus`, `executionFailureMessage`, `latestExtraction`); `progress counts pending, failed and interrupted members from their status`.
  `src/useExtraction.test.tsx`: `a run refused as superseded keeps the earlier results and asks the page to refresh the document` (the POST answers 409 `{ error: { code: 'source_representation_superseded', message } }`: the hook's `attempt` and results are unchanged, `onError` receives the message, `onSuperseded` is called once, and no monitor starts).
  `src/App.test.tsx`:
  - `after a failed Catalog attempt, the next run posts that attempt's recipe` (the monitored attempt ends `FAILED` with `strategy: 'CATALOG'`, `catalogRecipe: 'numbered-catalogue-de@1'`; clicking the run action posts `{ strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1' }`, and the toolbar names that recipe's label);
  - `a superseded refusal refreshes the document and disables Run without hiding the earlier results` (the reopen stub answers `sourceRepresentation.current: false` on the second read; the earlier result stays visible; Run is disabled).
  `src/projectContexts/BatchExtractionsPanel.test.tsx` / `batchExtractionStatus` tests: `an interrupted member reads Failed with the interruption message`.
  Run: `pnpm --filter studio exec vitest run shared src/useExtraction.test.tsx src/App.test.tsx src/projectContexts`. Expected: FAIL.

- [ ] **Step 2: Contracts**

  `extractionAttemptSchema` gains `catalogRecipe: catalogRecipeSchema.nullable()` and its refinement becomes:
  ```ts
  .superRefine((attempt, context) => {
    const empty = attempt.complete === null && attempt.modelAttribution === null && attempt.diagnostics === null &&
      attempt.resultPayload === null && attempt.evidenceLinks === null && !attempt.reviewable &&
      attempt.reviewedAt === null && attempt.reviewDecisions.length === 0
    const shape =
      attempt.executionStatus === 'COMPLETED'
        // A succeeded Extraction: its result, evidence and diagnostics, and no failure.
        ? attempt.outcome === 'SUCCEEDED' && attempt.diagnostics !== null && attempt.complete !== null &&
          attempt.modelAttribution !== null && attempt.failure === null && attempt.resultPayload !== null &&
          attempt.evidenceLinks !== null
        // Queued, running, failed, cancelled or interrupted: no outcome on the wire and no result; a failure exactly when FAILED.
        : attempt.outcome === null && empty && (attempt.executionStatus === 'FAILED') === (attempt.failure !== null)
    if (!shape) context.addIssue({ code: 'custom', message: 'Extraction fields do not match the execution state.' })
    if (attempt.catalogRecipe !== null && attempt.strategy !== 'CATALOG')
      context.addIssue({ code: 'custom', path: ['catalogRecipe'], message: 'A recipe applies to a Catalog Extraction only.' })
    // …keep the existing checks that follow the shape check (extraction.contract.ts:345-390).
  })
  ```
  `batchExtraction.contract.ts`: the member schema keeps `sourceDocumentId`, `sourceRepresentationRevisionId`, `executionStatus` (now required), `executionFailureMessage` (required, nullable) and `latestExtraction`; the batch schema keeps `executionStatus` (required; `QUEUED | RUNNING | COMPLETED` in practice) and drops `executionFailureMessage`, `startedAt`, `finishedAt`. `batchExtractionProgress` counts `pending` from members QUEUED/RUNNING as today. Update `batchDto` and `extractionAttemptDto` to match, with no optional fallbacks.

- [ ] **Step 3: Browser**

  - `useExtraction.ts:417-422`: when the rejection's code is `source_representation_superseded`, clear the monitor, keep `attempt` and `state` as they were, call `onError(error.message)` and `onSuperseded?.()`, and return null; every other definite rejection behaves as today.
  - `App.tsx`: pass `onSuperseded` to `useExtraction`, which asks `AppFrame` to re-read the open document's reopen snapshot (the loader that produced `openDocument`) and swaps it in only on success, so a failed refresh keeps the workspace; `sourceRepresentationCurrent` then disables Run (`App.tsx:634`). In `onTerminal` (539-556), when the attempt ended `FAILED` with `strategy === 'CATALOG'`, set `nextExtractionStrategy` to `'CATALOG'` and `nextCatalogRecipe` to `attempt.catalogRecipe ?? ''`, so the generic re-run repeats the recipe (the deferred PR #138/#140 follow-up).
  - `BatchExtractionScreens.tsx:134-150` and `BatchExtractionFinishedDialog.tsx:148-170`: remove the batch-level FAILED branch (a batch is never FAILED; its members are). `batchExtractionStatus.ts`: a member with `executionStatus: 'FAILED'` and no `latestExtraction` reads `Failed` with `executionFailureMessage` (the interruption message included).
  - Update the unit-test fixtures that carry the removed fields; update the two e2e specs' JSON fixtures (Playwright fulfills them through the strict schemas).

- [ ] **Step 4: Run and commit**

  ```bash
  pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/extraction/src prototypes/studio/shared prototypes/studio/api prototypes/studio/src \
    prototypes/studio/e2e/batch-extraction-export.spec.ts prototypes/studio/e2e/project-navigation.spec.ts
  git commit -m "feat(studio)!: derive Extraction and batch status without job-era fields; rerun a failed Catalog with its recipe"
  ```

### Task 8: `suggestSchemaBatch` as steps over ports

Nothing is registered here; Task 9 wires it. The workflow replaces the pump's `runSuggestion` (`api/_project_operations.ts:88-229`) with one named step per pinned source, one merge step and one conditional publication.

**Files:**
- Create: `prototypes/studio/api/_batch_suggestion_workflow.ts`, `prototypes/studio/api/_batch_suggestion_workflow.test.ts`

**Interfaces:**
- Consumes: Task 5's `WorkflowSteps` (`extraction/workflows`); `generateSchemaWithModel` (`api/_model.ts:137-146`), `modelSuggestedDefinition`, `sourceSuggestionFailure`, `verifiedCommonSuggestion` (`api/_batch_schema_suggestions.ts`).
- Produces:
  ```ts
  export const SUGGEST_SCHEMA_BATCH = 'suggestSchemaBatch'
  export type SuggestionMember = Readonly<{ sourceDocumentId: string; sourceRepresentationRevisionId: string }>
  /** Admission's snapshot: every current member pin, sorted by sourceDocumentId (spec, *suggestSchemaBatch*). */
  export type SuggestionAttemptInput = Readonly<{ batchSchemaSuggestionId: string; attempt: number; projectContextId: string; members: readonly SuggestionMember[] }>
  export type SuggestionProposal = { phase: 'READY'; proposal: SchemaDefinition; coverage: Coverage[]; draft: SchemaDefinition } | { phase: 'HETEROGENEOUS' }
  export type SuggestionStore = Readonly<{
    /** 'current' while this attempt is the suggestion's attempt and has no outcome; 'stopped' after an interruption, a later attempt or deletion. */
    attemptState(batchSchemaSuggestionId: string, attempt: number): Promise<'current' | 'stopped'>
    projectContextOwner(projectContextId: string): Promise<string | null>
    /** The pinned revision's canonical Markdown, or null when the revision is gone. */
    readMarkdown(sourceRepresentationRevisionId: string): Promise<string | null>
    publish(batchSchemaSuggestionId: string, attempt: number, result: SuggestionProposal): Promise<'published' | 'stopped'>
    fail(batchSchemaSuggestionId: string, attempt: number, failure: { code: string; message: string }): Promise<'published' | 'stopped'>
  }>
  export type SuggestionWorkflowPorts = Readonly<{ steps: WorkflowSteps; store: SuggestionStore; generate: typeof generateSchemaWithModel }>
  export function suggestSchemaBatchWorkflow(input: SuggestionAttemptInput, ports: SuggestionWorkflowPorts): Promise<void>
  export function registerBatchSuggestionWorkflow(ports: () => SuggestionWorkflowPorts): void   // name 'suggestSchemaBatch'
  ```

- [ ] **Step 1: Write the failing tests** (`_batch_suggestion_workflow.test.ts`; fake `steps` that run at once and record names, a fake store holding one suggestion, a scripted `generate`)
  - `generates each pinned source in its own named step, in sorted order, then merges and publishes once` (steps `suggestSource:<a>`, `suggestSource:<b>`, `merge`, `publish`; `publish` receives `{ phase: 'READY', proposal, coverage, draft }` with `draft` equal to `proposal`).
  - `a failed source blocks the merge and publishes the attempt's failure` (`{ code: 'source_suggestion_failed', message: 'Fields could not be suggested for every selected Source Document.' }`; no `merge` step).
  - `a missing key fails the attempt with model_key_required` (one source's `generate` rejects with `ModelKeyRequiredError`: the attempt's failure code is `model_key_required`, whatever the other sources did).
  - `stops without publishing when its attempt was interrupted, superseded or its scope deleted` (`attemptState` → `'stopped'` before source 2: no further step writes; `projectContextOwner` → null or `readMarkdown` → null behave the same).
  - `a heterogeneous merge publishes HETEROGENEOUS without a proposal`.
  - `each model call gets the step's cancel signal and a ten-minute limit` (the `signal` passed to `generate` aborts when the fake `cancelSignal()` aborts; it is an `AbortSignal.any` including a 600 000 ms timeout).
  - `every call resolves the Project Context owner's account` (`generate`'s first argument is `{ researcherAccountId: owner }`, never the session's).
  - `a failure publication that finds the attempt stopped writes nothing and does not throw`.
  Run: `pnpm --filter studio exec vitest run api/_batch_suggestion_workflow.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

  ```ts
  import { DBOS } from '@dbos-inc/dbos-sdk'
  import type { WorkflowSteps } from 'extraction/workflows'
  import { modelSuggestedDefinition, sourceSuggestionFailure, verifiedCommonSuggestion } from './_batch_schema_suggestions.js'
  import { generateSchemaWithModel } from './_model.js'

  export const SUGGEST_SCHEMA_BATCH = 'suggestSchemaBatch'
  const MODEL_OPERATION_TIMEOUT_MS = 10 * 60 * 1000
  const SOURCE_SUGGESTION_INSTRUCTION =
    'Suggest reusable extraction fields for this Source Document. Never include canonical Evidence fields: _evidence, snippets, pages, bboxes, occurrence IDs, or fuzzy matches.'
  const MERGE_INSTRUCTION =
    'Return one compact Extraction Schema containing only fields present in every supplied Source Document suggestion. Do not include extracted values, alternatives, merge notes, or canonical Evidence fields (_evidence, snippets, pages, bboxes, occurrence IDs, fuzzy matches).'

  /** The model call's signal: the step's cancellation (DBOS.stepStatus.cancelSignal, ~1 s after a cancel) and the
   *  ten-minute call limit. The key wrapper reads keys with it, so a cancel also ends the 60 s key wait (M2 ruling). */
  function modelSignal(cancel: AbortSignal | undefined): AbortSignal {
    return AbortSignal.any([...(cancel ? [cancel] : []), AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS)])
  }

  function durableFailure(error: unknown): { code: string; message: string } {
    const code = sourceSuggestionFailure(error).code
    const message = code === 'unexpected_failure' || !(error instanceof Error) ? 'The operation failed unexpectedly.' : error.message
    return { code, message: message.slice(0, 512) }
  }

  type SourceResult =
    | { kind: 'definition'; sourceDocumentId: string; definition: SchemaDefinition }
    | { kind: 'failure'; sourceDocumentId: string; failure: { code: string; message: string } }
    | { kind: 'stopped' }

  export async function suggestSchemaBatchWorkflow(input: SuggestionAttemptInput, ports: SuggestionWorkflowPorts): Promise<void> {
    const { steps, store, generate } = ports
    const { batchSchemaSuggestionId: id, attempt } = input
    const results: SourceResult[] = []
    for (const member of input.members) {
      // One named step per source: recovery of this attempt reuses finished sources; a new attempt reruns them all.
      const result = await steps.step(`suggestSource:${member.sourceDocumentId}`, async (): Promise<SourceResult> => {
        if ((await store.attemptState(id, attempt)) !== 'current') return { kind: 'stopped' }
        const owner = await store.projectContextOwner(input.projectContextId)
        const markdown = await store.readMarkdown(member.sourceRepresentationRevisionId)
        if (owner === null || markdown === null) return { kind: 'stopped' }
        try {
          const generated = await generate({ researcherAccountId: owner }, {
            document: { file: null, markdown, pages: null },
            instruction: SOURCE_SUGGESTION_INSTRUCTION,
            signal: modelSignal(steps.cancelSignal()),
          })
          return { kind: 'definition', sourceDocumentId: member.sourceDocumentId, definition: modelSuggestedDefinition(generated.template) }
        } catch (error) {
          return { kind: 'failure', sourceDocumentId: member.sourceDocumentId, failure: durableFailure(error) }
        }
      })
      if (result.kind === 'stopped') return
      results.push(result)
    }
    const failures = results.flatMap((result) => (result.kind === 'failure' ? [result.failure] : []))
    if (failures.length > 0) {
      // Failures block the merge (spec). A missing key is its own outcome, so the page resends keys and retries.
      const keyMissing = failures.find((failure) => failure.code === 'model_key_required')
      const failure = keyMissing ?? { code: 'source_suggestion_failed', message: 'Fields could not be suggested for every selected Source Document.' }
      await steps.step('publishFailure', () => store.fail(id, attempt, failure))
      return
    }
    const definitions = results.flatMap((result) => (result.kind === 'definition' ? [result] : []))
    const merged = await steps.step('merge', async () => {
      if ((await store.attemptState(id, attempt)) !== 'current') return { kind: 'stopped' as const }
      const owner = await store.projectContextOwner(input.projectContextId)
      if (owner === null) return { kind: 'stopped' as const }
      try {
        const generated = await generate({ researcherAccountId: owner }, {
          document: {
            file: null,
            markdown: definitions.map((source) => `SOURCE DOCUMENT ${source.sourceDocumentId} SUGGESTION:\n${JSON.stringify(source.definition)}`).join('\n\n'),
            pages: null,
          },
          instruction: MERGE_INSTRUCTION,
          signal: modelSignal(steps.cancelSignal()),
        })
        const common = verifiedCommonSuggestion(generated.template, definitions.map((source) => source.definition))
        return common
          ? { kind: 'proposal' as const, result: { phase: 'READY' as const, proposal: common.definition, coverage: common.coverage, draft: common.definition } }
          : { kind: 'proposal' as const, result: { phase: 'HETEROGENEOUS' as const } }
      } catch (error) {
        return { kind: 'failure' as const, failure: durableFailure(error) }
      }
    })
    if (merged.kind === 'stopped') return
    await steps.step('publish', () =>
      merged.kind === 'proposal' ? store.publish(id, attempt, merged.result) : store.fail(id, attempt, merged.failure))
  }

  export function registerBatchSuggestionWorkflow(ports: () => SuggestionWorkflowPorts): void {
    DBOS.registerWorkflow(async (input: SuggestionAttemptInput) => suggestSchemaBatchWorkflow(input, ports()), { name: SUGGEST_SCHEMA_BATCH })
  }
  ```
  `SchemaDefinition` and `Coverage` are the types `modelSuggestedDefinition` and `verifiedCommonSuggestion` already return (`_batch_schema_suggestions.ts:39-45, 78-107`); name them from there.

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/api/_batch_suggestion_workflow.ts prototypes/studio/api/_batch_suggestion_workflow.test.ts
  git commit -m "feat(studio): write the batch schema suggestion as one step per pinned source, a merge and one publication"
  ```

### Task 9: Batch schema suggestions on DBOS: attempts, whole-batch retry, no pump

**Files:**
- Modify: `packages/db/src/prisma/contract.prisma` (suggestions; regenerate the baseline, recreate the databases); `packages/db/src/project-store.ts` (`loadBatchSchemaSuggestion` 326-409, `createBatchSchemaSuggestion` 1641-1710, `updateBatchSchemaSuggestionDraft` 1752-1803, `retryBatchSchemaSuggestion` 1804-1863, `listProjectContexts`' use of `phase` 983-1096, the worker store 2098-2304; types 485-545, 666-713); `packages/db/src/project-store.test.ts` (529, 614), `packages/db/src/project-store.postgres.check.ts` (226-290), `packages/db/src/postgres-test-helpers.ts` (`withBlockedUpdates` keeps `'BatchSchemaSuggestion'`)
- Create: `packages/db/src/batch-schema-suggestion.postgres.check.ts` (added to `test:postgres`)
- Modify: `packages/extraction/src/postgres-suggested-batch.ts` (Run's guards)
- Studio: modify `api/batch_schema_suggestions.ts`, `shared/batchSchemaSuggestion.contract.ts`, `server/workflows.ts` (+ test), `server/app.ts` (the store's `enqueue`); delete `api/_project_operations.ts`, `api/project_operations.test.ts`; rewrite `api/durable_operations.test.ts` as `api/batch_schema_suggestions.test.ts`; update `server/researcher-project-ownership.test.ts` (66-68, 214, 678-689, 1399: no pump mock)
- Studio PostgreSQL: create `api/batch_suggestion_workflow.postgres.test.ts`, `test/support/scenarios/suggestion-publish.ts`, `test/support/scenarios/suggestion-recover.ts`
- Browser: `src/auth/authenticatedFetch.ts` (export `requestModelKeyResend`), `src/projectContexts/BatchExtractionsPanel.tsx` (104-178, 294-307, 623-628, 759-768, 1014-1033, 1068, 1365), `batchSchemaSuggestionMachine.ts` (230-250, 346-365), `batchExtractions.ts` (194-208), `useBatchSchemaSuggestion.ts`, and their tests (`BatchExtractionsPanel.test.tsx` 90-110, 1305-1388, 1822; `batchExtractions.test.ts` 24-41, 77-89; `batchSchemaSuggestionMachine.test.ts` 30, 112)
- E2E: `e2e/batch-extraction-export.spec.ts` (`readySuggestionDto` 55-92 and the stub at 474-516)

**Interfaces:**
- Consumes: Task 2 (`withPoolClientTransaction`, `TransactionalEnqueue`, `WorkflowStatuses`, `executionOf`, `LIVE_WORKFLOW_STATUSES`, `INTERRUPTED_FAILURE`), Task 8 (`registerBatchSuggestionWorkflow`, `SUGGEST_SCHEMA_BATCH`, `SuggestionStore`, `SuggestionAttemptInput`).
- Produces:
  ```ts
  // packages/db
  createResearcherProjectStore(researcherAccountId, database?, options?: { workflowStatuses?: WorkflowStatuses; enqueue?: TransactionalEnqueue })
  // ResearcherProjectStore
  createBatchSchemaSuggestion(projectContextId, sourceDocumentIds): Promise<{ status: 'created' | 'replayed'; suggestion: BatchSchemaSuggestionRecord } | { status: 'invalid' } | null>
  retryBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId, expectedAttempt: number): Promise<
    { status: 'retried' | 'replayed'; suggestion: BatchSchemaSuggestionRecord } | { status: 'attempt-conflict' } | { status: 'not-ready' } | null>
  // BatchSchemaSuggestionRecord: { batchSchemaSuggestionId, projectContextId, selectionKey, attempt, executionStatus (derived),
  //   phase: 'READY' | 'HETEROGENEOUS' | null, proposal, coverage, draft, draftVersion, failure, confirmedSchemaRevisionId,
  //   batchExtractionId, createdAt, sources: { sourceDocumentId, sourceRepresentationRevisionId, descriptor }[] }
  export const SUGGEST_SCHEMA_BATCH_NAME = 'suggestSchemaBatch'   // equal to Task 8's SUGGEST_SCHEMA_BATCH (asserted in server/workflows.test.ts)
  export const SUGGEST_QUEUE_NAME = 'suggest'                       // equal to server/dbos.ts SUGGEST_QUEUE (asserted there too)
  // InternalProjectWorkerStore (the lease methods go):
  readRevisionMarkdown(sourceRepresentationRevisionId): Promise<string | null>   // the canonical package's 'markdown' entry as text
  suggestionAttemptState(batchSchemaSuggestionId, attempt): Promise<'current' | 'stopped'>
  publishBatchSchemaSuggestion(batchSchemaSuggestionId, attempt, result: SuggestionProposal): Promise<'published' | 'stopped'>
  failBatchSchemaSuggestionAttempt(batchSchemaSuggestionId, attempt, failure: { code: string; message: string }): Promise<'published' | 'stopped'>
  ```

- [ ] **Step 1: Edit the baseline**

  ```prisma
  enum BatchSchemaSuggestionPhase {
    READY
    HETEROGENEOUS
  }

  enum SuggestionAttemptOutcome {
    SUCCEEDED
    FAILED
  }

  // A server-owned Batch Schema Suggestion: its membership pins, the retained proposal and draft, and its current
  // attempt. `attempt` counts whole-batch runs; `outcome` and `failure` are the current attempt's and stay null while it
  // runs. `phase` is the retained proposal's meaning, null before the first proposal. Execution status is derived from
  // the `suggest:<id>:<attempt>` workflow while `outcome` is null.
  model BatchSchemaSuggestion {
    id                        Uuid                        @id @default(uuid())
    projectContextId          Uuid
    selectionKey              String                      @unique
    attempt                   Int                         @default(1)
    outcome                   SuggestionAttemptOutcome?
    failure                   Json?
    phase                     BatchSchemaSuggestionPhase?
    proposal                  Json?
    coverage                  Json?
    draft                     Json?
    draftVersion              Int                         @default(0)
    confirmedSchemaRevisionId Uuid?                       @unique
    batchExtractionId         Uuid?                       @unique
    createdAt                 Timestamptz6                @default(now())
    projectContext            ProjectContext              @relation(fields: [projectContextId], references: [id], onDelete: Cascade)
    sources                   BatchSchemaSuggestionSource[]

    @@index([projectContextId, createdAt])
  }

  // One member pin. Deleting its Source Document (or revision) deletes the pin; the suggestion and its draft survive.
  model BatchSchemaSuggestionSource {
    batchSchemaSuggestionId        Uuid
    sourceDocumentId               Uuid
    sourceRepresentationRevisionId Uuid
    batchSchemaSuggestion          BatchSchemaSuggestion        @relation(fields: [batchSchemaSuggestionId], references: [id], onDelete: Cascade)
    sourceRepresentationRevision   SourceRepresentationRevision @relation(fields: [sourceRepresentationRevisionId, sourceDocumentId], references: [id, sourceDocumentId], onDelete: Cascade, map: "batch_suggestion_source_representation_fkey")

    @@id([batchSchemaSuggestionId, sourceDocumentId])
    @@unique([batchSchemaSuggestionId, sourceDocumentId, sourceRepresentationRevisionId], map: "batch_suggestion_source_pin_key")
    @@index([sourceRepresentationRevisionId, sourceDocumentId], map: "batch_suggestion_source_representation_idx")
  }
  ```
  Delete `enum ProjectOperationStatus` (nothing uses it after this). Regenerate; recreate the databases.

- [ ] **Step 2: Write the failing tests**

  `packages/db/src/batch-schema-suggestion.postgres.check.ts` (style of `pool-client-transaction.postgres.check.ts`: a DBOS launch on a throwaway schema with no workflows, an admission client implementing `TransactionalEnqueue`, `workflowStatuses` from that client):
  - `creation commits the suggestion, its sorted pins and attempt 1's workflow together` (`suggest:<id>:1` on queue `suggest`, input `{ batchSchemaSuggestionId, attempt: 1, projectContextId, members }` with members sorted by `sourceDocumentId`; an enqueue that throws after writing leaves neither).
  - `a repeated creation of the same selection replays the suggestion and enqueues nothing`.
  - `retry advances the attempt once; a repeat with the same expected attempt returns that successor even after it finished; an older expected attempt conflicts` (settle attempt 1 FAILED; `retry(…, 1)` → `retried`, attempt 2, `suggest:<id>:2` enqueued over all surviving pins; `retry(…, 1)` again → `replayed` with attempt 2 and no third workflow; publish attempt 2; `retry(…, 1)` → still `replayed`, returned although attempt 2 now has `outcome: 'SUCCEEDED'`, with no new workflow; `retry(…, 0)` → `attempt-conflict`).
  - `retry is refused while an attempt is active, after confirmation, and with no surviving member` (`not-ready` each time; an attempt without an outcome whose workflow was cancelled counts as terminal and may be retried).
  - `publication and failure write only the current attempt while it has no outcome` (`publish(…, attempt 1)` after attempt 2 started → `stopped`, nothing written; a second `publish` of attempt 2 → `stopped`; a successful publication increments `draftVersion` once and replaces `proposal` and `draft`; a failure keeps them).
  - `a draft cannot be edited while an attempt is active` (`updateBatchSchemaSuggestionDraft` → `invalid` during attempt 2, `updated` after it settles).
  - `the membership table holds pins only` (`information_schema.columns` for `batchSchemaSuggestionSource` lists exactly the three pin columns).
  `api/batch_suggestion_workflow.postgres.test.ts` (Studio tier; `generate` is a scripted fake that logs each call to a file; no model):
  - `a manual retry regenerates every surviving pin` (attempt 1 fails on source B only; after `retry`, attempt 2 calls `generate` for A and B again, then publishes).
  - `crash recovery of one attempt skips the sources it checkpointed` (scenario `suggestion-recover`: on the first run `generate` for source B kills the process; the second run's log shows A generated once and B twice).
  - `a draft published before a kill is published once` (scenario `suggestion-publish`: the store's `publishBatchSchemaSuggestion` kills after its commit on the first run; after recovery `draftVersion` is 1 and `outcome` is `SUCCEEDED`).
  `packages/extraction/src/extraction-module.integration.test.ts`: `Run requires a valid draft, a surviving member and no active attempt` (confirm → `batch_not_ready` in each case; replaces the old `executionStatus`/`phase` guard at `postgres-suggested-batch.ts:49-54`).
  `api/batch_schema_suggestions.test.ts` (rewritten from `durable_operations.test.ts`): `retry carries expectedAttempt: 202 with the successor, 409 attempt_conflict for an older one, 409 operation_not_ready while one runs`; `no route wakes a worker` (nothing to kick); `status reads are derived and a DBOS outage is 503`; `the list and read routes answer without starting work`.
  `BatchExtractionsPanel.test.tsx`:
  - `shows the retained proposal and no per-source progress` (replaces 1305 and 1371; no `SuggestionSourceProgress`, no `merging common fields`).
  - `disables editing and Run while an attempt runs and keeps the draft`.
  - `a model_key_required failure resends this browser's keys once, and Try again posts the next expected attempt` (the list answers the suggestion with `failure.code: 'model_key_required'`: `requestModelKeyResend` called once; clicking Try again awaits `ensureModelKeysSent` and POSTs `{ expectedAttempt: 1 }`).
  - `an empty selection keeps the draft and disables Run and Try again`.
  Run the four suites. Expected: FAIL.

- [ ] **Step 3: The store**

  `createBatchSchemaSuggestion`: inside `withPoolClientTransaction`, the current code's ownership, `currentBatchMembers` and `selectionKey`, then the parent insert, the source inserts and
  ```ts
  await enqueue(client, {
    workflowName: SUGGEST_SCHEMA_BATCH_NAME,           // 'suggestSchemaBatch': a string constant in packages/db, asserted equal to Task 8's in server/workflows.test.ts
    workflowID: `suggest:${id}:1`,
    queueName: SUGGEST_QUEUE_NAME,
    authenticatedUser: researcherAccountId,
    attributes: { projectContextId, batchSchemaSuggestionId: id },
  }, { batchSchemaSuggestionId: id, attempt: 1, projectContextId, members })   // members sorted by sourceDocumentId
  ```
  A unique violation on `selectionKey` rolls back and reloads the existing suggestion as `replayed` (as 1688-1709). `options.enqueue` is required by `createBatchSchemaSuggestion` and `retryBatchSchemaSuggestion` (throw a clear error when absent).

  `retryBatchSchemaSuggestion(projectContextId, id, expectedAttempt)`, inside `withPoolClientTransaction`:
  ```ts
  if (!(await ownsProjectContext(transaction, researcherAccountId, projectContextId))) return null
  // Lock the row first (the no-op update of row-lock.ts): a concurrent retry, draft edit, Run or source deletion waits.
  const locked = await orm.public.BatchSchemaSuggestion.where({ id, projectContextId }).updateAll({ id })
  if (locked.length !== 1) return null
  const row = await orm.public.BatchSchemaSuggestion.select('attempt', 'outcome', 'confirmedSchemaRevisionId').first({ id })
  if (row.attempt === expectedAttempt + 1) return { status: 'replayed' }        // this request's successor already exists
  if (row.attempt !== expectedAttempt) return { status: 'attempt-conflict' }
  if (row.confirmedSchemaRevisionId !== null) return { status: 'not-ready' }
  if (row.outcome === null && !stopped(await statuses([`suggest:${id}:${row.attempt}`]), `suggest:${id}:${row.attempt}`))
    return { status: 'not-ready' }                                                 // allowed only after a terminal attempt
  const members = await orm.public.BatchSchemaSuggestionSource.where({ batchSchemaSuggestionId: id })
    .select('sourceDocumentId', 'sourceRepresentationRevisionId').orderBy((source) => source.sourceDocumentId.asc()).all()
  if (members.length === 0) return { status: 'not-ready' }                        // an empty selection keeps its draft
  const attempt = row.attempt + 1
  await orm.public.BatchSchemaSuggestion.where({ id }).updateAll({ attempt, outcome: null, failure: null })
  await enqueue(client, { workflowName: SUGGEST_SCHEMA_BATCH_NAME, workflowID: `suggest:${id}:${attempt}`, queueName: SUGGEST_QUEUE_NAME,
    authenticatedUser: researcherAccountId, attributes: { projectContextId, batchSchemaSuggestionId: id } },
    { batchSchemaSuggestionId: id, attempt, projectContextId, members })
  return { status: 'retried' }
  ```
  where `stopped(map, id)` is `executionOf(map.get(id)) === 'INTERRUPTED'` (`REREAD` re-reads the row: an outcome written meanwhile makes it terminal). The caller reloads the suggestion for both `retried` and `replayed`.

  The worker store's publication and failure (the conditional terminal writes):
  ```ts
  async publishBatchSchemaSuggestion(id, attempt, result) {
    return database.transaction(async ({ orm }) => {
      // The predicate lives in the UPDATE: only the current attempt, only while it has no outcome. A retry that
      // advanced the attempt, a deletion that interrupted it or an earlier execution of this step leaves nothing to update.
      const row = await orm.public.BatchSchemaSuggestion.select('draftVersion').first({ id, attempt, outcome: null })
      if (!row) return 'stopped' as const
      const written = await orm.public.BatchSchemaSuggestion.where({ id, attempt, outcome: null }).updateAll(
        result.phase === 'READY'
          ? { outcome: 'SUCCEEDED', failure: null, phase: 'READY', proposal: result.proposal, coverage: result.coverage,
              draft: result.draft, draftVersion: row.draftVersion + 1 }
          : { outcome: 'SUCCEEDED', failure: null, phase: 'HETEROGENEOUS', proposal: null, coverage: null, draft: null,
              draftVersion: row.draftVersion + 1 },
      )
      return written.length === 1 ? 'published' as const : 'stopped' as const
    })
  },
  async failBatchSchemaSuggestionAttempt(id, attempt, failure) {
    const written = await database.orm.public.BatchSchemaSuggestion.where({ id, attempt, outcome: null })
      .updateAll({ outcome: 'FAILED', failure })                                  // proposal, draft and draftVersion untouched
    return written.length === 1 ? 'published' : 'stopped'
  },
  async suggestionAttemptState(id, attempt) {
    return (await database.orm.public.BatchSchemaSuggestion.select('id').first({ id, attempt, outcome: null })) ? 'current' : 'stopped'
  },
  ```
  The `draftVersion` read and the guarded update run in one transaction and the update's predicate repeats the guard, so two executions of the step cannot both increment it. `updateBatchSchemaSuggestionDraft` locks the row the same way, then refuses (`invalid`) unless `phase === 'READY'`, `confirmedSchemaRevisionId === null` and no attempt is active (outcome set, or the attempt's workflow `INTERRUPTED`), and keeps its `draftVersion` compare-and-set. `loadBatchSchemaSuggestion` returns the new record shape with `executionStatus` derived: `outcome SUCCEEDED` → `COMPLETED`; `FAILED` → `FAILED` with `failure`; no outcome → `executionOf(status)` (`QUEUED`, `RUNNING`, or `FAILED` with `INTERRUPTED_FAILURE` after a re-read), one `workflowStatuses` call for a whole list. Delete the lease methods, their types (`OperationLease`, `ProjectOperationStatus` export, `BatchSchemaSuggestionPhase`'s `SOURCES`/`MERGING`) and the per-source fields. `listProjectContexts` keeps reading `phase === 'READY'` for its "approve" hint.

  `persistSuggestedBatch` (Run): lock the suggestion row first; require `phase === 'READY'`, a parsable draft, at least one member, no active attempt (as above, through `ExtractionExecution.statuses`) and no confirmation; otherwise `batch_not_ready`. The member rows and enqueues are Task 6's.

- [ ] **Step 4: Studio**

  `server/workflows.ts`: `STUDIO_WORKFLOW_NAMES` becomes `[RUN_EXTRACTION, SUGGEST_SCHEMA_BATCH]`; `registerStudioWorkflows` adds
  ```ts
  registerBatchSuggestionWorkflow(() => {
    const worker = createInternalProjectWorkerStore()
    return {
      steps: dbosSteps,
      generate: generateSchemaWithModel,
      store: {
        attemptState: (id, attempt) => worker.suggestionAttemptState(id, attempt),
        projectContextOwner: (projectContextId) => worker.projectContextOwner(projectContextId),
        readMarkdown: (revisionId) => worker.readRevisionMarkdown(revisionId),   // new: the revision's canonical 'markdown' entry as text, or null
        publish: (id, attempt, result) => worker.publishBatchSchemaSuggestion(id, attempt, result),
        fail: (id, attempt, failure) => worker.failBatchSchemaSuggestionAttempt(id, attempt, failure),
      },
    }
  })
  ```
  and the test asserts `SUGGEST_SCHEMA_BATCH_NAME === SUGGEST_SCHEMA_BATCH` and `SUGGEST_QUEUE_NAME === SUGGEST_QUEUE`. `server/app.ts` gives the researcher store `enqueue: (client, workflow, input) => studioDbos().admission.enqueueInTransaction(client, { ...workflow, attributes: { ...workflow.attributes } }, input).then(() => undefined)` (lazy, like `workflowStatuses`).
  `api/batch_schema_suggestions.ts`: delete `operations`/`kick()` (136, 149, 168, 266); `POST /:id/retry` parses `{ expectedAttempt: z.number().int().positive() }` (422 otherwise), answers 202 with the suggestion for `retried`/`replayed`, 409 `attempt_conflict` and 409 `operation_not_ready`; `suggestionDto` emits the new shape; a rejected status read or enqueue is 503 `persistenceUnavailable`. `rm prototypes/studio/api/_project_operations.ts prototypes/studio/api/project_operations.test.ts`.
  `shared/batchSchemaSuggestion.contract.ts`: `suggestionSourceSchema` keeps only the two pins; `batchSchemaSuggestionSchema` gains `attempt: z.number().int().positive()`, keeps `executionStatus`, makes `phase` `z.enum(['READY', 'HETEROGENEOUS']).nullable()`, drops `startedAt`/`finishedAt`; add `batchSchemaSuggestionRetryRequestSchema = z.object({ expectedAttempt: z.number().int().positive() }).strict()` and `'attempt_conflict'` to the error codes.

- [ ] **Step 5: Browser and e2e fixtures**

  - `authenticatedFetch.ts`: export `requestModelKeyResend`.
  - `BatchExtractionsPanel.tsx`: delete `SuggestionSourceProgress` (112-178) and its failure categories (104-110), keeping one line for the suggestion's own failure that reads `Model key not available` for `model_key_required`; when a suggestion's `failure.code` becomes `model_key_required` (a transition, once per attempt), call `requestModelKeyResend()` — the 200 list response never reaches `authenticatedFetch`'s 409 hook; the proposal-version identity (1068, 1365) uses `attempt` and `draftVersion` instead of `finishedAt`; `canRun` (759-768) and Try again (1014-1024) also require `suggestion.sources.length > 0`.
  - `batchSchemaSuggestionMachine.ts`: `suggestionRunning` (232-234) reads `executionStatus` QUEUED/RUNNING (unchanged meaning); editing and Run are disabled while it holds; the `retrying` state sends `{ expectedAttempt: suggestion.attempt }`.
  - `batchExtractions.ts:194-208`: `retryBatchSchemaSuggestion(projectContextId, id, expectedAttempt)` awaits `ensureModelKeysSent()` (as today) and posts the body.
  - `e2e/batch-extraction-export.spec.ts`: `readySuggestionDto` (55-92) emits the new shape (`attempt: 1`, `phase: 'READY'`, `sources` with pins only).

- [ ] **Step 6: Run and commit**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test && pnpm --filter db test:postgres          # fresh databases
  pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e
  grep -rnE "kick\(|leaseOwner|leaseExpiresAt|claimBatchSchemaSuggestion|'SOURCES'|'MERGING'|SuggestionSourceProgress|_project_operations" \
    packages prototypes/studio --include=*.ts --include=*.tsx --include=*.prisma --exclude-dir=node_modules
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add -A prototypes/studio/api/_project_operations.ts prototypes/studio/api/project_operations.test.ts \
    prototypes/studio/api/durable_operations.test.ts
  git add packages/db packages/extraction prototypes/studio/api prototypes/studio/shared prototypes/studio/server \
    prototypes/studio/src prototypes/studio/test prototypes/studio/e2e/batch-extraction-export.spec.ts
  git commit -m "feat(studio)!: run batch schema suggestions as DBOS attempts with whole-batch retry, and delete the pump"
  ```
  Expected grep output: nothing.

### Task 10: Ingestion on DBOS: content replay, active deduplication, staged sources, lanes and admitted models

**Files:**
- Modify: `packages/db/src/prisma/contract.prisma` (`SourceDocument` loses `ingestionKey` and `@@unique([projectContextId, ingestionKey])`; regenerate; recreate the databases); `packages/db/src/project-store.ts` (`IngestSourceDocumentInput` 247-260 loses `ingestionKey`; `ReprocessSourceDocumentInput` 279-282 gains `requestKey`; `ingestSourceDocument` 1407-1520 replays by content only; new `findSourceDocumentByContent`; `IngestionKeyConflictError` 293-298 deleted; `reprocessSourceDocument` 1560-1640 reads `input.requestKey`), `project-store.test.ts` (949-1181, 1407-1453), `project-store.postgres.check.ts`, `source-reprocessing.postgres.check.ts` (the key moves to `requestKey`), `packages/extraction/src/extraction-module.integration.test.ts` (319, 628, 790)
- Create: `prototypes/studio/api/_kei_conversion.ts` (+ test), `prototypes/studio/api/_ingestion_workflow.ts` (+ test), `prototypes/studio/api/source_ingestion.postgres.test.ts`, `test/support/scenarios/ingestion-publish.ts`
- Modify: `prototypes/studio/api/source_documents.ts` (rewrite of 34-698; deletion 704-729 unchanged), `api/source_documents.test.ts`, `api/source_reprocess.ts` (compile only: the shared helpers move; Task 11 rewrites it), `api/_model_config.ts` (`configuredIngestionModels`), `server/workflows.ts` (+ test), `prototypes/studio/playwright.config.ts`, `playwright.base-path.config.ts`, `playwright.service.config.ts` (`FREE_SOURCE_INBOX`)
- Browser: `src/sourceIngestionMachine.ts` (+ test), `src/projectContexts/transport.ts` (+ test), `ProjectContextsProvider.tsx` (295-361), `ProjectContextPage.tsx` (714-751), `useProjectContexts.ts` (86), `src/ProjectNavigation.test.tsx` (1855-2223)
- E2E and system: `e2e/canonical-evidence-lifecycle.spec.ts` (253-260, 319-326), `e2e/schema-order-lifecycle.spec.ts` (90), `e2e/project-navigation.spec.ts` (upload stubs), `tests/contract.test.mjs` (98, 112)

**Interfaces:**
- Consumes: Task 1 (`studioDbos`, `awaitWorkflowOutcome`, `STUDIO_QUEUE`), Task 3 (`createKeiHandoff`, `settleKei`, `keiConvertOkSchema`, `conversionLane`, `conversionTimeoutMs`, `CONVERSION_PRIORITY`, `keiConvertWorkflowId`, `SUBMIT_TO_KEI_RETRY`), Task 4 (`countPdfPages`, `sourceInboxRoot`, `uploadSourcePath`, `stageSource`, `removeStagedSource`), Task 5 (`WorkflowSteps`, `dbosSteps`).
- Produces:
  ```ts
  // packages/db (ResearcherProjectStore)
  findSourceDocumentByContent(projectContextId: string, contentSha256: string): Promise<PersistedSourceDocument | null>
  ingestSourceDocument(projectContextId: string, input: IngestSourceDocumentInput): Promise<(PersistedSourceDocument & { disposition: 'created' | 'replayed' }) | null>
  // api/_kei_conversion.ts (shared with Task 11)
  export type ConvertedPackage = Readonly<{ descriptor: CanonicalPackageDescriptor; provenance: { contractVersion: string; preprocessId: string; parserName: string; parserVersion: string }; pageCount: number; published: boolean }>
  export function packageConversion(options: { readBase: string; runId: string; generation: string; pdf: Uint8Array; originalName: string; signal?: AbortSignal; fetcher?: typeof fetch; packageStore?: PackageStore; now?: () => Date }): Promise<ConvertedPackage>
  export function conversionFailure(outcome: Extract<KeiOutcome<unknown>, { ok: false }>): { status: 422 | 504; code: 'source_ingestion_failed' | 'source_ingestion_timeout'; message: string }
  // api/_ingestion_workflow.ts
  export const INGEST_SOURCE = 'ingestSource'
  export type IngestionInput = Readonly<{ projectContextId: string; attemptId: string; owner: string; source: string; sourceSha256: string; originalName: string; byteSize: number; pageSource: 'pdf' | 'ingest'; pageCount: number | null; lane: ConversionLane; models: Readonly<{ ocr: string | null; layout: string | null }> }>
  export type IngestionOutcome = { ok: true; sourceDocument: { sourceDocumentId: string; name: string; createdAt: string; sourceRepresentationId: string; revisionNumber: 1 }; pageCount: number } | { ok: false; status: 404 | 422 | 502 | 504; code: string; message: string }
  export type IngestionWorkflowPorts = Readonly<{ steps: WorkflowSteps; kei: KeiHandoff; readBase: string; inboxRoot: string; packageStore: PackageStore; storeFor(owner: string): Pick<ResearcherProjectStore, 'findSourceDocumentByContent' | 'ingestSourceDocument' | 'discardCanonicalPackage'> }>
  export function ingestSourceWorkflow(input: IngestionInput, ports: IngestionWorkflowPorts): Promise<IngestionOutcome>
  export function registerIngestionWorkflow(ports: () => IngestionWorkflowPorts): void
  // api/_model_config.ts
  export function configuredIngestionModels(researcherAccountId: string, source?: ModelConfigurationStore): Promise<{ ocr: string | null; layout: string | null }>
  ```

- [ ] **Step 1: Write the failing tests**

  `api/_ingestion_workflow.test.ts` (fake ports):
  - `completed content returns the existing document without converting, and removes this attempt's staged file` (A5: `findSourceDocumentByContent` answers a document; no `submitToKei` step).
  - `submits the staged source to its admitted lane with the admitted models, one priority and the page budget` (`kei-convert-small` for `lane` small, `model`/`layout_model` from `input.models`, `priority: 1`, `timeoutMs: conversionTimeoutMs(input.pageCount)`, `source` the relative path, `workflowId === keiConvertWorkflowId('ingest:<project>:<attempt>')`).
  - `a recovered or replayed ingestion keeps its admitted lane` (the lane comes from `input.lane`, never from a recount: a 3-page input admitted as large goes to `kei-convert-large`).
  - `a kei failure is 422 with kei's reason, a kei deadline is 504, and both remove the staged file`.
  - `publishes the converted package once; a publication that finds the content already published returns that document and discards this package`.
  - `an unexpected failure after submission cancels the kei child before rethrowing`.
  `api/source_documents.test.ts` (rewritten; `Dependencies` gains `admission`, `inboxRoot`, `countPages`, `ingestionModels`, `resultTimeoutMs`):
  - `refuses a form that still sends an ingestionKey` (400 `invalid_request`: `assertFormFields` allows only `file` and `layout`).
  - `replays completed content before parsing: no staged file, no workflow` (A3).
  - `stages the upload, counts its pages and enqueues ingestSource on the studio queue with its dedup ID, owner, lane and models`.
  - `a joined attempt removes this request's unused staged file` (the enqueue returns another workflow ID).
  - `an uncertain enqueue keeps its staged file and answers 503` (spec: the file is left for garbage collection).
  - `waits for the workflow and answers 201 with the document and page count`.
  - `a 504 detaches without cancelling the workflow` (A3).
  - `a workflow that vanished answers 502, not a hang` (`listWorkflows` returns nothing for the ID: 502 `source_ingestion_failed` at once).
  `api/source_ingestion.postgres.test.ts` (Studio tier; DBOS launched in the test file with `register: () => registerIngestionWorkflow(() => ports)`; a spawned kei stand-in on the file's kei schema serves `convert` and the read API; the handler is `createSourceDocumentIngestion(store, deps)` called with real multipart `Request`s):
  - `completed content replays before parsing: no staged file and no workflow` (A3).
  - `a re-upload after a lost response joins the active attempt and returns its document; a 504 preserves the work` (A3: stand-in `hold`; the first request with `resultTimeoutMs: 200` answers 504; a second upload of the same bytes returns the same workflow's document once the stand-in answers; one `ingest:` workflow, one `kei-convert:` workflow).
  - `simultaneous same-content uploads in one project run one workflow, and the loser's staged file is removed` (A4).
  - `identical PDFs in two projects stage independent files and run independently` (A4).
  - `content completed after the precheck is replayed by the workflow's first step` (A5: publish the content through the store after the handler's precheck and before its enqueue — a `beforeEnqueue` test seam in `Dependencies` — then the workflow returns that document without a `kei-convert:` workflow).
  - `a failed attempt releases deduplication and a re-upload starts a new attempt without any client key` (A5).
  - `an ingestion recovered after its owner changed the Ingestion Model Choice converts with the models it was admitted with` (A9: stand-in `hold`; change the owner's configuration; restart DBOS in the test file — `shutdownStudioDbos()` then `launchStudioDbos` with the same schemas and executor; answer; the `kei-convert:` workflow's recorded input has the admitted `model` and `layout_model`, and exactly one exists).
  - `two same-content uploads under different choices join one attempt with the first admitted models` (A10).
  - `a small PDF converts on kei-convert-small; a large or uncounted one on kei-convert-large` (A11/A12: 3-page and 31-page `blankPdf`s; `%PDF-1.7` + garbage bytes; the kei workflows' `queueName`).
  - `an ingestion published before a kill is published once` (A1: scenario `ingestion-publish` kills after `ingestSourceDocument` commits on the first run; after recovery one Source Document with one revision exists and the workflow's output names it).
  `api/_model_config.test.ts`: `configuredIngestionModels answers the owner's saved roles and null for an unchosen one`.
  Browser: `sourceIngestionMachine.test.ts` `queues uploads by a client-only item id and sends no key`, `a reprocess retry re-sends its request key after an uncertain failure and mints a new one after a confirmed failure` (503 → same key, keeps `e2e/project-navigation.spec.ts:327` passing; 422 → new key); `ProjectNavigation.test.tsx` updates its form assertions (`form.get('ingestionKey')` is null).
  Run the suites. Expected: FAIL.

- [ ] **Step 2: The store**

  `ingestSourceDocument` drops the ingestion-key branch (1434-1450) and the key-guarded compensating delete becomes `where({ id: createdSourceDocumentId, projectContextId })`; a 23505 on `(projectContextId, contentSha256)` returns the winner as `replayed` (the unique content constraint is the publication backstop). `findSourceDocumentByContent` is the content branch (1451-1459) as its own owner-checked read. `reprocessSourceDocument`/`findReprocessedSourceDocument` take the request key from `input.requestKey`. Update every test that passed a key.

- [ ] **Step 3: The shared conversion helpers and the workflow**

  `_kei_conversion.ts` moves `acceptedResult` (source_documents.ts:393-440), the translation (500-520), the packaging and the provenance check (523-575) out of `parseSourceDocument`, and adds the generation check — kei's `convert` output names the generation it published, and the manifest must be that one:
  ```ts
  if (manifest.data.generation !== options.generation)
    throw new ApiError(502, 'source_ingestion_failed', 'The Parsing Service published another parse than the one it reported.')
  ```
  `conversionFailure` maps `deadline_exceeded` to `{ status: 504, code: 'source_ingestion_timeout', message: 'Source Document parsing did not finish within its time limit.' }` and every other failure to `{ status: 422, code: 'source_ingestion_failed', message: `The Source Document could not be parsed: ${reason}`.slice(0, 512) }`.

  `_ingestion_workflow.ts`:
  ```ts
  export async function ingestSourceWorkflow(input: IngestionInput, ports: IngestionWorkflowPorts): Promise<IngestionOutcome> {
    const { steps, kei } = ports
    const store = ports.storeFor(input.owner)
    const workflowId = `ingest:${input.projectContextId}:${input.attemptId}`
    const removeStaged = () => steps.step('removeStagedSource', () => removeStagedSource(ports.inboxRoot, input.source))
    // Active deduplication is not permanent replay: content published after the request's precheck replays here.
    const replay = await steps.step('replayCompletedContent', () => completed(store, input))
    if (replay) { await removeStaged(); return replay }
    const child = keiConvertWorkflowId(workflowId)
    await steps.step('submitToKei', () => kei.submit({
      workflow: 'convert', workflowId: child, queueName: input.lane, priority: CONVERSION_PRIORITY,
      timeoutMs: conversionTimeoutMs(input.pageCount), authenticatedUser: input.owner,
      attributes: { projectContextId: input.projectContextId },
      request: { source: input.source, source_sha256: input.sourceSha256, source_name: input.originalName,
        page_source: input.pageSource, ingest: null, model: input.models.ocr, layout_model: input.models.layout,
        cut: 'auto', debug: false },
    }), SUBMIT_TO_KEI_RETRY)
    try {
      let polled: KeiPoll
      do polled = await steps.step('pollKei', () => kei.poll(child, steps.cancelSignal()))
      while (polled.state === 'live')
      const settled = settleKei(polled, keiConvertOkSchema)
      if (!settled.ok) { await removeStaged(); return { ok: false, ...conversionFailure(settled) } }
      // No bytes enter DBOS history: the step reads the staged file itself and returns a package descriptor.
      const converted = await steps.step('acceptConversion', async () => packageConversion({
        readBase: ports.readBase, runId: settled.value.run_id, generation: settled.value.generation,
        pdf: new Uint8Array(await readFile(join(ports.inboxRoot, input.source))), originalName: input.originalName,
        packageStore: ports.packageStore,
      }), ARTIFACT_READ_RETRY)
      const outcome = await steps.step('publishSourceDocument', () => publish(store, input, converted, ports.packageStore))
      await removeStaged()
      return outcome
    } catch (error) {
      if (isWorkflowCancellation(error)) throw error
      await steps.step('cancelKeiChild', () => kei.cancel(child))
      throw error
    }
  }
  ```
  `completed` returns the ok outcome for `findSourceDocumentByContent` (page count from the package's `source` entry, as `source_reprocess.ts:89` reads it), else null. `publish` calls `store.ingestSourceDocument(projectContextId, { contentSha256, mediaType: 'application/pdf', originalName, ...converted.descriptor, ...converted.provenance, ensureRetained })` (the Studio acceptance boundary: the owner-checked transaction and the content constraint); null → `{ ok: false, status: 404, code: 'not_found', message: 'Project Context was not found.' }` and the new package is discarded; a `replayed` document with another descriptor discards this package (`discardPublishedPackage`, `source_documents.ts:442-454`). Import `isWorkflowCancellation` and `ARTIFACT_READ_RETRY` from `extraction/workflows` (Task 5) rather than repeating them. `registerIngestionWorkflow` registers `ingestSourceWorkflow` under `INGEST_SOURCE`.

- [ ] **Step 4: The handler**

  `createSourceDocumentIngestion(store, dependencies)` keeps the project check, the form validation without `ingestionKey` (`assertFormFields(form, ['file', 'layout'])`), the MIME, size, magic-bytes and filename checks, then:
  ```ts
  const pdf = new Uint8Array(await file.arrayBuffer())
  const contentSha256 = createHash('sha256').update(pdf).digest('hex')
  // Completed content replays before any parse.
  const existing = await store.findSourceDocumentByContent(projectId, contentSha256)
  if (existing) return json({ ...ingestedDto(existing), pageCount: await pageCountOf(existing.descriptor) }, { status: 201, headers: noStore })
  const attemptId = randomUUID()
  const source = uploadSourcePath(projectId, attemptId)
  const root = dependencies.inboxRoot ?? sourceInboxRoot()
  await stageSource(root, source, pdf)
  const pageCount = await (dependencies.countPages ?? countPdfPages)(pdf)
  const owner = store.researcherAccountId                              // the owner: the project check above passed
  const models = await (dependencies.ingestionModels ?? configuredIngestionModels)(owner)
  const ours = `ingest:${projectId}:${attemptId}`
  await dependencies.beforeEnqueue?.()                                 // test seam for the precheck/enqueue race
  const admission = dependencies.admission ?? studioDbos().admission
  let workflowId: string
  try {
    const handle = await admission.enqueue({
      workflowName: INGEST_SOURCE, queueName: STUDIO_QUEUE, workflowID: ours,
      // Active deduplication: a same-project, same-content attempt that is still running is joined, not repeated.
      deduplicationID: `ingest:${projectId}:${contentSha256}`, duplicationPolicy: 'return-existing',
      authenticatedUser: owner, attributes: { projectContextId: projectId },
    }, { projectContextId: projectId, attemptId, owner, source, sourceSha256: contentSha256, originalName,
         byteSize: pdf.byteLength, pageSource, pageCount, lane: conversionLane(pageCount), models } satisfies IngestionInput)
    workflowId = handle.workflowID
  } catch (cause) {
    // An uncertain enqueue leaves its file for garbage collection rather than risking a live attempt's input.
    throw persistenceUnavailable(cause, 'Source Document ingestion could not be started.')
  }
  if (workflowId !== ours) await removeStagedSource(root, source)     // another attempt won; this file was never read
  const awaited = await awaitWorkflowOutcome<IngestionOutcome>(admission, workflowId, {
    timeoutMs: dependencies.resultTimeoutMs ?? 30 * 60 * 1000, signal: request.signal,
  })
  if (awaited.state === 'timed-out')                                   // detaches: nothing is cancelled
    throw new ApiError(504, 'source_ingestion_timeout', 'Source Document parsing did not finish within thirty minutes.')
  if (awaited.state === 'stopped')
    throw new ApiError(502, 'source_ingestion_failed', 'Source Document parsing stopped before it finished.')
  if (!awaited.output.ok) throw new ApiError(awaited.output.status, awaited.output.code, awaited.output.message)
  return json({ ...awaited.output.sourceDocument, pageCount: awaited.output.pageCount }, { status: 201, headers: noStore })
  ```
  Delete `DEFAULT_KEI_EXP`, `DEFAULT_MODEL`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_POLL_INTERVAL_MS`, `submittedRun`, `completedRun`, `retryAfterMs`, `parsingRequest`'s polling use, `parseSourceDocument` and the `KEI_EXP_MODEL` read (38-41, 270-390, 456-581). `server/workflows.ts` registers `ingestSource` with ports built from `studioDbos().kei`, `process.env.KEI_EXP_URL`, `sourceInboxRoot()`, `canonicalPackageStore` and `createResearcherProjectStore`; `STUDIO_WORKFLOW_NAMES` gains `INGEST_SOURCE`. The three Playwright configs set `FREE_SOURCE_INBOX` to a directory under the run's state (`artifacts/service-tests/state/source-inbox` for the service config, a `mkdtemp` directory for the other two).

- [ ] **Step 5: Browser, e2e seeds and the system test**

  `sourceIngestionMachine.ts`: an item's identity is `itemId` (`crypto.randomUUID()` minted in `ProjectContextsProvider.addSources`, never sent); a reprocess item carries `requestKey` (minted in `reprocessSource`); `source.retry` takes `itemId`; a failed reprocess item records whether its failure was uncertain (a network error, or an unmarked 502, 503 or 504 — `transport.ts` carries `status` and the terminal-response header) and its retry keeps `requestKey` only then, else mints a new one. `transport.ts` `ingestSourceDocument(projectContextId, file, layout, signal)` sends `file` and `layout` only. Remove `ingestionKey` from the e2e seeds (`canonical-evidence-lifecycle.spec.ts:253-260, 319-326`, `schema-order-lifecycle.spec.ts:90`), from `project-navigation.spec.ts`'s upload stubs and from `tests/contract.test.mjs` (98, 112).

- [ ] **Step 6: Run and commit**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test && pnpm --filter db test:postgres          # fresh databases
  pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e && pnpm --filter studio test:e2e:base-path
  grep -rnE "ingestionKey|IngestionKeyConflictError|KEI_EXP_MODEL|DEFAULT_MODEL|submittedRun|completedRun|/api/runs'" \
    packages prototypes/studio tests scripts compose*.yaml --include=*.ts --include=*.tsx --include=*.mjs --include=*.prisma --include=*.yaml --exclude-dir=node_modules
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/db packages/extraction prototypes/studio/api prototypes/studio/server prototypes/studio/src prototypes/studio/test \
    prototypes/studio/e2e prototypes/studio/playwright.config.ts prototypes/studio/playwright.base-path.config.ts \
    prototypes/studio/playwright.service.config.ts tests/contract.test.mjs
  git commit -m "feat(studio)!: ingest sources through a DBOS workflow with content replay, active deduplication and kei's lanes"
  ```
  Expected grep output: only `prototypes/studio/e2e/real-service.spec.ts` (21, 136), which Task 13 rewrites; that spec is outside `test:e2e` and already red since M3.

### Task 11: Reprocessing on DBOS: request-key replay, the stored page count's lane, the owner's current Ingestion Model Choice

**Files:**
- Create: `prototypes/studio/api/_reprocess_workflow.ts` (+ test), `prototypes/studio/api/source_reprocess.test.ts`, `prototypes/studio/api/source_reprocess.postgres.test.ts`, `test/support/scenarios/reprocess-publish.ts`
- Modify: `prototypes/studio/api/source_reprocess.ts` (rewrite of 31-163), `server/workflows.ts` (+ test)

**Interfaces:**
- Consumes: Task 10 (`packageConversion`, `conversionFailure`, `configuredIngestionModels`, the `requestKey` store fields), Task 4 (`reprocessSourcePath`, `stageSource`, `removeStagedSource`), Task 3, Task 1.
- Produces:
  ```ts
  export const REPROCESS_SOURCE = 'reprocessSource'
  export type ReprocessInput = Readonly<{ projectContextId: string; sourceDocumentId: string; requestKey: string; requestFingerprint: string; expectedRepresentationId: string; owner: string; originalName: string; pageSource: 'pdf' | 'ingest'; pageCount: number; lane: ConversionLane; models: Readonly<{ ocr: string | null; layout: string | null }> }>
  export type ReprocessOutcome = { ok: true; revision: { sourceDocumentId: string; name: string; createdAt: string; sourceRepresentationId: string; revisionNumber: number }; pageCount: number } | { ok: false; status: 404 | 409 | 422 | 502 | 504; code: string; message: string }
  export function reprocessSourceWorkflow(input: ReprocessInput, ports: ReprocessWorkflowPorts): Promise<ReprocessOutcome>
  export function registerReprocessWorkflow(ports: () => ReprocessWorkflowPorts): void
  ```

- [ ] **Step 1: Write the failing tests**

  `api/_reprocess_workflow.test.ts` (fake ports): `stages the expected revision's PDF from its canonical package under its reprocess name`, `submits to the lane admitted from the stored page count with the admitted models`, `publishes through reprocessSourceDocument with the request key, fingerprint and expected head, and answers 409 when the head moved`, `removes its staged file after publication and after a failure`, `an unexpected failure after submission cancels the kei child before rethrowing`.
  `api/source_reprocess.test.ts` (unit, fakes): `a published request key replays its revision without starting work`, `a running request key with the same fingerprint joins its workflow`, `a reused request key with another fingerprint answers 409 and starts nothing`, `a stale expected head answers 409 before any work`, `a new request key enqueues reprocessSource on the studio queue with the owner, the attributes, the stored page count's lane and the current Ingestion Model Choice`, `a 504 detaches`.
  `api/source_reprocess.postgres.test.ts` (DBOS in the file, spawned stand-in):
  - `a reprocess converts on the lane of its revision's stored page count with the owner's current Ingestion Model Choice` (A9, A11: the kei child's queue is `kei-convert-small` for the 3-page fixture revision; after the owner changes the choice, a new request key's kei input carries the new models).
  - `a repeated request key replays the original attempt after the choice changed: while it runs, after publication and after its history is deleted` (A10: stand-in `hold`; change the choice; repeat the POST → the same workflow, the original models; answer; repeat → 201 with the same revision, no second revision; `DBOS.deleteWorkflows([workflowId])`; repeat → the same revision from the row).
  - `the expected head is rechecked under the document lock at publication` (a second reprocess publishes first while the stand-in holds this one: this one answers 409 and appends nothing).
  - `a reprocess published before a kill appends one revision` (A1, scenario `reprocess-publish`).

- [ ] **Step 2: Implement**

  The handler keeps its route, validation and fingerprint (`source_reprocess.ts:41-74`) and the row-backed replay (75-94: `findReprocessedSourceDocument`, which works after history retention). Then:
  ```ts
  const workflowId = `reprocess:${documentId}:${requestKey}`
  const admission = dependencies.admission ?? studioDbos().admission
  const recordedFingerprint = async () => {
    const [recorded] = await admission.listWorkflows({ workflowIDs: [workflowId], loadInput: true, loadOutput: false })
    return recorded ? ((recorded.input?.[0] ?? {}) as { requestFingerprint?: string }).requestFingerprint ?? null : undefined
  }
  const known = await recordedFingerprint()
  if (known !== undefined && known !== requestFingerprint) throw new ReprocessConflictError()
  if (known === undefined) {
    // A new request key: the expected head, the lane from the stored package's page count, the owner's current choice.
    …the head check of 95-105, the descriptor of 106-115…
    const pageCount = JSON.parse(new TextDecoder().decode((await readPackage(descriptor, 'source')).bytes)).page_count
    const input: ReprocessInput = { projectContextId: projectId, sourceDocumentId: documentId, requestKey, requestFingerprint,
      expectedRepresentationId, owner: store.researcherAccountId, originalName: snapshot.sourceDocument.name,
      pageSource: layout === 'pages' ? 'pdf' : 'ingest', pageCount, lane: conversionLane(pageCount),
      models: await configuredIngestionModels(store.researcherAccountId) }
    await admission.enqueue({ workflowName: REPROCESS_SOURCE, queueName: STUDIO_QUEUE, workflowID: workflowId,
      authenticatedUser: input.owner,
      attributes: { projectContextId: projectId, sourceDocumentId: documentId, sourceRepresentationRevisionId: expectedRepresentationId } }, input)
    // Two first requests with one key and different bodies: the one enqueued first owns the ID.
    if ((await recordedFingerprint()) !== requestFingerprint) throw new ReprocessConflictError()
  }
  const awaited = await awaitWorkflowOutcome<ReprocessOutcome>(admission, workflowId, { timeoutMs: 30 * 60 * 1000, signal: request.signal })
  ```
  mapped like ingestion (504 detaches; `ok` → 201 with the revision and `pageCount`; a typed failure → its status and code, `ReprocessConflictError` → 409 `invalid_request` as today). A repeated key while running never resolves the configuration again. The workflow: step `stageReprocessSource` (read the expected revision's package `pdf` entry through the owner's store and `stageSource(inboxRoot, reprocessSourcePath(project, document, key), bytes)`), `submitToKei` (`kei-convert:reprocess:<document>:<key>`, `queueName: input.lane`, `CONVERSION_PRIORITY`, `conversionTimeoutMs(input.pageCount)`, the admitted models), `pollKei`, `acceptConversion` (`packageConversion` from the staged file), `publishRevision` (`store.reprocessSourceDocument(project, document, { …converted, expectedRepresentationId, requestFingerprint, requestKey, ensureRetained })`: it takes `lockSourceDocumentRow` and rechecks the head at commit; a replay of the same key returns the revision it created — PR #140 unchanged), `removeStagedSource`, and the same cancel-the-child rule on unexpected failure. `server/workflows.ts` registers it; `STUDIO_WORKFLOW_NAMES` gains `REPROCESS_SOURCE`. Delete the last HTTP-kei imports from `source_reprocess.ts` (`parseSourceDocument`).

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter db test:postgres       # fresh databases; source-reprocessing.postgres.check.ts still passes
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/api prototypes/studio/server prototypes/studio/test
  git commit -m "feat(studio): reprocess through a DBOS workflow on the revision's lane with the owner's current models"
  ```

### Task 12: Deletion keeps suggestion drafts valid, interrupts active attempts and stops the deleted scope's work

**Files:**
- Modify: `packages/db/src/project-store.ts` (`deleteSourceDocument` 893-920, `deleteProjectContext` 855-892 return what they stopped), `packages/db/src/project-store.test.ts` (1249)
- Create: `packages/db/src/source-deletion.postgres.check.ts` (added to `test:postgres`), `prototypes/studio/api/_scope_cancellation.ts` (+ test), `prototypes/studio/api/source_deletion.postgres.test.ts`
- Modify: `prototypes/studio/api/source_documents.ts` (`createSourceDocumentDeletion` 704-729), `api/project_contexts.ts` (the project DELETE), their tests

**Interfaces:**
- Consumes: Tasks 2, 6, 9, 10, 11.
- Produces:
  ```ts
  // packages/db
  deleteSourceDocument(projectContextId, sourceDocumentId): Promise<{ interruptedAttempts: readonly { batchSchemaSuggestionId: string; attempt: number }[] } | null>
  deleteProjectContext(projectContextId): Promise<boolean>   // unchanged
  // Studio
  export function cancelScopeWork(scope: { projectContextId: string; sourceDocumentId?: string }, interruptedAttempts?: readonly { batchSchemaSuggestionId: string; attempt: number }[], clients?: { admission; kei }): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

  `packages/db/src/source-deletion.postgres.check.ts` (DBOS launched on a throwaway schema with no workflows, as in Task 9's check, so attempts stay "active"):
  - `deleting a source a suggestion pins raises no FK error before, during or after the suggestion's publication, and keeps its draft valid` (A7: before — attempt 1 active; during — `withBlockedUpdates('BatchSchemaSuggestion', id, 1, …)` holds the publication's row while the deletion waits, then both finish; after — published; in every case the delete returns non-null, the suggestion's `draft` still parses as a schema definition and `draftVersion` is what publication left).
  - `deleting a source interrupts the active attempt without touching its proposal, draft or draft version` (A7: `outcome: 'FAILED'`, `failure.code: 'interrupted'`, `attempt` unchanged, `proposal`/`draft`/`draftVersion` byte-equal to before).
  - `a late success or failure of the interrupted attempt changes nothing` (A7: `publishBatchSchemaSuggestion(id, attempt, …)` and `failBatchSchemaSuggestionAttempt(…)` → `stopped`; the row is unchanged).
  - `surviving batch members' results and reviews stay pinned` (A7: a batch of A and B with finalized reviews; delete A; B's Extraction, its `sourceRepresentationRevisionId` pin and its `ExtractionReview` rows are unchanged; the batch lists B only).
  - `deleting the last pinned source keeps the draft; Run and retry refuse the empty selection` (A7).
  - `a deleted source's pending Extractions leave its batch and fail no surviving member` (the other member stays QUEUED).
  `api/source_deletion.postgres.test.ts` (Studio tier, spawned stand-in holding kei work):
  - `after deletion commits, the deleted source's live Studio workflows and their kei children are cancelled` (an Extraction and a reprocess of the source in flight and a suggestion attempt pinning it: `extract:<id>`, `reprocess:<doc>:<key>` and `suggest:<id>:<attempt>` end CANCELLED, and so do `kei-extract:<id>` and `kei-convert:reprocess:<doc>:<key>`; nothing is re-cancelled once cancelled).
  - `after project deletion commits, the project's live workflows and their kei children are cancelled`.
  - `a failed cancellation after deletion is logged and still answers 204` (M6's collectGarbage repairs it).

- [ ] **Step 2: Implement**

  `deleteSourceDocument`, in one transaction after the ownership and document reads:
  ```ts
  // Lock every suggestion that pins this document, in sorted order, before its membership disappears (spec,
  // *Suggestion preservation*); the same row lock serializes with retry, draft edits, Run and publication.
  const pinned = await orm.public.BatchSchemaSuggestionSource.where({ sourceDocumentId })
    .select('batchSchemaSuggestionId').all()
  const suggestionIds = [...new Set(pinned.map((row) => row.batchSchemaSuggestionId))].sort()
  const interruptedAttempts: { batchSchemaSuggestionId: string; attempt: number }[] = []
  for (const id of suggestionIds) {
    await orm.public.BatchSchemaSuggestion.where({ id }).updateAll({ id })                 // the row lock
    const row = await orm.public.BatchSchemaSuggestion.select('attempt', 'outcome').first({ id })
    if (!row || row.outcome !== null) continue
    // The active attempt's immutable input still names this source; its conditional publication can no longer succeed.
    await orm.public.BatchSchemaSuggestion.where({ id, attempt: row.attempt, outcome: null }).updateAll({
      outcome: 'FAILED',
      failure: { code: 'interrupted', message: 'A selected Source Document was deleted while its fields were being suggested.' },
    })
    interruptedAttempts.push({ batchSchemaSuggestionId: id, attempt: row.attempt })
  }
  …the existing descriptor read and SourceDocument delete (cascades revisions, Extractions, reviews and the pins)…
  return { interruptedAttempts }
  ```
  (An attempt already without an outcome but interrupted by a crash is interrupted here too; it was not going to publish.) `_scope_cancellation.ts`:
  ```ts
  /** Best-effort cancellation after a deletion committed (spec, *Deletion*). Ownership checks already hide the scope;
   *  this only stops work early. Cancels only live workflows, and a live Studio workflow's kei child. */
  export async function cancelScopeWork(scope, interruptedAttempts = [], clients = studioDbos()) {
    const attributes = scope.sourceDocumentId ? { sourceDocumentId: scope.sourceDocumentId } : { projectContextId: scope.projectContextId }
    const live = await clients.admission.listWorkflows({ attributes, status: ['ENQUEUED', 'DELAYED', 'PENDING'], loadInput: false, loadOutput: false })
    const ids = new Set([...live.map((status) => status.workflowID),
      ...interruptedAttempts.map((attempt) => `suggest:${attempt.batchSchemaSuggestionId}:${attempt.attempt}`)])
    const kei = createKeiHandoff(clients.kei)
    for (const id of ids) {
      const [status] = await clients.admission.listWorkflows({ workflowIDs: [id], loadInput: false, loadOutput: false })
      if (status && LIVE_WORKFLOW_STATUSES.has(status.status)) await clients.admission.cancelWorkflow(id)
      if (id.startsWith('extract:')) await kei.cancel(keiExtractWorkflowId(id.slice('extract:'.length)))
      else if (id.startsWith('ingest:') || id.startsWith('reprocess:')) await kei.cancel(keiConvertWorkflowId(id))
    }
  }
  ```
  The deletion handlers call it after the store returns (and after `discardPackagesIfUnreferenced`, which the store already runs), catching and logging any error, and answer 204 either way. A source deletion also passes the document ID so its ingestion-free workflows are found by `sourceDocumentId`; a project deletion passes only `projectContextId`.

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test && pnpm --filter db test:postgres          # fresh databases
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/db/src/project-store.ts packages/db/src/project-store.test.ts packages/db/src/source-deletion.postgres.check.ts \
    packages/db/package.json prototypes/studio/api
  git commit -m "feat(studio): keep suggestion drafts across source deletion, interrupt active attempts and stop the scope's work"
  ```

### Task 13: The real-service tier on kei's DBOS worker

This turns `pnpm test:service` green again (red since M3 Task 10). It pulls the spec's M6 *Test wiring* item for `e2e/realService.ts` into M4 (Ruling 12).

**Files:**
- Modify: `prototypes/studio/e2e/realService.ts` (137-234), `prototypes/studio/e2e/real-service.spec.ts`, `prototypes/studio/playwright.service.config.ts` (`FREE_PLAYWRIGHT_SOURCE_INBOX`, passed to Studio as `FREE_SOURCE_INBOX`)
- Modify: `packages/db/package.json` (`exports` `"./kei-role": "./src/kei-role.ts"`)

**Interfaces:**
- Consumes: M3's `kei-worker` (`python -m kei_exp.workflows.cli worker`), M2's `ensureKeiRole`, Tasks 6, 10, 11.
- Produces: `startRealService(logFile, { holdConversion? })` returning `{ url, runs, model, modelCalls, restart(), killWorker(), holdNextExtraction(), releaseExtraction(), conversionHeld(), releaseConversion(), keiWorkflows(prefix): Promise<WorkflowStatus[]>, close() }`.

- [ ] **Step 1: The harness**

  In `startRealService`:
  - Create kei's role on the service database before anything starts, as Studio's entrypoint does: connect a `pg.Client` to `DATABASE_URL`, `await ensureKeiRole(client, { password })` with `password = randomBytes(24).toString('hex')` (never printed), and build `KEI_SYSTEM_DATABASE_URL` from `DATABASE_URL` with user `kei`, that password and `hostaddr=127.0.0.1`.
  - Environment: drop `KEI_DATABASE_URL`; add `KEI_SYSTEM_DATABASE_URL` (the worker only — pass it to the worker's `spawn` and not to the API's), `KEI_SOURCE_INBOX: process.env.FREE_PLAYWRIGHT_SOURCE_INBOX` (created with `mkdir -p`), keep `KEI_RUNS`, `KEI_SLOT`, `KEI_VLLM_URL`, `KEI_EXTRACT_*`, `KEI_NUEXTRACT_URL: ''`, `CUDA_VISIBLE_DEVICES: ''`.
  - Delete the migration step (`kei_exp.jobs.cli schema --apply`, 219-220): `DBOS.launch()` migrates `kei_dbos`. The worker is `start(['-m', 'kei_exp.workflows.cli', 'worker', '--slot', 'free-service-e2e'])`; readiness waits for both `GET /api/models` and the worker's `kei worker kei-free-service-e2e serving` log line (read from the log file), 120 s.
  - `restart()` stops both and boots again; `killWorker()` sends SIGKILL to the worker only, waits for its exit and starts a new worker (the API keeps serving); `keiWorkflows(prefix)` lists `kei_dbos` rows through a `DBOSClient` with `applicationName: 'kei'` (`listWorkflows({ workflow_id_prefix: prefix, loadInput: true })`); the scripted model server gains `holdNextExtraction()` / `releaseExtraction()` (the next `/v1/chat/completions` request waits until released).
  - `close()` also destroys the client.
  `playwright.service.config.ts`: `process.env.FREE_PLAYWRIGHT_SOURCE_INBOX = resolve(state, 'source-inbox')` and `webServer.env.FREE_SOURCE_INBOX` set to it.

- [ ] **Step 2: The specs**

  `real-service.spec.ts`: both existing tests upload without `ingestionKey` (21, 136) and keep every evidence, review and restart assertion. Add, in serial mode:
  - `a small PDF uploaded and extracted while a large conversion runs finishes first` (A11 and the *Verification* lanes item: start the upload of a 40-page `textPdf` without awaiting it; a test-only worker wrapper pauses its first native `runner.convert` call after writing an entry marker, while the large child occupies `kei-convert-large`; upload a 1-page PDF (201) and run an Article extraction on it to `COMPLETED`; assert the large child is still `PENDING`, release the wrapper, then assert both small operations' `completedAt` values precede the large conversion's; the small one ran on `kei-convert-small`).
  - `a kei worker killed mid-conversion recovers the same child, and Studio publishes one document` (*Verification*: Studio and kei kill/restart with no duplicate kei work: upload a 40-page PDF, wait for the test-only native-runner entry marker and `PENDING`, `killWorker()`; the replacement runs unpaused, and the upload still answers 201; exactly one `kei-convert:` workflow for it, `SUCCESS`, with `recoveryAttempts >= 2`; one Source Document with one revision).
  - `cancelling an extraction cancels its kei workflow` (skipped when `FREE_REAL_EXTRACT_URL` is set, as `real-service.spec.ts:125` skips today, because only the scripted model can hold a call; `holdNextExtraction()`; POST an extraction; wait for `kei-extract:<id>` `PENDING`; `DELETE /api/extractions/<id>` → 202; within 5 s the kei row is `CANCELLED`; the attempt reads `FAILED` with `failure.code: 'cancelled'`; release the model and see nothing published).
  - `interactive and batch extractions reach kei at priority 1 and 10 with their deadlines` (*Verification* priorities and deadlines: `kei-extract:<interactive id>` has `priority: 1`, `timeoutMS: 600_000`; the batch member's has `priority: 10`).
  - `a reprocess of a small revision converts on kei-convert-small with the owner's Ingestion Model Choice` (A9/A11: `queueName: 'kei-convert-small'`; the kei input's `model` and `layout_model` equal the configured choice, or null when none).
  - `a PDF neither pdf.js nor PDFium can open is refused by kei and stored nowhere` (A12: `%PDF-1.7\n` + 2 KiB of zero bytes: 422 `source_ingestion_failed`; its `kei-convert:` workflow ran on `kei-convert-large` and returned `source_unreadable`; no Source Document).
  - `a PDF only PDFium opens converts on kei-convert-large` (A12). Build the fixture first with a probe: from `prototypes/parsing_service`, run `.venv/bin/python -c "import pypdfium2 as p, sys; print(len(p.PdfDocument(sys.argv[1])))" <file>` and Studio's `countPdfPages` on candidates — a valid `textPdf` whose cross-reference table is replaced by garbage, one whose `trailer` omits `/Root` but whose catalog object remains, one with a `startxref` offset past the end. Keep the first candidate for which PDFium counts pages and `countPdfPages` answers null, as `e2e/fixtures/pdfium-only.pdf` with a comment naming how it was made. If no candidate qualifies, do not weaken the test: report it to the controller, leave this case `test.fixme` with that reason, and rely on `api/source_ingestion.postgres.test.ts`'s `an uncounted PDF converts on kei-convert-large` for the lane rule.

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm test:service                      # Docling weights and the parsing .venv
  pnpm --filter studio typecheck && pnpm --filter studio lint
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/e2e/realService.ts prototypes/studio/e2e/real-service.spec.ts prototypes/studio/e2e/fixtures \
    prototypes/studio/playwright.service.config.ts packages/db/package.json
  git commit -m "test(studio): drive the real-service tier through kei's DBOS worker, lanes, cancels and a worker kill"
  ```
  If this host cannot run `test:service` (no Docling weights, no `.venv`), say so in the report; never report it as passed.

### Task 14: Verification and bookkeeping

**Files:**
- Create: `docs/validation/<YYYY-MM-DD>-dbos-m4-verification.md`
- Modify: `docs/plans/2026-09-24-unified-durable-execution.md` (mark the existing M4 heading done), this plan's `Status:` line

- [x] **Step 1: Residue search**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  grep -rnE "ExtractionJob|BatchExtractionMember|ExtractionJobKind|job-worker|ExtractionJobWorker|claimBatchSchemaSuggestion|leaseOwner|leaseExpiresAt|kick\(|wakeAfter|extractionRuntime|_extraction_runtime|_project_operations|ingestionKey|IngestionKeyConflictError|KEI_EXP_MODEL|DEFAULT_MODEL|'SOURCES'|'MERGING'|SuggestionSourceProgress|keiExpEnvelope|keiExpAccepted|kei_exp\.jobs|/api/runs/\$\{runId\}'|retryOfId|checkpoint\(" \
    prototypes packages scripts docker compose*.yaml tests .github .env.example --exclude-dir=node_modules --exclude-dir=.venv
  ```
  Expected: only the 422 request-body tests that post `retryOfId` as an unknown field (`api/extractions.test.ts`, `shared/extraction.contract.test.ts`). `docs/operations/*.md` and `docs/architecture/current.c4` still describe the old runtime; M6 rewrites them (Deferred table). Historical records under `docs/plans/`, `docs/validation/` and `openspec/changes/archive/` are not residue.

- [x] **Step 2: Run every tier**

  ```bash
  pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety
  # fresh disposable databases (Global Constraints), DATABASE_URL = EXTRACTION_TEST_DATABASE_URL, plus PARSING_TEST_DATABASE_URL:
  pnpm test:postgres
  pnpm test:e2e && pnpm --filter studio test:e2e:base-path
  pnpm test:service
  pnpm --filter studio build
  ```
  Then the production-bundle smoke (M0R 2 checked the mechanism on a probe host; this checks FREE's own bundle): with a disposable `free_test_m4_bundle` database migrated by `db:init`, a throwaway Entra key pair (`openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=free-bundle-smoke -keyout key.pem -out cert.pem`, its SHA-1 thumbprint) and dummy tenant and client IDs, start `node prototypes/studio/dist/server/index.js` with the production environment `server/config.ts` requires; wait for `FREE Studio listening`; with a `DBOSClient` (`applicationName: 'studio'`) enqueue `runExtraction` on `studio` for a random UUID; the workflow reaches `SUCCESS` (its `loadAdmitted` finds no row); stop with SIGTERM. Record the commands and output. Expected: every tier passes; a tier this host cannot run is recorded with the reason.

- [x] **Step 3: Record**

  Write the verification record (tested commit, commands, results, skips, the pool counts seen in the bundle smoke — `SELECT count(*) FROM pg_stat_activity WHERE datname = …` while idle and during one admission — as input for M6's pool measurement, and a pointer to the traceability table below). In the DBOS plan, mark the existing M4 heading done and link this task plan. Set this plan's status to `done YYYY-MM-DD`.
  ```bash
  git add docs/validation/<file> docs/plans/2026-09-24-unified-durable-execution.md docs/plans/2026-09-26-dbos-m4-studio-background.md
  git commit -m "docs(plans): record DBOS M4 completion"
  ```

---

## Traceability: M4 acceptance → tests

| Spec M4 acceptance (sub-bullet) | Test (file › name) | Task |
|---|---|---|
| A1 Kill after domain publication but before checkpoint: Extraction writes stay idempotent | `api/extraction_workflow.postgres.test.ts` › `an Extraction published before a kill is not published again after recovery` | 6 |
| A1 … ingestion | `api/source_ingestion.postgres.test.ts` › `an ingestion published before a kill is published once` | 10 |
| A1 … reprocess | `api/source_reprocess.postgres.test.ts` › `a reprocess published before a kill appends one revision` | 11 |
| A1 … batch draft | `api/batch_suggestion_workflow.postgres.test.ts` › `a draft published before a kill is published once` | 9 |
| A2 Cancel racing completion has one winner | `extraction-module.integration.test.ts` › `cancel racing completion has one winner` | 6 |
| A2 A confirmed failure uses a new operation ID/attempt | `extraction-module.integration.test.ts` › `a replay of a failed Extraction returns its failure, even after its workflow history was deleted, and enqueues nothing`; `batch-schema-suggestion.postgres.check.ts` › `retry advances the attempt once; …`; `sourceIngestionMachine.test.ts` › `a reprocess retry re-sends its request key after an uncertain failure and mints a new one after a confirmed failure` | 6, 9, 10 |
| A2 A row-backed replay after history GC never reruns | `extraction-module.integration.test.ts` › same replay test; `api/source_reprocess.postgres.test.ts` › `a repeated request key replays the original attempt … after its history is deleted` | 6, 11 |
| A3 A lost response/restart and a re-upload join active project/content work; a 504 preserves work | `api/source_ingestion.postgres.test.ts` › `a re-upload after a lost response joins the active attempt and returns its document; a 504 preserves the work`; `api/source_documents.test.ts` › `a 504 detaches without cancelling the workflow` | 10 |
| A3 Completed-content replay happens before parsing | `api/source_ingestion.postgres.test.ts` › `completed content replays before parsing: no staged file and no workflow`; `api/source_documents.test.ts` › `replays completed content before parsing: no staged file, no workflow` | 10 |
| A4 Simultaneous same-project/same-content uploads use one active workflow | `api/source_ingestion.postgres.test.ts` › `simultaneous same-content uploads in one project run one workflow, and the loser's staged file is removed` | 10 |
| A4 Identical PDFs in different projects have independent staging files | `api/source_ingestion.postgres.test.ts` › `identical PDFs in two projects stage independent files and run independently`; `api/_source_inbox.test.ts` › `identical bytes in two projects stage two independent files` | 4, 10 |
| A5 Completion between precheck/enqueue is replayed by the workflow's content check | `api/source_ingestion.postgres.test.ts` › `content completed after the precheck is replayed by the workflow's first step`; `api/_ingestion_workflow.test.ts` › `completed content returns the existing document without converting, …` | 10 |
| A5 Failed/cancelled attempts can be retried without client keys | `api/source_ingestion.postgres.test.ts` › `a failed attempt releases deduplication and a re-upload starts a new attempt without any client key`; `api/source_documents.test.ts` › `refuses a form that still sends an ingestionKey` | 10 |
| A6 Manual suggestion retry reruns all surviving pins | `api/batch_suggestion_workflow.postgres.test.ts` › `a manual retry regenerates every surviving pin`; `batch-schema-suggestion.postgres.check.ts` › `retry advances the attempt once; …` (enqueues over all surviving pins) | 9 |
| A6 Crash recovery of the same attempt skips checkpointed sources | `api/batch_suggestion_workflow.postgres.test.ts` › `crash recovery of one attempt skips the sources it checkpointed` | 9 |
| A6 No per-source progress rows | `batch-schema-suggestion.postgres.check.ts` › `the membership table holds pins only`; `BatchExtractionsPanel.test.tsx` › `shows the retained proposal and no per-source progress` | 9 |
| A6 Repeating a retry POST with the same expected attempt returns its one successor, even if it finished | `batch-schema-suggestion.postgres.check.ts` › `retry advances the attempt once; a repeat with the same expected attempt returns that successor even after it finished; an older expected attempt conflicts`; `api/batch_schema_suggestions.test.ts` › `retry carries expectedAttempt: …` | 9 |
| A7 Delete a source before, during and after suggestion publication: no FK error, preserved draft stays valid | `source-deletion.postgres.check.ts` › `deleting a source a suggestion pins raises no FK error before, during or after the suggestion's publication, and keeps its draft valid` | 12 |
| A7 Surviving extraction results/reviews stay pinned | `source-deletion.postgres.check.ts` › `surviving batch members' results and reviews stay pinned` | 12 |
| A7 Late success/failure cannot overwrite an interrupted attempt | `source-deletion.postgres.check.ts` › `deleting a source interrupts the active attempt without touching its proposal, draft or draft version`, `a late success or failure of the interrupted attempt changes nothing`; `batch-schema-suggestion.postgres.check.ts` › `publication and failure write only the current attempt while it has no outcome` | 9, 12 |
| A7 Empty selection retains the draft and disables Run/Retry | `source-deletion.postgres.check.ts` › `deleting the last pinned source keeps the draft; Run and retry refuse the empty selection`; `BatchExtractionsPanel.test.tsx` › `an empty selection keeps the draft and disables Run and Try again` | 9, 12 |
| A8 Pending Extractions count as batch members but do not replace a previously reviewed result | `extraction-module.integration.test.ts` › `pending Extractions count as batch members but do not displace the latest reviewed result on reopen` | 6 |
| A8 A batch rerun creates new identities | `extraction-module.integration.test.ts` › `a batch rerun creates new Extraction identities` | 6 |
| A9 An ingestion recovered after its owner changed the Ingestion Model Choice runs its admitted models | `api/source_ingestion.postgres.test.ts` › `an ingestion recovered after its owner changed the Ingestion Model Choice converts with the models it was admitted with` | 10 |
| A9 A re-upload of completed content returns the existing parse | `api/source_ingestion.postgres.test.ts` › `completed content replays before parsing: …` | 10 |
| A9 A reprocess uses the new choice | `api/source_reprocess.postgres.test.ts` › `a reprocess converts on the lane of its revision's stored page count with the owner's current Ingestion Model Choice`; `real-service.spec.ts` › `a reprocess of a small revision converts on kei-convert-small with the owner's Ingestion Model Choice` | 11, 13 |
| A10 Two same-content uploads under different choices join one attempt with its first admitted models | `api/source_ingestion.postgres.test.ts` › `two same-content uploads under different choices join one attempt with the first admitted models` | 10 |
| A10 A repeated reprocess POST after the choice changed replays the original attempt, after publication and after retention | `api/source_reprocess.postgres.test.ts` › `a repeated request key replays the original attempt after the choice changed: while it runs, after publication and after its history is deleted` | 11 |
| A11 A small document uploaded, or extracted, while a large conversion runs completes without waiting for it | `real-service.spec.ts` › `a small PDF uploaded and extracted while a large conversion runs finishes first`; `kei-handoff.postgres.test.ts` › `a cancelled child's lane stays occupied until its step returns` (lane independence at the contract) | 3, 13 |
| A11 A recovered or replayed ingestion keeps its admitted lane | `api/_ingestion_workflow.test.ts` › `a recovered or replayed ingestion keeps its admitted lane`; `api/source_ingestion.postgres.test.ts` › `an ingestion recovered after …` (one kei child, admitted input) | 10 |
| A11 A reprocess picks the lane from the revision's page count | `api/source_reprocess.postgres.test.ts` › `a reprocess converts on the lane of its revision's stored page count …`; `real-service.spec.ts` › `a reprocess of a small revision converts on kei-convert-small …` | 11, 13 |
| A12 A PDF that pdf.js cannot open but PDFium can converts on `kei-convert-large` | `real-service.spec.ts` › `a PDF only PDFium opens converts on kei-convert-large` (fixture probe; see Task 13); `api/source_ingestion.postgres.test.ts` › `a small PDF converts on kei-convert-small; a large or uncounted one on kei-convert-large`; `api/_pdf_pages.test.ts` › `answers null, never an exception, for bytes pdf.js cannot open` | 4, 10, 13 |
| A12 One neither can open fails in kei as today | `real-service.spec.ts` › `a PDF neither pdf.js nor PDFium can open is refused by kei and stored nowhere` | 13 |
| A12 `runExtraction` records `keiRunId` | `extraction-module.integration.test.ts` › `runExtraction records keiRunId from the pinned revision`; `workflows.test.ts` › `submits an interactive Extraction … attributes … include keiRunId` | 5, 6 |

Spec *Verification* items that M4 owns: native PDF Evidence parity (`real-service.spec.ts` existing tests, 13); Studio and kei kill/restart with no duplicate kei work (`… a kei worker killed mid-conversion …`, 13; `a Studio restart with an Extraction in flight resumes polling the same kei child`, 6; `a workflow killed mid-step recovers …`, 1); priorities and deadlines (`interactive and batch extractions reach kei at priority 1 and 10 …`, 13; `kei-handoff.test.ts` deadline cases, 3); lanes (13); cancelling a blocked native step (`cancelling an extraction cancels its kei workflow`, 13; `a cancelled child's lane stays occupied …`, 3); atomic admission and rollback (`pool-client-transaction.postgres.check.ts`, 2; `admits an Extraction row and its runExtraction workflow in one transaction`, `a failure after the enqueue rolls back both …`, 6); derived status (2, 6, 9).

Other M4 items and where they are built: `server/dbos.ts` configuration, one launch per process in `host.ts` and `developmentHost.ts`, the admission and kei clients, the `studio`/`suggest` queues, the database-clock boot timestamp (1); the development host drops its runtime reload (1, 6); the pool-client binding in `packages/db/src/prisma/db.ts` (2); status derivation (2); `packages/extraction` `kei-handoff.ts` (3) and `workflows.ts` (5, 6); admission inserts Extraction rows and enqueues in one transaction, keeping ownership, immutable-input replay and PR #140 (6); completion updates the admitted row; batch reads derive membership from rows; job/member DTOs removed (6, 7); `job-worker.ts`, claim/renew/checkpoint, the wake wiring, lease and status-mirror columns deleted (6, 9); `_extraction_runtime.ts` deleted and its exports rehomed for `extraction_models.ts`, `ingestion_models.ts`, `document_reopen.ts`, `batch_schema_suggestions.ts`, `extractions.ts`, `batch_extractions.ts` (6); `suggestSchemaBatch`, atomic input snapshot, whole-batch retry; pump, `kick()`, lease methods and per-source state and UI deleted (8, 9); preserved drafts with conditional attempt publication (9, 12); project/content replay, queue dedup, project/attempt staging; ingestion-key requests, DTOs, browser minting and follower machinery deleted (4, 10); reprocess request keys and expected-head checks kept (11); verify/translate/package shared, HTTP kei polling deleted (10, 11); the owner's Ingestion Model Choice frozen into the workflow input and passed to `convert` (10, 11); `KEI_EXP_MODEL` and `DEFAULT_MODEL` deleted (10); pages counted and the lane fixed at admission (4, 10, 11); public contracts revised with callers (7, 9, 10); Extraction cancel reaches kei (6); the M0R consequences — explicit workflow names (1, 5, 8, 10, 11), Studio declares DBOS and keeps it external (1), the second-launch guard (1), `minPollingIntervalMs: 100` (1), `applicationName` on both clients (1).

## Deferred to M5 and M6

| Item | Goes to | Why |
|---|---|---|
| `collectGarbage` (10-minute schedule) and its registration in `server/dbos.ts`; kei `deleteRuns` calls; staged-file, package and history retention; the Studio boot boundary for cancelled history | M6 | spec *Milestones → M6*; M4 only records `bootTimestampMs`, `keiRunId` and GC-mappable staging names |
| Scheduled repair of a missed cancellation (live work whose row is settled, live kei children of terminal parents) | M6 | Plan decision 15/16: M4's post-commit cancels are best effort |
| Pool-count measurement across Studio's domain pool, DBOS, the two clients and the kei worker | M6 verification | Task 14 records the bundle smoke's counts as input |
| `@dbos-inc/vercel-ai`, `chatTurn`, `suggestSchema`, `proposeSchemaEdit`, `ChatTurn`, `/api/model-operations`, the browser's automatic POST repetition on network errors | M5 | spec *Milestones → M5* (the reprocess retry-key rule of decision 14 is M4's because it changes the reprocess contract) |
| Test wiring left in M6: `.github/workflows/verify.yml` / `scripts/test-ci.mjs` migrate guarded test schemas; `packages/db/package.json` running `source-reprocessing.postgres.check.ts` (already in `test:postgres`) | M6 | M4's Studio PostgreSQL tier reuses CI's migrated extraction database, so CI needs no change |
| README, CONTEXT.md, ADRs 0012/0013, `docs/operations/*.md` (`FREE_SOURCE_INBOX`, the `source-inbox` volume in the backup set, `kei-jobs`), `docs/architecture/current.c4`, OpenSpec specs | M6 | spec *Milestones → M6* |
| The ~2000-page Spark run that may revise `conversionTimeoutMs` | Spark, separate (M0R 6) | the formula is provisional; the fixture pins today's constants |
