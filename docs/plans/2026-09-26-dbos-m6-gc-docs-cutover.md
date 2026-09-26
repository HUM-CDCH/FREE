# DBOS M6: Garbage Collection, Documentation, Test Wiring and the Spark Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 15 and 16 are **CONTROLLER-RUN**: never dispatch them to an implementer subagent.

Status: **not started (plan written 2026-09-26 against `feat/dbos-m2-m6` at f539911: M4 Tasks 1–4 committed, M4 Task 5 in the working tree, M4 Tasks 6–14 and all of M5 still to run; assumes the M4 and M5 plans are complete — both Task 14s recorded — before Task 1 starts; revised 2026-09-26 for the user's decision 15, which deletes the document chat in M5 (Ruling 3), and for the user's answers on the cutover (Ruling 7)).**

**Goal:** Deliver milestone M6 of the DBOS plan on `feat/dbos-m2-m6`: a `collectGarbage` workflow on a ten-minute schedule removes unreferenced canonical packages, staged sources, kei runs and both workflow histories under reference, retention and quiescence rules, and repairs missed cancellations; the M3 worker minors are fixed; `test:system` and CI wiring are brought up to date; every product, decision, operations, architecture and OpenSpec document describes the DBOS runtime; then the controller cuts the DGX Spark over (clean slate) and runs the end-to-end smoke test there, recording the evidence.

**Architecture:** `collectGarbage(scheduledTime)` is a named Studio workflow registered by `registerStudioWorkflows()` and scheduled by `applyStudioSchedules()` after launch on its own queue `gc` (global 1, no backfill). It reads the database clock once, then runs five named steps, each of which reads everything it needs before it deletes or cancels anything: **repair** (cancel live Studio workflows whose domain row is settled or whose scope is gone, and live kei children of stopped parents), **Studio history** (24 h interactive, 30 d background, deleted scopes at any age, cancelled history only when it was updated before this Studio process booted), **kei** (one portable `deleteRuns` enqueue per sweep on `kei-gc` naming the *conversions* whose runs nothing references and the kei history that may go; kei rechecks its own workflows against its own boot timestamp), **staged sources** and **packages** (24 h, rename-and-recheck). The decisions are pure functions in `api/_garbage_plan.ts`; the reads and deletions are ports in `api/_garbage_workflow.ts`; domain reads are one `packages/db` module. kei's `deleteRuns` changes contract so Studio never needs kei's private run-ID rule: Studio names a conversion, kei deletes that conversion's run and then its history.

**Tech Stack:** Studio (TypeScript, Vitest 4, Playwright, Hono), `@dbos-inc/dbos-sdk` 5.1.10, `packages/db` (Prisma Next 0.16, `pg`, `tsx --test`), `packages/extraction` (`tsx --test`), kei (`kei_exp.workflows`, Python 3.13, `dbos` 3.1.0, pytest), Docker Compose, LikeC4 (`pnpm architecture:check`), the DGX Spark (`baratheon`, aarch64 GB10) over SSH.

**Spec:** [docs/plans/2026-09-24-unified-durable-execution.md](2026-09-24-unified-durable-execution.md). Read *Decisions* (2, 3, 5, 6, 7, 13, 15 — the document chat is deleted, Ruling 3), *Rules*, *Target architecture*, *Workflows* (the `collectGarbage` and kei `deleteRuns` rows, *Status and ownership*), *Cancellation* (*Propagation is retried*, *kei's cooperative checks*), **Deletion and garbage collection (all)**, *Queues, deadlines and upgrades* (the `kei-gc` row, *Ownership*, *Versions*, *Pools*), *kei worker* (*Startup*), *Model configuration and keys* (*Decision records*, *Trust*, *XSS*), **Cutover (clean slate)**, **Milestones → M6 (all)**, *Verification*, *Risks*. Also read the M4 plan ([2026-09-26-dbos-m4-studio-background.md](2026-09-26-dbos-m4-studio-background.md): Rulings 1, 11, 12; Plan decisions 11, 15, 16, 17; Task 12; *Deferred to M5 and M6*), the M5 plan ([2026-09-26-dbos-m5-interactive.md](2026-09-26-dbos-m5-interactive.md): *Deferred to M6 and later*), the M3 plan's *Deferred to M4 and later* and kei's `workflows/gc.py`, `boot.py` and `tests/test_delete_runs.py`.

## Rulings (controller, 2026-09-26)

1. **Ruling: M6 keeps `collectGarbage` (ten-minute schedule), kei `deleteRuns` driving, boot-boundary history deletion for both schemas, cancellation repair, staged-upload cleanup and package cleanup.** M4 Task 12 already writes the interruption of affected suggestion attempts inside the deletion transaction and cancels the deleted scope's work after commit (best effort); M6 does not redo it. — *Why:* spec *Milestones → M6 → Garbage collection*; M4 plan decision 16.
2. **Ruling: the deferred documentation items routed to M6 are collected into the documentation tasks (10–13), each verified against the code before it is written.** The list: the Studio README's model-configuration section; `local-development.md`'s "syncs live"; `deployment.md`'s `FREE_KEI_POSTGRES_PASSWORD`, `FREE_DEPLOYMENT_CLI_PROVIDERS`, `source-inbox`, the obsolete `model-config.json` paragraph, `pnpm dev` needing PostgreSQL at startup, the development `postgres-data` volume recreation after a baseline edit and Studio's `CREATE` privilege for the `dbos` schema; the four OpenSpec specs; Compose comments naming `model-config.json` or the reset; the spec's M2 section still listing items that moved to M3–M5; kei's `docs/job-backend.md` and the Procrastinate plan superseded; the `OLLAMA_API_KEY` note; the document-chat mentions M5 leaves behind (Ruling 3).
3. **Ruling (user decision 15, 2026-09-26): the document chat is deleted, so M6 has no chat item.** M5 Task 1 deletes `/api/chat`, `streamChatWithModel` and `ChatTab.tsx`; there is no `chatTurn` workflow, no `ChatTurn` table, no chat route and no `@dbos-inc/vercel-ai`. The schema tab's durable interactive work is schema generation (`suggestSchema`, workflow ID prefix `suggestion:`) and edit proposals (`proposeSchemaEdit`, prefix `edit:`), both rowless and scoped only by their attributes. Hence: garbage collection knows two interactive prefixes and no chat row (Tasks 3, 5); the documentation tasks remove the document-chat mentions M5 leaves in `CONTEXT.md` (~:149), ADR 0007 (:9) and the `capability-route-resolution` OpenSpec spec, write no chat into any new text, and annotate the DBOS spec's remaining chat sections with a pointer to decision 15 (Tasks 10, 11, 13); the Spark smoke replaces its chat turn with an edit proposal across a reload and a Studio kill (Task 16 S7). This supersedes the first version's Ruling 3 (the Chat tab as developer-UI only). — *Cost if wrong:* the chat is rebuilt later from the spec's *Chat* sections, which stay (annotated), with its GC prefix and row check added back.
4. **Ruling: the operations runbook states that the lock file moved from `.slot-<n>.lock` to `.worker-<n>.lock`**, so the old `kei-jobs` process must be stopped before the new worker starts; that the fail-open cancel-check warning is logged once per step; the backup set (a `free` dump, `source-inbox`, `parsing-runs`, `studio-data`, the CLI homes; no researcher key in any backup); DBOS inspection of both schemas; and the patch and version rules.
5. **Ruling: residual M3 review minors are fixed here (Task 2):** `cli.py`'s `except Exception` becomes `BaseException` on a launch failure; DBOS's own "failed to launch" log is redacted like the worker's own message; cancellation is checked between the grounding batches inside `verify`.
6. **Ruling: the cutover and the Spark end-to-end test are CONTROLLER-RUN (Tasks 15–16), and every push and every destructive or disruptive step needs the user's explicit yes at that moment**, in this session, even under the standing goal. vLLM model containers are never restarted.
7. **Ruling (user, 2026-09-26): the cutover questions are answered.** (a) The controller pushes `feat/dbos-m2-m6` to `origin` and the **user** fetches it on the Spark (the Spark's key has a passphrase); no pull request is opened, so no GitHub `verify` run precedes the cutover. (b) `FREE_DEPLOYMENT_CLI_PROVIDERS` stays empty on the Spark: no CLI deployment connection is offered. (c) There is no second Entra account: S8's two-account check is covered by the local tests (M2's and M5's two-account and ownership tests) and recorded as not run on the Spark. (d) The Playwright MCP browser is already signed in to the Spark; the controller drives it and collects the server-side evidence over SSH. (e) The OCR check is the default OCR model `surya` with the non-default layout `layout_egret_xlarge`, and the run's recipe must name both (Task 16 S1, S9). Ruling 6 still applies: the push and every destructive step wait for the user's yes at that moment.

## Code facts this plan relies on (verified at f539911 and the M4/M5 plan interfaces)

- **DBOS 5.1.10** (read from `node_modules/.pnpm/@dbos-inc+dbos-sdk@5.1.10/.../dist/src`):
  - `DBOS.applySchedules([{ scheduleName, workflowFn, schedule, context?, automaticBackfill?, cronTimezone?, queueName? }])` after launch, idempotent (`dbos.d.ts:731-739`). A scheduled run's workflow ID is `sched-<scheduleName>-<ISO time>`, a triggered one `sched-<scheduleName>-trigger-<ISO time>`; it is enqueued on the schedule's `queueName` (else DBOS's internal queue) for the owner's latest application version with `scheduleName` recorded (`scheduler/scheduler.js:185,206-235,246`). `DBOSClient.triggerSchedule(name)` returns a handle (`client.d.ts:316`).
  - `listWorkflows(input)` has **no default limit** (`system_database.js:3296-3301`) and filters on `workflowIDs`, `workflowName` (string or array), `status` (array), `workflow_id_prefix` (array), `attributes` (JSONB containment), `scheduleName`, `completedBefore`, `applicationName`; `WorkflowStatus` carries `updatedAt` and `completedAt` (`workflow.d.ts:60-89`). A client lists its own application's rows by default.
  - `cancelWorkflow` sets `updated_at` **and** `completed_at` to the database's `now()` for every row not `SUCCESS`/`ERROR`, including a row already `CANCELLED` (`system_database.js:1321-1328`): a repeated cancel moves a cancelled workflow's `updatedAt` past a later boot.
  - `DBOS.deleteWorkflows(ids, deleteChildren?)` and `DBOSClient.deleteWorkflows` exist (`dbos.d.ts:370`, `client.d.ts:216`). DBOS runs **no** automatic retention: `garbageCollect` is reachable only from Conductor (`workflow_management.js:130-155`), which FREE never configures, and `DBOSConfig` has no retention key.
  - The system schema's payload tables that carry `workflow_uuid` (`operation_outputs`, `workflow_input`, `workflow_output`, `streams`, `workflow_events`, `workflow_events_history`) have no foreign key to `workflow_status`.
- **dbos 3.1.0 (Python):** `dbos_logger = logging.getLogger("dbos")` (`_logger.py:10`); `DBOS.launch()` logs `dbos_logger.error("DBOS failed to launch:", exc_info=e)` before re-raising (`_dbos.py:787`), and `_sys_db.py:5469` logs `f"Error connecting to the DBOS system database: {e}"`. Both can quote the database URL; neither passes through `cli.redacted()`.
- **kei at f539911:**
  - `workflows/gc.py`: `DeleteRunsInput {runs: list[RunId], history: list[str]}` (`contracts.py:65-67`); the step reads every status first, deletes eligible runs (writers eligible, not being extracted, directory unchanged for 24 h), then deletes `history` entries whose own workflow is eligible — **independently of whether their run was deleted** (`gc.py:162`). `eligible()` treats `SUCCESS`/`ERROR` as done and `CANCELLED`/`MAX_RECOVERY_ATTEMPTS_EXCEEDED` as done only when `updated_at < boot.timestamp_ms()` (`gc.py:33-39`).
  - A conversion's run is `runs.run_id_for(workflow_id)` (`runs.py:46-49`), kei's private rule (M4 Ruling 1: Studio never computes it). `ConvertOk` carries `run_id`; a failure output carries none; a cancelled or exhausted conversion has no output at all. `prepare_run` publishes the run directory (with a copy of the source PDF) before `convert_run`, so failed and cancelled conversions leave runs.
  - `cli.py:55-65`: `except Exception` around `DBOS(...)`/`DBOS.launch()`/`register_queues()`/`until()`; a `KeyboardInterrupt` or `SystemExit` raised there skips `DBOS.destroy()` and the hard exit, and the `with slot.hold_slot(...)` block then frees the lock while DBOS threads may still run steps.
  - `kie/extract/run.py:158-165` calls `check()` once before each record's `verify(...)`; `stages.verify` (`stages.py:397-470`) may send several grounding batches per record with no check between them. `discover(..., before_call=check)` (`stages.py:154-160`) is the precedent. `workflows/cancel.py:53-59` logs the fail-open warning once per `CancelCheck`, i.e. once per step execution.
  - The lock file is `KEI_RUNS/.worker-<slot>.lock` (`workflows/slot.py:23-25`); the Procrastinate worker used `LOCK_DIR/.slot-<slot>.lock`, so the two never exclude each other.
  - `tests/test_delete_runs.py` covers `deleteRuns` with `runs`+`history` (including a simulated restart, `restart(kei)`), and `tests/test_worker_recovery.py`'s `site` fixture spawns real `kei-worker` processes whose gated native call waits for `control/release` (`tests/helpers/kei_worker.py`).
- **Studio at f539911 and the M4/M5 plans:** `server/dbos.ts` (`launchStudioDbos({ databaseUrl, register, schema?, keiSchema?, executorId? })` reads `bootTimestampMs` from the database clock, registers, launches, registers `studio` and `suggest`, creates the `admission` and `kei` clients; `studioDbos()`, `databaseClockMs(url)`); `server/workflows.ts` (`registerStudioWorkflows(): void`, `STUDIO_WORKFLOW_NAMES`); M4 Task 3 `extraction/kei-handoff` (`KEI_QUEUE.gc = 'kei-gc'`, `keiConvertWorkflowId(parent)`, `keiExtractWorkflowId(id)`, `keiConvertOkSchema`, `createKeiHandoff(client)` with `enqueuePortable`, kei children carry their parent's attributes); M4 Task 5 `keiRunOf(preprocessId)`, `extractionAttributes()` including `keiRunId`, `WorkflowSteps`, `dbosSteps`, `isWorkflowCancellation`; M4 Task 4 `api/_source_inbox.ts` (`sourceInboxRoot()`, `uploadSourcePath(p, a)` = `<p>/<a>.pdf`, `reprocessSourcePath(p, d, k)` = `<p>/reprocess-<d>-<k>.pdf`, temporaries `<target>.<uuid>.tmp`, `removeStagedSource`); M4 Task 12 `cancelScopeWork`; the kei stand-in (`packages/extraction/src/testing/kei-stand-in.ts`) registers only `convert` and `extract`; the Studio PostgreSQL tier and crash harness (`test/support/postgres.ts`, `crash.ts`, `workflowChild.ts`, `scenarios/`); M5's rowless `suggestSchema` (`suggestion:<operationId>`, attributes `{ projectContextId, sourceDocumentId, sourceRepresentationRevisionId, extractionSchemaId: string | null }`) and `proposeSchemaEdit` (`edit:<operationId>`, attributes `{ projectContextId, extractionSchemaId, sourceDocumentId?, sourceRepresentationRevisionId? }`), and no new table (decision 15); M4's `Extraction.outcome` (nullable) and `BatchSchemaSuggestion.attempt`/`outcome`.
- **Packages:** `packages/db/src/artifact-store.ts` publishes `<sha256>.zip` under `<studio data>/source-representations` via `<sha>.<uuid>.tmp` + `link`, reuses an existing valid package without touching it (`save`, 238-265), and removes by quarantine rename to `<sha>.<uuid>.deleting`, recheck, then unlink or restore (`remove`, 267-300). Deletion handlers call `discardPackagesIfUnreferenced` after commit (`project-store.ts:816-826`).
- **Tests and CI:** `.github/workflows/verify.yml` and `scripts/test-ci.mjs` migrate `free_test_project_store` and `free_test_extraction` (= `DATABASE_URL`) and run `test:all:node`, whose `test:postgres:node` already includes `pnpm --filter studio test:postgres` (M4 Task 1); `packages/db`'s `test:postgres` already runs `source-reprocessing.postgres.check.ts` (`packages/db/package.json:14`); `pnpm test:e2e` uses the TypeScript kei stand-in and `pnpm test:service` the real `kei-worker` (M4 Ruling 12, Task 13). `tests/contract.test.mjs` (`pnpm test:system`): `helpers.mjs:59` and `contract.test.mjs:216-217` run `docker compose up`/`down` without `--profile mock-oidc`, so a stack it starts has no identity provider; `contract.test.mjs:170` expects a synchronous `outcome: 'SUCCEEDED'` from `POST /api/extractions`; the development overlay publishes `db` on `127.0.0.1:5432`, the same port as the disposable `free-m1-pg` container.
- **Documents (stale lines verified):** `README.md:49-53` (#5, "schema and prompt revisions"), `:58-76` (#7, deployment-wide configuration and the reset), `:77-80` (#8), `:85-90` (#10, "OS credential store"), `:159-162` ("sync live"), `:204-221` (Extraction execution, "no remote cancellation"); `CONTEXT.md:132-157` (deployment-wide Model Connection, Capability Route and Extraction Model Choice; no Ingestion Model Choice; Model Attribution); `docs/adr/0006`, `0007`, `0011` (`model-config.json`, keyring, reset); `docs/operations/deployment.md:31-35, 61-107, 237-272, 294-331, 341-359`; `docs/operations/local-development.md:3-13, 36-81, 124-137, 162-172`; `docs/architecture/current.c4` (Procrastinate, parsing job database, `batch_worker`, `model_config` with the keyring) and its `README.md`; `prototypes/studio/README.md:45-69` (`model-config.json`, the credential store, Single model mode, "container keyring") and `:88-90`; `prototypes/parsing_service/docs/job-backend.md` (no superseded header); `docs/plans/2026-09-24-procrastinate-source-ingestion.md` **already** carries its superseded header; no Compose file names `model-config.json` or the reset (`grep` at f539911 printed nothing).
- **The Spark (controller's record):** `geba@baratheon.cdch-dgxspark.lan.ku.dk`, aarch64 GB10, checkout `~/Projects/FREE` on `feat/kei-exp-parser`, deployed with `node scripts/free.mjs production` and `FREE_NGINX=container` at `https://baratheon.cdch-dgxspark.lan.ku.dk:11434/free` with real Entra; secrets in `~/free-secrets`; generated secrets in `.env` (never print it); non-interactive SSH lacks `~/.local/bin` and nvm's Node 24 on `PATH`; the key on the Spark has a passphrase, so the user fetches there (Ruling 7), e.g. over an agent-forwarded session (`ssh -A`) with `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15" git fetch origin <branch>` then `git merge --ff-only`; a redeploy recreates only services whose config hash changed, and Studio restarts whenever a parsing service is recreated; the temporary TLS certificate is self-signed.

## Global Constraints

- **Worktree and branch:** `/home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6` on `feat/dbos-m2-m6`. Other agents write under `docs/plans/2026-09-24-unified-durable-execution-evidence/m0r*/`: never touch, stage or commit anything there. Stage explicit paths, never `git add -A .` at the root.
- **Preconditions (Task 1 checks them and stops if any fails):** `grep -c "M5: interactive work on DBOS — done" docs/plans/2026-09-24-unified-durable-execution.md` prints 1; `grep -niE "suggest_?schema|propose_?schema_?edit|run_?extraction|ingest_?source|reprocess_?source" prototypes/studio/server/workflows.ts` lists M4's and M5's names; `ls prototypes/studio/api/chat.ts prototypes/studio/src/ChatTab.tsx` fails and `grep -rnE "ChatTurn|chatTurn|streamChatWithModel" prototypes/studio packages/db/src --exclude-dir=node_modules` prints nothing (M5 Task 1 deleted the chat; decision 15); `grep -n "export function cancelScopeWork" prototypes/studio/api/_scope_cancellation.ts` finds it; `grep -n "keiRunId" packages/extraction/src/workflows.ts` finds it; `ls prototypes/studio/e2e/realService.ts prototypes/studio/playwright.recovery.config.ts packages/extraction/src/testing/kei-stand-in-client.ts` succeeds.
- **Pins:** unchanged (`@dbos-inc/dbos-sdk` 5.1.10, `dbos` 3.1.0). M6 adds no dependency; `@dbos-inc/vercel-ai` is not installed (decision 15, M5 Ruling 2).
- **Names (fixed):** workflow `collectGarbage` (registered only by `registerStudioWorkflows()`, explicit `name`); schedule `collectGarbage`, cron `*/10 * * * *`, `automaticBackfill: false`, queue `gc` (`globalConcurrency: 1`); kei `deleteRuns` enqueued portably by Studio's kei client as application `kei` on `kei-gc` under `kei-gc:<scheduledTime ISO>`; the operator command `pnpm --filter studio gc:now`.
- **Policy (fixed, `GC_POLICY`):** interactive history (`suggestion:`, `edit:`) 24 h after completion; background history (`extract:`, `suggest:`, `ingest:`, `reprocess:`, `kei-extract:`) 30 days; the sweeps' own history (`sched-collectGarbage-*`, `kei-gc:*`) 24 h; packages, staged sources and their leftovers 24 h after their last modification; at most 1000 Studio histories deleted per sweep. Deleted scopes bypass age, never quiescence. No production setting shortens any of these; tests backdate file times (`utimes`) and, in disposable test schemas only, `completed_at`.
- **Rules the spec forbids breaking:** no new table, trigger, tombstone, cleanup-intent row, deletion barrier or status reconciler (spec *Rules*, *M6*). A failed status or reference read deletes nothing. A repeated cancel targets live statuses only. Studio never computes a kei run ID and never reads kei's run directory; kei never reads Studio's schemas.
- **Never print secrets.** No test, script or runbook step prints a database URL with its password, `FREE_KEI_POSTGRES_PASSWORD`, `.env`, a planted key, a session cookie or an Entra credential. Logs from GC name error classes, never messages.
- **Deletions:** implementer subagents may not run `git rm` without the user's authorization. Run plain `rm`, then `git add -A <those exact paths>`.
- **Python:** the worktree's `prototypes/parsing_service/.venv` predates M3 (it holds Procrastinate, not `dbos`). Run kei's tests exactly as the M3 record did: `cd prototypes/parsing_service && UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest …`. For `pnpm test:service`, use the parsing environment the M4 Task 13 and M5 Task 14 records used (they name it); if that is unclear, ask the controller. Never `pip`, never `uv sync`.
- **Test tiers (exact commands):**
  - Studio: `pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test`; one file: `pnpm --filter studio exec vitest run <path>`.
  - Studio PostgreSQL: `pnpm --filter studio test:postgres` with `DATABASE_URL` and `EXTRACTION_TEST_DATABASE_URL` exported and equal; one file: `pnpm --filter studio exec vitest run --config vitest.postgres.config.ts <path>`.
  - db: `pnpm --filter db typecheck && pnpm --filter db test`; `pnpm --filter db test:postgres` with `PROJECT_STORE_POSTGRES_URL` exported (fresh databases).
  - extraction: `pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres` (`EXTRACTION_TEST_DATABASE_URL`).
  - kei: fast `UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest -q -m "not postgres and not live_model"`; PostgreSQL (incl. `slow`) `PARSING_TEST_DATABASE_URL=… UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest -q -m "postgres and not live_model"`; one file with `-q tests/<file>.py`.
  - E2E: `pnpm --filter studio test:e2e` (both configs), base path `pnpm --filter studio test:e2e:base-path`; real service `pnpm test:service`.
  - Safety, scripts and architecture: `pnpm test:safety`, `node --test scripts/free.test.mjs scripts/test-ci.test.mjs`, `pnpm architecture:check`.
  - Whole repository: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety && pnpm test:postgres && pnpm test:e2e && pnpm test:service`.
- **Disposable databases only** (README #10): user `postgres`, loopback, explicit port 5432, databases `free_test_*`; the guards refuse anything else. Reuse the M1–M5 container; never stop it or any other service:
  ```bash
  docker ps --filter name=free-m1-pg --format '{{.Names}}'   # prints free-m1-pg when it is running
  # Only if it is not running and port 5432 is free (never stop another service to free it):
  docker run --rm -d --name free-m1-pg --mount type=tmpfs,destination=/var/lib/postgresql/data \
    -p 127.0.0.1:5432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=m1-disposable-only \
    -e POSTGRES_DB=free_test_parsing postgres:17
  for name in free_test_m6_store free_test_m6_extraction free_test_m6_parsing; do
    docker exec free-m1-pg dropdb -U postgres --if-exists --force "$name"
    docker exec free-m1-pg createdb -U postgres "$name"
  done
  export PROJECT_STORE_POSTGRES_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_m6_store
  export EXTRACTION_TEST_DATABASE_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_m6_extraction
  export PARSING_TEST_DATABASE_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_m6_parsing
  export DATABASE_URL=$EXTRACTION_TEST_DATABASE_URL
  DATABASE_URL=$PROJECT_STORE_POSTGRES_URL pnpm --filter db db:init
  pnpm --filter db db:init
  ```
  If `free-m1-pg` was started with another password, ask the controller rather than restarting it. `project-store.postgres.check.ts` requires an empty database: recreate before each `pnpm --filter db test:postgres`. DBOS-backed tests create and drop their own schemas (`dbos_t_<hex>`, `kei_dbos_t_<hex>`).
- **Commits:** one per task, conventional prefix, message ending with the session's attribution line. Never `git stash`, `reset` or `commit --amend` another task's work. M6 does not edit the baseline migration.

## Test tiers at the M6 seam

| Tier | Tasks 1–2 | Tasks 3–5 | Task 6 on | Task 8 on | Tasks 10–13 |
|---|---|---|---|---|---|
| Studio, db, extraction unit; typecheck; lint | green | green | green | green | green |
| kei fast and PostgreSQL | green (contract changed in Task 1) | green | green | green (+ recovery test) | green |
| db, extraction, Studio PostgreSQL | green | green | green (+ GC tests) | green | green |
| `pnpm test:e2e` (both configs) | green | green | green (the stack now schedules GC) | green | green |
| `pnpm test:service` | green | green | green | green (+ `real-service-gc.spec.ts`) | green |
| `pnpm test:safety`, scripts, `pnpm architecture:check` | green | green | green | green | green (c4 rewritten in Task 12) |
| `pnpm test:system` | stale (Task 9) | stale | stale | stale | fixed from Task 9 |

From Task 6 on, every stack whose host applies the schedule — the default and base-path Playwright stacks and `test:service` — sweeps at each ten-minute boundary during a run. Repair touches only work whose domain row is settled or whose scope is gone, and every deletion needs 24 hours of age or a deleted scope, so a sweep should never disturb a test; if a flake ever points at a sweep, diagnose the test's assumption (a rowless workflow, a deleted scope it still reads) instead of disabling the schedule.

Deploy nothing before Task 14 is recorded; Task 15 is the only deployment.

## Plan decisions (not settled by the spec; settled here — the ones marked ★ need the controller's or the user's confirmation)

1. ★ **`deleteRuns` names conversions, not runs.** Its input becomes `{ conversions: [kei-convert:<parent> …], history: [kei-extract:<id> | kei-gc:<time> …] }`. For each conversion kei deletes the run that conversion wrote (its own `run_id_for`) under today's writer, age and boot-boundary checks, then deletes the conversion's history **only once its run is gone**; a `kei-convert:` ID under `history` is refused (`invalid_request`). *Why:* Studio can name a run only through a conversion's history (a `ConvertOk.run_id`), or not at all for a failed or cancelled conversion, and never computes kei's rule (M4 Ruling 1); today's `gc.py:162` can delete a conversion's history while its run stays, leaving a run nobody can name. *Consequence:* a conversion's kei history lives as long as its run, which outlives the spec's 30-day background target while a revision references the run; it holds IDs and a manifest summary, no research content. *Cost if wrong:* a leaked `input.pdf` copy (up to 100 MiB) per failed, cancelled or deleted conversion, forever.
2. ★ **The schedule runs on its own Studio queue `gc` (global 1) with `automaticBackfill: false`, and only a host applies it.** `launchStudioDbos` gains `schedule?: () => Promise<void>`; `server/host.ts` and `server/developmentHost.ts` pass `applyStudioSchedules`; every test process that launches Studio's DBOS without it never sweeps. *Why:* two sweeps must not overlap, a Studio down for a day must not fire 144 sweeps, and a sweep firing at a ten-minute boundary inside an M4/M5 test would cancel that test's rowless workflows.
3. **Cancelling a workflow that has already published is harmless** (the row's outcome wins, its history then waits for a restart like any cancelled history), so repair adds no grace period.
4. **The sweep's own history and kei's `kei-gc` history are kept 24 h**; they hold IDs only.
5. **A staged file goes when it is older than 24 h, its workflow is absent or terminal (any terminal status), and its `kei-convert:` child is absent or not live.** Unlinking a file a cancelled kei step still reads does not disturb that reader. A name that maps to no workflow is kept; a stale `.tmp` goes.
6. **A package reused by `save` is touched**, and `remove` restores a quarantined package whose modification time is at or after the sweep's cutoff. This closes the one gap in rename-and-recheck: an old unreferenced package that a new ingestion reuses between the sweep's age check and its own commit.
7. **Each sweep reads the database clock once** (a checkpointed step) and compares DBOS times with it; file times use the same value (Studio and PostgreSQL share a host clock).
8. ★ **Test wiring the spec lists but M4 already settled:** "the Playwright stack and `e2e/playwright.compose.yaml` start the kei worker" is superseded by M4 Ruling 12 (the default e2e uses the TypeScript stand-in because GitHub's job has no Python; `test:service` starts the real worker, M4 Task 13); `verify.yml` and `scripts/test-ci.mjs` need no change (they migrate both Studio targets, and the DBOS tiers create their own schemas); `packages/db` already runs `source-reprocessing.postgres.check.ts`. Task 9 pins these with tests instead of editing them.
9. ★ **`pnpm test:system` refuses to start a stack while another container publishes 5432** (it never stops one), and runs its Compose commands with `--profile mock-oidc`. Running it at all needs a free 5432 and a reachable Ollama model; Task 14 records it as skipped otherwise.
10. ★ **The four OpenSpec specs are edited in place** ("sync shipped specs", as 233b9a4 did), not through a new change; the change they would describe is already implemented.
11. **An operator command triggers a sweep now** (`pnpm --filter studio gc:now`, `server/collectGarbageNow.ts`), because the runbook, `test:system`, `test:service` and the Spark smoke all need one; it uses `DBOSClient.triggerSchedule` as application `studio`.

## Review Focus

1. **A conversion's history is deleted while its run stays** (a young run, a run whose extraction is still cancelling, a run a surviving revision references at 30 days). Expected: the run stays nameable until it is gone; its history goes with it or after it. Pinned by Task 1 `test_a_conversion_history_stays_while_its_run_stays` and `test_history_refuses_a_conversion_id`, and Task 5 `names kei-gc history after 24 h; never names a conversion under history`.
2. **A sweep re-cancels a `CANCELLED` workflow** and moves its `updatedAt` past the current boot, so its history and runs are never collected. Expected: `updatedAt` is unchanged by any number of sweeps. Pinned by Task 6 `a sweep never cancels a workflow twice: a cancelled workflow's updatedAt does not move`.
3. **A failed or partial read is treated as "absent"** (a thrown `listWorkflows`, a closed pool, a malformed attribute) and everything looks deletable. Expected: that phase deletes and cancels nothing; the others still run. Pinned by Task 6 `_garbage_workflow.test.ts` `reads every status and reference of a phase before it deletes or cancels anything`, `a failed phase is reported by name and the next phases still run`, and `garbage_collection.postgres.test.ts` `a failed reference read deletes nothing in its phase …` / `a failed status read deletes nothing …`; Task 3 `unknown or malformed IDs are absent, and a failed read rejects`.
4. **A cancelled-in-process Studio parent hands a run to kei after the sweep checked it** (late handoff), or an ingestion commits a revision onto a package the sweep is removing. Expected: the run and the package survive. Pinned by Task 7 `late handoff: …`, Task 5 `protects a run named by keiRunId …`, Task 4 `a package reused while it is being swept is restored`.
5. **Studio or kei history is deleted while a cancelled step can still checkpoint** (current-process cancellation; a blocked native step; `MAX_RECOVERY_ATTEMPTS_EXCEEDED`). Expected: kept until the process that ran it has restarted; afterwards no payload row is orphaned. Pinned by Task 7 `current-process cancelled history survives any age …`, Task 8 `a cancelled extraction blocked in its native step …` and `test_a_conversion_past_its_recovery_attempts_keeps_its_run_until_the_next_kei_restart`.

---

### Task 1: `deleteRuns` names conversions; Studio's handoff and the kei stand-in speak it

**Files:**
- Modify: `prototypes/parsing_service/src/kei_exp/workflows/contracts.py` (`DeleteRunsInput`), `prototypes/parsing_service/src/kei_exp/workflows/gc.py` (`delete_runs`), `prototypes/parsing_service/tests/test_delete_runs.py`, `prototypes/parsing_service/tests/test_contracts.py`, `prototypes/parsing_service/tests/fixtures/contracts/deleteRuns.input.json`, `deleteRuns.output.json`, `prototypes/parsing_service/README.md` (the `deleteRuns` sentence near line 137)
- Modify: `packages/extraction/src/kei-handoff.ts`, `packages/extraction/src/kei-handoff.test.ts`, `packages/extraction/src/kei-handoff.postgres.test.ts`, `packages/extraction/src/testing/kei-stand-in.ts`, `kei-stand-in-cli.ts`, `kei-stand-in-client.ts`

**Interfaces:**
- Consumes: kei's `gc.py`, `boot.py`, `runs.run_id_for`; M4 Task 3's `createKeiHandoff`, `KEI_QUEUE`, `KEI_APPLICATION`, `CONVERT_PREFIX`.
- Produces:
  ```python
  # contracts.py
  ConvertWorkflowId = Annotated[str, Field(pattern=r"^kei-convert:.+$")]
  class DeleteRunsInput(_Contract):
      conversions: list[ConvertWorkflowId]   # their runs go, then their history
      history: list[str]                     # other kei workflows; a kei-convert: ID is a ValidationError
  # DeleteRunsOk unchanged: {ok, deleted_runs, kept_runs, deleted_history, kept_history}
  ```
  ```ts
  // extraction/kei-handoff
  export const DELETE_RUNS = 'deleteRuns'
  export const GC_PREFIX = 'kei-gc:'
  export function keiGcWorkflowId(scheduledTime: Date): string                  // kei-gc:<ISO>
  export const keiDeleteRunsInputSchema, keiDeleteRunsOkSchema                  // zod, strict
  export type KeiDeleteRunsInput = { conversions: string[]; history: string[] }
  export type KeiDeleteRunsOk = { ok: true; deleted_runs: string[]; kept_runs: string[]; deleted_history: string[]; kept_history: string[] }
  // KeiHandoff gains:
  requestDeleteRuns(workflowId: string, request: KeiDeleteRunsInput): Promise<void>
  // extraction/kei-stand-in, kei-stand-in-client
  KeiStandInScript.deleteRuns?(request: KeiDeleteRunsInput, workflowId: string): Promise<KeiDeleteRunsOk>
  KeiStandInProcess.deleteRunsRequests(): Promise<readonly { workflowId: string; request: KeiDeleteRunsInput; receivedAtMs: number }[]>
  ```

- [ ] **Step 1: Check the preconditions** (Global Constraints). If any fails, stop and report to the controller.

- [ ] **Step 2: Write the failing kei tests** (`tests/test_delete_runs.py`)

  Change the helpers to the new contract and add the cases below. `delete(kei, conversions=(), history=())` enqueues `{"conversions": [...], "history": [...]}`; `age()`, `converted()`, `cancelled_conversion()`, `restart()` stay.
  ```python
  def delete(kei, conversions=(), history=()):
      return kei.output(enqueue_delete(kei, conversions, history))


  def enqueue_delete(kei, conversions=(), history=()):
      return kei.enqueue("deleteRuns", config.GC, f"kei-gc:test-{next(GC_IDS)}",
                         {"conversions": list(conversions), "history": list(history)})


  def test_a_conversion_names_its_run_and_both_go_together(kei, fake):
      workflow_id = converted(kei)
      run_id = kei.output(workflow_id)["run_id"]
      age(kei.runs / run_id)
      output = delete(kei, [workflow_id])
      assert output["deleted_runs"] == [run_id] and output["deleted_history"] == [workflow_id]
      assert not (kei.runs / run_id).exists() and DBOS.get_workflow_status(workflow_id) is None


  def test_a_conversion_history_stays_while_its_run_stays(kei, fake):
      """Studio finds a run only through its conversion's history, so the history must outlive the run."""
      workflow_id = converted(kei, "kei-convert:ingest:p:y")
      run_id = kei.output(workflow_id)["run_id"]           # young: kept by age
      output = delete(kei, [workflow_id])
      assert (output["kept_runs"], output["kept_history"]) == ([run_id], [workflow_id])
      assert DBOS.get_workflow_status(workflow_id) is not None


  def test_a_failed_conversion_leaves_a_run_that_its_conversion_names(kei, fake, monkeypatch):
      """convert_run failed after prepare_run published the run: Studio has no run ID, only the conversion."""
      from kei_exp.kie import runner
      monkeypatch.setattr(runner, "convert", lambda *a, **k: (_ for _ in ()).throw(ValueError("broken page")))
      workflow_id = converted(kei, "kei-convert:ingest:p:f")
      assert kei.output(workflow_id)["ok"] is False
      run_id = runs.run_id_for(workflow_id)
      assert (kei.runs / run_id).is_dir()
      age(kei.runs / run_id)
      output = delete(kei, [workflow_id])
      assert output["deleted_runs"] == [run_id] and output["deleted_history"] == [workflow_id]


  def test_a_conversion_whose_run_was_never_written_loses_only_its_history(kei, fake):
      sha = kei_helper.stage_pdf(kei.inbox, "u.pdf", b"%PDF-1.7\n" + b"\0" * 2048)  # unreadable: prepare fails
      workflow_id = "kei-convert:ingest:p:u"
      kei.enqueue("convert", config.CONVERT_LARGE, workflow_id, kei_helper.convert_request("u.pdf", sha, model="fake"))
      assert kei.output(workflow_id)["code"] == "source_unreadable"
      assert not (kei.runs / runs.run_id_for(workflow_id)).exists()
      output = delete(kei, [workflow_id])
      assert output["deleted_history"] == [workflow_id] and DBOS.get_workflow_status(workflow_id) is None


  def test_history_refuses_a_conversion_id(kei):
      output = delete(kei, history=["kei-convert:ingest:p:z"])
      assert output["ok"] is False and output["code"] == "invalid_request"
  ```
  Rewrite every existing case to the new input: `test_an_old_run_whose_conversion_succeeded_is_deleted` (now `delete(kei, [workflow_id])`), `test_a_young_run_is_kept`, `test_a_run_with_a_cancelled_conversion_waits_for_a_kei_restart` (`delete(kei, [workflow_id])` before and after `restart(kei)`; before: `kept_runs == [run_id]`, `kept_history == [workflow_id]`; after: both deleted), `test_a_run_an_unfinished_extraction_reads_is_kept`, `test_a_live_conversion_keeps_its_old_run` (`delete(kei, [live])`), `test_prepare_leftovers_go_once_their_conversion_can_no_longer_write` (unchanged: `delete(kei)`), `test_a_failed_status_read_deletes_nothing`, `test_an_unreadable_run_is_kept_and_stops_nothing_else`, `test_a_run_that_cannot_be_removed_is_kept_and_stops_nothing_else`, `test_a_published_extraction_is_one_of_the_runs_writers`, and rename `test_a_run_id_that_is_not_one_path_component_is_an_invalid_request` to `test_a_conversion_id_without_its_prefix_is_an_invalid_request` (`delete(kei, ["../x"])` → `invalid_request`). Rewrite `test_history_goes_only_for_workflows_that_can_no_longer_write` over two `kei-extract:` workflows (one settled, one held live by the scripted chat, as `test_a_run_an_unfinished_extraction_reads_is_kept` holds one) plus a settled `kei-gc:test-…` workflow; `test_a_history_id_named_twice_is_deleted_once` uses a `kei-extract:` ID named twice.

  `tests/test_contracts.py` (it already imports `fixture` from `tests.helpers.contracts`; add `from kei_exp import runs`, and adapt any existing case that builds a `DeleteRunsInput` with `runs`, such as `test_run_and_extraction_ids_are_single_path_components`) gains:
  ```python
  def test_the_delete_runs_fixture_names_a_conversion_and_the_run_kei_derives_from_it():
      request = fixture("deleteRuns.input")["request"]
      contracts.DeleteRunsInput.model_validate(request)
      output = contracts.DeleteRunsOk.model_validate(fixture("deleteRuns.output"))
      assert output.deleted_runs == [runs.run_id_for(request["conversions"][0])]
      assert output.deleted_history == [*request["history"], *request["conversions"]]
  ```
  Run: `cd prototypes/parsing_service && PARSING_TEST_DATABASE_URL=$PARSING_TEST_DATABASE_URL UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest -q tests/test_delete_runs.py tests/test_contracts.py`. Expected: FAIL.

- [ ] **Step 3: Implement kei's side**

  `contracts.py`:
  ```python
  ConvertWorkflowId = Annotated[str, Field(pattern=r"^kei-convert:.+$")]


  class DeleteRunsInput(_Contract):
      # A conversion's run goes, then the conversion's history once the run is gone: that history is the only index
      # through which Studio can name the run (it never computes run_id_for), so it goes only after the run.
      conversions: list[ConvertWorkflowId] = Field(default_factory=list)
      history: list[str] = Field(default_factory=list)  # kei-extract: and kei-gc: workflows whose history may go

      @field_validator("history")
      @classmethod
      def _no_conversion(cls, value: list[str]) -> list[str]:
          named = [workflow_id for workflow_id in value if workflow_id.startswith(CONVERT_PREFIX)]
          if named:
              raise ValueError(f"{named[0]} is a conversion: its history goes with its run, under conversions")
          return value
  ```
  (Import `field_validator` from pydantic; pydantic's Rust regex has no look-ahead, hence the validator.)
  `gc.py` `delete_runs`: derive the runs from the conversions and delete a conversion's history only once its run is absent.
  ```python
  @DBOS.step(name="delete_runs")
  def delete_runs(request: dict) -> dict:
      boot_ms = boot.timestamp_ms()
      conversions = list(dict.fromkeys(request["conversions"]))
      history = list(dict.fromkeys(request["history"]))
      run_of = {conversion: runs.run_id_for(conversion) for conversion in conversions}
      requested = list(dict.fromkeys(run_of.values()))
      # …every read exactly as today (staged, converting, extracting, writers, unreadable), then:
      statuses = _statuses(sorted({*history, *conversions, *(wid for found in writers.values() for wid in found)}))
      # …the deletion loop over `requested` exactly as today…
      # A conversion's history is its run's only index (Studio never derives a run ID), so it goes only once the run is.
      deleted_history = [wid for wid in history if eligible(statuses.get(wid), boot_ms)]
      deleted_history += [conversion for conversion in conversions
                          if not (runs.RUNS / run_of[conversion]).exists() and eligible(statuses.get(conversion), boot_ms)]
      kept_history = [wid for wid in [*history, *conversions] if wid not in deleted_history]
      # …delete_workflows(deleted_history), log and return DeleteRunsOk as today
  ```
  Update the module docstring's second paragraph accordingly ("Studio names conversions; kei derives their runs"). Rewrite the fixtures:
  `deleteRuns.input.json` `request`: `{"conversions": ["kei-convert:ingest:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222"], "history": ["kei-extract:33333333-3333-4333-8333-333333333333"]}`;
  `deleteRuns.output.json`: `deleted_runs` is `["run-<the 24 hex digits run_id_for prints for that conversion>"]` (compute it once with `UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync python -c "from kei_exp import runs; print(runs.run_id_for('kei-convert:ingest:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'))"` and paste the output), `kept_runs: []`, `deleted_history: ["kei-extract:3333…", "kei-convert:ingest:1111…:2222…"]`, `kept_history: []`. In `README.md`, the sentence naming `deleteRuns` becomes: "`deleteRuns` (`gc.py`, `boot.py`) deletes the runs of the conversions Studio names and then those conversions' history, plus other kei history Studio names, each only once no kei workflow that could still write it is live or stopped since this worker booted."

- [ ] **Step 4: Write the failing Studio tests**

  `packages/extraction/src/kei-handoff.test.ts`:
  - `the deleteRuns fixture parses with Studio's schema and round-trips` (`keiDeleteRunsInputSchema.parse(fixture('deleteRuns.input').request)` deep-equals it; the same for `keiDeleteRunsOkSchema` and `deleteRuns.output`).
  - `a history entry that names a conversion is refused, and so is a conversion without its prefix` (`safeParse` of `{ conversions: [], history: ['kei-convert:x'] }` and `{ conversions: ['x'], history: [] }` fail).
  - `requestDeleteRuns enqueues deleteRuns portably on kei-gc as kei under the given ID` (fake `enqueuePortable` records `(options, args)`; `options` equal `{ workflowName: 'deleteRuns', queueName: 'kei-gc', workflowID: 'kei-gc:2026-09-26T12:00:00.000Z', applicationName: 'kei' }` — the fixture's `enqueue` block in camelCase — and `args` equal `[request]`).
  - `keiGcWorkflowId names the schedule's instant` (`keiGcWorkflowId(new Date('2026-09-26T12:00:00Z')) === 'kei-gc:2026-09-26T12:00:00.000Z'`).
  `packages/extraction/src/kei-handoff.postgres.test.ts` (it already spawns the stand-in): `a deleteRuns request reaches the stand-in on kei-gc, is recorded, and deletes only settled history` (convert one document with policy `auto`; `requestDeleteRuns('kei-gc:t1', { conversions: ['kei-convert:<parent>'], history: [] })`; poll `kei-gc:t1` to `SUCCESS`; `deleteRunsRequests()` has one entry with that request; the conversion's history is gone and its output named its run under `deleted_runs`).
  Run: `pnpm --filter extraction test && pnpm --filter extraction test:postgres`. Expected: FAIL.

- [ ] **Step 5: Implement Studio's side**

  `kei-handoff.ts`:
  ```ts
  export const DELETE_RUNS = 'deleteRuns'
  export const GC_PREFIX = 'kei-gc:'
  /** One kei cleanup per sweep: re-enqueueing the same ID is a no-op in every state (M0 #1), so a recovered sweep asks once. */
  export const keiGcWorkflowId = (scheduledTime: Date) => `${GC_PREFIX}${scheduledTime.toISOString()}`
  export const keiDeleteRunsInputSchema = z.object({
    conversions: z.array(z.string().regex(/^kei-convert:.+$/)),
    history: z.array(z.string().min(1).refine((id) => !id.startsWith(CONVERT_PREFIX),
      "A conversion's history goes with its run: name it under conversions.")),
  }).strict()
  export const keiDeleteRunsOkSchema = z.object({
    ok: z.literal(true), deleted_runs: z.array(z.string()), kept_runs: z.array(z.string()),
    deleted_history: z.array(z.string()), kept_history: z.array(z.string()),
  }).strict()
  export type KeiDeleteRunsInput = z.infer<typeof keiDeleteRunsInputSchema>
  export type KeiDeleteRunsOk = z.infer<typeof keiDeleteRunsOkSchema>
  ```
  `KeiHandoff` gains `requestDeleteRuns`; in `createKeiHandoff`:
  ```ts
  async requestDeleteRuns(workflowId, request) {
    keiDeleteRunsInputSchema.parse(request)
    // Only kei registers kei-gc (spec, *Ownership*); the client names kei's application so only kei dequeues it.
    await client.enqueuePortable(
      { workflowName: DELETE_RUNS, queueName: KEI_QUEUE.gc, workflowID: workflowId, applicationName: KEI_APPLICATION },
      [request],
    )
  },
  ```
  `testing/kei-stand-in.ts`: register a third portable workflow `deleteRuns` (`maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS`) that validates with `keiDeleteRunsInputSchema` (invalid → `fail('invalid_request', …)`), records `{ workflowId: DBOS.workflowID, request, receivedAtMs: Date.now() }` in an in-memory list, and answers inside one step named `delete_runs` (DBOS 5.1.10 runs `DBOS.listWorkflows` and `DBOS.deleteWorkflows` directly when called inside a step: `runInternalStep`, `dist/src/dbos.js:104-118`) with `options.script.deleteRuns?.(request, workflowId)` or, by default: read the statuses of every named ID with `DBOS.listWorkflows({ workflowIDs, loadInput: false, loadOutput: true })`; a conversion or history ID whose status is `SUCCESS` or `ERROR` is deleted with `DBOS.deleteWorkflows`; a deleted conversion's stored result (the `results` map, keyed by the run ID its output named) is forgotten and that run ID reported under `deleted_runs`; everything else is kept and reported under `kept_runs`/`kept_history`. The CLI serves `GET /control/delete-runs` with the recorded list; the client gains `deleteRunsRequests()`. Update the module comment ("registers kei's portable `convert`, `extract` and `deleteRuns`").

- [ ] **Step 6: Run and commit**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6/prototypes/parsing_service
  UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest -q -m "not postgres and not live_model"
  PARSING_TEST_DATABASE_URL=$PARSING_TEST_DATABASE_URL UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest -q -m "postgres and not live_model"
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  pnpm --filter extraction typecheck && pnpm --filter extraction test && pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck
  git add prototypes/parsing_service/src/kei_exp/workflows/contracts.py prototypes/parsing_service/src/kei_exp/workflows/gc.py \
    prototypes/parsing_service/tests/test_delete_runs.py prototypes/parsing_service/tests/test_contracts.py \
    prototypes/parsing_service/tests/fixtures/contracts/deleteRuns.input.json prototypes/parsing_service/tests/fixtures/contracts/deleteRuns.output.json \
    prototypes/parsing_service/README.md packages/extraction/src/kei-handoff.ts packages/extraction/src/kei-handoff.test.ts \
    packages/extraction/src/kei-handoff.postgres.test.ts packages/extraction/src/testing
  git commit -m "feat(kei): name conversions to deleteRuns and keep a conversion's history while its run exists"
  ```

### Task 2: kei worker hardening: every launch failure exits holding the slot, DBOS's own logs are redacted, grounding batches check for a cancel

**Files:**
- Modify: `prototypes/parsing_service/src/kei_exp/workflows/cli.py`, `prototypes/parsing_service/tests/test_worker_boot.py`
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/stages.py` (`verify`), `prototypes/parsing_service/src/kei_exp/kie/extract/run.py` (158-165), `prototypes/parsing_service/tests/test_extract_stages.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `cli.RedactingFilter(database_url)` (a `logging.Filter`), installed on `logging.getLogger("dbos")` by `serve()` before `DBOS(...)`; `stages.verify(..., before_call: Callable[[], None] | None = None)`.

- [ ] **Step 1: Write the failing tests**

  `tests/test_worker_boot.py`:
  ```python
  @pytest.mark.parametrize("interrupt", [KeyboardInterrupt, SystemExit])
  def test_an_interrupt_during_launch_destroys_dbos_and_exits_still_holding_the_slot(monkeypatch, capsys, interrupt):
      """A BaseException must not unwind the slot's `with` block while DBOS threads may still run steps."""
      order: list[str] = []

      @contextlib.contextmanager
      def hold(name):
          order.append("flock")
          try:
              yield
          finally:
              order.append("release")

      class FakeDBOS:
          def __init__(self, *, config):
              order.append("configure")

          @staticmethod
          def launch():
              order.append("launch")
              raise interrupt()

          @staticmethod
          def destroy():
              order.append("destroy")

      monkeypatch.setattr(slot, "hold_slot", hold)
      monkeypatch.setattr(boot, "database_clock_ms", lambda url: 1234)
      monkeypatch.setattr(boot, "_timestamp_ms", None)
      monkeypatch.setattr(cli, "DBOS", FakeDBOS)
      cli.serve("slot-7", "postgresql://x", until=lambda: order.append("serving"),
                exit_process=lambda code: order.append(f"exit {code}"))
      assert order[-3:] == ["destroy", "exit 1", "release"]
      assert capsys.readouterr().err.startswith(f"kei worker stopped: {interrupt.__name__}")


  def test_dbos_own_logs_never_print_the_database_password(monkeypatch, caplog):
      url = "postgresql://kei:s3cr%40t-pw@db:5432/free"
      filtered = cli.RedactingFilter(url)
      logger = logging.getLogger("dbos")
      logger.addFilter(filtered)
      try:
          with caplog.at_level(logging.INFO, logger="dbos"):
              try:
                  raise RuntimeError(f"connection to {url} failed: password=s3cr@t-pw")
              except RuntimeError as error:
                  logger.error("DBOS failed to launch:", exc_info=error)                     # _dbos.py:787
              logger.error(f"Error connecting to the DBOS system database: {url}")            # _sys_db.py:5469
              logger.info("Initializing DBOS with URL: %s", url)
      finally:
          logger.removeFilter(filtered)
      text = caplog.text
      assert "s3cr" not in text and "s3cr%40t-pw" not in text
      assert "DBOS failed to launch" in text and "RuntimeError" in text
  ```
  (Add `import logging` to the file. The first test mirrors `test_dbos_is_destroyed_when_launch_or_the_lanes_fail`; if the two fakes end up identical, factor them into one module-level helper.) Also extend `test_a_startup_error_never_prints_the_database_password` to read `caplog.text` as well as stderr (`assert SYNTHETIC_PASSWORD not in caplog.text`), so no case leaves it in a log record either; the dedicated filter test above is the one that bites today, because these cases fail at the clock read, before DBOS logs anything.
  `tests/test_extract_stages.py`:
  ```python
  def test_verification_asks_its_hook_before_every_grounding_batch_and_stops_when_it_raises():
      """The worker's cooperative cancellation reaches inside a record: a record whose claims split into several batches
      stops before its next batch once cancelled (run.py checked only before the record)."""
      fields = {"entry_no": "31", "site": "Hjortlund parish", "year": 1827, "finds": ["spyd", "sword"]}
      sizes = []
      probe = FakeChat(lambda s, u, schema: sizes.append(len(s) + len(u) + len(json.dumps(schema))) or {"C1": "NONE", "C2": "NONE"})
      verify(passages()[1:3], fields, SCHEMA, probe, record=0, budget=10**9)
      budget = sizes[0] - 1                        # the two pending claims no longer fit one batch: two batches
      asked, calls = [], []

      def before_call():
          if len(calls) == 1:
              raise RuntimeError("cancelled")
          asked.append(len(calls))
      chat = FakeChat(lambda s, u, schema: calls.append(u) or {claim: "NONE" for claim in schema["properties"]})
      with pytest.raises(RuntimeError, match="cancelled"):
          verify(passages()[1:3], fields, SCHEMA, chat, record=0, budget=budget, before_call=before_call)
      assert asked == [0] and len(calls) == 1
  ```
  Plus, in the same file: `test_extract_passes_its_check_to_verification` (monkeypatch `stages.verify` inside `run` to capture the `before_call` it receives; it is the `before_entry` hook `extract` was given).
  Run: `UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest -q tests/test_worker_boot.py tests/test_extract_stages.py`. Expected: FAIL.

- [ ] **Step 2: Implement**

  `cli.py`:
  ```python
  class RedactingFilter(logging.Filter):
      """DBOS logs its own launch and connection failures (dbos _dbos.py:787, _sys_db.py:5469) before the worker can
      report them; driver messages there can quote the URL. Rewrite each record's message and traceback in place."""

      def __init__(self, database_url: str) -> None:
          super().__init__()
          self._url = database_url

      def filter(self, record: logging.LogRecord) -> bool:
          message = record.getMessage()
          if record.exc_info:
              kind, error = record.exc_info[0], record.exc_info[1]
              message = f"{message} {kind.__name__ if kind else 'Error'}: {error}"
              record.exc_info, record.exc_text = None, None     # the traceback repeats the message; drop it
          record.msg, record.args = redacted(message, self._url), ()
          return True
  ```
  In `serve()`, right after `logging.basicConfig(...)`: `logging.getLogger("dbos").addFilter(RedactingFilter(database_url))`. Change `except Exception as error:  # noqa: BLE001` at line 61 to `except BaseException as error:  # noqa: BLE001 - an interrupt too must destroy DBOS and exit holding the slot`.
  `stages.verify` gains the keyword `before_call: Callable[[], None] | None = None` and, just before `answer, attempts = _complete(chat, stage="grounding", …)`, `if before_call is not None: before_call()`. `run.py:164` passes `before_call=check` (the record-level `check()` before it stays). Update `extract`'s docstring sentence: "…before each record's verification and before each of its grounding batches…".

- [ ] **Step 3: Run and commit**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6/prototypes/parsing_service
  UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest -q -m "not postgres and not live_model"
  PARSING_TEST_DATABASE_URL=$PARSING_TEST_DATABASE_URL UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest -q tests/test_worker_boot.py tests/test_worker_recovery.py
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/parsing_service/src/kei_exp/workflows/cli.py prototypes/parsing_service/tests/test_worker_boot.py \
    prototypes/parsing_service/src/kei_exp/kie/extract/stages.py prototypes/parsing_service/src/kei_exp/kie/extract/run.py \
    prototypes/parsing_service/tests/test_extract_stages.py
  git commit -m "fix(kei): exit holding the slot on any launch failure, redact DBOS's own logs, check for a cancel between grounding batches"
  ```

### Task 3: The domain references garbage collection reads, in `packages/db`

**Files:**
- Create: `packages/db/src/garbage-references.ts`, `packages/db/src/garbage-references.postgres.check.ts`
- Modify: `packages/db/src/index.ts` (exports), `packages/db/package.json` (`test:postgres` gains the check)

**Interfaces:**
- Consumes: M4's `Extraction.outcome` (nullable), `BatchSchemaSuggestion.attempt`/`outcome`; `SourceRepresentationRevision.preprocessId`/`artifactReference`. M5 adds no table (spec decision 15: no `ChatTurn`); its `suggestion:` and `edit:` workflows are rowless and are scoped by their attributes only.
- Produces (exported from `db`):
  ```ts
  export type ScopeIds = Readonly<{
    projectContextIds: readonly string[]; sourceDocumentIds: readonly string[]; sourceRepresentationRevisionIds: readonly string[]
    extractionSchemaIds: readonly string[]; batchSchemaSuggestionIds: readonly string[]; extractionIds: readonly string[]
  }>
  export const EMPTY_SCOPE_IDS: ScopeIds
  export type ScopeSnapshot = Readonly<{
    projectContexts: ReadonlySet<string>; sourceDocuments: ReadonlySet<string>; sourceRepresentationRevisions: ReadonlySet<string>
    extractionSchemas: ReadonlySet<string>
    suggestions: ReadonlyMap<string, Readonly<{ attempt: number; settled: boolean }>>   // settled: the current attempt has an outcome
    extractions: ReadonlyMap<string, Readonly<{ settled: boolean }>>                    // settled: outcome is not null
  }>
  export type GarbageReferences = Readonly<{
    scopes(ids: ScopeIds): Promise<ScopeSnapshot>                          // an ID absent from the snapshot no longer exists
    referencedPreprocessIds(): Promise<ReadonlySet<string>>                // every surviving revision's preprocessId
    referencedPackages(artifactReferences: readonly string[]): Promise<ReadonlySet<string>>
    packageIsReferenced(artifactReference: string): Promise<boolean>
  }>
  export function createGarbageReferences(database?: Database): GarbageReferences
  ```

- [ ] **Step 1: Write the failing check** (`garbage-references.postgres.check.ts`, in the pattern of `model-configuration.postgres.check.ts`: `PROJECT_STORE_POSTGRES_URL`, the disposable-target guard, dynamic imports after setting `DATABASE_URL`, its own account deleted in `after`)
  - `scopes reports existing rows and the state of suggestions and Extractions` (seed through the ORM: an account, a project, a document, a revision with `preprocessId: 'kei-exp:run-abc:g1'` and `artifactReference` = `artifactSha256` = 64 hex digits, an Extraction Schema, a suggestion at `attempt: 2` with an outcome, an Extraction with `outcome: null`; `scopes()` with those IDs and one random UUID per kind: every seeded ID is present, the random ones absent; `suggestions.get(id)` is `{ attempt: 2, settled: true }`, `extractions.get(id).settled === false`).
  - `after the project is deleted, none of its scopes exist` (delete the `ProjectContext` row; the same `scopes()` call returns empty sets and maps).
  - `unknown or malformed IDs are absent, and a failed read rejects` (`scopes({ ...EMPTY_SCOPE_IDS, projectContextIds: ['not-a-uuid', 'A0000000-0000-4000-8000-000000000000'] })` resolves with no project — a malformed ID must not fail the read; a `createGarbageReferences(database)` over a facade whose pool was ended **rejects** on `scopes`, `referencedPreprocessIds` and `referencedPackages` rather than resolving empty).
  - `referencedPreprocessIds and referencedPackages name what surviving revisions reference` (the seeded revision's `preprocessId` is in the set; `referencedPackages([seeded, other])` is `{seeded}`; `packageIsReferenced(other) === false`).
  Run: `pnpm --filter db exec tsx --test src/garbage-references.postgres.check.ts` (fresh databases). Expected: FAIL (module missing).

- [ ] **Step 2: Implement** (`garbage-references.ts`)

  ```ts
  import { db, type Database } from './prisma/db.js'

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  /** Only canonical lowercase UUIDs can name a row; anything else (a test's placeholder, a corrupt attribute) is absent
   *  without a query, so one bad attribute can never fail — and so stall — every sweep. */
  const ids = (values: readonly string[]) => [...new Set(values.filter((value) => UUID.test(value)))]

  export const EMPTY_SCOPE_IDS: ScopeIds = {
    projectContextIds: [], sourceDocumentIds: [], sourceRepresentationRevisionIds: [], extractionSchemaIds: [],
    batchSchemaSuggestionIds: [], extractionIds: [],
  }

  export function createGarbageReferences(database: Database = db): GarbageReferences {
    const orm = database.orm.public
    return {
      async scopes(input) {
        const wanted = {
          projects: ids(input.projectContextIds), documents: ids(input.sourceDocumentIds),
          revisions: ids(input.sourceRepresentationRevisionIds), schemas: ids(input.extractionSchemaIds),
          suggestions: ids(input.batchSchemaSuggestionIds), extractions: ids(input.extractionIds),
        }
        const [projects, documents, revisions, schemas, suggestions, extractions] = await Promise.all([
          wanted.projects.length ? orm.ProjectContext.where((row) => row.id.in(wanted.projects)).select('id').all() : [],
          wanted.documents.length ? orm.SourceDocument.where((row) => row.id.in(wanted.documents)).select('id').all() : [],
          wanted.revisions.length ? orm.SourceRepresentationRevision.where((row) => row.id.in(wanted.revisions)).select('id').all() : [],
          wanted.schemas.length ? orm.ExtractionSchema.where((row) => row.id.in(wanted.schemas)).select('id').all() : [],
          wanted.suggestions.length ? orm.BatchSchemaSuggestion.where((row) => row.id.in(wanted.suggestions)).select('id', 'attempt', 'outcome').all() : [],
          wanted.extractions.length ? orm.Extraction.where((row) => row.id.in(wanted.extractions)).select('id', 'outcome').all() : [],
        ])
        const idSet = (rows: readonly { id: string }[]) => new Set(rows.map((row) => row.id))
        return {
          projectContexts: idSet(projects), sourceDocuments: idSet(documents),
          sourceRepresentationRevisions: idSet(revisions), extractionSchemas: idSet(schemas),
          suggestions: new Map(suggestions.map((row) => [row.id, { attempt: row.attempt, settled: row.outcome !== null }])),
          extractions: new Map(extractions.map((row) => [row.id, { settled: row.outcome !== null }])),
        }
      },
      async referencedPreprocessIds() {
        const rows = await orm.SourceRepresentationRevision.select('preprocessId').all()
        return new Set(rows.map((row) => row.preprocessId))
      },
      async referencedPackages(references) {
        const wanted = [...new Set(references)]
        if (wanted.length === 0) return new Set()
        const rows = await orm.SourceRepresentationRevision.where((row) => row.artifactReference.in(wanted))
          .select('artifactReference').all()
        return new Set(rows.map((row) => row.artifactReference))
      },
      async packageIsReferenced(artifactReference) {
        return Boolean(await orm.SourceRepresentationRevision.select('id').first({ artifactReference }))
      },
    }
  }
  ```
  (The `.where((row) => row.<column>.in(ids))` form is the one `project-store.ts:934-980` uses.) Export everything from `src/index.ts`; append `src/garbage-references.postgres.check.ts` to `test:postgres`.

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test && pnpm --filter db test:postgres       # fresh databases
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/db/src/garbage-references.ts packages/db/src/garbage-references.postgres.check.ts packages/db/src/index.ts packages/db/package.json
  git commit -m "feat(db): read the scopes, revision references and package references garbage collection decides on"
  ```

### Task 4: Studio's file sweeps: canonical packages and staged sources

**Files:**
- Modify: `packages/db/src/artifact-store.ts` (`list`, `leftovers`, `removeLeftover`, `remove`'s age recheck, `save`'s touch on reuse), `packages/db/src/artifact-store.test.ts`
- Modify: `prototypes/studio/api/_source_inbox.ts` (`listStagedSources`, `stagedSourceWorkflowId`), `prototypes/studio/api/_source_inbox.test.ts`

**Interfaces:**
- Consumes: M4 Task 4's `uploadSourcePath`, `reprocessSourcePath`, `stageSource`.
- Produces:
  ```ts
  // packages/db (CanonicalPackageStore gains)
  list(): Promise<readonly { descriptor: CanonicalPackageDescriptor; modifiedMs: number }[]>
  leftovers(): Promise<readonly { name: string; modifiedMs: number }[]>      // <sha>.<uuid>.tmp and <sha>.<uuid>.deleting
  removeLeftover(name: string): Promise<void>                                 // refuses any other name
  remove(descriptor, isReferenced, options?: { modifiedBeforeMs?: number }): Promise<boolean>
  // api/_source_inbox.ts
  export type StagedSource = Readonly<{ relative: string; modifiedMs: number; workflowId: string | null; temporary: boolean }>
  export function stagedSourceWorkflowId(relative: string): string | null     // ingest:<p>:<a> | reprocess:<d>:<k> | null
  export function listStagedSources(root: string): Promise<readonly StagedSource[]>
  ```
  Empty project directories are never removed: an `rmdir` could land between an upload's `mkdir` and its temporary write and fail that upload, and an empty directory costs nothing.

- [ ] **Step 1: Write the failing tests**

  `packages/db/src/artifact-store.test.ts` (a temporary root; build valid packages with `packCanonicalPackage` as the existing tests do):
  - `lists stored packages with their modification times and ignores other names` (two saved packages, a `README` file and a directory: `list()` returns exactly the two descriptors with `modifiedMs` equal to `lstat().mtimeMs`; a missing root lists nothing).
  - `lists .tmp and .deleting leftovers and removes only names of that shape` (create `<sha>.<uuid>.tmp`, `<sha>.<uuid>.deleting`, `notes.tmp`: `leftovers()` names the first two; `removeLeftover('../x')` and `removeLeftover('notes.tmp')` reject and delete nothing).
  - `a package reused while it is being swept is restored` (A1: save P; backdate it 48 h with `utimes`; save P again — the reuse touches it; `remove(P, async () => false, { modifiedBeforeMs: Date.now() - 24 * 3600_000 })` answers `false` and P is still `available`).
  - `saving a package the sweep has quarantined publishes it again` (save P; `rename` its file to `<sha>.<uuid>.deleting` as a sweep does; save P again: `published: true`, P `available`).
  - `remove still deletes an old unreferenced package` (backdated 48 h, `modifiedBeforeMs` now − 24 h, `isReferenced` false → `true`, gone).
  `prototypes/studio/api/_source_inbox.test.ts`:
  - `maps an upload file to its ingest workflow and a reprocess file to its reprocess workflow` (`stagedSourceWorkflowId(uploadSourcePath(p, a)) === \`ingest:${p}:${a}\``; `stagedSourceWorkflowId(reprocessSourcePath(p, d, k)) === \`reprocess:${d}:${k}\``; `'x/y.pdf'`, `'../a.pdf'`, an uppercase UUID → `null`).
  - `lists staged files and stale temporaries with their times; an unknown name maps to no workflow` (stage an upload and a reprocess file, drop a `<target>.<uuid>.tmp` and a `notes.txt` into a project directory: four entries, the temporary with `temporary: true`, `notes.txt` with `workflowId: null`; files outside a UUID-named project directory are ignored; a missing root lists nothing; an empty project directory lists nothing and stays).
  Run: `pnpm --filter db test` and `pnpm --filter studio exec vitest run api/_source_inbox.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

  `artifact-store.ts` (inside `createCanonicalPackageStore`; import `readdir` and `utimes` from `node:fs/promises`):
  ```ts
  const PACKAGE_FILE = /^([a-f0-9]{64})\.zip$/
  const LEFTOVER = /^[a-f0-9]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(tmp|deleting)$/

  async function entries(): Promise<string[]> {
    try {
      return await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  async function modified(name: string): Promise<number | null> {
    try {
      const info = await lstat(join(root, name))
      return info.isFile() ? info.mtimeMs : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null   // removed meanwhile
      throw error
    }
  }
  async function list() {
    const found: { descriptor: CanonicalPackageDescriptor; modifiedMs: number }[] = []
    for (const name of await entries()) {
      const reference = PACKAGE_FILE.exec(name)?.[1]
      const modifiedMs = reference ? await modified(name) : null
      if (reference && modifiedMs !== null)
        found.push({ descriptor: { artifactReference: reference, artifactSha256: reference }, modifiedMs })
    }
    return found
  }
  async function leftovers() {
    const found: { name: string; modifiedMs: number }[] = []
    for (const name of await entries()) {
      const modifiedMs = LEFTOVER.test(name) ? await modified(name) : null
      if (modifiedMs !== null) found.push({ name, modifiedMs })
    }
    return found
  }
  async function removeLeftover(name: string) {
    if (!LEFTOVER.test(name)) throw new Error('Not a canonical package leftover.')
    await rm(join(root, name), { force: true })
  }
  ```
  In `save`, the reuse branch becomes:
  ```ts
  if (await available(descriptor)) {
    try {
      // A reused package is in use again: refresh its age, so a sweep that already judged it old restores it instead
      // of deleting it under a revision that is about to reference it (remove's modifiedBeforeMs).
      const now = new Date()
      await utimes(packagePath(descriptor), now, now)
      return { ...descriptor, document, manifest, published: false }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A sweep quarantined it between the check and the touch: publish it again below.
    }
  }
  ```
  In `remove`, right after the quarantine `rename` succeeds:
  ```ts
  if (options?.modifiedBeforeMs !== undefined && (await lstat(quarantine)).mtimeMs >= options.modifiedBeforeMs) {
    await restore()          // touched after the sweep's cutoff: a writer reuses it
    return false
  }
  ```
  Extend the `CanonicalPackageStore` type and return the new functions.
  `_source_inbox.ts` (import `readdir` and `lstat`; reuse the UUID pattern `uploadSourcePath` validates with — if that is `canonicalUuidSchema`, take its regular expression's `source` rather than a second definition):
  ```ts
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
  const ANY_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  const UPLOAD = new RegExp(`^(${UUID})/(${UUID})\\.pdf$`)
  const REPROCESS = new RegExp(`^(${UUID})/reprocess-(${UUID})-(${UUID})\\.pdf$`)
  const TEMPORARY = new RegExp(`\\.pdf\\.${ANY_UUID}\\.tmp$`)
  const PROJECT = new RegExp(`^${UUID}$`)

  /** The workflow a staged file belongs to (M4 plan decision 11), or null for a name Studio never writes. */
  export function stagedSourceWorkflowId(relative: string): string | null {
    const upload = UPLOAD.exec(relative)
    if (upload) return `ingest:${upload[1]}:${upload[2]}`
    const reprocess = REPROCESS.exec(relative)
    return reprocess ? `reprocess:${reprocess[2]}:${reprocess[3]}` : null
  }

  export async function listStagedSources(root: string): Promise<readonly StagedSource[]> {
    let projects
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const found: StagedSource[] = []
    for (const project of projects) {
      if (!project.isDirectory() || !PROJECT.test(project.name)) continue
      for (const file of await readdir(join(root, project.name), { withFileTypes: true })) {
        if (!file.isFile()) continue
        const relative = `${project.name}/${file.name}`
        let modifiedMs: number
        try {
          modifiedMs = (await lstat(join(root, relative))).mtimeMs
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue   // removed meanwhile
          throw error
        }
        const temporary = TEMPORARY.test(file.name)
        found.push({ relative, modifiedMs, workflowId: temporary ? null : stagedSourceWorkflowId(relative), temporary })
      }
    }
    return found
  }
  ```

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter db typecheck && pnpm --filter db test
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio exec vitest run api/_source_inbox.test.ts
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add packages/db/src/artifact-store.ts packages/db/src/artifact-store.test.ts prototypes/studio/api/_source_inbox.ts prototypes/studio/api/_source_inbox.test.ts
  git commit -m "feat(studio): list and age canonical packages and staged sources, and keep a package a writer reuses mid-sweep"
  ```

### Task 5: The garbage-collection plan as pure functions

Nothing reads or deletes here: every rule of spec *Deletion and garbage collection* becomes a pure function over rows the workflow reads (Task 6), so the rules are table-tested without PostgreSQL.

**Files:**
- Create: `prototypes/studio/api/_garbage_plan.ts`, `prototypes/studio/api/_garbage_plan.test.ts`

**Interfaces:**
- Consumes: Task 1 (`KeiDeleteRunsInput`), Task 3 (`ScopeIds`, `ScopeSnapshot`), Task 4 (`StagedSource`), M4 Task 3 (`keiConvertOkSchema`), M4 Task 5 (`keiRunOf`).
- Produces:
  ```ts
  export type GarbagePolicy = Readonly<{ interactiveRetentionMs: number; backgroundRetentionMs: number; sweepRetentionMs: number; fileMinAgeMs: number; historyBatch: number }>
  export const GC_POLICY: GarbagePolicy        // 24 h, 30 d, 24 h, 24 h, 1000
  export type WorkflowRow = Readonly<{ workflowID: string; status: string; updatedAt?: number; completedAt?: number; attributes?: Readonly<Record<string, unknown>>; output?: unknown }>
  export const LIVE_STATUSES: readonly ['ENQUEUED', 'DELAYED', 'PENDING']
  export const TERMINAL_STATUSES: readonly ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED']
  export const STUDIO_WORKFLOW_PREFIXES: readonly ['extract:', 'suggest:', 'ingest:', 'reprocess:', 'suggestion:', 'edit:']
  export const SWEEP_PREFIX = 'sched-collectGarbage-'
  export function quiescent(row: WorkflowRow | undefined, bootTimestampMs: number): boolean
  export function keiParentOf(keiWorkflowId: string): string | null
  export function scopeIdsOf(rows: readonly WorkflowRow[]): ScopeIds
  export function planCancellationRepair(input: { liveStudio: readonly WorkflowRow[]; liveKei: readonly WorkflowRow[]; parents: ReadonlyMap<string, WorkflowRow>; scopes: ScopeSnapshot }): { studio: string[]; kei: string[] }
  export function planStudioHistory(input: { rows: readonly WorkflowRow[]; scopes: ScopeSnapshot; nowMs: number; bootTimestampMs: number; policy: GarbagePolicy }): string[]
  export function planKeiCleanup(input: { kei: readonly WorkflowRow[]; parents: ReadonlyMap<string, WorkflowRow>; runHolders: readonly WorkflowRow[]; referencedPreprocessIds: ReadonlySet<string>; extractions: ReadonlyMap<string, { settled: boolean }>; nowMs: number; bootTimestampMs: number; policy: GarbagePolicy }): KeiDeleteRunsInput | null
  export function planStagedSources(input: { files: readonly StagedSource[]; parents: ReadonlyMap<string, WorkflowRow>; children: ReadonlyMap<string, WorkflowRow>; nowMs: number; policy: GarbagePolicy }): string[]
  export function planPackages(input: { packages: readonly { descriptor: CanonicalPackageDescriptor; modifiedMs: number }[]; leftovers: readonly { name: string; modifiedMs: number }[]; referenced: ReadonlySet<string>; nowMs: number; policy: GarbagePolicy }): { packages: CanonicalPackageDescriptor[]; leftovers: string[]; modifiedBeforeMs: number }
  ```

- [ ] **Step 1: Write the failing tests** (`api/_garbage_plan.test.ts`; `const BOOT = 1_000_000_000_000`, `NOW = BOOT + 40 * DAY`; builders `row(id, status, { updatedAt, completedAt, attributes, output })` and `scopes({ … })` with empty defaults)
  - Rules shared by every plan:
    - `a workflow is quiescent when absent, ended, or stopped before this boot` (absent, `SUCCESS`, `ERROR` → true; `CANCELLED`/`MAX_RECOVERY_ATTEMPTS_EXCEEDED` with `updatedAt` `BOOT − 1` → true; `BOOT`, `BOOT + 1` or missing → false; `ENQUEUED`, `DELAYED`, `PENDING`, an unknown status → false).
    - `maps kei-extract and kei-convert IDs to their Studio parents and nothing else` (`kei-extract:x` → `extract:x`; `kei-convert:ingest:p:a` → `ingest:p:a`; `kei-convert:reprocess:d:k` → `reprocess:d:k`; `kei-gc:t`, `other` → null).
    - `collects every scope an attribute or a workflow ID names` (`scopeIdsOf` over `extract:e1`, `suggest:s1:3`, `edit:o1` (names nothing by its ID), attributes with each key, and `extractionSchemaId: null`, which names nothing).
  - Repair (spec *Orphaned execution*, *Propagation is retried*):
    - `cancels a live runExtraction whose Extraction has an outcome or no longer exists`.
    - `cancels a live suggestion attempt that is settled, superseded by a later attempt, or deleted` (`suggest:s:2` with the row at attempt 3, or settled, or absent).
    - `cancels live workflow-first work only when its scope is gone; a first generation's null schema names no scope` (`ingest:`, `reprocess:`, `suggestion:`, `edit:` with an existing scope stay; a missing project, document, revision or non-null schema cancels; `extractionSchemaId: null` never does).
    - `cancels a live kei child whose parent is terminal, absent, or cancelled in this sweep` (A7 "any late kei submission").
    - `leaves live work alone while its domain row is open and its scope exists`.
  - Studio history (spec *History retention*, *Cancelled Studio history*):
    - `deletes settled interactive history after 24 h and background history after 30 days` (`completedAt` at `NOW − 25 h` for `suggestion:`/`edit:` → deleted; `extract:` at `NOW − 25 h` → kept, at `NOW − 31 d` → deleted).
    - `deletes a deleted scope's settled history at any age` (A8).
    - `keeps history cancelled in this process at any age, even for a deleted scope` (A6: `CANCELLED`, `updatedAt: BOOT + 1`, `completedAt: NOW − 60 d`, project absent → kept).
    - `deletes history cancelled before this boot once its age or deleted scope allows` (A6).
    - `keeps a sweep's own runs for 24 h` (`sched-collectGarbage-…` rows).
    - `deletes at most the batch size, oldest first`.
  - kei runs and history (spec *kei runs and history*, *kei boot boundary*, *Late handoffs*):
    - `names a quiescent parent's conversion whose run no revision references` (`kei-convert:ingest:p:a` `SUCCESS` with output `{ ok: true, run_id: 'run-1', … }` valid under `keiConvertOkSchema`, parent absent, no `kei-exp:run-1:*` preprocessId → `conversions: ['kei-convert:ingest:p:a']`).
    - `names a failed or cancelled conversion, whose run no revision can reference` (output `{ ok: false, … }`, and a `CANCELLED` conversion with no output).
    - `never names a conversion whose run a surviving revision references`.
    - `never names a live or unquiesced parent's conversion, even when its run is unreferenced` (A1: parent `PENDING`; parent `CANCELLED` at `BOOT + 1`).
    - `protects a run named by keiRunId of a live extraction or one stopped in this process` (A4: holder `extract:x` `PENDING` or `CANCELLED` at `BOOT + 5` with attributes `{ keiRunId: 'run-1' }` → the conversion of `run-1` is not named; the same holder `CANCELLED` at `BOOT − 5` → named).
    - `protects a run while a kei-extract child naming it is live` ("cleanup rechecks the run's kei children").
    - `names a conversion that ended MAX_RECOVERY_ATTEMPTS_EXCEEDED, for kei's own boot boundary to decide` (A5).
    - `names kei-extract history once its parent is quiescent and its Extraction is gone or 30 days old` (and never while the parent is `PENDING`).
    - `names kei-gc history after 24 h; never names a conversion under history` (Review Focus 1: over a seeded random mix of 50 rows, every `history` entry starts with `kei-extract:` or `kei-gc:`).
    - `asks for nothing when nothing is due` (→ `null`).
  - Files (spec *Staged uploads*, *Packages*):
    - `removes an old file whose workflow is absent or terminal and whose kei child is not live` (A9: an absent workflow — a crash before enqueue, or a lost deduplication race — and a `SUCCESS` one).
    - `keeps a file whose attempt is live, whose kei child is live, or that is younger than 24 h` (A9: a recovered attempt `PENDING`; a `CANCELLED` parent whose `kei-convert:` child is `PENDING`).
    - `removes an old temporary; keeps a file whose name maps to no workflow`.
    - `removes old unreferenced packages and old leftovers only, and passes the cutoff for the recheck` (A1: a package modified 23 h ago is kept).
  Run: `pnpm --filter studio exec vitest run api/_garbage_plan.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement** (`api/_garbage_plan.ts`)

  ```ts
  import type { CanonicalPackageDescriptor, ScopeIds, ScopeSnapshot } from 'db'
  import { keiConvertOkSchema, type KeiDeleteRunsInput } from 'extraction/kei-handoff'
  import { keiRunOf } from 'extraction/workflows'
  import type { StagedSource } from './_source_inbox.js'

  const HOUR = 3_600_000
  export const GC_POLICY: GarbagePolicy = {
    interactiveRetentionMs: 24 * HOUR, backgroundRetentionMs: 30 * 24 * HOUR, sweepRetentionMs: 24 * HOUR,
    fileMinAgeMs: 24 * HOUR, historyBatch: 1000,
  }
  export const LIVE_STATUSES = ['ENQUEUED', 'DELAYED', 'PENDING'] as const
  export const TERMINAL_STATUSES = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const
  export const STUDIO_WORKFLOW_PREFIXES = ['extract:', 'suggest:', 'ingest:', 'reprocess:', 'suggestion:', 'edit:'] as const
  export const SWEEP_PREFIX = 'sched-collectGarbage-'
  const INTERACTIVE_PREFIXES = ['suggestion:', 'edit:']
  const LIVE = new Set<string>(LIVE_STATUSES)
  const TERMINAL = new Set<string>(TERMINAL_STATUSES)
  const ENDED = new Set(['SUCCESS', 'ERROR'])
  const STOPPED = new Set(['CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'])
  const EXTRACT = /^extract:([^:]+)$/
  const SUGGEST = /^suggest:([^:]+):(\d+)$/

  /** Whether a Studio workflow can run no more steps: gone, ended, or stopped (both stamped from the database clock)
   *  before this process booted. A step of a workflow cancelled in this process may still be running and checkpoint
   *  (spec, *Cancelled Studio history*); no elapsed age proves otherwise. */
  export function quiescent(row: WorkflowRow | undefined, bootTimestampMs: number): boolean {
    if (!row || ENDED.has(row.status)) return true
    return STOPPED.has(row.status) && row.updatedAt !== undefined && row.updatedAt < bootTimestampMs
  }

  export function keiParentOf(keiWorkflowId: string): string | null {
    if (keiWorkflowId.startsWith('kei-extract:')) return `extract:${keiWorkflowId.slice('kei-extract:'.length)}`
    if (keiWorkflowId.startsWith('kei-convert:')) return keiWorkflowId.slice('kei-convert:'.length) || null
    return null
  }

  const endedAt = (row: WorkflowRow) => row.completedAt ?? row.updatedAt ?? Number.POSITIVE_INFINITY
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  /** A named ID that is absent from the snapshot; a missing or null attribute names nothing. */
  const missing = (present: ReadonlySet<string> | ReadonlyMap<string, unknown>, value: unknown) =>
    typeof value === 'string' && !present.has(value)

  function scopeGone(row: WorkflowRow, scopes: ScopeSnapshot): boolean {
    const attributes = row.attributes ?? {}
    return missing(scopes.projectContexts, attributes.projectContextId) ||
      missing(scopes.sourceDocuments, attributes.sourceDocumentId) ||
      missing(scopes.sourceRepresentationRevisions, attributes.sourceRepresentationRevisionId) ||
      missing(scopes.extractionSchemas, attributes.extractionSchemaId) ||      // null: a first generation, no schema yet
      missing(scopes.suggestions, attributes.batchSchemaSuggestionId)
  }

  /** The row a row-backed workflow publishes into is gone. */
  function rowGone(row: WorkflowRow, scopes: ScopeSnapshot): boolean {
    const extraction = EXTRACT.exec(row.workflowID), suggestion = SUGGEST.exec(row.workflowID)
    if (extraction) return !scopes.extractions.has(extraction[1]!)
    if (suggestion) return !scopes.suggestions.has(suggestion[1]!)
    return false
  }

  /** The domain already holds this attempt's outcome, or never will (spec, *Propagation is retried*). */
  function settled(row: WorkflowRow, scopes: ScopeSnapshot): boolean {
    const extraction = EXTRACT.exec(row.workflowID), suggestion = SUGGEST.exec(row.workflowID)
    if (extraction) return scopes.extractions.get(extraction[1]!)?.settled ?? true
    if (suggestion) {
      const current = scopes.suggestions.get(suggestion[1]!)
      return !current || current.attempt !== Number(suggestion[2]) || current.settled
    }
    return false
  }

  export function scopeIdsOf(rows: readonly WorkflowRow[]): ScopeIds {
    const projects = new Set<string>(), documents = new Set<string>(), revisions = new Set<string>(), schemas = new Set<string>()
    const suggestions = new Set<string>(), extractions = new Set<string>()
    const add = (set: Set<string>, value: unknown) => { if (typeof value === 'string') set.add(value) }
    for (const row of rows) {
      const attributes = row.attributes ?? {}
      add(projects, attributes.projectContextId)
      add(documents, attributes.sourceDocumentId)
      add(revisions, attributes.sourceRepresentationRevisionId)
      add(schemas, attributes.extractionSchemaId)
      add(suggestions, attributes.batchSchemaSuggestionId)
      add(extractions, EXTRACT.exec(row.workflowID)?.[1])
      add(suggestions, SUGGEST.exec(row.workflowID)?.[1])
    }
    const sorted = (set: Set<string>) => [...set].sort()
    return {
      projectContextIds: sorted(projects), sourceDocumentIds: sorted(documents), sourceRepresentationRevisionIds: sorted(revisions),
      extractionSchemaIds: sorted(schemas), batchSchemaSuggestionIds: sorted(suggestions), extractionIds: sorted(extractions),
    }
  }

  export function planCancellationRepair(input: {
    liveStudio: readonly WorkflowRow[]; liveKei: readonly WorkflowRow[]; parents: ReadonlyMap<string, WorkflowRow>; scopes: ScopeSnapshot
  }): { studio: string[]; kei: string[] } {
    const studio = input.liveStudio
      .filter((row) => LIVE.has(row.status) && (scopeGone(row, input.scopes) || settled(row, input.scopes)))
      .map((row) => row.workflowID)
    const stopping = new Set(studio)
    const live = new Map(input.liveStudio.map((row) => [row.workflowID, row]))
    const kei = input.liveKei.filter((row) => {
      const parentId = LIVE.has(row.status) ? keiParentOf(row.workflowID) : null
      if (parentId === null) return false                         // kei-gc and anything else are kei's own
      if (stopping.has(parentId)) return true
      const parent = live.get(parentId) ?? input.parents.get(parentId)
      return !parent || !LIVE.has(parent.status)                  // a child outliving its parent: a missed or late cancel
    }).map((row) => row.workflowID)
    return { studio: studio.sort(), kei: kei.sort() }
  }

  export function planStudioHistory(input: {
    rows: readonly WorkflowRow[]; scopes: ScopeSnapshot; nowMs: number; bootTimestampMs: number; policy: GarbagePolicy
  }): string[] {
    const { policy } = input
    const due = input.rows.filter((row) => {
      if (!TERMINAL.has(row.status) || !quiescent(row, input.bootTimestampMs)) return false
      const age = input.nowMs - endedAt(row)
      if (row.workflowID.startsWith(SWEEP_PREFIX)) return age >= policy.sweepRetentionMs
      if (scopeGone(row, input.scopes) || rowGone(row, input.scopes)) return true   // deleted scopes bypass age, not quiescence
      const interactive = INTERACTIVE_PREFIXES.some((prefix) => row.workflowID.startsWith(prefix))
      return age >= (interactive ? policy.interactiveRetentionMs : policy.backgroundRetentionMs)
    })
    return due.sort((a, b) => endedAt(a) - endedAt(b)).slice(0, policy.historyBatch).map((row) => row.workflowID)
  }

  function convertedRunOf(output: unknown): string | null {
    const parsed = keiConvertOkSchema.safeParse(output)
    return parsed.success ? parsed.data.run_id : null
  }

  export function planKeiCleanup(input: {
    kei: readonly WorkflowRow[]; parents: ReadonlyMap<string, WorkflowRow>; runHolders: readonly WorkflowRow[]
    referencedPreprocessIds: ReadonlySet<string>; extractions: ReadonlyMap<string, { settled: boolean }>
    nowMs: number; bootTimestampMs: number; policy: GarbagePolicy
  }): KeiDeleteRunsInput | null {
    const referenced = new Set<string>()
    for (const preprocessId of input.referencedPreprocessIds) {
      const run = keiRunOf(preprocessId)?.runId
      if (run) referenced.add(run)
    }
    const protectedRuns = new Set<string>()
    // Late handoffs: a Studio extraction that may still hand its run to kei keeps it (spec, *Late handoffs*) …
    for (const holder of input.runHolders) {
      const run = text(holder.attributes?.keiRunId)
      if (run && !quiescent(holder, input.bootTimestampMs)) protectedRuns.add(run)
    }
    // … and so does a kei extraction reading it now ("cleanup rechecks the run's kei children before passing it on").
    for (const row of input.kei) {
      const run = text(row.attributes?.keiRunId)
      if (run && row.workflowID.startsWith('kei-extract:') && LIVE.has(row.status)) protectedRuns.add(run)
    }
    const conversions: string[] = [], history: string[] = []
    for (const row of input.kei) {
      if (!TERMINAL.has(row.status)) continue
      const age = input.nowMs - endedAt(row)
      if (row.workflowID.startsWith('kei-gc:')) {
        if (age >= input.policy.sweepRetentionMs) history.push(row.workflowID)
        continue
      }
      const parentId = keiParentOf(row.workflowID)
      if (parentId === null || !quiescent(input.parents.get(parentId), input.bootTimestampMs)) continue
      if (row.workflowID.startsWith('kei-convert:')) {
        const run = convertedRunOf(row.output)          // null: failed or stopped, a run no revision can reference
        if (run !== null && (referenced.has(run) || protectedRuns.has(run))) continue
        conversions.push(row.workflowID)                // kei rechecks its own writers and boot boundary
      } else if (row.workflowID.startsWith('kei-extract:')) {
        const extraction = input.extractions.get(row.workflowID.slice('kei-extract:'.length))
        if (!extraction || age >= input.policy.backgroundRetentionMs) history.push(row.workflowID)
      }
    }
    if (conversions.length === 0 && history.length === 0) return null
    return { conversions: conversions.sort(), history: history.sort() }
  }

  export function planStagedSources(input: {
    files: readonly StagedSource[]; parents: ReadonlyMap<string, WorkflowRow>; children: ReadonlyMap<string, WorkflowRow>
    nowMs: number; policy: GarbagePolicy
  }): string[] {
    return input.files.filter((file) => {
      if (input.nowMs - file.modifiedMs < input.policy.fileMinAgeMs) return false
      if (file.temporary) return true
      if (file.workflowId === null) return false
      const parent = input.parents.get(file.workflowId)
      if (parent && !TERMINAL.has(parent.status)) return false                // an active attempt keeps its PDF
      const child = input.children.get(`kei-convert:${file.workflowId}`)
      return !child || !LIVE.has(child.status)                                 // kei may still be reading it
    }).map((file) => file.relative).sort()
  }

  export function planPackages(input: {
    packages: readonly { descriptor: CanonicalPackageDescriptor; modifiedMs: number }[]
    leftovers: readonly { name: string; modifiedMs: number }[]; referenced: ReadonlySet<string>; nowMs: number; policy: GarbagePolicy
  }): { packages: CanonicalPackageDescriptor[]; leftovers: string[]; modifiedBeforeMs: number } {
    const modifiedBeforeMs = input.nowMs - input.policy.fileMinAgeMs
    return {
      packages: input.packages.filter((entry) => entry.modifiedMs < modifiedBeforeMs &&
        !input.referenced.has(entry.descriptor.artifactReference)).map((entry) => entry.descriptor),
      leftovers: input.leftovers.filter((entry) => entry.modifiedMs < modifiedBeforeMs).map((entry) => entry.name),
      modifiedBeforeMs,
    }
  }
  ```

- [ ] **Step 3: Run and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio exec vitest run api/_garbage_plan.test.ts
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/api/_garbage_plan.ts prototypes/studio/api/_garbage_plan.test.ts
  git commit -m "feat(studio): decide what garbage collection cancels and deletes, as pure rules over workflow rows and references"
  ```

### Task 6: `collectGarbage`: the workflow, its registration, the ten-minute schedule on queue `gc`, and `gc:now`

**Files:**
- Create: `prototypes/studio/api/_garbage_workflow.ts`, `prototypes/studio/api/_garbage_workflow.test.ts`, `prototypes/studio/server/collectGarbageNow.ts`, `prototypes/studio/server/collectGarbageNow.test.ts`, `prototypes/studio/api/garbage_collection.postgres.test.ts`, `prototypes/studio/test/support/garbage.ts`
- Modify: `prototypes/studio/server/dbos.ts` (`GC_QUEUE`, `COLLECT_GARBAGE_SCHEDULE`, `COLLECT_GARBAGE_CRON`, the `schedule` option), `server/dbos.test.ts`, `server/workflows.ts` (+ `workflows.test.ts`), `server/host.ts` (+ test), `server/developmentHost.ts` (+ test, and `vite.config.test.ts` where the development host's launch is tested), `prototypes/studio/package.json` (`"gc:now": "tsx server/collectGarbageNow.ts"`)

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5; M4's `studioDbos()`, `databaseClockMs`, `dbosSteps`, `isWorkflowCancellation`, `createKeiHandoff`, `keiConvertWorkflowId`, `canonicalPackageStore`, `sourceInboxRoot`, `removeStagedSource`.
- Produces:
  ```ts
  // server/dbos.ts
  export const GC_QUEUE = 'gc'
  export const COLLECT_GARBAGE_SCHEDULE = 'collectGarbage'
  export const COLLECT_GARBAGE_CRON = '*/10 * * * *'
  // StudioDbosOptions gains: schedule?: () => Promise<void>   // called after the queues are registered; only hosts pass it
  // api/_garbage_workflow.ts
  export const COLLECT_GARBAGE = 'collectGarbage'
  export type GarbagePorts = Readonly<{
    steps: WorkflowSteps
    bootTimestampMs(): number
    clock(): Promise<number>                                        // the database clock, ms
    studio: Pick<DBOSClient, 'listWorkflows' | 'cancelWorkflow' | 'deleteWorkflows'>
    kei: Pick<DBOSClient, 'listWorkflows' | 'cancelWorkflow'>
    keiHandoff: Pick<KeiHandoff, 'requestDeleteRuns'>
    references: GarbageReferences
    packages: Pick<CanonicalPackageStore, 'list' | 'leftovers' | 'remove' | 'removeLeftover'>
    inbox: Readonly<{ root: string; list(root: string): Promise<readonly StagedSource[]>; remove(root: string, relative: string): Promise<void> }>
    policy: GarbagePolicy
    log(line: string): void
  }>
  export type GarbageSummary = Readonly<{
    cancelledStudio: string[]; cancelledKei: string[]; deletedStudioHistory: number
    keiRequest: Readonly<{ workflowId: string; conversions: string[]; history: string[] }> | null
    removedStagedSources: number; removedPackages: number; removedLeftovers: number; failedPhases: string[]
  }>
  export function collectGarbageWorkflow(scheduledTime: Date, ports: GarbagePorts): Promise<GarbageSummary>
  export function registerGarbageWorkflow(ports: () => GarbagePorts): (scheduledTime: Date, context: unknown) => Promise<GarbageSummary>
  export function garbagePorts(overrides?: Partial<GarbagePorts>): GarbagePorts
  // server/workflows.ts
  export function registerStudioWorkflows(options?: { garbagePorts?: () => GarbagePorts }): void
  export function applyStudioSchedules(): Promise<void>
  // server/collectGarbageNow.ts
  export function collectGarbageNow(databaseUrl: string, create?: typeof DBOSClient.create): Promise<{ workflowId: string; summary: GarbageSummary }>
  // test/support/garbage.ts
  export function backdateWorkflow(url: string, schema: string, workflowId: string, byMs: number): Promise<void>   // completed_at only
  export function ageFile(path: string, byMs: number): Promise<void>                                             // utimes, recursively for a directory
  export function orphanPayloadRows(url: string, schema: string): Promise<number>
  ```

- [ ] **Step 1: Write the failing unit tests**

  `api/_garbage_workflow.test.ts` (fake ports: `steps.step(name, run)` runs at once and records `name`; `studio`/`kei` fakes answer `listWorkflows` from in-memory rows and record every call — reads, `cancelWorkflow`, `deleteWorkflows` — into one ordered `calls` array; `references`, `packages`, `inbox` are recording fakes):
  - `runs the phases in order after reading the clock once, as named steps` (step names `clock`, `repairCancellations`, `studioHistory`, `keiRunsAndHistory`, `stagedSources`, `packages`).
  - `reads every status and reference of a phase before it deletes or cancels anything` (Review Focus 3: within each phase, no mutation in `calls` precedes that phase's last read).
  - `reads the Studio parents before the domain references in the kei phase` (spec *kei runs and history*: the kei listing, then the parent listing, then the `extract:` holder listing, then `referencedPreprocessIds`).
  - `cancels only workflows that are still live when it gets to them` (a row planned for cancellation that a re-read shows `CANCELLED` is not cancelled again).
  - `a failed phase is reported by name and the next phases still run; its error message is not logged` (`references.scopes` rejects with an `Error('postgresql://u:secret@h/db')`: `failedPhases` is `['repairCancellations', 'studioHistory', 'keiRunsAndHistory']`, the staged and package phases ran, no `cancelWorkflow`/`deleteWorkflows`/`requestDeleteRuns` happened, and the logged lines contain `Error` but not `secret`).
  - `a workflow cancellation is rethrown, not reported as a failed phase` (a step rejects with an error for which `isWorkflowCancellation` is true).
  - `asks kei once, under kei-gc:<scheduled time>, and never when the plan is empty`.
  - `deletes Studio history in batches of at most 100`.
  `server/dbos.test.ts`: extend `reads the boot timestamp from the database clock, then registers workflows, then launches, then registers the queues` so the order becomes `[…, 'registerQueue:studio', 'registerQueue:suggest', 'registerQueue:gc', 'schedule', 'client:studio:dbos', 'client:kei:kei_dbos']` when `schedule` is passed (with `('gc', { globalConcurrency: 1 })`), and add `does not schedule anything unless a host asks` (no `schedule` option → never called).
  `server/workflows.test.ts`: `registers collectGarbage under its name and applies its schedule every ten minutes on the gc queue without backfill` (`DBOS.applySchedules` spy called once with `[{ scheduleName: 'collectGarbage', workflowFn: <the handle registerWorkflow returned for collectGarbage>, schedule: '*/10 * * * *', queueName: 'gc', automaticBackfill: false }]`); `applyStudioSchedules refuses to run before registration`.
  `server/host.test.ts` and the development host tests: `the host launches DBOS with the schedule` (the `launchStudioDbos` spy receives `schedule === applyStudioSchedules`).
  `server/collectGarbageNow.test.ts`: `triggers the collectGarbage schedule as Studio and returns the sweep's summary` (fake `create` receives `{ systemDatabaseUrl, systemDatabaseSchemaName: 'dbos', applicationName: 'studio', systemDatabasePoolSize: 1 }`; `triggerSchedule('collectGarbage')`; `getResult()`; `destroy()` called); `destroys the client and reports only the error's class when the sweep fails`.
  Run: `pnpm --filter studio exec vitest run api/_garbage_workflow.test.ts server/dbos.test.ts server/workflows.test.ts server/host.test.ts server/collectGarbageNow.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement the workflow** (`api/_garbage_workflow.ts`)

  ```ts
  import { DBOS, type DBOSClient, type WorkflowStatus } from '@dbos-inc/dbos-sdk'
  import { canonicalPackageStore, createGarbageReferences, EMPTY_SCOPE_IDS, type CanonicalPackageStore, type GarbageReferences } from 'db'
  import { createKeiHandoff, keiConvertWorkflowId, keiGcWorkflowId, type KeiDeleteRunsInput, type KeiHandoff } from 'extraction/kei-handoff'
  import { dbosSteps, isWorkflowCancellation, type WorkflowSteps } from 'extraction/workflows'
  import { COLLECT_GARBAGE_SCHEDULE, databaseClockMs, studioDbos } from '../server/dbos.js'
  import {
    GC_POLICY, LIVE_STATUSES, STUDIO_WORKFLOW_PREFIXES, SWEEP_PREFIX, TERMINAL_STATUSES, keiParentOf, planCancellationRepair,
    planKeiCleanup, planPackages, planStagedSources, planStudioHistory, scopeIdsOf, type GarbagePolicy, type WorkflowRow,
  } from './_garbage_plan.js'
  import { listStagedSources, removeStagedSource, sourceInboxRoot, type StagedSource } from './_source_inbox.js'

  export const COLLECT_GARBAGE = 'collectGarbage'
  const NO_DATA = { loadInput: false, loadOutput: false } as const

  const rows = (statuses: readonly WorkflowStatus[]): WorkflowRow[] =>
    statuses.map(({ workflowID, status, updatedAt, completedAt, attributes, output }) =>
      ({ workflowID, status, updatedAt, completedAt, attributes, output }))
  const byId = (list: readonly WorkflowRow[]) => new Map(list.map((row) => [row.workflowID, row]))
  const unique = (values: readonly (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))]
  const listed = async (client: Pick<DBOSClient, 'listWorkflows'>, workflowIDs: string[]) =>
    workflowIDs.length === 0 ? [] : rows(await client.listWorkflows({ workflowIDs, ...NO_DATA }))

  /** Cancels `id` only while it is still live: cancelling a CANCELLED row again moves its updatedAt past this boot, and
   *  its cleanup would then wait for yet another restart (system_database.js:1321-1328). */
  async function cancelIfLive(client: Pick<DBOSClient, 'listWorkflows' | 'cancelWorkflow'>, id: string): Promise<boolean> {
    const [row] = await listed(client, [id])
    if (!row || !(LIVE_STATUSES as readonly string[]).includes(row.status)) return false
    await client.cancelWorkflow(id)
    return true
  }

  export async function repairCancellations(ports: GarbagePorts): Promise<{ studio: string[]; kei: string[] }> {
    // Every read first: a failed read throws here and nothing is cancelled.
    const liveStudio = rows(await ports.studio.listWorkflows({ workflow_id_prefix: [...STUDIO_WORKFLOW_PREFIXES], status: [...LIVE_STATUSES], ...NO_DATA }))
    const liveKei = rows(await ports.kei.listWorkflows({ workflowName: ['convert', 'extract'], status: [...LIVE_STATUSES], ...NO_DATA }))
    const parents = byId(await listed(ports.studio, unique(liveKei.map((row) => keiParentOf(row.workflowID)))))
    const scopes = await ports.references.scopes(scopeIdsOf(liveStudio))
    const plan = planCancellationRepair({ liveStudio, liveKei, parents, scopes })
    const studio: string[] = [], kei: string[] = []
    for (const id of plan.studio) if (await cancelIfLive(ports.studio, id)) studio.push(id)
    for (const id of plan.kei) if (await cancelIfLive(ports.kei, id)) kei.push(id)
    return { studio, kei }
  }

  export async function collectStudioHistory(ports: GarbagePorts, nowMs: number): Promise<number> {
    const terminal = rows(await ports.studio.listWorkflows({
      workflow_id_prefix: [...STUDIO_WORKFLOW_PREFIXES, SWEEP_PREFIX], status: [...TERMINAL_STATUSES], ...NO_DATA,
    }))
    const scopes = await ports.references.scopes(scopeIdsOf(terminal))
    const due = planStudioHistory({ rows: terminal, scopes, nowMs, bootTimestampMs: ports.bootTimestampMs(), policy: ports.policy })
    for (let start = 0; start < due.length; start += 100) await ports.studio.deleteWorkflows(due.slice(start, start + 100))
    return due.length
  }

  export async function collectKei(ports: GarbagePorts, nowMs: number, workflowId: string): Promise<KeiDeleteRunsInput | null> {
    // Parents before references (spec, *kei runs and history*): a parent read as quiescent can publish no reference
    // after this, so a reference read afterwards is complete for it; the reverse order could miss a late publication.
    const kei = rows(await ports.kei.listWorkflows({ workflowName: ['convert', 'extract', 'deleteRuns'], loadInput: false, loadOutput: true }))
    const parents = byId(await listed(ports.studio, unique(kei.map((row) => keiParentOf(row.workflowID)))))
    const runHolders = rows(await ports.studio.listWorkflows({
      workflow_id_prefix: 'extract:', status: [...LIVE_STATUSES, 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'], ...NO_DATA,
    }))
    const referencedPreprocessIds = await ports.references.referencedPreprocessIds()
    const extractionIds = kei.filter((row) => row.workflowID.startsWith('kei-extract:')).map((row) => row.workflowID.slice('kei-extract:'.length))
    const { extractions } = await ports.references.scopes({ ...EMPTY_SCOPE_IDS, extractionIds })
    const request = planKeiCleanup({ kei, parents, runHolders, referencedPreprocessIds, extractions, nowMs,
      bootTimestampMs: ports.bootTimestampMs(), policy: ports.policy })
    if (request) await ports.keiHandoff.requestDeleteRuns(workflowId, request)
    return request
  }

  export async function collectStagedSources(ports: GarbagePorts, nowMs: number): Promise<number> {
    const files = await ports.inbox.list(ports.inbox.root)
    const workflowIds = unique(files.map((file) => file.workflowId))
    const parents = byId(await listed(ports.studio, workflowIds))
    const children = byId(await listed(ports.kei, workflowIds.map(keiConvertWorkflowId)))
    const doomed = planStagedSources({ files, parents, children, nowMs, policy: ports.policy })
    for (const relative of doomed) await ports.inbox.remove(ports.inbox.root, relative)
    return doomed.length
  }

  export async function collectPackages(ports: GarbagePorts, nowMs: number): Promise<{ packages: number; leftovers: number }> {
    const [packages, leftovers] = await Promise.all([ports.packages.list(), ports.packages.leftovers()])
    const referenced = await ports.references.referencedPackages(packages.map((entry) => entry.descriptor.artifactReference))
    const plan = planPackages({ packages, leftovers, referenced, nowMs, policy: ports.policy })
    let removed = 0
    for (const descriptor of plan.packages) {
      const gone = await ports.packages.remove(descriptor,
        () => ports.references.packageIsReferenced(descriptor.artifactReference), { modifiedBeforeMs: plan.modifiedBeforeMs })
      if (gone) removed += 1
    }
    for (const name of plan.leftovers) await ports.packages.removeLeftover(name)
    return { packages: removed, leftovers: plan.leftovers.length }
  }

  export async function collectGarbageWorkflow(scheduledTime: Date, ports: GarbagePorts): Promise<GarbageSummary> {
    const nowMs = await ports.steps.step('clock', () => ports.clock())
    const failedPhases: string[] = []
    // One step per phase: its reads and deletions are one checkpoint, so a recovered sweep reruns only the phase that
    // was running. A phase that fails deleted nothing it had not already checked, and the others still run.
    async function phase<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> {
      try {
        return await ports.steps.step(name, run, { retriesAllowed: false })
      } catch (error) {
        if (isWorkflowCancellation(error)) throw error
        failedPhases.push(name)
        // The class only: a driver's message can quote a database URL.
        ports.log(`collectGarbage: ${name} failed (${error instanceof Error ? error.name : 'unknown error'}); the next sweep retries it`)
        return fallback
      }
    }
    const repaired = await phase('repairCancellations', () => repairCancellations(ports), { studio: [], kei: [] })
    const deletedStudioHistory = await phase('studioHistory', () => collectStudioHistory(ports, nowMs), 0)
    const keiWorkflowId = keiGcWorkflowId(scheduledTime)
    const request = await phase('keiRunsAndHistory', () => collectKei(ports, nowMs, keiWorkflowId), null)
    const removedStagedSources = await phase('stagedSources', () => collectStagedSources(ports, nowMs), 0)
    const packages = await phase('packages', () => collectPackages(ports, nowMs), { packages: 0, leftovers: 0 })
    return {
      cancelledStudio: repaired.studio, cancelledKei: repaired.kei, deletedStudioHistory,
      keiRequest: request && { workflowId: keiWorkflowId, conversions: request.conversions, history: request.history },
      removedStagedSources, removedPackages: packages.packages, removedLeftovers: packages.leftovers, failedPhases,
    }
  }

  export function registerGarbageWorkflow(ports: () => GarbagePorts) {
    return DBOS.registerWorkflow(
      (scheduledTime: Date, _context: unknown) => collectGarbageWorkflow(new Date(scheduledTime), ports()),
      { name: COLLECT_GARBAGE },
    )
  }

  export function garbagePorts(overrides: Partial<GarbagePorts> = {}): GarbagePorts {
    const launched = studioDbos()
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new Error('DATABASE_URL is required for garbage collection.')
    return {
      steps: dbosSteps,
      bootTimestampMs: () => launched.bootTimestampMs,
      clock: () => databaseClockMs(databaseUrl),
      studio: launched.admission,
      kei: launched.kei,
      keiHandoff: createKeiHandoff(launched.kei),
      references: createGarbageReferences(),
      packages: canonicalPackageStore,
      inbox: { root: sourceInboxRoot(), list: listStagedSources, remove: removeStagedSource },
      policy: GC_POLICY,
      log: (line) => console.warn(line),
      ...overrides,
    }
  }
  ```
  (`COLLECT_GARBAGE_SCHEDULE` is imported for the `gc:now` command's and the tests' use; drop the import if nothing in this module needs it.)

- [ ] **Step 3: Wire registration, schedule and hosts**

  `server/dbos.ts`: add the three constants; `StudioDbosOptions` gains `schedule?: () => Promise<void>` with the comment `/** Applies the Studio schedules after the queues exist (applyStudioSchedules). Only a host passes it, so a test process that launches Studio's DBOS never sweeps. */`; in `start()` after `registerQueue(SUGGEST_QUEUE, …)`:
  ```ts
  await DBOS.registerQueue(GC_QUEUE, { globalConcurrency: 1 }) // sweeps never overlap
  await options.schedule?.()
  ```
  `server/workflows.ts`: append `COLLECT_GARBAGE` to `STUDIO_WORKFLOW_NAMES`; `registerStudioWorkflows(options: { garbagePorts?: () => GarbagePorts } = {})` registers every M4/M5 workflow as today and then `collectGarbage = registerGarbageWorkflow(options.garbagePorts ?? (() => garbagePorts()))`; and
  ```ts
  export async function applyStudioSchedules(): Promise<void> {
    if (!collectGarbage) throw new Error('applyStudioSchedules runs after registerStudioWorkflows.')
    // Stored in the system database; applying it again at every boot replaces the same definition. No backfill: a
    // Studio that was down for a day runs one sweep, not 144.
    await DBOS.applySchedules([{
      scheduleName: COLLECT_GARBAGE_SCHEDULE, workflowFn: collectGarbage, schedule: COLLECT_GARBAGE_CRON,
      queueName: GC_QUEUE, automaticBackfill: false,
    }])
  }
  ```
  `server/host.ts` passes `schedule: applyStudioSchedules` beside `register: registerStudioWorkflows`; `server/developmentHost.ts` passes `schedule: workflows.applyStudioSchedules` from the module it already loads with `ssrLoadModule('/server/workflows.ts')`.
  `server/collectGarbageNow.ts`:
  ```ts
  import { pathToFileURL } from 'node:url'
  import { DBOSClient } from '@dbos-inc/dbos-sdk'
  import type { GarbageSummary } from '../api/_garbage_workflow.js'
  import { COLLECT_GARBAGE_SCHEDULE, STUDIO_APPLICATION, STUDIO_SCHEMA } from './dbos.js'

  /** Runs one sweep now and waits for it: `docker compose exec -T studio pnpm --filter studio gc:now`. The running
   *  Studio executes it (the schedule belongs to its application); this process only enqueues and reads. */
  export async function collectGarbageNow(databaseUrl: string, create = DBOSClient.create) {
    const client = await create({ systemDatabaseUrl: databaseUrl, systemDatabaseSchemaName: STUDIO_SCHEMA,
      systemDatabasePoolSize: 1, applicationName: STUDIO_APPLICATION })
    try {
      const handle = await client.triggerSchedule(COLLECT_GARBAGE_SCHEDULE)
      return { workflowId: handle.workflowID, summary: (await handle.getResult()) as GarbageSummary }
    } finally {
      await client.destroy()
    }
  }

  if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) {
      console.error('DATABASE_URL is required.')
      process.exit(2)
    }
    collectGarbageNow(databaseUrl).then(
      (result) => console.log(JSON.stringify(result)),
      (error: unknown) => {
        console.error(`collectGarbage failed: ${error instanceof Error ? error.name : 'unknown error'}`)
        process.exit(1)
      },
    )
  }
  ```
  (If `STUDIO_APPLICATION` or `STUDIO_SCHEMA` moved out of `server/dbos.ts` during M4, import them from where they now live.)

- [ ] **Step 4: Write the PostgreSQL tests and their support** (`api/garbage_collection.postgres.test.ts`; one DBOS launch per file on `testSchemas()`, `launchStudioDbos({ …, register: () => registerStudioWorkflows({ garbagePorts: () => garbagePorts(overrides) }), schedule: applyStudioSchedules })` with a mutable `overrides` object the tests set; a spawned stand-in on the file's kei schema; `XDG_DATA_HOME` and `FREE_SOURCE_INBOX` under a temporary directory set before any import; sweeps run with `DBOS.triggerSchedule('collectGarbage')` and `await handle.getResult()`)

  `test/support/garbage.ts`:
  ```ts
  /** Makes a settled workflow look older. Disposable test schemas only (the guard below); updated_at is left alone,
   *  because it is what the boot boundary compares. */
  export async function backdateWorkflow(url: string, schema: string, workflowId: string, byMs: number): Promise<void> {
    if (!/^(dbos|kei_dbos)_t_[0-9a-f]{8}$/.test(schema)) throw new Error(`Refusing to backdate in ${schema}.`)
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      await client.query(`UPDATE "${schema}".workflow_status SET completed_at = completed_at - $1 WHERE workflow_uuid = $2`, [byMs, workflowId])
    } finally {
      await client.end()
    }
  }
  export async function ageFile(path: string, byMs: number): Promise<void> {
    const then = new Date(Date.now() - byMs)
    const info = await lstat(path)
    if (info.isDirectory()) for (const entry of await readdir(path)) await ageFile(join(path, entry), byMs)
    await utimes(path, then, then)
  }
  /** Rows in a system schema's payload tables whose workflow no longer exists (they have no foreign key). */
  export async function orphanPayloadRows(url: string, schema: string): Promise<number> {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      const { rows: tables } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = $1 AND column_name = 'workflow_uuid' AND table_name <> 'workflow_status'`, [schema])
      let orphans = 0
      for (const { table_name } of tables) {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*) FROM "${schema}"."${table_name}" t
            WHERE NOT EXISTS (SELECT 1 FROM "${schema}".workflow_status s WHERE s.workflow_uuid = t.workflow_uuid)`)
        orphans += Number(rows[0]!.count)
      }
      return orphans
    } finally {
      await client.end()
    }
  }
  ```
  Tests:
  - `launch applies the collectGarbage schedule on the gc queue every ten minutes, without backfill` (`DBOS.getSchedule('collectGarbage')` has `schedule: '*/10 * * * *'`, `queueName: 'gc'`, `automaticBackfill: false`; `DBOS.listSchedules()` names only it).
  - `a triggered sweep over an empty store finishes with no failed phase and asks kei for nothing` (`summary.failedPhases` is `[]`, `keiRequest` is null; the sweep's own workflow ran on queue `gc`).
  - `a sweep cancels a live runExtraction whose Extraction already has an outcome, and its kei child` (admit an Extraction with the stand-in holding its extraction; write the `cancelled` outcome directly through the store's conditional terminal write, without the cancel route's DBOS calls — a missed cancel; sweep: `extract:<id>` and `kei-extract:<id>` are `CANCELLED`, and `summary.cancelledStudio`/`cancelledKei` name them).
  - `a sweep never cancels a workflow twice: a cancelled workflow's updatedAt does not move` (Review Focus 2: after the previous case, record both rows' `updatedAt`; run three more sweeps; both unchanged).
  - `a failed reference read deletes nothing in its phase and the other phases still run` (Review Focus 3, A8: an `ingest:` workflow for a random project finishes (its project never existed, so its scope is gone), an old unreferenced package and an old orphan staged file exist; set `overrides.references` to a wrapper whose `scopes` rejects; sweep: `failedPhases` names the three phases that read scopes, the `ingest:` history is still there, the stand-in recorded no `deleteRuns`, and the package and the staged file are gone; clear the override; the next sweep deletes the `ingest:` history).
  - `a failed status read deletes nothing` (A8: `overrides.studio` whose `listWorkflows` rejects: nothing cancelled or deleted in any phase that lists Studio workflows; the stand-in recorded no `deleteRuns`).
  Run: `pnpm --filter studio exec vitest run --config vitest.postgres.config.ts api/garbage_collection.postgres.test.ts`. Expected: PASS after Steps 2–3 (write the file before Step 2 and confirm it fails first).

- [ ] **Step 5: Run and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test && pnpm --filter studio test:postgres
  pnpm --filter studio test:e2e
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/api/_garbage_workflow.ts prototypes/studio/api/_garbage_workflow.test.ts prototypes/studio/api/garbage_collection.postgres.test.ts \
    prototypes/studio/server prototypes/studio/test/support/garbage.ts prototypes/studio/package.json prototypes/studio/vite.config.test.ts
  git commit -m "feat(studio): collect garbage every ten minutes on its own queue, repair missed cancels, and run a sweep on demand"
  ```

### Task 7: Garbage-collection acceptance on the Studio PostgreSQL tier: late handoff, the boot boundary, deleted projects, staged uploads

Every case here crosses a Studio restart or a held kei step, so it runs through the crash harness (M4 Task 1): a child process launches Studio's DBOS on the file's schemas with the same executor, runs a scenario, and exits or is killed; the parent restarts it. The stand-in is spawned by the parent test, so it outlives Studio's restarts.

**Files:**
- Create: `prototypes/studio/api/garbage_acceptance.postgres.test.ts`, `prototypes/studio/test/support/scenarios/gc-late-handoff.ts`, `gc-cancelled-history.ts`, `gc-missed-cancel.ts`, `gc-deleted-project.ts`, `gc-staged-sources.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 6; M4's crash harness (`runWorkflowChild(scenario, env)`, scenario contract `run({ firstRun, env })`), `spawnKeiStandIn` and its `policy`/`held`/`answer`/`deleteRunsRequests`, M4's ingestion and extraction admission helpers used by `api/source_ingestion.postgres.test.ts` and `extraction-module.integration.test.ts`, M4 Task 12's `cancelScopeWork`, the store's `deleteSourceDocument`/`deleteProjectContext`.
- Produces: the scenarios; nothing later tasks import.

- [ ] **Step 1: Write the scenarios and the failing tests**

  Every scenario launches with `schedule: applyStudioSchedules` and sweeps with `DBOS.triggerSchedule('collectGarbage')` + `getResult()`; it writes what it observed as one JSON line to the file named by `env.GC_OBSERVATIONS`, which the parent test reads. Workflow data is created through Studio's own admission paths (ingestion through the stand-in with policy `auto`, extraction admission through the extraction module) so every kei row carries its parent's attributes and every revision's `preprocessId` names the stand-in's run.
  - `late handoff: a run whose extraction handoff was held survives every sweep until a Studio restart, and the late kei child is cancelled` (A4, Studio's half; protection by a *live* kei child naming the run is proved by Task 5's `protects a run while a kei-extract child naming it is live`, because here repair cancels the late child earlier in the same sweep; `gc-late-handoff.ts`). First run: ingest a document (conversion `W`, run `R`); admit an Extraction whose `kei.submit` port waits for the file `env.GC_LATCH` before calling through (the scenario wraps the production handoff); wait for the wrapper's "entered" marker; delete the source through the store and `cancelScopeWork` exactly as the handler does (the parent `extract:<id>` becomes `CANCELLED` in this process); sweep → no recorded request names `W`; create the latch; wait until `kei-extract:<id>` exists and is `PENDING` (the late submission, held by the stand-in's extract policy `hold`); `backdateWorkflow` everything by 60 days; sweep → still no `W` (the parent is stopped in this process and the child is live), and repair cancelled the late child; exit. Second run (a new boot): sweep → `W` is named now (the parent is quiescent and no kei child naming `R` is live), and never before: every request naming `W` has `receivedAtMs` after the second child's start, which the observations record. kei's half — the late extraction's still-running step keeps `R` until *kei* restarts — is `test_delete_runs.py` › `test_a_run_an_unfinished_extraction_reads_is_kept` (rewritten to the conversions contract in Task 1) and Task 8's blocked-step spec.
  - `current-process cancelled history survives any age; after a restart it goes, and no checkpoint is left orphaned` (A6, A2 Studio side; `gc-cancelled-history.ts`). First run: start a `suggestSchemaBatch` attempt whose generate port ignores its abort signal and blocks until `env.GC_LATCH` exists (so its step outlives the cancel); cancel `suggest:<id>:1`; `backdateWorkflow` it by 60 days; delete its project (a deleted scope); sweep → its history is still there; create the latch; wait for the port's "returned" marker file, then 2 s more, so whatever DBOS records for the returning step has been written; sweep → still there (cancelled in this process); exit. Second run: sweep → gone; `orphanPayloadRows(url, schema) === 0`. The test also asserts no in-place relaunch happens: the child's `launchStudioDbos` is called once per process (the harness counts launches in the observations).
  - `a cancel written before a crash is carried to the workflow and its kei child by the next sweep` (A7; `gc-missed-cancel.ts`). First run: admit an Extraction with the stand-in holding its kei extraction; call the extraction module's cancel with a hook that SIGKILLs the child right after the `cancelled` outcome commits and before any DBOS cancel. Second run: the recovered `extract:<id>` is live and its kei child is live; sweep → both `CANCELLED`; the Extraction still reads `FAILED`/`cancelled`, written once. A7's "any late kei submission" — a child enqueued after its parent stopped — is the late-handoff case above, where the next sweep cancels it.
  - `after project deletion a sweep deletes the scope's settled history in both schemas, keeps its current-process cancelled history, and names only what is quiescent` (A8; `gc-deleted-project.ts`). First run: ingest a document; run one Extraction to `COMPLETED` (stand-in `auto`) and admit a second one held by the stand-in; delete the project (store + `cancelScopeWork`: the held one becomes `CANCELLED` in this process); sweep → the `ingest:` and the completed `extract:` histories are gone, the cancelled `extract:` history remains; the stand-in's request is exactly `{ conversions: [], history: ['kei-extract:<completed id>'] }` (the conversion's run is still protected by the cancelled-in-process holder); exit. Second run: sweep → the cancelled `extract:` history is gone and the request is `{ conversions: ['kei-convert:ingest:<p>:<a>'], history: ['kei-extract:<cancelled id>'] }`.
  - `a file staged before a crash that never enqueued is removed once it is old` (A9; `gc-staged-sources.ts`): `stageSource(root, uploadSourcePath(p, a), bytes)` with no workflow, `ageFile` 25 h, sweep → removed; the same file 23 h old → kept.
  - `a file whose ingestion was recovered after a crash is kept while it runs, however old` (A9): an upload admitted with the stand-in's convert policy `hold`; SIGKILL the child after the enqueue; restart; `ageFile` 48 h; sweep → kept (its workflow is live and so is `kei-convert:ingest:<p>:<a>`); answer the stand-in → the ingestion finishes and removes its own file; sweep → nothing left to remove.
  - `the losing upload of a deduplication race leaves only its own file for collection, never the winner's` (A9): two same-content uploads race (the M4 race helper); the winner's workflow is held by the stand-in; stage a third file under a fresh attempt ID with no workflow (a loser whose clean-up was lost); `ageFile` both 25 h; sweep → the loser's file is removed and the winner's file is kept.
  - `a held ingestion's conversion, a held extraction's run and a fresh package survive a sweep` (A1): with an ingestion and an extraction held by the stand-in and a package saved 1 h ago that no revision references yet, a sweep names neither conversion nor run to kei, and the package is still `available`.
  Run: `pnpm --filter studio exec vitest run --config vitest.postgres.config.ts api/garbage_acceptance.postgres.test.ts`. Expected: FAIL before the scenarios exist; PASS after them (Tasks 1–6 already implement the behaviour; a failure here is a defect to fix in the task that owns the rule, not in the test).

- [ ] **Step 2: Run and commit**

  ```bash
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test:postgres
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add prototypes/studio/api/garbage_acceptance.postgres.test.ts prototypes/studio/test/support/scenarios
  git commit -m "test(studio): prove late handoffs, the boot boundary, deleted projects and staged uploads under garbage collection"
  ```

### Task 8: Garbage-collection acceptance across real kei-worker processes

**Files:**
- Modify: `prototypes/parsing_service/tests/test_worker_recovery.py`
- Create: `prototypes/studio/e2e/real-service-gc.spec.ts`
- Modify: `prototypes/studio/e2e/realService.ts` (helpers below), `prototypes/studio/playwright.service.config.ts` (`testMatch: ['real-service.spec.ts', 'real-service-gc.spec.ts']`), `prototypes/studio/playwright.config.ts` (`testIgnore` gains `real-service-gc.spec.ts`)

**Interfaces:**
- Consumes: Tasks 1, 6; M4 Task 13's `startRealService(logFile)` (`url`, `runs`, `restart()`, `killWorker()`, `holdNextExtraction()`, `releaseExtraction()`, `keiWorkflows(prefix)`, `close()`); Task 6's `orphanPayloadRows`.
- Produces (`realService.ts` gains): `collectGarbage(): Promise<GarbageSummary>` (a `DBOSClient` as application `studio` on the service database's `dbos` schema, `triggerSchedule('collectGarbage')`, `getResult()`), `studioWorkflows(prefix): Promise<WorkflowStatus[]>`, `cancelKeiWorkflow(id): Promise<void>` (the kei client), `ageRun(runId, byMs): Promise<void>` (`ageFile` over `<runs>/<runId>`), `runExists(runId): Promise<boolean>`, `orphanPayloadRows(schema: 'dbos' | 'kei_dbos'): Promise<number>`.

- [ ] **Step 1: Write the failing kei test** (`tests/test_worker_recovery.py`, using `site`)

  ```python
  def test_a_conversion_past_its_recovery_attempts_keeps_its_run_until_the_next_kei_restart(site):
      """A5. Every crash of the worker re-executes the conversion's native call; past max_recovery_attempts DBOS stops
      recovering it. Its step may be the last thing that process ran, so its run waits for another kei boot."""
      paths, start, kei, _ = site
      sha = kei_helper.stage_pdf(paths["inbox"], "m.pdf", mask())
      workflow_id = "kei-convert:ingest:p:m"
      worker = start()
      kei().enqueue("convert", config.CONVERT_SMALL, workflow_id, kei_helper.convert_request("m.pdf", sha, model="fake", cut="none"))
      for attempt in range(1, config.MAX_RECOVERY_ATTEMPTS + 2):
          if kei().row(workflow_id)["status"] == "MAX_RECOVERY_ATTEMPTS_EXCEEDED":
              break
          kei_helper.until(lambda: (paths["control"] / f"started-{attempt}").exists(), 120, f"native call {attempt}")
          worker.kill()
          worker = start()
      status = final(kei(), workflow_id)
      assert status.status == "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
      run_id = runs.run_id_for(workflow_id)
      age(paths["runs"] / run_id)                        # tests.test_delete_runs.age, imported
      first = delete_through(kei(), [workflow_id], "kei-gc:max-1")
      assert first["kept_runs"] == [run_id] and first["kept_history"] == [workflow_id]
      worker.kill()
      start()                                            # a new boot: the exhausted workflow's steps have ended
      second = delete_through(kei(), [workflow_id], "kei-gc:max-2")
      assert second["deleted_runs"] == [run_id] and second["deleted_history"] == [workflow_id]
      assert not (paths["runs"] / run_id).exists()
  ```
  with `delete_through(kei, conversions, workflow_id)` enqueueing `deleteRuns` on `config.GC` through the client and returning `final(kei, workflow_id).output` (`config.MAX_RECOVERY_ATTEMPTS` is 5, `workflows/config.py:22`; import `runs` and `test_delete_runs.age`).
  Run: `PARSING_TEST_DATABASE_URL=… UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest -q tests/test_worker_recovery.py -k recovery_attempts`. Expected: PASS once Task 1 is in (it pins behaviour that Task 1 already implements end to end; it fails on today's `runs` contract).

- [ ] **Step 2: Write the real-service specs** (`e2e/real-service-gc.spec.ts`, serial, the harness of `real-service.spec.ts`; each test uploads its own generated PDF through authenticated FREE so its run is new)
  - `a deleted project's run, its kei history and its Studio history go in one sweep, without a kei restart` (A3 "runs that ended normally", A8): upload a PDF, run an Article extraction to `COMPLETED`, read the run ID from the kei conversion's output (`keiWorkflows('kei-convert:')`), delete the project (204); `ageRun(runId, 25 h)`; `collectGarbage()`; poll the named `kei-gc:` workflow to `SUCCESS`: `runExists(runId)` is false; `keiWorkflows('kei-convert:ingest:<project>')` and `keiWorkflows('kei-extract:<id>')` are empty; `studioWorkflows('ingest:<project>')` and `studioWorkflows('extract:<id>')` are empty.
  - `a cancelled extraction blocked in its native step keeps its run and history through every sweep until kei restarts; afterwards nothing in kei_dbos is orphaned` (A3 cancelled, A2 kei side; skipped when `FREE_REAL_EXTRACT_URL` is set, as the other hold-based tests are): upload; `holdNextExtraction()`; POST an extraction; wait for `kei-extract:<id>` `PENDING`; `cancelKeiWorkflow('kei-extract:<id>')` (kei's own cancel: Studio's parent then settles `cancelled` and ends normally, so only kei's boot boundary is under test); delete the project; `ageRun(runId, 25 h)`; `collectGarbage()` twice → `runExists(runId)` stays true and `kei-extract:<id>` still exists; `releaseExtraction()`; wait until the kei step has returned (its `operation_outputs` row for the step exists, or the worker log's step-failure line); `collectGarbage()` → still kept; `killWorker()` (a new kei boot); `collectGarbage()`; poll → the run and both kei histories are gone, and `orphanPayloadRows('kei_dbos') === 0`.
  - `a sweep during a large conversion on another lane leaves its files; the conversion completes` (A3 lanes): upload and delete a small project so a run is due (aged); start a 40-page upload without awaiting it; wait for its `kei-convert:` row `PENDING` on `kei-convert-large`; `collectGarbage()`; the due run is gone; the large upload answers 201; its conversion is `SUCCESS` and its Source Document opens with 40 pages.
  - `a sweep during a held extraction leaves its run and history` (A1): `holdNextExtraction()`; POST an extraction; while it is held, `collectGarbage()` (nothing about it is named: the `kei-gc:` request, if any, lists neither its conversion nor its `kei-extract:`); release; it completes and publishes.
  Run: `pnpm test:service`. Expected: PASS once Step 3 adds the helpers.

- [ ] **Step 3: Implement the harness helpers** in `realService.ts` as listed under *Interfaces* (reuse the kei client M4 Task 13 creates for `keiWorkflows`; create one Studio client the same way, destroyed in `close()`), and the config changes.

- [ ] **Step 4: Run and commit**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6/prototypes/parsing_service
  PARSING_TEST_DATABASE_URL=$PARSING_TEST_DATABASE_URL UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync pytest -q tests/test_worker_recovery.py
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  pnpm test:service
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test:e2e
  git add prototypes/parsing_service/tests/test_worker_recovery.py prototypes/studio/e2e/real-service-gc.spec.ts prototypes/studio/e2e/realService.ts \
    prototypes/studio/playwright.service.config.ts prototypes/studio/playwright.config.ts
  git commit -m "test(studio): prove garbage collection against the real kei worker: restarts, lanes, held steps, recovery exhaustion"
  ```
  If this host cannot run `test:service`, say so in the report; never report it as passed.

### Task 9: Test wiring: `test:system` against today's stack, and pins for what CI already runs

**Files:**
- Modify: `tests/helpers.mjs` (`ensureStackUp`, `compose`, a port check), `tests/contract.test.mjs`
- Modify: `scripts/test-ci.test.mjs`
- Modify: `README.md` and `docs/operations/local-development.md` only in the `test:system` rows (Task 11/12 own the rest of those files; keep this edit to the one table cell each)

**Interfaces:**
- Consumes: Task 6's `gc:now`; M4's asynchronous extraction contract (admission answers the attempt, `GET /api/extractions/<id>` reads its derived status) and ingestion without keys; M2's per-account `PUT /api/model_config`.
- Produces: `helpers.mjs` `COMPOSE_PROFILE = ['--profile', 'mock-oidc']`, `assertDatabasePortAvailable()`, `collectGarbageNow()`.

- [ ] **Step 1: Pin what is already wired** (`scripts/test-ci.test.mjs`)

  ```js
  test('the Node aggregate runs every PostgreSQL tier CI migrates for, the Studio tier included', () => {
    const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts
    assert.match(scripts['test:all:node'], /pnpm test:postgres:node/)
    assert.match(scripts['test:postgres:node'], /pnpm --filter db test:postgres/)
    assert.match(scripts['test:postgres:node'], /pnpm --filter extraction test:postgres/)
    assert.match(scripts['test:postgres:node'], /pnpm --filter studio test:postgres/)
  })

  test('db\'s PostgreSQL tier runs the reprocessing and garbage-reference checks', () => {
    const scripts = JSON.parse(readFileSync(new URL('../packages/db/package.json', import.meta.url), 'utf8')).scripts
    assert.match(scripts['test:postgres'], /source-reprocessing\.postgres\.check\.ts/)
    assert.match(scripts['test:postgres'], /garbage-references\.postgres\.check\.ts/)
  })
  ```
  Run `node --test scripts/test-ci.test.mjs`: PASS (these pin the spec's M6 *Test wiring* items M4 and Task 3 already satisfied; see Plan decision 8). No change to `verify.yml` or `scripts/test-ci.mjs`.

- [ ] **Step 2: Fix the `test:system` harness**

  `tests/helpers.mjs`:
  ```js
  /** The development stack's identity provider is a profile; a stack started without it cannot sign anyone in. */
  export const COMPOSE_PROFILE = ['--profile', 'mock-oidc']

  /** The development overlay publishes PostgreSQL on 127.0.0.1:5432, which the disposable test container also uses.
   *  This suite never stops another container to free it. */
  export function assertDatabasePortAvailable() {
    const published = spawnSync('docker', ['ps', '--filter', 'publish=5432', '--format', '{{.Names}}'], { encoding: 'utf8' })
    const project = developmentComposeEnvironment().COMPOSE_PROJECT_NAME ?? 'free'
    const others = published.stdout.split('\n').map((line) => line.trim())
      .filter((name) => name !== '' && !name.startsWith(`${project}-db-`))
    if (others.length > 0)
      throw new Error(`Port 5432 is published by ${others.join(', ')}. test:system needs it for the development database ` +
        'and never stops another container: stop it yourself, or run test:system on another host.')
  }

  export async function ensureStackUp() {
    if (await healthy()) return
    assertDatabasePortAvailable()
    ensureCertificates()
    compose([...COMPOSE_PROFILE, 'up', '-d', '--build', '--wait'])
    await waitForHealth()
  }

  /** One garbage-collection sweep now, run by the stack's own Studio. */
  export function collectGarbageNow() {
    const result = compose(['exec', '-T', 'studio', 'pnpm', '--filter', 'studio', 'gc:now'])
    return JSON.parse(result.stdout.trim().split('\n').at(-1))
  }
  ```
  (Read `developmentComposeEnvironment()` for how the project name is set; if the launcher leaves Compose's default, the project is the checkout directory's name lower-cased — use `docker compose ps --format '{{.Project}}'` once instead of guessing.)
  `tests/contract.test.mjs`:
  - `durability` restarts with `compose([...COMPOSE_PROFILE, 'down'])` and `compose([...COMPOSE_PROFILE, 'up', '-d', '--wait'])`.
  - `extraction: the canonical schema-guided path succeeds with evidence` posts the admission and then polls `GET /extractions/<id>` every 2 s for up to 600 s until `executionStatus` is `COMPLETED` (fail on `FAILED` with the failure's code), then asserts evidence and diagnostics on the polled body.
  - The upload sends no `ingestionKey` (M4 Task 10 removed it; confirm) and the model configuration `PUT` keeps today's per-account body.
  - New, after `projects: permanent deletion removes the owned graph`: `garbage collection: a sweep after the deletion runs every phase` (`collectGarbageNow().summary.failedPhases` deep-equals `[]`).
  Run: nothing automatic (the suite mutates the development stack). Record in the report whether `pnpm test:system` was run and its result; Task 14 runs it only when 5432 is free and an Ollama model is reachable (Plan decision 9).

- [ ] **Step 3: Record and commit**

  In `README.md`'s verification table, the `pnpm test:system` row gains: "It refuses to start while another container publishes port 5432, and never stops one." In `docs/operations/local-development.md`'s row, the same sentence.
  ```bash
  node --test scripts/free.test.mjs scripts/test-ci.test.mjs
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  git add tests/helpers.mjs tests/contract.test.mjs scripts/test-ci.test.mjs README.md docs/operations/local-development.md
  git commit -m "test: run test:system against the DBOS stack with its identity provider, and pin the CI tiers it relies on"
  ```

### Task 10: Decision records: ADR 0012 and 0013, amendments to 0006, 0007 and 0011, superseded markers

Documentation tasks have no unit tests; each starts with a check that fails on today's text (a `grep` that must print nothing, or a required line that is missing) and ends with it passing. Copy the prose below verbatim unless the code disagrees with it — then fix the prose to match the code and say so in the report.

**Files:**
- Create: `docs/adr/0012-one-durable-execution-layer.md`, `docs/adr/0013-per-researcher-model-configuration.md`
- Modify: `docs/adr/0006-machine-wide-local-model-configuration.md`, `docs/adr/0007-two-explicit-model-capability-routes.md`, `docs/adr/0011-one-model-configuration-page.md`, `prototypes/parsing_service/docs/job-backend.md`, `docs/plans/2026-09-24-unified-durable-execution.md` (the M2 section's note and five decision-15 annotations only)

- [ ] **Step 1: The failing check**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  ls docs/adr/0012-one-durable-execution-layer.md docs/adr/0013-per-researcher-model-configuration.md    # fails today
  grep -L "Superseded by \[0013\]" docs/adr/0006-machine-wide-local-model-configuration.md                # prints the file today
  grep -L "Superseded" prototypes/parsing_service/docs/job-backend.md                                      # prints the file today
  grep -n "Superseded (not" docs/plans/2026-09-24-procrastinate-source-ingestion.md                        # already there: keep
  grep -c "decision 15" docs/adr/0007-two-explicit-model-capability-routes.md                             # 0 today
  grep -c "^> \*\*Not built (decision 15" docs/plans/2026-09-24-unified-durable-execution.md            # 0 today
  ```

- [ ] **Step 2: Write ADR 0012** (`docs/adr/0012-one-durable-execution-layer.md`)

  ```markdown
  # 0012: One durable execution layer: DBOS in Studio and in the Parsing Service

  Date: 2026-09-26. Status: accepted; implemented on `feat/dbos-m2-m6` (M1–M6 of
  [the DBOS plan](../plans/2026-09-24-unified-durable-execution.md)). Amends the
  job-backend part of [0009](0009-own-parsing-and-extraction-service-in-free.md).

  ## Context

  FREE ran three durable job mechanisms and one long poll. The Parsing Service
  queued conversions and extractions in Procrastinate on its own database, with
  no cancel route, no idempotency and raw recovery SQL. Studio leased
  `ExtractionJob` rows in its web process; a restart reran an extraction from
  scratch and orphaned the Parsing Service's work. Batch Schema Suggestions ran
  from a pump that HTTP handlers kicked. An upload held a thirty-minute request
  open. Schema generation and edit proposals lived in the page, so a reload
  lost them.

  ## Decision

  - DBOS is the execution authority in both applications. Studio runs DBOS
    inside its one server process (system schema `dbos`); the Parsing Service's
    worker runs its own DBOS application (schema `kei_dbos`, owned by its own
    restricted role). Both schemas live in database `free`.
  - FREE's tables keep outcomes with research meaning. Execution status is
    derived from DBOS on read, never mirrored.
  - Row-backed work (Extractions, Batch Extractions, suggestion attempts) is
    enqueued in the same transaction as its rows. Other work starts
    workflow-first under a client-minted or server-minted ID.
  - Studio hands conversions and extractions to the Parsing Service by portable
    enqueue on its lanes: a large and a small conversion lane, a two-slot
    extraction lane and a cleanup lane.
  - Schema Suggestion and schema edit proposals run as workflows, so a reload
    or a Studio restart finds them again. The document chat, which no page
    had shown since August 2026, was deleted rather than made durable.
  - A ten-minute `collectGarbage` schedule removes canonical packages, staged
    sources, Parsing Service runs and both workflow histories by reference,
    retention and quiescence. Cancelled work is cleaned up only after the
    process that ran it has restarted.
  - Rejected: a Procrastinate HTTP relay, a stateless Parsing Service,
    Hatchet, Temporal, Absurd, a hand-written scheduler, a separate Studio
    worker service, Redis.

  ## Consequences

  - `parsing_db`, Procrastinate, `ExtractionJob`, `BatchExtractionMember`, the
    lease worker and the suggestion pump are gone; one PostgreSQL server holds
    everything.
  - A Studio restart interrupts calls in flight; unfinished steps run again on
    recovery. Exactly-once provider execution is not claimed.
  - Cancelled history and runs wait for the next restart of their process;
    there is no fixed deletion deadline.
  - A code change that alters a workflow's steps uses `DBOS.patch()`; the
    versions `studio@1` and `kei@1` change only after draining.
  - DBOS history holds interactive results for about 24 hours and background
    inputs for about 30 days, and database dumps include it.
  ```

- [ ] **Step 3: Write ADR 0013** (`docs/adr/0013-per-researcher-model-configuration.md`)

  ```markdown
  # 0013: Model configuration belongs to each Researcher Account; keys stay in the researcher's browser

  Date: 2026-09-26. Status: accepted; supersedes
  [0006](0006-machine-wide-local-model-configuration.md); amends
  [0007](0007-two-explicit-model-capability-routes.md) and
  [0011](0011-one-model-configuration-page.md). Implemented in M2–M4 of
  [the DBOS plan](../plans/2026-09-24-unified-durable-execution.md).

  ## Context

  0006 kept one machine-wide configuration for one researcher on localhost,
  with credentials in the operating system's keyring, and called a hosted
  deployment unsupported. FREE now runs hosted for several researchers. Any
  signed-in researcher could re-point the routes everyone's documents were sent
  to, and the container's keyring needed D-Bus and an empty-password unlock.

  ## Decision

  - Each Researcher Account owns one configuration in PostgreSQL: its Model
    Connections, its Interaction Route (the page's *Assistant model*) and
    Schema Suggestion Route, its Extraction Model Choice and its Ingestion
    Model Choice. A Project Context uses its owner's configuration. Every model
    call, background work included, resolves the owner's configuration when it
    starts; workflows carry only IDs.
  - An unset Interaction Route runs on the deployment's instruction model. An
    unset Schema Suggestion Route follows the Interaction Route. The NuExtract
    protocol is used exactly when the connection is vLLM and the model is
    NuExtract; it is never stored or chosen.
  - Keys never enter Studio's storage. The page keeps each key in the browser's
    `localStorage`, under the signed-in account and bound to the connection and
    its API base, and sends it with `PUT /api/model-keys`, which checks the
    account. Studio keeps the key only in memory and reads it inside each
    provider attempt. A connection records only whether it uses a key. After a
    Studio restart the next request from an open page resends the keys;
    background work with no page open fails with `model_key_required` and is
    retried by the researcher.
  - Deployment connections are operator-defined, read-only and shared by every
    researcher: the vLLM servers (`FREE_DEPLOYMENT_*`) and the Codex CLI and
    Claude Code providers the operator enables with
    `FREE_DEPLOYMENT_CLI_PROVIDERS`, which run on the server's own CLI login.
    Researchers cannot define a CLI connection.
  - The Ingestion Model Choice picks the Parsing Service's OCR and layout
    models for new ingestions and reprocessing. Admission freezes it into the
    workflow input; existing revisions never change.
  - Validation on write keeps the stored configuration valid, so there is no
    reset.

  ## Consequences

  - Keys are safe from database dumps, backups and passive access; not from an
    operator who changes Studio's code, and not from a script injected into
    Studio's origin, which the app shell's strict Content-Security-Policy
    guards against.
  - Keys are entered once per browser. Accounts that share one browser profile
    share its storage.
  - Researcher-supplied API bases stay allowed, as before; an allowlist is out
    of scope.
  - A shared CLI login runs every researcher's calls on the operator's billing
    and rate limits.
  ```

- [ ] **Step 4: Amend 0006, 0007, 0011; mark `job-backend.md`; annotate the spec's M2 section**

  - `0006`: insert after the title: `> **Superseded by [0013](0013-per-researcher-model-configuration.md)** (2026-09-26): model configuration belongs to each Researcher Account in PostgreSQL, keys stay in the researcher's browser, and hosted deployment is supported. The text below is the historical decision.`
  - `0007`: extend the existing blockquote with a second paragraph: `> Amended by [0013](0013-per-researcher-model-configuration.md): both routes belong to each Researcher Account; an unset Schema Suggestion Route follows the Interaction Route; and the NuExtract protocol is derived from the connection (vLLM) and the model ID (NuExtract), never stored or chosen.` and a third: `> Amended by the DBOS plan's decision 15 (2026-09-26): the document chat was deleted, so the Interaction Route serves conversational Extraction Schema editing (edit proposals) only.`
  - `0011`: the status line becomes `Date: 2026-09-23. Status: accepted; amends [0007](…) and the Studio part of [0010](…); amended by [0013](0013-per-researcher-model-configuration.md).` Delete the paragraph that begins "There is no migration: a `model-config.json` saved by an earlier Studio fails closed" and append:
    ```markdown
    ## Amendment (0013, 2026-09-26)

    The page edits the signed-in researcher's own configuration, which lives in
    PostgreSQL, not in `model-config.json`. It has Models and Connections tabs;
    Models follows the researcher's work in three steps (reading documents,
    schema and chat, extracting data) and has no Single/Routes mode.
    `extractionModels` and `ingestionModels` belong to the account's
    configuration. The configuration is validated on every write, so the reset
    and `DELETE /api/model_config` are gone, and nothing is kept in a keyring.
    ```
  - `prototypes/parsing_service/docs/job-backend.md`: insert after the title: `> **Superseded (2026-09-26)** by [ADR 0012](../../../docs/adr/0012-one-durable-execution-layer.md): the Parsing Service runs on DBOS (\`kei_exp.workflows\`); Procrastinate and its job database are gone. This record is kept for its measurements.`
  - `docs/plans/2026-09-24-unified-durable-execution.md`: directly under the line that starts `**M2: platform, baseline and configuration — done`, insert: `> Some items below moved to later milestones: the Compose removals, \`source-inbox\` and the worker waiting for Studio (M3/M4), \`scripts/free.mjs\`'s \`parsing_db\` and two safety tests (M3), the baseline's job, member, ingestion-key and suggestion edits (M4; \`ChatTurn\` was dropped by decision 15), and the key wrapper's \`cancelSignal\` (M4/M5). The [M2 plan's deferral table](2026-09-26-dbos-m2-platform-configuration.md#deferred-to-later-milestones-spec-m2-items-this-plan-does-not-do) lists each with its milestone.`
  - `docs/plans/2026-09-24-unified-durable-execution.md`, decision 15's pointers: decision 15 already says "the chat items elsewhere in this plan are superseded"; mark the five places a reader acts on. Each is one blockquote line of its own (blank lines around it), starting `> **Not built (decision 15, 2026-09-26):**`, inserted at the place named; the chat text itself stays as the design a later rebuild would start from:
    1. *Pins* — directly after the paragraph that begins "Everything below uses features of the pins" (and its bullet list): `> **Not built (decision 15, 2026-09-26):** \`@dbos-inc/vercel-ai\` and its \`readDurableStream\` served only the document chat, which M5 deleted; neither is installed or used.`
    2. *Rules → Secrets never enter DBOS* — directly after that bullet (before "**A new mechanism must delete more than it adds.**", as a paragraph between the two bullets): `> **Not built (decision 15, 2026-09-26):** the sentences from "For chat, that boundary belongs to \`durableCalls\`" to the end of the bullet describe the deleted document chat; generation and edit proposals sanitize inside their own steps.`
    3. *Interactive model work → Chat* — directly before the bullet that starts "**Chat (\`chatTurn\`).**": `> **Not built (decision 15, 2026-09-26):** the document chat was deleted in M5 instead of made durable: no \`chatTurn\` workflow, \`ChatTurn\` table, chat routes or \`ChatTab\`. The schema tab's durable interactive work is *Generation* and *Edit proposals* above.`
    4. *Public contract changes* — directly under the heading: `> **Not built (decision 15, 2026-09-26):** the chat-request bullet below; \`/api/chat\` was deleted with no alias, and the dispatcher answers it 404.`
    5. *Verification* — directly under the heading: `> **Not built (decision 15, 2026-09-26):** the chat items below (active-chat exclusion, one answer per chat turn, a reload mid-chat, chat reconnect and re-POST recovery, chat across a reload and a restart) are not verified; generation and edit proposals are. \`free-document-chat\` stays in the residue search.`

- [ ] **Step 5: Run the check and commit**

  ```bash
  ls docs/adr/0012-one-durable-execution-layer.md docs/adr/0013-per-researcher-model-configuration.md
  grep -L "Superseded by \[0013\]" docs/adr/0006-machine-wide-local-model-configuration.md          # prints nothing
  grep -L "Superseded" prototypes/parsing_service/docs/job-backend.md                                 # prints nothing
  grep -n "There is no migration" docs/adr/0011-one-model-configuration-page.md                       # prints nothing
  grep -c "decision 15" docs/adr/0007-two-explicit-model-capability-routes.md                         # 1
  grep -c "^> \*\*Not built (decision 15" docs/plans/2026-09-24-unified-durable-execution.md        # 5
  git add docs/adr prototypes/parsing_service/docs/job-backend.md docs/plans/2026-09-24-unified-durable-execution.md
  git commit -m "docs(adr): record one durable execution layer and per-researcher model configuration"
  ```

### Task 11: README, CONTEXT.md, the Studio and Parsing Service READMEs and CLAUDE files

**Files:**
- Modify: `README.md`, `CONTEXT.md`, `prototypes/studio/README.md`, `prototypes/studio/CLAUDE.md`, `prototypes/parsing_service/README.md`, `prototypes/parsing_service/CLAUDE.md`

- [ ] **Step 1: The failing check**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  grep -niE "prompt revisions|deployment-wide|credential store|OS credential|confirmed reset|keyring|model-config\.json|Single model|no remote cancellation|Polling waits|sync live|in-memory queue|document chat|chat turn|chat transcript" \
    README.md CONTEXT.md prototypes/studio/README.md prototypes/studio/CLAUDE.md prototypes/parsing_service/README.md prototypes/parsing_service/CLAUDE.md
  ```
  Expected today: many hits. After this task: none.

- [ ] **Step 2: `README.md`**

  - Product contract #5 becomes:
    > 5. **Durable, versioned state.** Project Contexts, source documents and their representation revisions, schema revisions, extractions, and review decisions survive ordinary restarts. One Extraction record carries a run from admission to its outcome and on to its reviews; it stays pinned to the source-representation and schema revisions it used, so newer revisions can make it stale without rewriting its history. Work in progress survives too: it runs as DBOS workflows inside Studio and the Parsing Service, which resume after a restart, and its status is derived from them rather than stored twice.
  - #7 becomes (keep today's two sentences on output formatting, from "For those provider calls, output formatting is automatic" through "Output formatting has no route override.", where marked):
    > 7. **Model-provider surface.** Each Researcher Account owns its model configuration, stored in PostgreSQL: its Model Connections, the Assistant model (the Interaction Route) and the Schema Suggestion Route, the Extraction Model Choice and the Ingestion Model Choice. A Project Context uses its owner's configuration. The Model Configuration page supports Ollama, OpenAI, Anthropic, Google, vLLM and OpenAI-compatible connections. A researcher's API keys stay in their own browser; Studio holds a copy only in memory while it needs one, and never in PostgreSQL, on disk, in logs or in workflow history. The deployment's own model servers are read-only deployment connections that every researcher can use: its vLLM servers with the GPU overlay, and the Codex CLI and Claude Code providers when the operator enables them with `FREE_DEPLOYMENT_CLI_PROVIDERS`; those run on the server's own CLI login. An unset Assistant model runs on the deployment's instruction model, and an unset Schema Suggestion Route follows the Assistant model. The Ingestion Model Choice picks the Parsing Service's OCR and layout models for new ingestions and reprocessing only; existing revisions never change. Extraction execution is delegated to the included Parsing Service; FREE uses the configured provider directly for Schema Suggestion and Interaction. ⟨today's output-formatting sentences⟩ On a vLLM connection, Schema Suggestion uses the NuExtract protocol whenever the model is NuExtract; nothing selects it by hand. The configuration is validated whenever it is saved, so there is no reset.
  - #8 becomes:
    > 8. **Safe startup.** Authored forward migrations finish before Studio becomes ready, both for a fresh database and an already-migrated one. Studio's entrypoint then creates the Parsing Service's restricted database role and schema, and each process migrates its own DBOS system schema (`dbos`, `kei_dbos`) when it launches. Normal startup never resets the database or seeds an account, Project Context, provider, route, or credential.
  - #10 becomes:
    > 10. **Secrets and destructive limits.** Deployment secrets — the session secret, database passwords, the Entra certificate, a CLI login — enter through the environment or mounted files, never committed files. Researchers' model keys never reach the server's storage, and FREE needs no operating-system secret store. Forward migration replay may target the configured deployment database. Reset is limited to `postgres` on loopback port 5432 database `free`. Disposable PostgreSQL checks are limited to `postgres` on loopback port 5432 databases named `free_test_*`. Production is never reset; the single exception is the one-time, pre-production cutover to durable execution ([runbook](docs/operations/deployment.md#cutover-to-durable-execution-one-time-clean-slate)).
  - *Quickstart*: "Migrations finish before the replacement processes start, and source changes then sync live." becomes "Migrations finish before the replacement processes start. Afterwards, a browser-code change reloads in place and a server-code change restarts Studio (Compose Watch)."
  - *Extraction execution*: replace from "Polling waits up to ten minutes" to the end of the paragraph with: "Each Extraction runs as a durable workflow: Studio hands it to the Parsing Service's worker on its extraction lane, whose deadline is ten minutes for Article and three hours for Catalog, counted from when the worker starts it. Cancelling an Extraction records the cancellation and stops the Parsing Service's work too. A failed extraction carries the Parsing Service's own reason. There is no targeted Catalog retry; start a new Extraction to rerun."
  - *Verification* table: the `pnpm test:postgres` row names the Studio PostgreSQL tier ("Studio's DBOS workflows, db, extraction and Parsing Service PostgreSQL checks against caller-provisioned disposable loopback `free_test_*` databases; the DBOS checks create and drop their own schemas").
- [ ] **Step 3: `CONTEXT.md`** (replace the entries named; add the new **Ingestion Model Choice** after **Extraction Model Choice**; `CONTEXT.md:149`'s "document chat" goes with the **Interaction Route** entry, and there is no **Chat Turn** entry: decision 15)

  ```markdown
  **Model Connection**:
  A Researcher Account's description of how FREE can reach a model provider: a hosted provider with the researcher's own key, or the researcher's own Ollama, vLLM or OpenAI-compatible server. Its key stays in the researcher's browser. A *deployment connection* is one the deployment runs or enables — its vLLM servers, and the Codex CLI and Claude Code providers on the server's own login: read-only, described by the environment rather than saved, and usable by every researcher.
  _Avoid_: provider configuration, endpoint, account

  **Capability Route**:
  A Researcher Account's choice of Model Connection and model for a related family of FREE model work. A Project Context uses its owner's routes. A route left unset runs on a default: the Interaction Route on the deployment's instruction model, when the deployment serves one, and the Schema Suggestion Route on the Interaction Route.
  _Avoid_: task route, model setting, project model

  **Schema Suggestion Route**:
  The Capability Route used for Schema Suggestion. It uses the *NuExtract protocol* — NuExtract's own template generation, driven through its chat template — exactly when its connection is vLLM and its model is NuExtract; nothing stores or selects the protocol. Left unset, it follows the Interaction Route. Formerly the Extraction Route; Extraction itself runs in the Parsing Service.
  _Avoid_: extraction route, extraction model, ext route

  **Extraction Model Choice**:
  A Researcher Account's choice, set on the Model Configuration page, of the Parsing Service's extraction models by role: the *field model* reads values off the source for the Extraction Schema, and the *reasoning model* decides over labelled source text (where records start, which passage grounds a value, which competing candidate is right). Each role is chosen among the models the Parsing Service deployment serves for that role; a role left unchosen uses the deployment's default. Every single and batch Extraction is requested on its Project Context owner's choice current when it starts, and records it beside the models each role actually ran on. It is not a Capability Route and does not name a Model Connection.
  _Avoid_: extraction model, extraction route, model setting

  **Ingestion Model Choice**:
  A Researcher Account's choice of the Parsing Service's OCR model (text recognition for scanned pages) and layout model (the detector that cuts scanned pages into regions). It applies to new ingestions and reprocessing only: an admitted ingestion keeps the models it was admitted with, and existing Source Representation Revisions never change. A page with a text layer uses neither. A role left unchosen uses the deployment's default. It names no Model Connection.
  _Avoid_: OCR setting, parser model

  **Interaction Route**:
  The Capability Route used for conversational Extraction Schema editing: the schema panel's "Describe a change to the schema…" and the edit proposals it returns. The Model Configuration page calls it the *Assistant model*.
  _Avoid_: chat model, chat route

  **Model Attribution**:
  A sanitized snapshot of the Model Connection, model, and execution profile used for a specific piece of model work. Extractions record it. Interactive model work — generated schemas and schema edit proposals — records none, so a recovered or replayed result never gains an attribution reconstructed from today's routes. It never contains credentials and does not replace source-backed Evidence.
  _Avoid_: model provenance, current model, evidence
  ```

- [ ] **Step 4: The Studio and Parsing Service files**

  - `prototypes/studio/README.md`, section *Model configuration* (45-69), becomes:
    ~~~markdown
    ## Model configuration

    Each Researcher Account has its own model configuration in PostgreSQL; a fresh account starts with none. Open **Configure models** for the Model Configuration page. Its **Models** tab follows the work in three steps — reading documents (the Ingestion Model Choice), schema and chat (the *Assistant model*, which Schema Suggestion follows until given its own model), and extracting data (the Extraction Model Choice) — and its **Connections** tab lists the researcher's connections beside the deployment's read-only ones (`FREE_DEPLOYMENT_INSTRUCT_URL`, `FREE_DEPLOYMENT_INSTRUCT_MODEL`, `FREE_DEPLOYMENT_NUEXTRACT_URL` from the GPU overlay, and the CLI providers enabled by `FREE_DEPLOYMENT_CLI_PROVIDERS`).

    - A connection's key is typed into the page and stays in this browser's `localStorage`, bound to the account, the connection and its API base; changing the base or provider clears it. The page sends keys to Studio with `PUT /api/model-keys`, and Studio keeps them only in memory. After a Studio restart the page resends them on its next request; background work with no page open fails with `model_key_required` and can be retried.
    - **Apply** saves the whole draft in one transaction; the configuration is validated on every write, so there is no reset.
    - Connection checks run when the page opens and after edited provider inputs settle. They are advisory: they never generate content or change configuration, and never gate a manual model ID or Apply.
    - A keyless Ollama connection calls its server anonymously, even when `OLLAMA_API_KEY` is set in Studio's environment.

    Ollama, OpenAI, Anthropic, Google, vLLM, and generic OpenAI-compatible connections can be added by a researcher; Codex CLI and Claude Code are deployment connections only. A vLLM connection is OpenAI-compatible and switches the chat template's thinking off. Enter provider base URLs exactly as their adapters expect. Ollama uses the server base, such as `http://127.0.0.1:11434`, and FREE reaches its native resources beneath `/api`. Other HTTP providers may require a version prefix such as `/v1` or `/v1beta`; generic OpenAI-compatible bases provide `/models` and `/chat/completions` beneath the entered base.

    The Studio container includes the Codex CLI and Claude Code. Enable them with `FREE_DEPLOYMENT_CLI_PROVIDERS`, then log in once inside the running container:

    ```bash
    docker compose exec studio codex login --device-auth
    docker compose exec studio codex login status
    ```

    Claude Code authenticates from `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`). The Codex home and Claude Code's state live in the `studio-config` and `studio-claude` volumes, so rebuilding the image keeps the logins.
    ~~~
    In *Reprocessing a Source Document*, replace the last two sentences ("Recreate the database from the baseline … durable queue recovery.") with: "Reprocessing runs as a durable workflow: closing the browser does not stop it, and repeating the request with the same request key rejoins it or returns its published revision."
  - `prototypes/studio/CLAUDE.md`: append
    ```markdown
    ## DBOS

    - `server/dbos.ts` launches DBOS once per process; never call `DBOS.launch()` elsewhere, and never register a workflow at module import (the API dispatcher and several tests import every handler). `registerStudioWorkflows()` registers each workflow with an explicit `name` (bundlers rename functions).
    - `@dbos-inc/dbos-sdk` stays external to the server bundle (`vite.server.config.ts`).
    - A change to a workflow's step sequence goes behind `DBOS.patch()`; `studio@1` changes only after draining. Workflow inputs carry IDs, never keys or document text.
    - The development host keeps the first DBOS launch across recompositions; after editing a workflow module restart Studio (Compose Watch does).
    ```
  - `prototypes/parsing_service/README.md`: confirm the worker section describes `kei-worker worker`, the four lanes, `KEI_SYSTEM_DATABASE_URL`, the `.worker-<slot>.lock` and the boot timestamp (M3 wrote it); add after it: "Studio's `collectGarbage` names the conversions whose runs nothing references and the kei history that may go; `deleteRuns` deletes each run only once no kei workflow that could still write it is live or stopped since this worker booted, then that conversion's history. kei never reads Studio's schemas."
  - `prototypes/parsing_service/CLAUDE.md`: "…this internal service owns parsing, extraction, canonical evidence and durable jobs." becomes "…canonical evidence, and its DBOS worker (`kei_exp.workflows`, schema `kei_dbos`, its own restricted role)." and add: "A change to a workflow's steps goes behind `DBOS.patch()` (`enable_patching` is on); `kei@1` changes only after draining."

- [ ] **Step 5: Run the check and commit**

  ```bash
  grep -niE "prompt revisions|deployment-wide|credential store|OS credential|confirmed reset|keyring|model-config\.json|Single model|no remote cancellation|Polling waits|sync live|in-memory queue|document chat|chat turn|chat transcript" \
    README.md CONTEXT.md prototypes/studio/README.md prototypes/studio/CLAUDE.md prototypes/parsing_service/README.md prototypes/parsing_service/CLAUDE.md
  # prints nothing
  git add README.md CONTEXT.md prototypes/studio/README.md prototypes/studio/CLAUDE.md prototypes/parsing_service/README.md prototypes/parsing_service/CLAUDE.md
  git commit -m "docs: describe per-researcher configuration, browser-held keys and durable execution in the READMEs and CONTEXT"
  ```

### Task 12: Operations runbooks and the architecture model

**Files:**
- Modify: `docs/operations/deployment.md`, `docs/operations/local-development.md`, `docs/architecture/current.c4`, `docs/architecture/README.md`, `.env.example` (only if the check below finds a stale line)

- [ ] **Step 1: The failing check**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  grep -nE "FREE_PARSING_POSTGRES_PASSWORD|kei-jobs|job database|job PostgreSQL|schema initializer|Parsing PostgreSQL|job store|model-config\.json|Reset model configuration|deployment-wide|credential state|sync live|job schema" \
    docs/operations/deployment.md docs/operations/local-development.md docs/architecture/README.md .env.example compose*.yaml
  grep -nE "Procrastinate|jobs = datastore|batch_worker|model_config|keyring|POST /api/runs|poll" docs/architecture/current.c4
  pnpm architecture:check
  ```
  Expected today: hits in every file but `.env.example` and Compose (verified clean at f539911; if a hit appears there now, fix it in this task); `architecture:check` passes today and must still pass.

- [ ] **Step 2: `docs/operations/deployment.md`**

  - *Prerequisites and hosted settings*, second paragraph: "Compose runs its API, worker, job PostgreSQL, schema initializer, and, with GPU access, the vLLM model servers …" becomes "Compose runs its read API and its DBOS worker, and with GPU access the vLLM model servers for OCR and extraction, beside Studio and the one PostgreSQL server both use."
  - The secrets paragraph and `.env` block: `FREE_PARSING_POSTGRES_PASSWORD=<separately-generated-hex-output>` becomes `FREE_KEI_POSTGRES_PASSWORD=<separately-generated-hex-output>`, and after `FREE_ENTRA_CLIENT_CERT_THUMBPRINT` add the commented lines `# FREE_DEPLOYMENT_CLI_PROVIDERS=codex-cli,claude-code` and `# CLAUDE_CODE_OAUTH_TOKEN=<claude-setup-token-output>`. Add these bullets after the `FREE_POSTGRES_PASSWORD` bullet:
    > - `FREE_KEI_POSTGRES_PASSWORD` is the password of the Parsing Service's own database role, `kei`, which owns only the `kei_dbos` schema: the service parses untrusted PDFs and must not be able to read Studio's tables or rewrite Studio's workflow inputs. Studio's entrypoint creates the role and its schema from this value at every start, so changing it takes effect at the next start. Use a generated hexadecimal value.
    > - `FREE_DEPLOYMENT_CLI_PROVIDERS` (optional; `codex-cli`, `claude-code`, comma-separated) offers the Codex CLI and Claude Code to every researcher as read-only deployment connections. They run on this server's own CLI login, so every researcher's calls on them use the operator's billing and rate limits; leave it unset to offer neither. Log the CLIs in once inside the running container (`docker compose … exec studio codex login --device-auth`; Claude Code reads `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`).
    > - Studio's `DATABASE_URL` role must own database `free` or hold `CREATE` on it (DBOS creates the `dbos` schema at launch) and `CREATEROLE` (the entrypoint creates `kei`); Compose uses `postgres`.
  - *GPU and DGX Spark*: delete its first paragraph (`FREE_PARSING_POSTGRES_PASSWORD` …).
  - *Start and preserve state* becomes:
    > Normal startup builds before it stops the existing Studio and parsing API/worker, so a failed build leaves the application running. Once they stop, Compose starts Studio: its entrypoint replays the authored migrations, creates the Parsing Service's role and schema, and Studio launches DBOS, which migrates the `dbos` schema and applies the ten-minute garbage-collection schedule. The Parsing Service's worker starts only after Studio is healthy; it takes its slot lock (`KEI_RUNS/.worker-<slot>.lock`), reads the database clock as its boot timestamp and migrates `kei_dbos`. A failed migration prevents startup. The launcher never resets a database or seeds an account, Project Context, Model Connection, route, or key.
    >
    > (the three-line `node scripts/free.mjs production` / `ps` / `curl` block stays)
    >
    > Retain the `postgres-data`, `source-inbox`, `parsing-runs`, `studio-data`, `studio-config` and `studio-claude` volumes; the model caches are re-downloadable. Completed runs are inputs to later extractions, not caches. A plain `docker compose down` retains volumes; `down --volumes` destroys them. Never run `down` on a GPU host just to redeploy: it stops the model servers too.
    >
    > Studio's container healthcheck opens a local TCP connection, which succeeds only after migrations and the DBOS launch. The Parsing Service API has its own healthcheck; the worker logs `kei worker kei-<slot> serving` once it serves its lanes. Extraction quality is checked by integration validation, not by the health routes. Check the public application through the configured HTTPS proxy and sign-in path.
    Delete the paragraph "This source consolidation does not transfer runs …".
  - *Configure shared models* becomes *Configure models*:
    > After signing in, each researcher opens **Configure models** in the Project Context rail. The configuration belongs to that Researcher Account and applies to its own Project Contexts only.
    >
    > 1. **Connections**: the deployment's own servers are listed read-only — the vLLM servers with the GPU overlay, and the CLI providers the operator enabled. A researcher adds their own connections (Ollama, OpenAI, Anthropic, Google, vLLM, OpenAI-compatible). A key typed there stays in that browser; Studio holds a copy only in memory while it needs one.
    > 2. **Models**, in three steps: *Reading documents* (the Ingestion Model Choice: the OCR and layout models for new ingestions and reprocessing), *Schema & chat* (the Assistant model; Schema Suggestion follows it unless given its own model) and *Extracting data* (the Extraction Model Choice). A step at its defaults says so in one sentence.
    > 3. **Apply** saves the whole configuration in one transaction.
    >
    > A Studio restart empties its memory: an open page sends its keys again with its next request, and background work started without an open page fails with `model_key_required` until the researcher retries it. A keyless Ollama connection is called anonymously even when the operator's environment sets `OLLAMA_API_KEY`; a researcher who uses ollama.com enters their own key. There is no configuration reset; the configuration is validated whenever it is saved.
    Delete the paragraph that begins "The Extraction Model Choice, Model Connections, Capability Routes, and saved credential state are deployment-wide" and the `model-config.json` paragraph after it.
  - *Configure service extraction*: after its first paragraph add "`KEI_OCR_MODEL` (default `surya`) is the OCR model a parse uses when its owner chose none; the Parsing Service's listing and its conversions read the same value."
  - *Network exposure and proxy trust* table: delete the *Parsing PostgreSQL* row; rename *Parsing worker and schema initializer* to *Parsing worker (DBOS)*. Replace "The API and worker share the job database and run volume." with "The worker reads Studio's staged source PDFs from the `source-inbox` volume (read-only) and writes runs; the API only reads runs and has no database access."
  - New sections before *Replace a certificate*:
    ~~~markdown
    ## Durable execution (DBOS)

    Studio and the Parsing Service run their work as DBOS workflows in database `free`:

    | Schema | Owner | Holds |
    | --- | --- | --- |
    | `public` | Studio | Research state and each account's model configuration (no keys) |
    | `dbos` | Studio | Studio's workflows; queues `studio`, `suggest` and `gc`; the `collectGarbage` schedule |
    | `kei_dbos` | role `kei` | The Parsing Service's workflows; lanes `kei-convert-large`, `kei-convert-small`, `kei-extract`, `kei-gc` |

    The `kei` role is denied on `public` and `dbos`. One worker serves the one slot; never scale `parsing_worker`.

    Inspect both schemas from the database container (read-only queries):

    ```bash
    docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free -c \
      "SELECT workflow_uuid, name, status, queue_name, to_timestamp(updated_at / 1000.0) AS updated FROM dbos.workflow_status ORDER BY created_at DESC LIMIT 20"
    docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free -c \
      "SELECT workflow_uuid, name, status, queue_name, to_timestamp(updated_at / 1000.0) AS updated FROM kei_dbos.workflow_status ORDER BY created_at DESC LIMIT 20"
    docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free -c \
      "SELECT 'dbos' AS schema, status, count(*) FROM dbos.workflow_status GROUP BY 2 UNION ALL SELECT 'kei_dbos', status, count(*) FROM kei_dbos.workflow_status GROUP BY 2"
    docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free -c "SELECT * FROM dbos.workflow_schedules"
    ```
    (Add `-f compose.nginx.yaml` and `-f compose.gpu.yaml` when the deployment uses them.)

    - **Cancelling.** A cancel stops a workflow at its next step boundary; a step already running finishes first. The Parsing Service's steps also check for a cancel between pages and records. That check fails open: if the worker cannot read a workflow's status (a PostgreSQL restart), it carries on and logs `the status of … could not be read` once per step execution, and reads again at its next check.
    - **Garbage collection** runs every ten minutes on queue `gc`. It cancels work whose outcome is already recorded or whose Project Context is gone; deletes interactive history 24 hours and background history 30 days after it ends, and a deleted scope's history at once; asks the Parsing Service to delete runs nothing references (after 24 hours) with their history; and removes staged PDFs of finished attempts and unreferenced canonical packages after 24 hours. Work cancelled in the running process is kept until that process restarts, because one of its steps may still write; every deploy restarts both. Run a sweep now with `docker compose … exec -T studio pnpm --filter studio gc:now`, which prints a JSON summary; a non-empty `failedPhases` also appears in Studio's log as `collectGarbage: <phase> failed (<error class>)`, and the next sweep retries it.
    - **Changing a workflow.** A code change that adds, removes, reorders or renames a step of a workflow ships behind a patch — `DBOS.patch('<name>')` in Studio, `DBOS.patch("<name>")` in the Parsing Service (both enable patching) — so workflows started before it recover on the old path. Remove the branch with `deprecatePatch` / `deprecate_patch` once no workflow from before the patch can still be recovered. The application versions `studio@1` and `kei@1` stay fixed; change one only for an incompatible contract change, and only after draining: stop new work, wait until neither schema has an `ENQUEUED`, `DELAYED` or `PENDING` workflow, then deploy.

    ## Back up and restore

    Stop `studio` and `parsing_worker` first, so nothing writes while the backup runs. The backup set is:

    - `pg_dump -Fc free` (all three schemas; it includes workflow history — interactive results for up to about a day, background inputs for up to about 30 days);
    - the `source-inbox`, `parsing-runs` and `studio-data` volumes;
    - the CLI homes: `studio-config` (the Codex login under `codex/`) and `studio-claude`;
    - outside Compose: `.env` and the secret files it names.

    No backup holds a researcher's key: keys live only in researchers' browsers and in Studio's memory. The CLI homes hold the operator's own CLI logins, so protect those backups like `.env`. The model caches are re-downloadable and need no backup. To restore, recreate `free` from the dump into an empty PostgreSQL volume, restore the volumes, and start normally: migrations are already applied, and the entrypoint sets the `kei` role's password from `.env` again.

    ## Cutover to durable execution (one-time, clean slate)

    This runbook moved a deployment from Procrastinate to DBOS once, before FREE held production data. Nothing on the host survives it: researchers re-enter their connections and keys and re-upload their PDFs. It is the one exception to "production is never reset" (README #10).

    1. Build the new images while the old stack serves: `docker compose <files> build`.
    2. Stop `nginx` (with the bundled nginx), `studio`, `parsing_service` and `parsing_worker`, then the old `parsing_migrate` container. The old worker locked `.slot-<slot>.lock` and the new one locks `.worker-<slot>.lock`, so the two would not exclude each other: confirm no `kei-jobs` process is left (`docker ps --format '{{.Names}} {{.Command}}'`).
    3. Take one `pg_dump -Fc` of `free` and of the old `parsing_db` for inspection; there is no restore path.
    4. Reset the storage: remove the `parsing_db` container and its `parsing-postgres` volume; drop and recreate database `free`; empty `parsing-runs` and Studio's data directory in `studio-data` (`FREE Studio-nodejs`); delete `FREE Studio-nodejs/model-config.json` from `studio-config`, keeping `codex/`; keep `studio-claude`.
    5. In `.env`, add `FREE_KEI_POSTGRES_PASSWORD` (`openssl rand -hex 32`), set `FREE_DEPLOYMENT_CLI_PROVIDERS` if wanted, and remove `FREE_PARSING_POSTGRES_PASSWORD`.
    6. Start: `node scripts/free.mjs production`. The baseline migration, the `kei` role and schema, and both DBOS schemas are created at startup.
    7. Check: the health route; `\dn` lists `public`, `dbos` and `kei_dbos`; `SET ROLE kei; SELECT 1 FROM public."ProjectContext"` is denied; `dbos.workflow_schedules` has `collectGarbage`; the worker logged `serving`.
    8. Smoke-test: upload; an extraction and a cancel; a Batch Schema Suggestion; a generation and a schema edit proposal across a reload and a Studio restart; a second account, where one exists, sees none of the first's configuration or operations; delete a project and run `gc:now`.

    Never restart a model server as part of this: if `docker compose config --hash '*'` shows a model server's hash changed, stop and decide first.
    ~~~
- [ ] **Step 3: `docs/operations/local-development.md`**

  - Intro: "Compose runs PostgreSQL, the Parsing Service API and worker, a separate job database, model servers, Studio, …" becomes "Compose runs PostgreSQL, the Parsing Service's API and DBOS worker, model servers, Studio, …".
  - *Start*, second paragraph: "…It runs `docker compose --profile mock-oidc up --watch` after they stop, so migration cannot overlap processes using the old job schema." becomes "…after they stop, so no old process overlaps its replacement."
  - Replace "Migrations replay automatically in the Studio container entrypoint before the dev server starts. The separate parsing job schema is applied before its API and worker start. Their source changes restart the processes through Compose Watch." with "Migrations replay in the Studio container's entrypoint before the dev server starts; the entrypoint then creates the Parsing Service's database role, DBOS launches with the dev server, and the worker starts once Studio is healthy and migrates its own schema."
  - Replace the paragraph "Source changes under `prototypes/studio`, … sync live into the relevant container. … Parsing job-schema changes require restarting `pnpm dev` … (see the watch rules in `compose.override.yaml`)." with:
    > Browser code under `prototypes/studio/src` syncs live and reloads in place. Server code — Studio's `api/`, `server/` and `shared/`, and `packages/*` — syncs and restarts Studio, because DBOS runs inside Studio's process and launches once per process. Parsing Service source changes restart its API and worker. Changes to the database schema, the Prisma Next generator configuration or migrations rebuild Studio so contract generation and migration replay run again; dependency manifest or Dockerfile changes also rebuild the image (see the watch rules in `compose.override.yaml`).
    >
    > While the baseline migration is edited in place (until the cutover), a development database created from an earlier baseline is refused by `db:init`: recreate the `postgres-data` volume once (`docker compose down`, `docker volume rm <project>_postgres-data`, then `pnpm dev`). Running Studio on the host (`pnpm --filter studio dev`) needs PostgreSQL at startup, because DBOS launches with the server: start it first with `pnpm --filter db db:start`.
  - The *Stop* paragraph: "…the job database and parsing run volume are durable inputs to future extraction. `pnpm db:reset` resets only the disposable development research database, not the job store." becomes "…the parsing run volume and the source inbox are durable inputs to future extraction. `pnpm db:reset` resets the development database `free`, including both DBOS schemas; restart the stack afterwards so Studio and the worker recreate them."
  - *Database operations*, last bullet: "Production startup replays `pnpm --filter db db:init` for research data and `kei-jobs schema --apply` for the separate job store; neither resets data." becomes "Startup replays `pnpm --filter db db:init` and creates the Parsing Service's role (`pnpm --filter db db:kei-role`); each DBOS process migrates its own schema at launch. None of these resets data."
  - *Verification* table: the `pnpm test:postgres` cell adds "`DATABASE_URL` must equal `EXTRACTION_TEST_DATABASE_URL` for Studio's DBOS tier, which creates and drops its own `dbos_t_*`/`kei_dbos_t_*` schemas"; the `pnpm test:e2e` cell adds "kei is a TypeScript stand-in speaking kei's workflow contract"; the `pnpm test:service` cell says "the included real Python API and DBOS worker".
  - *Host-run tooling*: "The Parsing Service API, job database, and model servers are private to the Compose network." becomes "The Parsing Service's API, worker and model servers are private to the Compose network."
- [ ] **Step 4: `docs/architecture/current.c4` and its README**

  In `model { … }`, replace the `studio` and `parsing_service` blocks and the datastores after them with:
  ```
  studio = system 'Studio Application' 'React UI plus a production Hono Node host on one authenticated same-origin boundary; DBOS runs inside the same process.' {
    ui = container 'React UI' 'Source Document viewer, browser annotations, schema editor, Extraction Results, Evidence and the Model Configuration page.' 'React'
    key_store = component 'Browser key store' 'Each researcher''s API keys in localStorage, per account, connection and API base.' 'TypeScript, localStorage'
    browser_http = component 'Browser HTTP adapter' '`src/api.ts`, `src/projectContexts.ts` and `src/schemaRevisions.ts` send same-origin requests; `authenticatedFetch` resends keys when the Studio boot ID changes.' 'TypeScript'
    handlers = container 'Hono Node host' '`server/*.ts` authenticates and scopes browser requests, serves the built client, and dispatches `api/*.ts` same-origin handlers.' 'Hono, Node.js'
    authentication = component 'Authentication boundary' 'OIDC authorization-code transactions with PKCE and nonce validation, fixed token-expiry sessions, canonical-origin enforcement, and the trusted-proxy peer contract.' 'TypeScript, MSAL Node'
    durable = component 'DBOS in Studio' '`server/dbos.ts` launches DBOS once per process (schema `dbos`): Studio''s workflows, the `studio`, `suggest` and `gc` queues, the ten-minute `collectGarbage` schedule, and clients for admission and the kei handoff.' 'DBOS TypeScript'
    provider_registry = component 'Provider registry' '`api/_provider.ts` resolves the Project Context owner''s Capability Route and adapts the provider; a keyed model reads its key inside each attempt.' 'AI SDK v7 provider adapters'
    key_cache = component 'Key cache' 'Researcher keys in Studio''s memory only, per account and connection.' 'TypeScript'
    extraction_module = component 'Extraction module' '`packages/extraction` admits an Extraction row and its `runExtraction` workflow in one transaction, hands the work to the Parsing Service''s lanes, and owns review and PostgreSQL persistence.' 'TypeScript, Prisma Next'
    garbage = component 'Garbage collection' '`collectGarbage` repairs missed cancels and removes packages, staged sources, Parsing Service runs and workflow history by reference, retention and quiescence.' 'TypeScript, DBOS'
    project_store = component 'ProjectStore' '`packages/db` owns Project Store reads and writes, including each account''s model configuration; handlers hold no SQL.' 'TypeScript, Prisma Next'
  }

  parsing_service = system 'Parsing Service' 'Included Python service for PDF parsing, extraction and grounding; its DBOS worker runs the work Studio enqueues.' {
    http_api = container 'Read API' '`GET /api/models`, `/api/extraction-models`, `/api/ingestion-models`, run manifests, pages and extraction artifacts; no database access.' 'FastAPI'
    parser = container 'DBOS worker' '`kei-worker worker`: convert on kei-convert-large and kei-convert-small, extract on kei-extract, deleteRuns on kei-gc; holds its slot lock for its lifetime; schema `kei_dbos` as role `kei`.' 'Python, DBOS, Docling'
    models = container 'vLLM model servers' 'Surya OCR, NuExtract and the instruction model, one vLLM server each (GPU overlay).' 'vLLM'
    task_cache = datastore 'Canonical service runs' 'Run directories: the verified source copy, generation-pinned page artifacts and extraction outputs; deleted by deleteRuns once nothing references them.'
  }

  project_db = datastore 'PostgreSQL free' 'Schema `public`: Researcher Accounts, their model configuration (no keys) and account-owned research state. Schemas `dbos` (Studio) and `kei_dbos` (the Parsing Service, its own role): DBOS system state.' 'PostgreSQL 17, Prisma Next, DBOS'
  package_store = datastore 'Canonical ingestion packages' 'Content-addressed portable packages in the `FREE Studio` data directory. The Project Store keeps only the package reference.' 'Operating system data directory'
  source_inbox = datastore 'Source inbox' 'Staged source PDFs named by project and attempt: written by Studio, read by the Parsing Service''s worker.' 'Docker volume'
  model_connections = external 'Model Connections' 'Researchers'' own HTTP model providers, and the deployment''s vLLM servers and enabled CLI providers.'
  ```
  (LikeC4 escapes a quote inside a single-quoted string by doubling it; if `pnpm architecture:check` disagrees, rephrase without the apostrophe.) Delete `model_config`. Replace the relationships with the set below, keeping the unchanged authentication, gateway and browser lines as they are:
  ```
  studio -> parsing_service 'Enqueues conversions and extractions on its lanes; reads manifests, pages and artifacts over private HTTP'
  studio -> project_db 'Reads and writes research state; runs its DBOS workflows'
  studio -> package_store 'Reads and retains canonical packages'
  studio -> source_inbox 'Stages source PDFs'
  studio -> model_connections 'Executes the Project Context owner''s model operations'
  parsing_service -> project_db 'Runs its DBOS workflows in kei_dbos'
  parsing_service -> source_inbox 'Reads staged source PDFs'
  studio.ui -> studio.key_store 'Keeps and reads this browser''s keys'
  studio.handlers -> studio.durable 'Admits, reads and cancels owner-checked workflows'
  studio.handlers -> studio.key_cache 'Keeps keys sent with PUT /api/model-keys; clears them at sign-out'
  studio.handlers -> studio.provider_registry 'Probes a connection'
  studio.handlers -> studio.extraction_module 'Admits and reopens Extractions; records versioned reviews; admits and reads batches'
  studio.handlers -> studio.project_store 'Reads a snapshot; manages Project Contexts, Source Documents, schemas and model configuration'
  studio.handlers -> source_inbox 'Stages an uploaded PDF under its project and attempt'
  studio.handlers -> package_store 'Reads the pdf, markdown and source entries; discards the packages a deletion left unreferenced'
  studio.durable -> project_db 'Checkpoints Studio workflows in dbos; enqueues kei work in kei_dbos'
  studio.durable -> studio.extraction_module 'Runs runExtraction'
  studio.durable -> studio.provider_registry 'Runs Schema Suggestion and edit proposals'
  studio.durable -> studio.garbage 'Runs collectGarbage every ten minutes'
  studio.durable -> parsing_service.http_api 'Reads converted manifests and pages'
  studio.project_store -> project_db 'Reads and writes through Prisma Next'
  studio.extraction_module -> project_db 'Reads and writes the Extraction row, Evidence and versioned reviews through Prisma Next'
  studio.extraction_module -> package_store 'Reads the pinned canonical representation package'
  studio.extraction_module -> parsing_service.http_api 'Reads the published extraction artifact'
  studio.provider_registry -> studio.key_cache 'Reads a key inside each provider attempt'
  studio.provider_registry -> studio.project_store 'Reads the owner''s configuration'
  studio.provider_registry -> model_connections 'Calls the resolved Model Connection'
  studio.garbage -> project_db 'Checks references and both workflow schemas; deletes quiescent Studio history; enqueues deleteRuns'
  studio.garbage -> package_store 'Removes old unreferenced packages'
  studio.garbage -> source_inbox 'Removes old staged PDFs of finished attempts'
  parsing_service.parser -> project_db 'Dequeues its lanes and checkpoints in kei_dbos as role kei'
  parsing_service.parser -> source_inbox 'Copies the staged PDF into a run'
  parsing_service.parser -> parsing_service.models 'Calls OCR or extraction models as required'
  parsing_service.parser -> parsing_service.task_cache 'Publishes canonical pages and extraction artifacts; deletes unreferenced runs'
  parsing_service.http_api -> parsing_service.task_cache 'Serves canonical artifacts'
  ```
  Views: in `current_context` and `current_modules`, replace `model_config` with `source_inbox` in the `include` lists, and in `current_context`'s description replace "Model configuration and credentials remain deployment-wide shared state." with "Each Researcher Account owns its model configuration; keys stay in researchers' browsers and in Studio's memory." and "The Parsing Service job database and run directory are durable" with "The run directory and the source inbox are durable". In `local_compose_topology` and `local_entra_topology`, `studio.handlers -> parsing_service.http_api 'Submit and poll parsing tasks'` becomes `studio.durable -> parsing_service.http_api 'Read converted manifests and pages'`. In `schema_guided_extraction`, the generation and edit steps go through `studio.durable` (`studio.handlers -> studio.durable 'Start suggestSchema and wait for it'`, `studio.durable -> studio.provider_registry 'Resolve the owner''s Schema Suggestion Route'`, and likewise `proposeSchemaEdit` with the Interaction Route); in its description, "The Interaction Route serves chat and conversational schema edits." becomes "The Interaction Route serves conversational schema edits." (decision 15); and the extraction steps become:
  ```
    studio.ui -> studio.handlers 'POST /api/extractions with the pinned Source Representation and Schema Revision'
    studio.handlers -> studio.extraction_module 'Admit the Extraction row and runExtraction in one transaction'
    studio.durable -> studio.extraction_module 'Run runExtraction'
    studio.extraction_module -> project_db 'Enqueue kei extract on kei-extract with its priority and deadline'
    parsing_service.parser -> parsing_service.models 'Extract values and verify source evidence'
    studio.extraction_module -> parsing_service.http_api 'Read the published artifact'
    studio.extraction_module -> package_store 'Read the pinned parsed_document.v2 and canonical anchors'
    studio.extraction_module -> project_db 'Publish Evidence, issues and diagnostics on the Extraction row, once'
    studio.ui -> studio.handlers 'Poll GET /api/extractions/:id; its status is derived from the row and DBOS'
  ```
  Replace `source_document_ingestion` and `model_configuration`, and add `garbage_collection`:
  ```
  dynamic view source_document_ingestion {
    title 'Add Source Documents — current'
    description '''
      The Project Context page submits selected PDFs one at a time. Studio
      replays completed content from the project without parsing; otherwise it
      stages the verified PDF and starts one ingestSource workflow per project
      and content, which a second upload of the same content joins. The workflow
      hands the conversion to the Parsing Service's small or large lane by page
      count, with the owner's Ingestion Model Choice frozen into its input, then
      retains the canonical package and publishes the Source Document and
      revision 1. The request waits up to thirty minutes; a timeout detaches
      without cancelling.
    '''
    researcher -> studio.ui 'Add one or more PDFs'
    studio.ui -> studio.browser_http 'POST one PDF'
    studio.browser_http -> studio.handlers 'POST /api/project-contexts/:id/source-documents'
    studio.handlers -> studio.project_store 'Replay completed content, if any'
    studio.handlers -> source_inbox 'Stage the verified PDF under its project and attempt'
    studio.handlers -> studio.durable 'Start ingestSource, or join the active one for this content'
    studio.durable -> project_db 'Enqueue kei convert on the lane the page count picks'
    parsing_service.parser -> source_inbox 'Copy the staged PDF into a run'
    parsing_service.parser -> parsing_service.task_cache 'Publish the canonical pages'
    studio.durable -> parsing_service.http_api 'Read the result manifest and canonical pages'
    studio.durable -> package_store 'Retain and validate the canonical package'
    studio.durable -> studio.project_store 'Create Source Document and revision 1'
    studio.project_store -> project_db 'Commit the durable ingestion result'
    studio.handlers -> studio.ui 'Return the saved Source Document'
  }

  dynamic view model_configuration {
    title 'Model configuration — current'
    description 'Each Researcher Account has its own configuration; keys stay in the browser. Discovery is advisory: it never generates content, changes configuration, or gates Apply.'
    researcher -> studio.ui 'Open Configure models'
    studio.ui -> studio.handlers 'GET /api/model_config'
    studio.handlers -> studio.project_store 'Read the signed-in account''s configuration'
    studio.handlers -> studio.ui 'Show connections, steps and the deployment''s read-only connections'
    studio.ui -> studio.key_store 'Read this browser''s key for each keyed connection'
    studio.ui -> studio.handlers 'POST /api/model_probe with the key the page holds'
    studio.handlers -> studio.provider_registry 'Probe the provider adapter'
    studio.provider_registry -> model_connections 'Discover models or check connectivity'
    studio.handlers -> studio.ui 'Show the probe result without credentials'
    researcher -> studio.ui 'Edit a connection, a key or a step, then Apply'
    studio.ui -> studio.key_store 'Keep the key under account, connection and API base'
    studio.ui -> studio.handlers 'PUT /api/model_config'
    studio.handlers -> studio.project_store 'Save the account''s configuration in one transaction'
    studio.ui -> studio.handlers 'PUT /api/model-keys'
    studio.handlers -> studio.key_cache 'Keep the keys in memory for this account'
    studio.handlers -> studio.ui 'Show the committed configuration'
  }

  dynamic view garbage_collection {
    title 'Garbage collection — every ten minutes'
    description '''
      collectGarbage runs on its own queue. Each phase reads everything first
      and deletes nothing when a read fails. Work cancelled in the running
      Studio or Parsing Service process is kept until that process restarts,
      because one of its steps may still write.
    '''
    studio.durable -> studio.garbage 'Fire the schedule'
    studio.garbage -> project_db 'Cancel live work whose outcome is recorded or whose scope is gone, and kei children of stopped parents'
    studio.garbage -> project_db 'Delete quiescent Studio history past retention, or of a deleted scope'
    studio.garbage -> project_db 'Enqueue deleteRuns naming unreferenced conversions and the kei history that may go'
    parsing_service.parser -> parsing_service.task_cache 'Delete each run no kei workflow can still write, then its conversion''s history'
    studio.garbage -> source_inbox 'Remove staged PDFs of finished attempts after 24 hours'
    studio.garbage -> package_store 'Quarantine, recheck and remove unreferenced packages after 24 hours'
  }
  ```
  `docs/architecture/README.md`: replace "The model deliberately contains no speculative credential vault, key-management service, parsing queue, or separate application backend. Model configuration and credentials remain deployment-wide Studio state, and the Parsing Service owns no model operation." with "The model deliberately contains no credential vault, key-management service or separate application backend. Model configuration belongs to each Researcher Account; keys stay in researchers' browsers and in Studio's memory. Durable work runs as DBOS workflows inside Studio and the Parsing Service's worker." Change item 10 to "`model_configuration` — each account's Model Connections, steps and browser-held keys." and add "11. `garbage_collection` — the ten-minute sweep and its quiescence rules."

- [ ] **Step 5: Run the check and commit**

  ```bash
  grep -nE "FREE_PARSING_POSTGRES_PASSWORD|kei-jobs|job database|job PostgreSQL|schema initializer|Parsing PostgreSQL|job store|model-config\.json|Reset model configuration|deployment-wide|credential state|sync live|job schema" \
    docs/operations/local-development.md docs/architecture/README.md .env.example compose*.yaml
  grep -nE "job database|job PostgreSQL|schema initializer|Parsing PostgreSQL|job store|Reset model configuration|deployment-wide|credential state|sync live" docs/operations/deployment.md
  grep -nE "FREE_PARSING_POSTGRES_PASSWORD|kei-jobs|model-config\.json" docs/operations/deployment.md
  grep -nE "Procrastinate|jobs = datastore|batch_worker|model_config =|keyring|POST /api/runs" docs/architecture/current.c4
  grep -niE "document chat|chat turn|chat transcript|serves chat" docs/operations docs/architecture -r
  # the first, second, fourth and fifth print nothing; the third prints only lines of the cutover runbook section, which names
  # the old password, the old worker and the obsolete file on purpose
  pnpm architecture:check
  git add docs/operations docs/architecture .env.example
  git commit -m "docs(operations): run, inspect, back up and cut over the DBOS deployment; redraw the architecture"
  ```

### Task 13: The OpenSpec specs describe what shipped

Edited in place (Plan decision 10). Each spec keeps its file and its `## Purpose` / `## Requirements` layout; requirements use `SHALL`, and every requirement keeps at least one `#### Scenario` with **WHEN**/**THEN** bullets, as the existing specs do. Below, each requirement is given as its full statement plus its scenario titles; write each scenario's body from the requirement sentence it tests — one **WHEN** naming the input, one or two **THEN**/**AND** naming the observable result — as in these two worked examples, and check each body against the code or test that implements it (the M2/M4/M5 test with the same subject):

```markdown
#### Scenario: A key sent for one base is never used for another

- **WHEN** a researcher's page sent a key for a connection at one API base, and the connection's base is then changed
- **THEN** Studio does not use that key for the new base
- **AND** the page clears its stored key for that connection at once and schedules no probe with it

#### Scenario: Two simultaneous same-content uploads run one workflow

- **WHEN** two uploads of the same PDF into the same Project Context arrive before either completes
- **THEN** one `ingestSource` workflow parses it and both requests answer with the same Source Document
- **AND** the losing request's staged file is removed
```

**Files:**
- Modify: `openspec/specs/model-connection-configuration/spec.md`, `openspec/specs/capability-route-resolution/spec.md`, `openspec/specs/source-document-ingestion/spec.md`, `openspec/specs/schema-chat-edit/spec.md`

- [ ] **Step 1: The failing check**

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  grep -nE "machine-wide|model-config\.json|keyring|credential store|keyring_unavailable|Single model|nuextractRaw|Extraction Route|POST /tasks|one-hour grace|Seven provider kinds|duplicate CLI" openspec/specs/{model-connection-configuration,capability-route-resolution,source-document-ingestion,schema-chat-edit}/spec.md
  grep -niE "document.chat" openspec/specs/capability-route-resolution/spec.md    # hits at 8, 16, 18, 48, 77, 79, 81 today
  ```
  Expected today: many hits. After: none.

- [ ] **Step 2: `model-connection-configuration`** — Purpose: "Defines each Researcher Account's Model Connections, keys held in the researcher's browser, provider discovery, the deployment's read-only connections, and the Model Configuration page." Replace every requirement with these (scenarios in the existing style):
  1. **Each Researcher Account has one durable configuration.** FREE SHALL store one configuration per Researcher Account in PostgreSQL (connections, the Interaction and Schema Suggestion Routes, the Extraction Model Choice, the Ingestion Model Choice) and SHALL NOT store any key there. An account that never applied reads the empty configuration. `GET`/`PUT /api/model_config` read and replace only the signed-in account's configuration; one account's applies serialize on its row. FREE MUST NOT import or fall back to `AI_*` settings. Scenarios: *A fresh account reads an empty configuration*; *A second account reads none of the first's configuration*; *Two applies from one account serialize*; *A stored document that fails validation is a 500 that echoes nothing* (there is no reset).
  2. **Configuration writes accept only researcher-editable state.** (Keep today's two scenarios — *Existing identity changes provider kind*, *A route dangles after an edit* — and add:) A researcher-defined Codex CLI or Claude Code connection SHALL be refused by Apply and by Probe. Scenario: *A researcher-defined CLI connection is refused*.
  3. **Keys stay in the researcher's browser.** A connection SHALL record only `hasKey` (managed kinds always do). The page SHALL keep each key in `localStorage` under the signed-in account, bound to the connection's ID and API base; changing the base or provider SHALL clear it at once and cancel a scheduled probe. The page SHALL send keys with `PUT /api/model-keys` (write-only; entries merge; `null` removes one) on load, after Apply, before starting model work, when a response carries a new `X-FREE-Studio-Boot`, and once after `model_key_required`. Studio SHALL reject a handoff whose named account differs from the session's, and accept a key only for one of the account's connections at its current provider and base. Studio SHALL keep keys only in memory, use a cached key only while the connection still has that provider and base, and clear an account's keys at sign-out. A malformed key or probe body SHALL be answered with a fixed error that echoes nothing. Scenarios: *A key sent for one base is never used for another*; *A stale tab's handoff under another account is rejected*; *Sign-out clears this browser's keys and Studio's copy*; *A Studio restart is followed by a resend*; *A malformed body echoes nothing*.
  4. **Keyed and keyless connections call their servers as declared.** A connection with `hasKey` SHALL never call its server anonymously: with no cached key its attempt waits up to 60 s for a resend, ends early on an abort or a workflow cancel, and then fails with `model_key_required` (`isRetryable: false`). A connection without `hasKey` SHALL call anonymously, and a keyless Ollama connection SHALL NOT send the environment's `OLLAMA_API_KEY`. Scenarios: *No cached key, no page open*; *A cancel during the wait never reaches the provider*; *A keyless Ollama connection stays anonymous*.
  5. **Eight provider kinds; CLI providers are deployment connections.** FREE SHALL support Ollama, OpenAI, Anthropic, Google, vLLM and OpenAI-compatible researcher connections, and Codex CLI and Claude Code only as deployment connections enabled by `FREE_DEPLOYMENT_CLI_PROVIDERS`. Deployment connections (the vLLM servers from `FREE_DEPLOYMENT_*` and the enabled CLI providers) SHALL be listed read-only with reserved IDs, never saved, and usable by every researcher. (Keep today's base-URL scenarios: *Provider bases preserve supplied versions and prefixes*, *An API base contains embedded credentials*, *A native API base is customized*, *An Ollama server base reaches each native resource once* — minus its raw-NuExtract clause — and *Native OpenAI and OpenAI-compatible use distinct generation protocols*.) New scenario: *An enabled CLI provider is a read-only deployment connection*.
  6. **Discovery is advisory, ephemeral and seamless.** (Keep today's text and scenarios, with two changes:) *The panel opens with saved connections* becomes "WHEN the page opens THEN FREE probes every eligible connection — a deployment connection without a credential, a keyless connection anonymously, and a keyed one only with this browser's key for that account, provider and base — AND does not probe a keyed connection this browser has no key for"; and every "credential" in the probe text becomes "the key the page holds". Probes SHALL always carry the key typed or stored in the page; the server never looks one up for a probe.
  7. **Configuration and probe endpoints expose stable observable results.** (Keep the envelope and status rules; drop credential actions, `credentialStates`, the keyring's 503 and the local-prototype-only sentence.) Scenarios: keep *Apply does not probe*, *An explicit probe reports a provider failure*, *Probes overlap*; *A new draft is probed* now says the probe uses "the key the page supplies, never a stored one".
  8. **The Model Configuration page follows the researcher's work.** The page SHALL have Models and Connections tabs sharing one draft and one Apply. Models SHALL have three steps: *Reading documents* (the Ingestion Model Choice), *Schema & chat* (the *Assistant model*, which is the Interaction Route; Schema Suggestion follows it until given its own route, and an explicit Schema Suggestion route stays explicit even when equal to it) and *Extracting data* (the Extraction Model Choice). "Use defaults" SHALL remove a step's stored choice. There SHALL be no Single/Routes mode. Scenarios: *An unset Schema Suggestion route follows the Assistant model*; *An explicit route stays explicit across a reload*; *Use defaults removes the stored choice*; *A manual model ID is displayed* (today's scenario).
  9. **The Ingestion Model Choice lists what the deployment serves.** The page SHALL offer OCR models from `GET /api/ingestion-models`, marking one the OCR server does not serve as not selectable, and layout presets, which are always selectable. A saved choice the listing no longer offers SHALL stay saved and shown; a listing failure SHALL block no other edit. Scenarios: *An OCR model the server does not serve cannot be chosen*; *A saved choice the listing dropped stays*; *A listing failure blocks nothing else*.
- [ ] **Step 3: `capability-route-resolution`** — Purpose: "Maps every Studio model operation to its Project Context owner's route, with the deployment's defaults for unset routes." Requirements:
  1. **Two Capability Routes per Researcher Account.** Schema Suggestion SHALL resolve the Schema Suggestion Route; conversational Extraction Schema editing (edit proposals) SHALL resolve the Interaction Route. Extraction runs in the Parsing Service on the Extraction Model Choice and resolves no Capability Route. Every operation, background work included, SHALL resolve the Project Context owner's configuration when it starts. Scenarios: *Schema Suggestion is routed*; *Schema editing is routed*; *Another account's routes are never consulted*.
  2. **Resolution uses one exact target, with named defaults.** An unset Interaction Route SHALL resolve to the deployment's instruction model when the deployment serves one; an unset Schema Suggestion Route SHALL resolve `schemaSuggestion ?? interaction ?? default`. Nothing else substitutes. (Keep *The selected model was entered manually* and *Environment settings are present*.) Scenarios: *An unset Schema Suggestion Route follows the Interaction Route*; *With no route and no deployment default the operation fails with `invalid_model_config`*.
  3. **The NuExtract protocol is derived.** Schema Suggestion SHALL use the NuExtract protocol exactly when the route's connection is vLLM and its model ID names NuExtract (`/nuextract/i`); no route stores or selects a protocol, and no other route uses it. Scenario: *All four combinations of vLLM or not and NuExtract model or not* (only vLLM + NuExtract uses the protocol).
  4. (Keep **Explicit unsupported temperature fails before model invocation** unchanged. Keep **Interaction context uses canonical Source Document Markdown** without the document chat (decision 15): delete its first sentence ("Document chat SHALL include …") and the scenario *Document chat has a Source Document*; "Neither Interaction operation SHALL send raw Docling output or choose a route based on input media." becomes "It SHALL NOT send raw Docling output or choose a route based on input media.", and *Schema editing has a Source Document source* gains "- **AND** it does not send raw Docling output".)
  5. **A recovered operation resolves again and records no attribution.** A workflow SHALL carry only IDs; each attempt resolves the owner's current route and key. Interactive results (generations and edit proposals) record no Model Attribution. Scenario: *A route changed between two attempts runs the second attempt on the new route*.
- [ ] **Step 4: `source-document-ingestion`** — Purpose: "Upload a PDF Source Document into a Project Context, parse it durably in the Parsing Service, and publish it once per project and content." Replace the whole requirement set (the `POST /tasks` service it describes no longer exists) with:
  1. **Upload validation preserves the PDF trust boundary.** Studio SHALL accept one PDF per request under the owner's Project Context, stream it with an exact 100 MiB cap, and require a PDF MIME hint (when present) and `%PDF-` magic bytes. (Keep today's scenarios for exactly 100 MiB, over 100 MiB, a disallowed MIME hint, absent magic and a declared oversized envelope, re-worded from "task creation" to "the upload".)
  2. **Completed content replays before parsing.** A PDF whose SHA-256 already has a Source Document in the same Project Context SHALL return that document without staging, converting or starting a workflow; the same bytes in another Project Context are independent. Scenarios: *Re-uploading a completed PDF returns the existing document*; *Identical PDFs in two projects are parsed independently*.
  3. **One active ingestion per project and content.** Otherwise Studio SHALL stage the verified bytes at `<project>/<attempt>.pdf` in the source inbox (atomic rename) and enqueue `ingestSource` with deduplication by project and content; a concurrent or repeated upload of the same content SHALL join the active attempt, and the loser's own staged file SHALL be removed. The workflow's first step rechecks completed content. A failed or cancelled attempt releases the deduplication, so uploading again starts a new attempt; there is no client key. Scenarios: *Two simultaneous same-content uploads run one workflow*; *A re-upload after a lost response joins the active attempt*; *A failed attempt can be retried by uploading again*.
  4. **Conversion runs on the lane its page count picks, with the admitted models.** Admission SHALL count the PDF's pages (pdf.js, count only) and send at most 30 pages to `kei-convert-small` and anything else, including a PDF pdf.js cannot open, to `kei-convert-large`; it SHALL freeze the owner's explicit Ingestion Model Choice into the workflow input. A recovered or replayed ingestion keeps its lane and models. Scenarios: *A small PDF converts on the small lane while a large one converts*; *An uncounted PDF converts on the large lane*; *An ingestion recovered after the owner changed the choice runs its admitted models*.
  5. **The request waits, and a timeout detaches.** The upload SHALL wait up to thirty minutes for the workflow's outcome and answer 201 with the Source Document, 422 `source_ingestion_failed` with the Parsing Service's reason, or 504 on a deadline or timeout; a 504 SHALL NOT cancel the workflow. Scenario: *A 504 leaves the work running and a later upload joins or replays it*.
  6. **Staged sources are removed by reference and age.** A staged PDF SHALL be deleted by its workflow after use; garbage collection SHALL remove a staged file only when it is older than 24 hours, its attempt's workflow is absent or terminal, and its Parsing Service conversion is not live. Scenarios: *A file staged before a crash that never enqueued is removed after 24 hours*; *The active attempt's PDF is never removed*.
  Keep `<!-- markdownlint-disable MD013 -->` at the top.
- [ ] **Step 5: `schema-chat-edit`** — in *Schema panel includes an inline chat area*, keep the text. Add:
  - **Requirement: A schema edit proposal survives a reload and a Studio restart.** Each edit request SHALL carry a new operation ID and its base Schema Revision and run as a `proposeSchemaEdit` workflow. After a reload the schema panel SHALL show a running proposal with its instruction and poll it every 2 s until it settles, and SHALL reopen the review bar for the newest finished proposal whose base is the current revision while the draft is clean. Discard SHALL delete that proposal and every older finished proposal on the same base; Stop SHALL cancel a running one. Scenarios: *A reload mid-proposal reopens the review bar*; *Discard persists across a reload*; *A proposal on an older base is not restored*; *A second account cannot list, read or cancel the first's proposals*.
- [ ] **Step 6: Run the check and commit**

  ```bash
  grep -nE "machine-wide|model-config\.json|keyring|credential store|keyring_unavailable|Single model|nuextractRaw|Extraction Route|POST /tasks|one-hour grace|Seven provider kinds|duplicate CLI" openspec/specs/{model-connection-configuration,capability-route-resolution,source-document-ingestion,schema-chat-edit}/spec.md
  # prints nothing
  grep -niE "document.chat" openspec/specs/capability-route-resolution/spec.md
  # prints nothing (decision 15)
  grep -c "^#### Scenario" openspec/specs/{model-connection-configuration,capability-route-resolution,source-document-ingestion,schema-chat-edit}/spec.md
  # every requirement has at least one scenario: compare with grep -c "^### Requirement"
  git add openspec/specs
  git commit -m "docs(openspec): sync the model configuration, route resolution, ingestion and schema-edit specs with what shipped"
  ```

### Task 14: Verification, the smoke kit, and bookkeeping (local)

**Files:**
- Create: `docs/validation/<YYYY-MM-DD>-dbos-m6-verification.md`
- Create: `docs/plans/2026-09-24-unified-durable-execution-evidence/m6-spark/make_scans.py`, `queries.sql`, `planted-key-scan.sh`, `README.md` (a stub Task 16 fills)
- Modify: this plan's `Status:` line

- [ ] **Step 1: Residue search** (spec *Verification*)

  ```bash
  cd /home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6
  grep -rniE "procrastinate|leaseOwner|leaseExpiresAt|leaseVersion|claimBatch|renewLease|wakeAfter|kick\(|checkpoint\(|ConfigFileSystem|keyring|dbus|write barrier|writeBarrier|retryOfId|llmInspector|llm_inspector|/events|cancel_requested|free-document-chat|result_version.{0,4}4|options\.model|ExtractionJob|BatchExtractionMember|ingestionKey|follower|admission wait|SuggestionSourceProgress|configurationMode|nuextractRaw|KEI_EXP_MODEL|ChatTurn|chatTurn|streamChatWithModel|ChatTab|vercel-ai" \
    prototypes packages scripts docker compose*.yaml tests .github .env.example docs/operations docs/architecture README.md CONTEXT.md openspec/specs \
    --exclude-dir=node_modules --exclude-dir=.venv
  ```
  Record every hit with its reason, as the M3 record did. Expected exceptions only: tests that assert an absence (`tests/safety.test.mjs`, `prototypes/parsing_service/tests/test_api_reads.py`, `scripts/free.test.mjs`, the M2–M5 absence tests, including any M5 test that pins `@dbos-inc/vercel-ai`'s absence from `ssr.external`), the 422 request-body tests that post a removed field, and the cutover runbook in `docs/operations/deployment.md` (it names `kei-jobs` and `model-config.json` on purpose). ADRs, `docs/plans/`, `docs/validation/` and `openspec/changes/archive/` are historical records, not residue.
  Structural check (spec *Rules*: no tombstones, barriers, cleanup-intent tables or reconcilers): `git diff <the M5 record's tested commit>..HEAD -- packages/db/src/prisma/contract.prisma packages/db/migrations` prints nothing.

- [ ] **Step 2: Run every tier**

  ```bash
  pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety && pnpm architecture:check
  # fresh disposable databases (Global Constraints), DATABASE_URL = EXTRACTION_TEST_DATABASE_URL, plus PARSING_TEST_DATABASE_URL:
  pnpm test:postgres
  pnpm test:e2e && pnpm --filter studio test:e2e:base-path
  pnpm test:service
  pnpm --filter studio build
  ```
  Then the production-bundle smoke of M4/M5 Task 14, extended: with the bundle running on a disposable `free_test_m6_bundle` database, run `DATABASE_URL=<that URL> pnpm --filter studio gc:now`; it prints a summary with `failedPhases: []`, which proves the production host registered `collectGarbage` and applied its schedule on `gc`. While the bundle is idle and again during one sweep, record `SELECT usename, application_name, state, count(*) FROM pg_stat_activity WHERE datname = 'free_test_m6_bundle' GROUP BY 1, 2, 3` (spec *Pools*: Studio's domain pool, its DBOS pool, the admission and kei clients; the Spark run in Task 15 adds the kei worker). Run `pnpm test:system` only if port 5432 is free and `FREE_TEST_OLLAMA_BASE_URL` answers (Plan decision 9); otherwise record it as skipped with that reason. A tier this host cannot run is recorded with its reason, never as passed.

- [ ] **Step 3: The smoke kit for Task 16** (reviewed like code; nothing here touches the Spark)

  `m6-spark/make_scans.py` — image-only PDFs from the repository's grave reports, so the Parsing Service runs OCR and layout (the originals carry a text layer, which would bypass both):
  ```python
  """Scanned (image-only) PDFs for the Spark smoke.

  UV_PROJECT_ENVIRONMENT=/tmp/kei-m3-t7-venv uv run --no-sync --project prototypes/parsing_service \
      python docs/plans/2026-09-24-unified-durable-execution-evidence/m6-spark/make_scans.py <out dir>
  """
  import sys
  from pathlib import Path

  import pypdfium2 as pdfium

  ROOT = Path(__file__).resolve().parents[4]
  GRAVES = ROOT / "examples" / "graves"
  SCALE = 150 / 72


  def pages(pdf_path, count=None):
      document = pdfium.PdfDocument(pdf_path)
      try:
          total = len(document) if count is None else min(count, len(document))
          return [document[index].render(scale=SCALE).to_pil().convert("RGB") for index in range(total)]
      finally:
          document.close()


  def write(images, target):
      images[0].save(target, "PDF", resolution=150, save_all=True, append_images=images[1:])
      check = pdfium.PdfDocument(target)
      assert all(check[index].get_textpage().count_chars() == 0 for index in range(len(check))), "a text layer survived"
      print(f"{target.name}: {len(check)} pages")


  def main(out: Path):
      out.mkdir(parents=True, exist_ok=True)
      write(pages(GRAVES / "Hvissinge_Ost_TAK_1728.pdf") + pages(GRAVES / "Hojbakkegaard_TAK_1177.pdf"), out / "large41-scan.pdf")
      write(pages(GRAVES / "Brondbylund_3_TAK_1506.pdf", 3), out / "small3-scan.pdf")
      write(pages(GRAVES / "Katrinesminde_SBM1116.pdf", 2), out / "layout2-scan.pdf")


  if __name__ == "__main__":
      main(Path(sys.argv[1]))
  ```
  Run it into `/tmp/free-m6-spark/` and record the page counts (41, 3, 2). The PDFs are not committed.
  `m6-spark/queries.sql` — the read-only queries Task 16 runs with `psql -v name=value -f`: Studio and kei workflows of one project (`attributes @> jsonb_build_object('projectContextId', :'project')`), lane order (`SELECT workflow_uuid, queue_name, status, to_timestamp(completed_at/1000.0) FROM kei_dbos.workflow_status WHERE workflow_uuid LIKE 'kei-%' ORDER BY created_at DESC LIMIT 20`), the schedule (`SELECT * FROM dbos.workflow_schedules`), connection counts (`SELECT usename, application_name, state, count(*) FROM pg_stat_activity WHERE datname = 'free' GROUP BY 1, 2, 3`), orphan payload rows in both schemas (the query of `orphanPayloadRows`, written out for `dbos` and `kei_dbos`), and the role check (`SET ROLE kei; SELECT 1 FROM public."ProjectContext" LIMIT 1;` expected to fail with 42501).
  `m6-spark/planted-key-scan.sh`:
  ```bash
  #!/usr/bin/env bash
  # On the Spark, from ~/Projects/FREE: KEY=<synthetic key> PROJECT=<compose project> COMPOSE="docker compose -f … -f …" bash planted-key-scan.sh
  # Prints counts only; the dump and the logs stay in the pipe.
  set -euo pipefail
  : "${KEY:?}" "${PROJECT:?}" "${COMPOSE:?}"
  dump=$($COMPOSE exec -T db pg_dump -U postgres free | grep -cF -- "$KEY" || true)
  files=$(docker run --rm -e KEY \
    -v "${PROJECT}_studio-data:/v/studio-data:ro" -v "${PROJECT}_studio-config:/v/studio-config:ro" \
    -v "${PROJECT}_studio-claude:/v/studio-claude:ro" -v "${PROJECT}_source-inbox:/v/source-inbox:ro" \
    -v "${PROJECT}_parsing-runs:/v/parsing-runs:ro" --entrypoint sh postgres:17 -c 'grep -rlF -- "$KEY" /v | wc -l')
  logs=$($COMPOSE logs --no-color studio parsing_service parsing_worker 2>&1 | grep -cF -- "$KEY" || true)
  echo "pg_dump matches: ${dump}; volume files: ${files}; log lines: ${logs}"
  ```
  `bash -n` it. `m6-spark/README.md`: a stub with the title "DBOS M6 on the DGX Spark: cutover and end-to-end smoke (pending)" and the list of files above.

- [ ] **Step 4: Record and commit**

  Write the verification record (tested commit, commands, results, skips with reasons, the residue table, the pool counts, the `gc:now` summary, and a pointer to this plan's traceability table). Set this plan's status to `Tasks 1–14 done YYYY-MM-DD; the Spark cutover (Tasks 15–16) pending`.
  ```bash
  git add docs/validation/<file> docs/plans/2026-09-24-unified-durable-execution-evidence/m6-spark docs/plans/2026-09-26-dbos-m6-gc-docs-cutover.md
  git commit -m "docs(plans): record DBOS M6 local verification and the Spark smoke kit"
  ```

### Task 15: CONTROLLER-RUN — the branch to the Spark and the clean-slate cutover

**Never dispatched to a subagent.** The controller runs every step itself over SSH and stops at each ⛔ until the user answers **yes** to that exact step in this session; a standing goal is not a yes. Nothing is printed from `.env`, `~/free-secrets` or a dump. vLLM model containers are never restarted, stopped or recreated.

Shorthands used below (on the Spark, in `~/Projects/FREE`):
```bash
ssh -A geba@baratheon.cdch-dgxspark.lan.ku.dk       # agent forwarding: the Spark's own key has a passphrase
export PATH="$(ls -d ~/.nvm/versions/node/v24*/bin | tail -1):$HOME/.local/bin:$PATH"
cd ~/Projects/FREE
DC="docker compose -f compose.yaml -f compose.prod.yaml -f compose.nginx.yaml -f compose.gpu.yaml"
PROJECT=$(docker compose -f compose.yaml -f compose.prod.yaml ps --format '{{.Project}}' | head -1)   # expected: free
```

- [ ] **Step 1: Preconditions (local).** Task 14 is recorded with every tier green (or each gap explained and accepted by the user); the user has read this plan's rulings list; the working tree is clean.
- [ ] **Step 2: ⛔ Push the branch to `origin`** (Ruling 7a: GitHub, no pull request; Ruling 6: the user's yes at this moment). Show `git log --oneline origin/feat/kei-exp-parser..feat/dbos-m2-m6 | wc -l` and the branch tip, wait for yes, then `git push origin feat/dbos-m2-m6`. Record the pushed SHA; Step 4 checks the Spark against it.
- [ ] **Step 3: Pre-flight on the Spark (read-only).** Record in the evidence README:
  ```bash
  git status --short; git branch --show-current; git log -1 --oneline
  df -h / /var/lib/docker; docker system df
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
  docker volume ls --filter "name=${PROJECT}_" --format '{{.Name}}'
  docker inspect -f '{{.Name}} {{index .Config.Labels "com.docker.compose.config-hash"}}' $(docker ps -q) | sort
  grep -o '^[A-Z_]*=' .env | sort          # names only, never values
  ```
  Stop and report if the checkout has local changes, if free disk is under about 60 GB, or if any `parsing_worker`/`kei-jobs` container is restarting.
- [ ] **Step 4: The user fetches the branch; ⛔ then prepare `.env`** (non-destructive to data; changes production's configuration). The user fetches on the Spark (Ruling 7a: the Spark's key has a passphrase), for example in their own `ssh -A` session:
  ```bash
  cd ~/Projects/FREE
  GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15" git fetch origin feat/dbos-m2-m6
  git switch feat/dbos-m2-m6 2>/dev/null || git switch -c feat/dbos-m2-m6 --track origin/feat/dbos-m2-m6
  git merge --ff-only origin/feat/dbos-m2-m6
  ```
  The controller then checks, read-only, that `git branch --show-current` prints `feat/dbos-m2-m6`, `git log -1 --format=%H` prints Step 2's SHA and `git status --short` prints nothing; otherwise stop and report. After the user's yes:
  ```bash
  grep -q '^FREE_KEI_POSTGRES_PASSWORD=' .env || printf 'FREE_KEI_POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" >> .env
  grep -c '^FREE_DEPLOYMENT_CLI_PROVIDERS=.' .env      # must print 0: no CLI deployment connection (Ruling 7b)
  ```
  If the second command prints 1, stop and ask before changing it. Leave `FREE_PARSING_POSTGRES_PASSWORD` in `.env` until Step 7 succeeds (the old stack's `parsing_db` still reads it); remove it in Step 9.
- [ ] **Step 5: Model servers stay untouched (read-only check).** `$DC config --hash '*'` and compare each `ocr_model`, `nuextract_model` and `extraction_model` hash with the running container's label from Step 3. If any differs, **stop**: starting the new stack would recreate that model server. Report which one and why (the rendered difference: `$DC config ocr_model` against the old checkout's rendering) and wait for the user's decision.
- [ ] **Step 6: Build while the old stack serves.** `$DC build studio parsing_service parsing_worker` (a failed build changes nothing that runs). Record the duration.
- [ ] **Step 7: ⛔ Stop, dump, reset (destructive).** Show the user the exact commands below with the container and volume names Step 3 printed, and wait for yes.
  ```bash
  $DC stop --timeout 60 nginx studio parsing_service parsing_worker
  docker stop "${PROJECT}-parsing_migrate-1" 2>/dev/null || true
  docker ps --format '{{.Names}} {{.Command}}' | grep -c kei-jobs          # must print 0: the old worker's .slot-<n>.lock
                                                                          # would not exclude the new worker's .worker-<n>.lock
  CUTOVER=~/free-cutover-$(date +%F) && mkdir -m 700 -p "$CUTOVER"
  docker exec "${PROJECT}-db-1" pg_dump -U postgres -Fc free > "$CUTOVER/free.dump"
  docker exec "${PROJECT}-parsing_db-1" sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$CUTOVER/parsing_db.dump"
  chmod 600 "$CUTOVER"/*.dump && ls -la "$CUTOVER"
  docker stop "${PROJECT}-parsing_db-1" && docker rm "${PROJECT}-parsing_db-1" "${PROJECT}-parsing_migrate-1"
  docker volume rm "${PROJECT}_parsing-postgres"
  docker exec "${PROJECT}-db-1" dropdb -U postgres --force free
  docker exec "${PROJECT}-db-1" createdb -U postgres free
  docker run --rm -v "${PROJECT}_parsing-runs:/runs" --entrypoint sh postgres:17 -c 'ls -la /runs | head -20; find /runs -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
  docker run --rm -v "${PROJECT}_studio-data:/d" --entrypoint sh postgres:17 -c 'ls -la /d'
  ```
  The `studio-data` listing must show only `FREE Studio-nodejs` (Studio's data directory); if it shows anything else, stop and ask before deleting. Then:
  ```bash
  docker run --rm -v "${PROJECT}_studio-data:/d" --entrypoint sh postgres:17 -c 'rm -rf "/d/FREE Studio-nodejs"'
  docker run --rm -v "${PROJECT}_studio-config:/c" --entrypoint sh postgres:17 -c 'ls -la /c "/c/FREE Studio-nodejs" 2>&1; rm -f "/c/FREE Studio-nodejs/model-config.json"'
  ```
  Keep `codex/` in `studio-config`, all of `studio-claude`, the model caches, `~/free-secrets` and the TLS files. The dumps are for inspection only; there is no restore path (spec *Cutover*).
- [ ] **Step 8: Start the new stack.** `node scripts/free.mjs production` (it validates `.env` including `FREE_KEI_POSTGRES_PASSWORD`, builds from cache, stops the three services — already stopped — and runs `up --no-build -d --wait`; the `source-inbox` volume is created). Then confirm the model containers kept their IDs and start times from Step 3.
- [ ] **Step 9: Post-start checks (read-only), recorded.**
  ```bash
  $DC ps
  curl --fail -sS --cacert ~/free-secrets/<the TLS certificate file .env names> https://baratheon.cdch-dgxspark.lan.ku.dk:11434/free/api/healthz
  $DC logs --no-color --since 15m studio | grep -E "listening|DBOS" | tail -20
  $DC logs --no-color --since 15m parsing_worker | grep -E "slot|serving" | tail -5
  $DC exec -T db psql -U postgres -d free -c '\dn'                           # public, dbos, kei_dbos
  $DC exec -T db psql -U postgres -d free -c 'SELECT * FROM dbos.workflow_schedules'
  $DC exec -T db psql -U postgres -d free -v ON_ERROR_STOP=0 -c 'SET ROLE kei; SELECT 1 FROM public."ProjectContext" LIMIT 1'   # permission denied
  $DC exec -T db psql -U postgres -d free -c "SELECT usename, application_name, state, count(*) FROM pg_stat_activity WHERE datname = 'free' GROUP BY 1, 2, 3"
  $DC exec -T studio pnpm --filter studio gc:now                             # failedPhases: []
  ```
  (Check the certificate file name with `grep -o '^FREE_TLS_CERT_PATH=' .env` — the name only — and `ls ~/free-secrets`.) Then remove the old password line: `sed -i '/^FREE_PARSING_POSTGRES_PASSWORD=/d' .env`. If the stack does not become healthy, do not improvise a rollback: collect `$DC ps` and the failing service's last 200 log lines, report, and wait. Falling back means switching the checkout to `feat/kei-exp-parser` and starting an *empty* old stack (the data is already gone), which also needs the user's yes.
- [ ] **Step 10: Record** the cutover section of `m6-spark/README.md` (commands, timings, the connection counts, the schedule row, the `gc:now` summary; no secret, no dump content).

### Task 16: CONTROLLER-RUN — the end-to-end smoke on the Spark, and the milestone record

**Never dispatched to a subagent.** Driver (Ruling 7d): the Playwright MCP browser (`mcp__plugin_playwright_playwright__*`) is already signed in to the Spark; the controller drives the UI there, uses `browser_evaluate` only for same-origin JSON reads, and gathers the server-side evidence over SSH (`queries.sql`, logs). The controller never handles Entra credentials: if the session has expired, the user signs in again in that browser. Every item records **what was done, by whom, and the evidence** in `m6-spark/README.md`. ⛔ marks a step that disrupts the running service.

- [ ] **S1 Session and configuration.** The browser is signed in (Ruling 7d). Models tab: the deployment's vLLM connections are listed read-only and no CLI connection is (Ruling 7b); set *Reading documents* to OCR `surya` (the default OCR model) and layout `layout_egret_xlarge` (non-default) (Ruling 7e); leave the Assistant model unset (the deployment's instruction model). Evidence: `GET /api/ingestion-models` shows `surya` serving and the other OCR models not serving and not selectable (a screenshot of the step, and the JSON from `browser_evaluate(fetch(...))`).
- [ ] **S2 Upload.** Create project *M6 smoke A*; upload `examples/Beretning_Ellekilde_8_13.pdf` (native, 6 pages). Evidence (`queries.sql`): `ingest:<project>:<attempt>` `SUCCESS` on queue `studio`; `kei-convert:ingest:<project>:<attempt>` `SUCCESS` on `kei-convert-small`.
- [ ] **S3 Extraction and cancel.** Draft a small schema; run an Article extraction to `COMPLETED` (Evidence links visible). Start a Catalog extraction on the same document and press Cancel within a few seconds. Evidence: the attempt reads cancelled; `extract:<id>` and `kei-extract:<id>` are `CANCELLED` within 5 s of each other.
- [ ] **S4 Batch suggestion.** Upload `examples/graves/Brondbylund_3_TAK_1506.pdf` into the same project; run a Batch Schema Suggestion over both documents. Evidence: the proposal is ready; `suggest:<id>:1` `SUCCESS` on queue `suggest`.
- [ ] **S5 Generation and schema edit across a reload.** Generate a schema; reload the page while it runs; the panel shows "Still working …" and then saves the result. Ask for a schema edit; reload while it runs; the review bar returns; Discard; reload; it stays discarded. Evidence: `suggestion:<op>` and `edit:<op>` rows `SUCCESS`, each with one model call in Studio's log.
- [ ] **S6 ⛔ A Studio kill mid-generation.** Start a generation; then `docker kill -s KILL "${PROJECT}-studio-1" && docker start "${PROJECT}-studio-1"`. The page recovers (the boot ID changes; keys would be resent) and the generation saves once. Evidence: the `suggestion:<op>` row has `recovery_attempts >= 2` and ends `SUCCESS`; the Schema Revision count grew by one.
- [ ] **S7 ⛔ An edit proposal across a reload and a Studio kill** (replaces the chat turn: decision 15, Ruling 3; with S5 and S6, generation and edit proposals each cross a reload and a kill). Ask for a schema edit ("Add a field for the site's municipality"); reload while it runs: the panel shows the running proposal with its instruction and polls it. While it still runs, kill Studio as in S6. Once Studio is back the page recovers and the review bar opens once, with the proposal on the current base revision; Discard it and reload: it stays discarded. If the proposal settles before the kill lands, repeat with a longer instruction and record the number of tries. Evidence: the `edit:<op>` row has `recovery_attempts >= 2` and ends `SUCCESS`; `GET /api/model-operations?projectContextId=<project>&extractionSchemaId=<schema>` through `browser_evaluate` lists it once before Discard and not after; Studio's log shows no provider error body.
- [ ] **S8 Two accounts: not run on the Spark** (Ruling 7c: there is no second Entra account). Record it as not run, naming the local tests that cover it: M2's two-account model-configuration e2e test, M5's model-operation ownership tests (a second account cannot list, read or cancel the first's operations: 404, never 403) and `server/researcher-project-ownership.test.ts`.
- [ ] **S9 A scanned PDF under the non-default layout choice.** Upload `/tmp/free-m6-spark/layout2-scan.pdf` into project *M6 smoke B*. Evidence: its revision's `preprocessId` names run `R`; `$DC exec -T parsing_service python -c "import json, urllib.request; m = json.load(urllib.request.urlopen('http://127.0.0.1:8001/api/runs/R/result')); print(m['recipe']['model'], m['recipe']['layout_model'])"` prints `surya layout_egret_xlarge` (Ruling 7e: the recipe must name both). The OCR half of the spec's "non-default OCR and layout choice" cannot be exercised here: the OCR server serves one model, and swapping it would restart a vLLM server (Ruling 6); the listing check in S1 stands in for it.
- [ ] **S10 Lanes: a small scan while a large scan converts.** In one tab upload `large41-scan.pdf` into *M6 smoke B*; when `queries.sql` shows its `kei-convert:` row `PENDING` on `kei-convert-large`, upload `small3-scan.pdf` from a second tab; when it completes, run an Article extraction on it. Evidence: the small conversion ran on `kei-convert-small`, and both its conversion and its extraction completed before the large conversion (`completed_at` order), which completes too.
- [ ] **S11 The app shell's CSP and the PDF viewer.** From the controller's machine: `curl -sS -k -D - -o /dev/null https://baratheon.cdch-dgxspark.lan.ku.dk:11434/free/ | grep -i content-security-policy` (the temporary certificate is self-signed; `-k` only for this header read) — record the header. Open a document: the PDF viewer renders its pages; `browser_console_messages` shows no Content-Security-Policy violation.
- [ ] **S12 A planted key reaches no dump, volume or log.** Locally generate `KEY=FREE_SYNTHETIC_KEY_$(openssl rand -hex 12)` (never commit it). In Connections add an OpenAI-compatible connection *Planted* with base `http://extraction_model:8000/v1` (the deployment's instruction server, which ignores the key) and key `$KEY`; its probe runs on page open. Point the Assistant model at *Planted* with the instruction model's ID; run a generation, a schema edit proposal and a Batch Schema Suggestion retry. Then on the Spark: `KEY=… PROJECT=$PROJECT COMPOSE="$DC" bash planted-key-scan.sh` prints `pg_dump matches: 0; volume files: 0; log lines: 0`. Remove the *Planted* connection and its key, and unset the Assistant model again.
- [ ] **S13 Project deletion, then garbage collection.** Right before deleting, start one more Catalog extraction in *M6 smoke A* and cancel it (cancelled in *this* Studio process; S3's was cancelled before the S6/S7 restarts). Delete *M6 smoke A*. Run `$DC exec -T studio pnpm --filter studio gc:now`. Evidence: `failedPhases: []`; no `SUCCESS`/`ERROR` Studio row with that `projectContextId` remains, and neither does S3's cancelled `extract:` row (it was updated before this boot); the fresh cancelled `extract:` row remains (the boot boundary); the `kei-gc:` workflow is `SUCCESS` and keeps the project's runs (younger than 24 h, and the fresh extraction's run is still protected by its holder): its output lists them under `kept_runs`, or the request did not name them. ⛔ Ask the user whether the controller may re-check after 24 hours **and** a restart of both Studio and the kei worker (a deploy restarts both): then the project's runs and their conversions' histories are gone (`$DC exec -T parsing_worker ls /app/runs`), which completes S13.
- [ ] **S14 Both schemas.** `queries.sql`'s status counts for `dbos` and `kei_dbos`, the schedule row, the connection counts during an extraction, and `orphanPayloadRows` for both schemas (0).
- [ ] **Record and close the milestone.** Fill `m6-spark/README.md`; write `docs/validation/<YYYY-MM-DD>-dbos-m6-spark-cutover.md` summarizing S1–S14 (result, evidence link, gaps with reasons); in the DBOS plan replace `**M6: garbage collection, documentation, test wiring and cutover.**` with `**M6: garbage collection, documentation, test wiring and cutover — done YYYY-MM-DD.** Task plan: [2026-09-26-dbos-m6-gc-docs-cutover.md](2026-09-26-dbos-m6-gc-docs-cutover.md); Spark: [record](../validation/<file>).` and change the plan's opening `Status:` line to say M1–M6 are done and the cutover ran on that date; add the date to README #10's cutover sentence; set this plan's status to `done YYYY-MM-DD`. Commit (controller); pushing that commit is another ⛔.

---

## Traceability: M6 acceptance → tests

Test files are under `prototypes/studio/` unless they start with `packages/` or `prototypes/parsing_service/`.

| Spec M6 acceptance (sub-bullet) | Test (file › name) | Task |
|---|---|---|
| A1 In-flight runs survive | `api/_garbage_plan.test.ts` › `never names a live or unquiesced parent's conversion, even when its run is unreferenced`; `api/garbage_acceptance.postgres.test.ts` › `a held ingestion's conversion, a held extraction's run and a fresh package survive a sweep`; `e2e/real-service-gc.spec.ts` › `a sweep during a held extraction leaves its run and history` | 5, 7, 8 |
| A1 In-flight packages survive | `packages/db/src/artifact-store.test.ts` › `a package reused while it is being swept is restored`, `saving a package the sweep has quarantined publishes it again`; `api/_garbage_plan.test.ts` › `removes old unreferenced packages and old leftovers only, …` | 4, 5 |
| A1 Children of live Studio parents survive | `api/_garbage_plan.test.ts` › `never names a live or unquiesced parent's conversion …`, `protects a run named by keiRunId …`; `api/garbage_acceptance.postgres.test.ts` › `a held ingestion's conversion …` | 5, 7 |
| A2 After a blocked cancelled native step exits and cleanup runs, no late orphan checkpoint remains | kei: `e2e/real-service-gc.spec.ts` › `a cancelled extraction blocked in its native step keeps its run and history through every sweep until kei restarts; afterwards nothing in kei_dbos is orphaned`; Studio: `api/garbage_acceptance.postgres.test.ts` › `current-process cancelled history survives any age; after a restart it goes, and no checkpoint is left orphaned` | 7, 8 |
| A3 A run with a cancelled kei workflow survives every sweep while that kei process lives, and is removed after a kei restart | `e2e/real-service-gc.spec.ts` › `a cancelled extraction blocked in its native step …`; `prototypes/parsing_service/tests/test_delete_runs.py` › `test_a_run_with_a_cancelled_conversion_waits_for_a_kei_restart`, `test_a_run_an_unfinished_extraction_reads_is_kept` | 1, 8 |
| A3 Runs that ended normally are removed without one | `e2e/real-service-gc.spec.ts` › `a deleted project's run, its kei history and its Studio history go in one sweep, without a kei restart`; `test_delete_runs.py` › `test_a_conversion_names_its_run_and_both_go_together` | 1, 8 |
| A3 A conversion running in another lane never loses files to a sweep | `e2e/real-service-gc.spec.ts` › `a sweep during a large conversion on another lane leaves its files; the conversion completes`; `test_delete_runs.py` › `test_a_live_conversion_keeps_its_old_run`, `test_prepare_leftovers_go_once_their_conversion_can_no_longer_write` | 1, 8 |
| A4 Late handoff: the run survives until a Studio restart | `api/garbage_acceptance.postgres.test.ts` › `late handoff: a run whose extraction handoff was held survives every sweep until a Studio restart, and the late kei child is cancelled`; `api/_garbage_plan.test.ts` › `protects a run named by keiRunId of a live extraction or one stopped in this process`, `protects a run while a kei-extract child naming it is live` | 5, 7 |
| A4 … and the late kei extraction never overlaps its deletion | `test_delete_runs.py` › `test_a_run_an_unfinished_extraction_reads_is_kept` (kei keeps a run while a cancelled extraction's step may still write, until kei restarts); `e2e/real-service-gc.spec.ts` › `a cancelled extraction blocked in its native step …` | 1, 8 |
| A5 Recovery exhaustion: the run survives GC in that process and is removed after the next kei restart | `prototypes/parsing_service/tests/test_worker_recovery.py` › `test_a_conversion_past_its_recovery_attempts_keeps_its_run_until_the_next_kei_restart`; `api/_garbage_plan.test.ts` › `names a conversion that ended MAX_RECOVERY_ATTEMPTS_EXCEEDED, for kei's own boot boundary to decide`; `test_delete_runs.py` › `test_prepare_leftovers_go_once_their_conversion_can_no_longer_write` (the exceeded case) | 1, 5, 8 |
| A6 Current-process cancelled Studio history survives GC regardless of age | `api/_garbage_plan.test.ts` › `keeps history cancelled in this process at any age, even for a deleted scope`; `api/garbage_acceptance.postgres.test.ts` › `current-process cancelled history survives any age; …` | 5, 7 |
| A6 A fully terminated process followed by a restart permits eligible cleanup, using the database-clock boot boundary; no in-place relaunch | `api/garbage_acceptance.postgres.test.ts` › same test (second run); `api/_garbage_plan.test.ts` › `deletes history cancelled before this boot once its age or deleted scope allows`, `a workflow is quiescent when absent, ended, or stopped before this boot`; M4 `server/dbos.test.ts` › `launches once per process: a second call returns the first launch and never launches again`, `reads the boot timestamp from the database clock, …` | 5, 7 (M4 1) |
| A7 Cancel publication then crash before DBOS cancel: the next sweep cancels Studio work with terminal domain outcomes | `api/garbage_acceptance.postgres.test.ts` › `a cancel written before a crash is carried to the workflow and its kei child by the next sweep`; `api/garbage_collection.postgres.test.ts` › `a sweep cancels a live runExtraction whose Extraction already has an outcome, and its kei child`; `api/_garbage_plan.test.ts` › the repair cases | 5, 6, 7 |
| A7 … and any late kei submission | `api/garbage_acceptance.postgres.test.ts` › `late handoff: …` (the late child is cancelled by the next sweep); `api/_garbage_plan.test.ts` › `cancels a live kei child whose parent is terminal, absent, or cancelled in this sweep` | 5, 7 |
| A8 Delete a project, then apply reference, retention and quiescence rules in both schemas | `api/garbage_acceptance.postgres.test.ts` › `after project deletion a sweep deletes the scope's settled history in both schemas, keeps its current-process cancelled history, and names only what is quiescent`; `e2e/real-service-gc.spec.ts` › `a deleted project's run, its kei history and its Studio history go in one sweep, …`; `api/_garbage_plan.test.ts` › `deletes a deleted scope's settled history at any age` | 5, 7, 8 |
| A8 Failed reference/status queries delete nothing | `api/garbage_collection.postgres.test.ts` › `a failed reference read deletes nothing in its phase and the other phases still run`, `a failed status read deletes nothing`; `api/_garbage_workflow.test.ts` › `reads every status and reference of a phase before it deletes or cancels anything`, `a failed phase is reported by name …`; `packages/db/src/garbage-references.postgres.check.ts` › `unknown or malformed IDs are absent, and a failed read rejects`; `test_delete_runs.py` › `test_a_failed_status_read_deletes_nothing` | 1, 3, 6 |
| A9 Stage then crash before enqueue: GC removes the unused file | `api/garbage_acceptance.postgres.test.ts` › `a file staged before a crash that never enqueued is removed once it is old`; `api/_garbage_plan.test.ts` › `removes an old file whose workflow is absent or terminal …` | 5, 7 |
| A9 Crash after enqueue: never the active attempt's PDF | `api/garbage_acceptance.postgres.test.ts` › `a file whose ingestion was recovered after a crash is kept while it runs, however old`; `api/_garbage_plan.test.ts` › `keeps a file whose attempt is live, whose kei child is live, …` | 5, 7 |
| A9 Lose a dedup race: only the unused file | `api/garbage_acceptance.postgres.test.ts` › `the losing upload of a deduplication race leaves only its own file for collection, never the winner's` | 7 |

Other M6 items and where they are built or proved:

| Spec M6 item | Where |
|---|---|
| The `collectGarbage` schedule | Task 6: `server/workflows.test.ts` › `registers collectGarbage under its name and applies its schedule every ten minutes on the gc queue without backfill`; `api/garbage_collection.postgres.test.ts` › `launch applies the collectGarbage schedule …`; Task 14 bundle `gc:now` |
| kei `deleteRuns` for kei files and history | Task 1 (contract, pytest, fixture, node:test); Tasks 6–8 drive it |
| Deletion handlers record interruption of affected suggestion attempts before removing membership | M4 Task 12: `packages/db/src/source-deletion.postgres.check.ts` › `deleting a source interrupts the active attempt without touching its proposal, draft or draft version`, `a late success or failure of the interrupted attempt changes nothing`; rerun in Task 14 |
| The Studio boot boundary for cancelled history | Tasks 5, 7 (A6) |
| Repair missed cancellation calls; no tombstones, barriers or status reconciler | Tasks 5–7 (A7); Task 14's structural check (no schema change) |
| ADR 0012; ADR 0013 superseding 0006; amendments to 0007 and 0011; the Procrastinate plan and `job-backend.md` superseded | Task 10 |
| README #5, #7, #8, #10, Extraction execution | Task 11 |
| CONTEXT.md configuration terms and Model Attribution; the Parsing README and CLAUDE; Studio CLAUDE | Task 11 |
| `docs/architecture/current.c4` | Task 12 (`pnpm architecture:check`) |
| OpenSpec specs for model-connection configuration, capability-route resolution, source-document ingestion, schema chat edit | Task 13 |
| Operations: backup set; DBOS inspection of both schemas; patch and version rules; the cutover runbook | Task 12 (`deployment.md` new sections) |
| Test wiring: `e2e/realService.ts`, the Playwright stack and configs start the kei worker | M4 Task 13 (`realService.ts`, real worker in `test:service`); superseded for the default e2e stack by M4 Ruling 12 (Plan decision 8); Task 8 extends the service harness |
| Test wiring: `verify.yml` and `scripts/test-ci.mjs` migrate the guarded test schemas | already true (both Studio targets migrated; DBOS tiers create their own schemas); pinned by Task 9 `scripts/test-ci.test.mjs` › `the Node aggregate runs every PostgreSQL tier CI migrates for, the Studio tier included` |
| Test wiring: `packages/db/package.json` runs `source-reprocessing.postgres.check.ts` | already true; pinned by Task 9 › `db's PostgreSQL tier runs the reprocessing and garbage-reference checks` |
| Residual M3 minors | Task 2 |
| Cutover (spec *Cutover (clean slate)*, steps 1–5) | Task 15 |
| Smoke test (spec *Cutover* step 6) and *Verification → Manual* on the GPU deployment | Task 16 S1–S14 |
| *Verification*: residue search; *Pools* measurement | Task 14 (local), Task 15 Step 9 (Spark, with the kei worker) |
| Decision 15 (the document chat is deleted): no chat prefix or row in garbage collection; the document-chat mentions in `CONTEXT.md`, ADR 0007 and the `capability-route-resolution` spec removed; the DBOS spec's remaining chat sections annotated | Tasks 3, 5 (`_garbage_plan.test.ts` › `deletes settled interactive history after 24 h …` over `suggestion:`/`edit:`); Tasks 10, 11, 13 (their checks); Task 14 residue search (`ChatTurn`, `chatTurn`, `streamChatWithModel`, `ChatTab`, `vercel-ai`) |
| Interactive work across a reload and a Studio kill on the Spark (generation and edit proposal) | Task 16 S5, S6, S7 |
| The user's cutover answers (Ruling 7): push to `origin` and the user's fetch; no CLI providers; S8 local-only; the signed-in Playwright browser; the OCR check | Task 15 Steps 2, 4; Task 16 intro, S1, S8, S9 |

## Deferred and out of scope

| Item | Where it goes | Why |
|---|---|---|
| M0R 6 pending: a book near 2000 pages (memory, cut time, the conversion deadline formula), `page_source=ingest` spreads, Studio schema generation during a kei extraction on `extraction_model` (its chat half went with decision 15) | Spark, separate (user's call) | not M6 acceptance; needs long GPU time on the production servers |
| Removal of the smoke's runs 24 h after S13 | Task 16 S13's follow-up, if the user allows it | runs younger than 24 h are kept by design |
| Merging `feat/dbos-m2-m6` (PR, review, `finishing-a-development-branch`) | after Task 16, the user's decision | the branch is complete only once the Spark smoke is recorded |
| A GitHub `verify` run on the branch | the merge pull request (no PR before the cutover: Ruling 7a) | CI runs only on pull requests and `dev` |
| S8 (two accounts) on the Spark | not run (Ruling 7c) | no second Entra account; the local two-account and ownership tests cover it |
| Fair sharing between accounts; per-page conversion fan-out; per-model-call Python checkpoints; streaming crops into OCR | out of scope | spec *Out of scope* |

