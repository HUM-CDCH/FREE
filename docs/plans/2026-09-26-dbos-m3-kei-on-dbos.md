# DBOS M3: kei on DBOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: **not started (plan written 2026-09-26 against c543aeb; assumes the M2 plan, `2026-09-26-dbos-m2-platform-configuration.md`, is implemented first).**

**Goal:** Deliver milestone M3 of the DBOS plan on `feat/dbos-m2-m6`: the Parsing Service's worker becomes kei's DBOS application (`convert`, `extract`, `deleteRuns` on four lanes), Procrastinate, `parsing_db` and the kei HTTP submission routes go, Catalog extraction runs its entries in parallel chunks, and the legacy v4-manifest and `options.model` readers are deleted.

**Architecture:** `src/kei_exp/workflows/` holds a DBOS 3.1.0 application (`kei`, schema `kei_dbos` in database `free`, version `kei@1`) run by `kei-worker worker`, which takes a lifetime flock, reads a database-clock boot timestamp, launches DBOS and registers four queues whose worker limit equals their global limit. Studio (M4) enqueues the three workflows by name with portable JSON; M3 pins that contract with fixtures and exercises it with a Python `DBOSClient`. Steps are plain functions outside a workflow, so most behaviour is tested without a database; lanes, cancellation, deadlines and recovery are tested against disposable PostgreSQL with a DBOS worker in the test process or in a child process. The parsing API keeps only its read routes and has no database.

**Tech Stack:** Parsing Service `kei_exp` (Python 3.13, FastAPI, pydantic 2, pytest, uv, `dbos==3.1.0`, psycopg 3), Studio (TypeScript, Zod 4, Vitest) for the v4 reader removal only, Docker Compose, `node:test` safety tests.

**Spec:** [docs/plans/2026-09-24-unified-durable-execution.md](2026-09-24-unified-durable-execution.md). Read *Rules*, *Target architecture*, *Workflows* (kei rows), *Studio → kei handoff*, *Cancellation*, *Deletion and garbage collection* (kei runs and history, kei boot boundary), *Queues, deadlines and upgrades*, *kei worker*, *Model configuration and keys → Ingestion Model Choice*, *Public contract changes* and *Milestones → M3* (it ends at its *Tests* list; the text from "`server/dbos.ts` holds" on is M4, whose heading is missing — it is not part of this plan). Evidence this plan builds on: [m0r/README.md](2026-09-24-unified-durable-execution-evidence/m0r/README.md) item 4 and [m0r/kei/kei_lanes.py](2026-09-24-unified-durable-execution-evidence/m0r/kei/kei_lanes.py) (proven queue, cancel, deadline and boot-boundary code on dbos 3.1.0), [rev8-tests/README.md](2026-09-24-unified-durable-execution-evidence/rev8-tests/README.md) (Catalog chunk harness).

## Rulings (controller, 2026-09-26)

1. **Ruling: M2–M4 are one integration boundary; only the full-stack tiers may be red at the M3 seam.** From Task 10 on, `pnpm test:service` (Studio's `e2e/real-service.spec.ts`, whose `e2e/realService.ts` starts `kei_exp.jobs.cli` and posts to `POST /api/runs`) is red until M4 rewrites the handoff, and a running `pnpm dev` stack cannot ingest or extract. Every component tier stays green at every task: parsing fast, parsing Postgres, Studio (`typecheck`, `lint`, `test`), `extraction` and `db` unit tiers, `node --test scripts/*.test.mjs` and `pnpm test:safety`. `pnpm test:e2e` is not affected by M3: its kei is an in-test HTTP fake on `127.0.0.1:41750` (`prototypes/studio/playwright.config.ts:19`), not the Python service, so it keeps whatever state M2 left. — *Why:* the spec runs component checks between M2, M3 and M4 and the full-stack gate after M4; Studio's submission side is rewritten in M4. — *Cost if wrong:* a component tier allowed to go red hides a kei regression that M4 then bisects across three milestones.
2. **Ruling: the Compose/runtime items M2 deferred move into M3 with their consumer.** M3 removes `parsing_db`, the `parsing-postgres` volume, `parsing_migrate` and the parsing API's database environment from every overlay; drops `FREE_PARSING_POSTGRES_PASSWORD` from `scripts/free.mjs` (there is no `parsing_db` stop/restart entry; `free.mjs:450` stops `studio parsing_service parsing_worker`), `free.test.mjs` and `.env.example`; gives `parsing_worker` kei's restricted database URL (role `kei` on database `free`, schema `kei_dbos`, created by M2's Studio entrypoint from `FREE_KEI_POSTGRES_PASSWORD`); makes `parsing_worker` wait for Studio's healthcheck and removes Studio's `depends_on: parsing_worker` (`compose.yaml:137-143`); and adds the safety tests "the parsing API has no database access" and "kei's restricted URL". The `source-inbox` volume stays M4 (Studio writes it), but `convert`'s input names the staged PDF by a path relative to `KEI_SOURCE_INBOX` now (Task 2). — *Why:* M2's Rulings 2 and 3; Procrastinate needs `parsing_db` until Task 10 deletes it. — *Cost if wrong:* M4 inherits a half-removed topology, or the worker starts before its role and schema exist.
3. **Ruling: the enqueuer sets the conversion deadline; M3 documents it and tests it with a Python-side enqueue.** `workflowTimeoutMS` for `convert` is `max(600_000, 3 × (20_000 + 6_300 × pages))` (M0R 4), computed by Studio's `submitToKei` in M4. M3 puts the formula and its values in `tests/fixtures/contracts/deadlines.json` and enqueues with Python's `workflow_timeout` (seconds). — *Why:* only the enqueuer knows the page count at admission, and DBOS measures the deadline from kei's dequeue (M0R 4). — *Cost if wrong:* a drift between the fixture and M4's TypeScript formula cancels a book early and discards hours of GPU work, which only the Spark would show.
4. **Ruling: the portable contract fixtures live in `prototypes/parsing_service/tests/fixtures/contracts/` and are checked by pytest in M3; M4 adds the node:test side.** — *Why:* the spec's *Contract* bullet; kei defines the contract, Studio consumes it. — *Cost if wrong:* a contract drift appears only at the M4 full-stack gate.
5. **Ruling: kei's DBOS identity and lanes are fixed.** App name `kei`, system schema `kei_dbos`, `application_version` `kei@1`, `enable_patching: True`, executor ID `kei-<slot>`. Queues `kei-convert-large` (global 1, worker 1), `kei-convert-small` (1, 1), `kei-extract` (2, 2; priority 1 interactive before 10 batch, FIFO ties), `kei-gc` (1, 1), registered after `DBOS.launch()`. dbos 3.1.0 has no priority flag (`priority_enabled` was removed in 3.0; M0R 4 measured priority order with none), so "priority enabled" is the enqueuer's `priority` and needs no queue option. The lifetime flock (`hold_slot`) is taken before launch; the boot timestamp is read from the database clock after the flock and before launch. — *Why:* spec *kei worker*, *Cancellation → Physical capacity* and M0R 4. — *Cost if wrong:* a cancelled native step's slot is reused (two conversions on one lane), or `deleteRuns` removes files a cancelled step is still writing.
6. **Ruling: no test needs a GPU.** Tests use `tests/helpers/fake.py`'s `FakeTranscriber` on image-only PDFs (`tests/helpers/pdfs.py:binary_pdf`), scripted chats (`tests/helpers/chat.py`) and `WordCounter` (`tests/test_extract_grounded.py`); the Postgres tier uses the existing guarded disposable databases (`tests/helpers/postgres.py`, `PARSING_TEST_DATABASE_URL`, one fresh `free_test_parsing_*` database per test). The only model-dependent tiers are the existing `live_model` ones (Docling weights, CPU) and Task 14 on the Spark. — *Why:* the implementers' hosts have no GPU. — *Cost if wrong:* the lane and chunk tests would be skipped exactly where they matter.

## Plan decisions (not settled by the spec; settled here — the three marked ★ need the controller's confirmation)

1. **Run IDs derive from the `convert` workflow ID:** `run-` + the first 24 hex digits of its SHA-256 (`runs.run_id_for`). `prepare_run` is then idempotent: a re-execution after a crash between its rename and its checkpoint rebuilds the same directory instead of orphaning one, and `deleteRuns` finds a run's conversion in its `params.json`. IDs still match Studio's `RUN_ID` (`api/source_documents.ts:42`). *Cost if wrong:* run IDs no longer show a date and model; nothing reads those.
2. **Extraction IDs derive from the `extract` workflow ID** (`kei-extract:<extractionId>`); the input carries no separate ID, so the artifact directory `extractions/<extractionId>/` always names its workflow.
3. **Failures.** `should_retry` is the spec's boolean predicate `isinstance(classify(e), TransientBackendError)`. kei's own refusals raise `KeiFailure(code, reason)` (never retried). Each workflow returns `{ok: false, code, reason, retryable}` for whatever its steps finally raised — `retryable: true` only after exhausted transient retries (`DBOSMaxStepRetriesExceeded`) — and lets DBOS's own errors (cancellation, conflicts) propagate. Step errors are pickled by DBOS; the failure types in play round-trip (verified 2026-09-26 in this repository's venv: pydantic `ValidationError`, `JSONDecodeError`, `requests.HTTPError`, `ConversionError`, `IncompleteConversionError`, `StaleGeneration`, `ResultError`), and Task 1 pins it.
4. **★ Cooperative cancellation points.** Today only `jobs/tasks.py:94,98,166` check (before resolution, before conversion, after conversion); extraction never checks, although the spec says "cancellation is checked between entries as today". M3 checks the DBOS status (a) twice before model work, (b) on the step's own thread for every page event of the cut (a 2000-page book cuts for about 90 min before OCR), and (c) before every Catalog entry, throttled to one status read per second. The post-conversion check (`tasks.py:166`) is dropped: the result is published inside the conversion and `output.md` is gone, so it would guard nothing; the fail-open policy holds by construction (no status read can discard a finished conversion). A running native call finishes first.
5. **★ `max_recovery_attempts=5` on `convert` and `extract`** (dbos default 100). A PDF that kills the worker (out of memory on a 2000-page book is not yet measured, M0R 6) would otherwise crash-loop the whole worker, and every lane with it, up to 100 times. *Cost if wrong:* a book interrupted by five deploys ends `MAX_RECOVERY_ATTEMPTS_EXCEEDED` and must be reprocessed.
6. **★ The worker's database URL is `KEI_SYSTEM_DATABASE_URL`** (worker only; required, no default). The old `KEI_DATABASE_URL` disappears, so a stale overlay fails loudly instead of pointing DBOS at `parsing_db`.
7. **`convert` input is minimal:** `{source, source_sha256, source_name, page_source, ingest, model, layout_model, cut, debug}`. No page range, `crop_dpi`, `stream` or image knobs (Studio sends none); `stream` is always false because live token previews are deleted.
8. **`deleteRuns` finds a run's writers itself:** the conversion named in `params.json`, every `extractions/<id>/` directory, and every `extract` workflow whose input names the run and is live or stopped at or after the boot timestamp. Studio passes `{runs, history}`; a run is deleted only when every writer is eligible and no directory in it was written for 24 h. Deletion renames to `.deleting-<run>` first; leftovers are swept. An unexpected error ends the workflow `ERROR`; Studio's next schedule retries.
9. **The extractions read route becomes file-only:** `GET /api/runs/{id}/extractions/{xid}` serves `result.json` or answers 404; status is the `extract` workflow's (Studio, M4).
10. **The worker logs `phase` and `log` events at INFO and drops page and token events;** there is no progress store.
11. **`KEI_CATALOG_CHUNKS`** is set on `parsing_worker` only; unset means 1 (the CLI and a non-GPU stack stay unsplit); a non-positive or non-integer value stops the worker at import. The artifact records the chunk count actually used as `"chunks"`, outside the fingerprint.
12. **The slot lock moves to `KEI_RUNS/.worker-<slot>.lock`** (spec wording; today `.slot-<slot>.lock`, `jobs/worker.py:38-40`), with `hold_slot` moved to `workflows/slot.py`.

## Code facts this plan relies on (verified at c543aeb)

- dbos 3.1.0 (source in the uv cache, `dbos-3.1.0.dist-info`):
  - `DBOS.register_queue(name, *, worker_concurrency, global_concurrency, polling_interval_sec=1.0, on_conflict=...)`; `Queue.global_concurrency` / `.worker_concurrency` properties; no priority option.
  - `@DBOS.step(name=, retries_allowed=False, interval_seconds=1.0, max_attempts=3, backoff_rate=2.0, should_retry=None)`: `max_attempts` counts every attempt; the wait before retry *i* (0-based) is `interval_seconds * backoff_rate**i`; a predicate returning False re-raises the original error; exhaustion raises `DBOSMaxStepRetriesExceeded(step_name, max_retries, errors)` (`_outcome.py:171-193`, `_core.py:2240-2262`).
  - A step called outside a workflow runs as a plain function (`decorate_step` wrapper, `_core.py:2496-2518`).
  - `DBOS.get_workflow_status(id)` records a checkpoint only when called from workflow code: inside a step `ctx.is_workflow()` is false (`_context.py:279-283`, `_sys_db.py:5109-5140`); from a thread without DBOS context it just reads.
  - `@DBOS.workflow(name=, max_recovery_attempts=100, serialization_type=)`; `WorkflowSerializationFormat.PORTABLE` makes inputs and outputs portable JSON; step outputs stay pickled.
  - `DBOSConfig` keys used: `name`, `system_database_url`, `dbos_system_schema`, `application_version`, `executor_id`, `enable_patching`, `log_level`. Launch creates `kei_dbos` only if `information_schema.schemata` lacks it (`_migration.py:173-187`), so M2's pre-created, kei-owned schema needs no `CREATE` on the database.
  - `DBOSClient(system_database_url=, dbos_system_schema=, application_name=)`; `EnqueueOptions` keys `workflow_name`, `queue_name`, `workflow_id`, `priority` (Python refuses 0), `workflow_timeout` (**seconds**), `application_name`, `serialization_type`.
  - `DBOS.list_workflows(workflow_ids=, status=, name=, load_input=, load_output=)`; `WorkflowStatus.input` is `{"args": (...), "kwargs": {...}}`; `DBOS.delete_workflows(ids)`; `DBOS.list_workflow_steps(id)` returns dicts with `function_name`; `DBOSWorkflowCancelledError` derives from `BaseException` (`_error.py:28,372`), so `except Exception` in workflow code never swallows a cancellation.
  - No admin server or port is opened by `DBOS.launch()` in 3.1.0.
- `prototypes/parsing_service`:
  - `src/kei_exp/jobs/` is 1,380 lines; `hold_slot` is `jobs/worker.py:42-57` (`LOCK_DIR` 31, `lock_path` 38-40); cooperative checks `jobs/tasks.py:94,98,166`; `classify` `jobs/tasks.py:50-75`; `RetryStrategy(max_attempts=2, wait=5, linear_wait=5)` at `tasks.py:196,250` (three attempts, waits 5 s and 10 s).
  - `api.py`: `lifespan` 49-58 (store pool), `_stage` 85-99, `create_run` 102-218, `get_run` 228-240, `_extraction_status` 261-267, `create_extraction` 270-302, `get_extraction` 305-320.
  - `runs.py`: `TERMINAL` 28, `STATUS_OF` 29-30, `UNRECORDED` 31, `new_id` 47-48, `run_tokens` 91-102, `_legacy_duration` 105-115, `_params_summary` 118-127, `summary_of` 130-146, `summary` 149-170, `is_legacy` 173-175. `logged_events` and `replay` were deleted by M1.
  - `pagefile.py:228` accepts `result_version` 4; `kie/extract/run.py:58,63-68` and `kie/extract/models.py:109-117` hold the `options.model` branch; `transcription/surya.py:215` `configure`; `kie/extract/grounded.py:132-155` `_Run.call`, `:684-707` `_document`, `:190-195` the entry loop; `kie/extract/tokens.py:50-52` `TokenCounter.request_tokens` keeps no per-call state (safe to share across chunk threads, as the rev-8 harness did).
  - `kie/stages/ocr.py:188` and `transcription/types.py:82` name `kei_exp.jobs.tasks.classify` in comments.
  - `FakeTranscriber` returns one record for `execution.pages or (1, 1)` (`tests/helpers/fake.py:44`), so tests that convert with it use one-page PDFs and `cut: "none"`.
- M2 plan (`2026-09-26-dbos-m2-platform-configuration.md`) provides: `kei_exp.models.DEFAULT_OCR_MODEL = os.environ.get("KEI_OCR_MODEL", "surya")` (refused at import when unknown); `GET /api/ingestion-models` answering `{"defaults": {"ocr", "layout"}, "models": {...}}` via `api.loaded_model(VLLM_URL)`; `ensureKeiRole` (role `kei`, `NOCREATEDB`, `REVOKE ALL ON SCHEMA public FROM PUBLIC`, `CREATE SCHEMA IF NOT EXISTS kei_dbos AUTHORIZATION kei`); `FREE_KEI_POSTGRES_PASSWORD` on Studio only, dev default `kei-development`; the production fixture value `'d'.repeat(64)` in `tests/safety.test.mjs`.
- Repository: `compose.yaml:16-40` (`x-parsing-runtime`, entrypoint `kei-jobs schema` at 24), `:58-83` (`parsing_db`, `parsing_migrate`), `:97-107` (`parsing_worker`), `:117` (`KEI_EXP_MODEL`), `:137-143` (Studio `depends_on`), `:173` (`parsing-postgres`); `compose.override.yaml:168-202`; `compose.prod.yaml:22-36`; `compose.gpu.yaml:43-46,88-89,121-132`; `tests/safety.test.mjs:131-248`; `scripts/free.mjs:421,547`; Studio `api/_kei_exp.ts:86`, `api/_kei_exp.test.ts:125,361,384`, `api/source_documents.test.ts:83`, `test/fixtures/kei-exp/result.json:2,7`.

## Global Constraints

- **Worktree and branch:** `/home/gennaro/projects/FREE/.claude/worktrees/feat+dbos-m2-m6` on `feat/dbos-m2-m6`. Other agents write under `docs/plans/2026-09-24-unified-durable-execution-evidence/m0r*/`: never touch, stage or commit anything there. Stage explicit paths, never `git add -A .` at the root.
- **Pin:** `dbos==3.1.0` exactly. Use only the APIs listed under *Code facts*. Register queues after `DBOS.launch()`; register every workflow before it (import `kei_exp.workflows.registered`).
- **Names:** workflows `convert`, `extract`, `deleteRuns`; workflow IDs `kei-convert:<parent workflow ID>`, `kei-extract:<extractionId>`, `kei-gc:<schedule time>`; steps `resolve_models`, `prepare_run`, `convert_run`, `extract_run`, `delete_runs`.
- **No compatibility aliases** (spec, *Public contract changes*): no v4 reader, no `options.model`, no `kei-jobs` shim, no store-backed status route.
- **Deletions:** implementer subagents may not run `git rm` without the user's authorization. Run plain `rm` / `rm -r`, then `git add -A <those exact paths>`.
- **Python:** from `prototypes/parsing_service`, `uv run --no-sync …`; `uv add` / `uv remove` only in Tasks 1 and 10, and `uv sync` once after Task 3 adds a console script. Lint touched files with `uvx ruff check <files>`; the 4 existing findings in `src/kei_exp/transcription/native.py`, `tests/test_result.py`, `tests/test_table_cells.py` are out of scope. Never `pip`. Run `pnpm install` with `FREE_SKIP_PYTHON=1`.
- **Test tiers (exact commands):**
  - Parsing fast: `cd prototypes/parsing_service && uv run --no-sync pytest -q -m "not postgres and not live_model"`.
  - Parsing Postgres: `cd prototypes/parsing_service && uv run --no-sync pytest -q -m "postgres and not live_model"` with `PARSING_TEST_DATABASE_URL` exported. `slow` tests are part of it.
  - Parsing live: `uv run --no-sync pytest -q -m "live_model and not postgres"`; service smoke `uv run --no-sync pytest -q tests/test_service_smoke.py` (Postgres and Docling weights).
  - Studio (Task 11): `pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test`.
  - Root (Task 12): `node --test scripts/free.test.mjs` and `pnpm test:safety` (Docker needed to render Compose).
- **Disposable databases only** (README #10): user `postgres`, loopback, port 5432, database `free_test_*`. Reuse the M1/M2 container; never stop it or any other service:
  ```bash
  docker ps --filter name=free-m1-pg --format '{{.Names}}'   # prints free-m1-pg when it is running
  # Only if it is not running and port 5432 is free:
  docker run --rm -d --name free-m1-pg --mount type=tmpfs,destination=/var/lib/postgresql/data \
    -p 127.0.0.1:5432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=m1-disposable-only \
    -e POSTGRES_DB=free_test_parsing postgres:17
  docker exec free-m1-pg psql -U postgres -tc "select 1 from pg_database where datname='free_test_parsing'" | grep -q 1 \
    || docker exec free-m1-pg createdb -U postgres free_test_parsing
  export PARSING_TEST_DATABASE_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_parsing
  ```
  If the container was started with another password, ask the controller rather than restarting it. Every Postgres test gets its own `free_test_parsing_*` database (the `database` fixture) and drops it; a test that creates a role drops it too (roles are cluster-wide).
- **No GPU, no live provider, no secrets in output.** Never print `FREE_KEI_POSTGRES_PASSWORD` or a database URL with its password.
- **Commits:** one per task, conventional prefix, message ending with the session's attribution line. Never `git stash`, `reset` or `commit --amend` another task's work.

## Test tiers at the M3 seam

| Tier | Tasks 1–9 | From Task 10 | Notes |
|---|---|---|---|
| Parsing fast | green | green | every task |
| Parsing Postgres (incl. `slow`) | green | green | every task |
| Parsing live / service smoke | green | green | needs Docling weights; run in Tasks 10 and 13 |
| Studio, extraction, db unit | green | green | Task 11 changes Studio |
| `node --test scripts/*.test.mjs`, `pnpm test:safety` | green | green | Task 12 changes both |
| `pnpm test:e2e` | unaffected | unaffected | kei is an in-test fake |
| `pnpm test:service` | green | **red until M4** | Ruling 1 |
| `pnpm dev` ingestion/extraction | works | **broken until M4** | never deploy the middle state |

## Review Focus

1. **kei's DBOS launch as the restricted `kei` role** (no `CREATE` on `free`, `public` revoked, schema pre-created by M2). Expected: launch migrates `kei_dbos` and serves; `public` stays denied. M2 only proves the role with plain SQL; nothing launches DBOS as it until M3. Pinned by Task 3 `test_kei_launches_as_its_restricted_role_and_is_denied_on_public`.
2. **A staged source path that escapes the inbox** (`..`, an absolute path, a symlink out). Expected: `invalid_request`, nothing read, no run directory. Pinned by Task 5 `test_a_source_outside_the_inbox_is_refused_before_anything_is_read`.
3. **A crash between `prepare_run`'s rename and its checkpoint.** Expected: the re-executed step rebuilds the same run directory, with no second directory and no `.prepare-*` left. Pinned by Task 5 `test_prepare_run_executed_again_rebuilds_the_same_run`.
4. **A cancelled extraction still writing a run it has not yet published to** (no `extractions/<id>/` yet). Expected: `deleteRuns` keeps the run until a kei restart. Pinned by Task 7 `test_a_run_an_unfinished_extraction_reads_is_kept`.
5. **A cancel during the cut of a long book.** Expected: the step stops at the next page event, not after the whole cut. Pinned by Task 5 `test_a_cancel_stops_the_conversion_at_its_next_page_event`.

---

### Task 1: Add `dbos`; move failure classification to `failures.py` with a boolean `should_retry`

**Files:**
- Modify: `prototypes/parsing_service/pyproject.toml`, `prototypes/parsing_service/uv.lock` (through `uv add`)
- Create: `prototypes/parsing_service/src/kei_exp/failures.py`
- Modify: `prototypes/parsing_service/src/kei_exp/jobs/tasks.py` (`TRANSIENT` 35-36, `TRANSIENT_STATUS` 43, `TransientBackendError` 46-47, `classify` 50-75)
- Modify: `prototypes/parsing_service/src/kei_exp/kie/stages/ocr.py:188`, `prototypes/parsing_service/src/kei_exp/transcription/types.py:82` (comments)
- Create: `prototypes/parsing_service/tests/test_failures.py`
- Modify: `prototypes/parsing_service/tests/test_jobs_task.py` (classify tests 62-116 move out, except `test_a_store_outage_is_classified_for_retry`)

**Interfaces:**
- Consumes: nothing.
- Produces (`kei_exp.failures`): `TransientBackendError(RuntimeError)`; `KeiFailure(code: str, reason: str)` with `.code`, `.reason`; `CODES: tuple[str, ...]`; `classify(error) -> BaseException`; `should_retry(error) -> bool`; `failure_of(error, default: str) -> tuple[str, str]`; `STEP_RETRY: dict` (keyword arguments for `@DBOS.step`).

- [ ] **Step 1: Add the dependency**

  ```bash
  cd prototypes/parsing_service
  uv add 'dbos==3.1.0'
  uv run --no-sync python -c "from importlib.metadata import version; print(version('dbos'))"
  ```
  Expected: `3.1.0`. `procrastinate` stays until Task 10. If resolution fails, stop and report the conflict.

- [ ] **Step 2: Write the failing tests** (`tests/test_failures.py`)

  ```python
  """Which step failures DBOS retries, and what a workflow reports for the rest (spec, *kei worker*)."""
  import json
  import pickle

  import pytest
  import requests
  from pydantic import BaseModel

  from kei_exp.failures import (CODES, STEP_RETRY, KeiFailure, TransientBackendError, classify, failure_of,
                                should_retry)
  from kei_exp.kie.extract.run import StaleGeneration
  from kei_exp.pagefile import ResultError
  from kei_exp.transcription.types import ConversionError, IncompleteConversionError


  def http_error(status: int) -> requests.HTTPError:
      response = requests.Response()
      response.status_code = status
      return requests.HTTPError(f"{status} from the server", response=response)


  @pytest.mark.parametrize("error", [
      requests.ConnectionError("refused"), requests.Timeout("slow"), ConnectionError("reset"), TimeoutError("t"),
      ConversionError("the OCR server is unreachable"), ConversionError("503 Service Unavailable"),
      http_error(429), http_error(502), http_error(503), http_error(504),
  ])
  def test_a_backend_that_is_not_ready_is_retried(error):
      assert isinstance(classify(error), TransientBackendError)
      assert should_retry(error) is True


  @pytest.mark.parametrize("error", [
      http_error(400), http_error(404), http_error(500), ValueError("bad page range"), KeyError("x"),
      IncompleteConversionError("Conversion incomplete; output not written: connection timed out on page 3"),
      ConversionError("layout cut failed"), KeiFailure("source_mismatch", "hashes differ"),
  ])
  def test_a_failure_about_this_document_or_request_is_not_retried(error):
      assert should_retry(error) is False  # a bool: DBOS reads a returned exception as True


  def test_should_retry_is_a_bool_not_the_classified_exception():
      assert type(should_retry(ValueError("x"))) is bool and type(should_retry(TimeoutError("x"))) is bool


  def test_the_step_retry_policy_is_three_attempts_waiting_five_then_ten_seconds():
      waits = [STEP_RETRY["interval_seconds"] * STEP_RETRY["backoff_rate"] ** attempt
               for attempt in range(STEP_RETRY["max_attempts"] - 1)]
      assert STEP_RETRY["retries_allowed"] is True and waits == [5.0, 10.0]
      assert STEP_RETRY["should_retry"] is should_retry


  @pytest.mark.parametrize("error, default, code", [
      (KeiFailure("too_many_pages", "2001 pages"), "conversion_failed", "too_many_pages"),
      (IncompleteConversionError("page 2 was cut off"), "conversion_failed", "conversion_incomplete"),
      (http_error(503), "extraction_failed", "model_unavailable"),
      (ConversionError("the model server has 'x' loaded"), "conversion_failed", "conversion_failed"),
      (http_error(400), "extraction_failed", "extraction_failed"),
  ])
  def test_a_final_step_error_maps_to_one_portable_code(error, default, code):
      found, reason = failure_of(error, default)
      assert found == code and found in CODES and reason


  def test_a_validation_error_is_an_invalid_request():
      class Body(BaseModel):
          pages: int
      with pytest.raises(Exception) as caught:
          Body.model_validate({"pages": "many"})
      assert failure_of(caught.value, "extraction_failed")[0] == "invalid_request"


  def test_every_failure_a_step_raises_survives_dbos_pickling():
      try:
          json.loads("{bad")
      except json.JSONDecodeError as error:
          decode = error
      for error in (KeiFailure("no_result", "none"), TransientBackendError("down"), http_error(503), decode,
                    ConversionError("x"), IncompleteConversionError("y"), StaleGeneration("z"), ResultError("r")):
          back = pickle.loads(pickle.dumps(error))
          assert type(back) is type(error) and str(back) == str(error)
      assert pickle.loads(pickle.dumps(KeiFailure("no_result", "none"))).code == "no_result"
  ```
  Also delete the classify tests at `tests/test_jobs_task.py:62-116` except `test_a_store_outage_is_classified_for_retry` (it stays with the store until Task 10).

  Run: `uv run --no-sync pytest -q tests/test_failures.py`. Expected: FAIL (`No module named 'kei_exp.failures'`).

- [ ] **Step 3: Implement `failures.py`**

  ```python
  """What a failed step means: another attempt may meet a backend that is ready again, or the failure is about this
  document or request and repeats identically.

  `classify` is the one judgement (moved from `jobs/tasks.py`). DBOS asks `should_retry` after each failed attempt of a
  step and needs a bool: `classify` returns an exception, which DBOS would read as always true. `failure_of` turns what a
  step finally raised into the portable code a workflow reports (`workflows/contracts.py`).
  """
  from __future__ import annotations

  import requests
  from pydantic import ValidationError

  from kei_exp.transcription.types import ConversionError, IncompleteConversionError

  # TRANSIENT, TRANSIENT_STATUS and their comments: moved verbatim from jobs/tasks.py:32-43.
  TRANSIENT = ("unreachable", "connection refused", "connection reset", "timed out", "timeout",
               "temporarily unavailable", "service unavailable", "bad gateway", "stream disconnected")
  TRANSIENT_STATUS = (429, 502, 503, 504)
  CODES = ("invalid_request", "source_missing", "source_mismatch", "source_unreadable", "too_many_pages",
           "model_unavailable", "conversion_failed", "conversion_incomplete", "no_result", "stale_generation",
           "extraction_failed", "cancelled")
  REASON_CHARS = 2000


  class TransientBackendError(RuntimeError):
      """A model or network failure that another attempt may not meet: the one retried class."""


  class KeiFailure(Exception):
      """A refusal kei makes itself, reported under `code`. Never retried. Picklable: DBOS records step errors."""

      def __init__(self, code: str, reason: str) -> None:
          super().__init__(code, reason)
          self.code, self.reason = code, reason

      def __str__(self) -> str:
          return f"{self.code}: {self.reason}"


  def classify(error: BaseException) -> BaseException:
      """`error` as a `TransientBackendError` when another attempt is worth making, else `error` itself."""
      # Body moved from jobs/tasks.py:61-75 without its `store.Unavailable` branch: a DBOS system-database outage
      # blocks inside DBOS's own retry loop and never reaches a step.
      if isinstance(error, (requests.ConnectionError, requests.Timeout, ConnectionError, TimeoutError)):
          return TransientBackendError(str(error))
      if isinstance(error, requests.HTTPError):
          status = getattr(error.response, "status_code", None)
          return TransientBackendError(str(error)) if status in TRANSIENT_STATUS else error
      if isinstance(error, IncompleteConversionError):
          return error
      if isinstance(error, ConversionError) and any(phrase in str(error).lower() for phrase in TRANSIENT):
          return TransientBackendError(str(error))
      return error


  def should_retry(error: BaseException) -> bool:
      """DBOS's retry predicate for `convert_run` and `extract_run`."""
      return isinstance(classify(error), TransientBackendError)


  # The keyword arguments of both model steps: three attempts, waiting 5 s then 10 s (Procrastinate's
  # RetryStrategy(max_attempts=2, wait=5, linear_wait=5) at jobs/tasks.py:196,250).
  STEP_RETRY = {"retries_allowed": True, "max_attempts": 3, "interval_seconds": 5.0, "backoff_rate": 2.0,
                "should_retry": should_retry}


  def failure_of(error: BaseException, default: str) -> tuple[str, str]:
      """(code, reason) of a step's final error; `default` names a failure of the step's own work."""
      if isinstance(error, KeiFailure):
          return error.code, error.reason[:REASON_CHARS]
      if isinstance(error, IncompleteConversionError):
          code = "conversion_incomplete"
      elif should_retry(error):
          code = "model_unavailable"
      elif isinstance(error, ValidationError):
          code = "invalid_request"
      else:
          code = default
      reason = str(error) if isinstance(error, (ValueError, ConversionError)) else f"{type(error).__name__}: {error}"
      return code, reason[:REASON_CHARS]
  ```
  In `jobs/tasks.py`, delete `TRANSIENT`, `TRANSIENT_STATUS`, `TransientBackendError` and the body of `classify`, import `from kei_exp import failures` and `from kei_exp.failures import TransientBackendError`, and keep this until Task 10:
  ```python
  def classify(error: BaseException) -> BaseException:
      """`failures.classify`, plus the store outage only this backend meets (deleted with it)."""
      if isinstance(error, store.Unavailable):
          return TransientBackendError(str(error))
      return failures.classify(error)
  ```
  Change the two comments (`ocr.py:188`, `types.py:82`) to name `kei_exp.failures.classify`.

- [ ] **Step 4: Verify**

  ```bash
  uv run --no-sync pytest -q tests/test_failures.py tests/test_jobs_task.py
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uv run --no-sync pytest -q -m "postgres and not live_model"
  uvx ruff check src/kei_exp/failures.py src/kei_exp/jobs/tasks.py tests/test_failures.py tests/test_jobs_task.py
  ```
  Expected: all pass; ruff `All checks passed!`.

- [ ] **Step 5: Commit**

  ```bash
  git add prototypes/parsing_service/pyproject.toml prototypes/parsing_service/uv.lock \
    prototypes/parsing_service/src/kei_exp/failures.py prototypes/parsing_service/src/kei_exp/jobs/tasks.py \
    prototypes/parsing_service/src/kei_exp/kie/stages/ocr.py prototypes/parsing_service/src/kei_exp/transcription/types.py \
    prototypes/parsing_service/tests/test_failures.py prototypes/parsing_service/tests/test_jobs_task.py
  git commit -m "feat(parsing): add dbos 3.1.0 and classify step failures with a boolean should_retry"
  ```

---

### Task 2: Portable contracts, kei's queue table and the contract fixtures

**Files:**
- Create: `prototypes/parsing_service/src/kei_exp/workflows/__init__.py` (docstring only)
- Create: `prototypes/parsing_service/src/kei_exp/workflows/config.py`
- Create: `prototypes/parsing_service/src/kei_exp/workflows/contracts.py`
- Modify: `prototypes/parsing_service/src/kei_exp/runs.py` (add `COMPONENT`: `re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")`, "one path component: a run or extraction ID; Studio's `RUN_ID` accepts it"; the API uses it in Task 10 without importing anything that imports `dbos`)
- Create: `prototypes/parsing_service/tests/fixtures/contracts/{queues,deadlines,convert.input,convert.output.ok,convert.output.failed,extract.input,extract.output.ok,extract.output.failed,deleteRuns.input,deleteRuns.output}.json`
- Create: `prototypes/parsing_service/tests/test_contracts.py`

**Interfaces:**
- Consumes: `kei_exp.failures.CODES`, `failure_of`, `KeiFailure` (Task 1).
- Produces (`kei_exp.workflows.config`): `APP_NAME = "kei"`, `SCHEMA = "kei_dbos"`, `APP_VERSION = "kei@1"`, `SLOT`, `CONVERT_LARGE`, `CONVERT_SMALL`, `EXTRACT`, `GC`, `QUEUES: dict[str, int]`, `PRIORITY_INTERACTIVE = 1`, `PRIORITY_BATCH = 10`, `MAX_RECOVERY_ATTEMPTS = 5`, `executor_id(slot) -> str`, `dbos_config(database_url, slot, *, log_level="INFO") -> DBOSConfig`, `register_queues(*, polling_interval_sec=1.0) -> dict[str, Queue]`.
- Produces (`kei_exp.runs`): `COMPONENT` (regex; re-exported by `contracts`).
- Produces (`kei_exp.workflows.contracts`): `CONVERT_PREFIX = "kei-convert:"`, `EXTRACT_PREFIX = "kei-extract:"`, `GC_PREFIX = "kei-gc:"`; pydantic models `ConvertInput`, `ConvertOk`, `ExtractInput`, `ExtractOk`, `DeleteRunsInput`, `DeleteRunsOk`, `Failure`; `failure(code, reason, *, retryable) -> dict`; `settled(steps: Callable[[], dict], *, default: str) -> dict`; `extraction_id_of(workflow_id) -> str`.

- [ ] **Step 1: Write the fixtures**

  `queues.json`:
  ```json
  {
    "application_name": "kei",
    "schema": "kei_dbos",
    "application_version": "kei@1",
    "queues": {
      "kei-convert-large": {"global_concurrency": 1, "worker_concurrency": 1},
      "kei-convert-small": {"global_concurrency": 1, "worker_concurrency": 1},
      "kei-extract": {"global_concurrency": 2, "worker_concurrency": 2},
      "kei-gc": {"global_concurrency": 1, "worker_concurrency": 1}
    },
    "priorities": {"interactive": 1, "batch": 10},
    "small_document_pages": 30,
    "workflow_id_prefixes": {"convert": "kei-convert:", "extract": "kei-extract:", "deleteRuns": "kei-gc:"}
  }
  ```
  `deadlines.json` (milliseconds, measured from kei's dequeue):
  ```json
  {
    "convert": {
      "formula": "max(600000, 3 * (20000 + 6300 * pages))",
      "cases": [[1, 600000], [28, 600000], [29, 608100], [30, 627000], [40, 816000], [2000, 37860000]]
    },
    "extract": {"article": 600000, "catalog": 10800000}
  }
  ```
  Each `*.input.json` is `{"enqueue": {...EnqueueOptions as Studio sends them, timeout in ms...}, "request": {...}}`. `convert.input.json`:
  ```json
  {
    "enqueue": {"workflow_name": "convert", "queue_name": "kei-convert-small",
                "workflow_id": "kei-convert:ingest:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
                "application_name": "kei", "priority": 1, "workflow_timeout_ms": 600000},
    "request": {"source": "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.pdf",
                "source_sha256": "641e16c209b792546e79ca2a660e14ecf6750c3c027ffb46a3b89f9a79770293",
                "source_name": "report.pdf", "page_source": "pdf", "ingest": null,
                "model": null, "layout_model": null, "cut": "auto", "debug": false}
  }
  ```
  `convert.output.ok.json`: `{"ok": true, "run_id": "run-0123456789abcdef01234567", "generation": "20260926T120000.000000Z-0a1b2c3d", "page_count": 3, "source_sha256": "641e16c2…0293" (the full 64 digits above), "page_source": "pdf"}`.
  `convert.output.failed.json`: `{"ok": false, "code": "source_mismatch", "reason": "the staged PDF hashes to 0000…, not 641e…", "retryable": false}`.
  `extract.input.json`: `enqueue` = `{"workflow_name": "extract", "queue_name": "kei-extract", "workflow_id": "kei-extract:33333333-3333-4333-8333-333333333333", "application_name": "kei", "priority": 1, "workflow_timeout_ms": 10800000}`; `request` = `{"run_id": "run-0123456789abcdef01234567", "generation": "20260926T120000.000000Z-0a1b2c3d", "request": {"schema": <the SCHEMA of tests/test_extract_grounded.py:21-28 as JSON>, "options": {"strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}}}}`.
  `extract.output.ok.json`: `{"ok": true, "run_id": "run-0123456789abcdef01234567", "extraction_id": "33333333-3333-4333-8333-333333333333", "generation": "20260926T120000.000000Z-0a1b2c3d", "artifact_sha256": "<64 hex>", "model": "numind/NuExtract3-FP8", "models": {"fields": "numind/NuExtract3-FP8", "reasoning": "Qwen/Qwen3.8-27B-FP8"}}`.
  `extract.output.failed.json`: `{"ok": false, "code": "stale_generation", "reason": "the run's result is generation …", "retryable": false}`.
  `deleteRuns.input.json`: `enqueue` = `{"workflow_name": "deleteRuns", "queue_name": "kei-gc", "workflow_id": "kei-gc:2026-09-26T12:00:00.000Z", "application_name": "kei"}` (no priority: Python refuses 0 and cleanup needs none); `request` = `{"runs": ["run-0123456789abcdef01234567"], "history": ["kei-convert:ingest:…", "kei-extract:33333333-3333-4333-8333-333333333333"]}`.
  `deleteRuns.output.json`: `{"ok": true, "deleted_runs": ["run-0123456789abcdef01234567"], "kept_runs": [], "deleted_history": [<the two IDs>], "kept_history": []}`.

- [ ] **Step 2: Write the failing tests** (`tests/test_contracts.py`)

  ```python
  """The portable contract of kei's workflows, as the fixtures Studio's node:test also reads (M4)."""
  import json
  from pathlib import Path

  import pytest
  from pydantic import ValidationError

  from kei_exp.failures import CODES
  from kei_exp.kie.extract.run import ExtractRequest
  from kei_exp.workflows import config, contracts

  FIXTURES = Path(__file__).parent / "fixtures" / "contracts"
  INPUTS = {"convert": contracts.ConvertInput, "extract": contracts.ExtractInput,
            "deleteRuns": contracts.DeleteRunsInput}
  OUTPUTS = {"convert.output.ok": contracts.ConvertOk, "convert.output.failed": contracts.Failure,
             "extract.output.ok": contracts.ExtractOk, "extract.output.failed": contracts.Failure,
             "deleteRuns.output": contracts.DeleteRunsOk}


  def fixture(name: str) -> dict:
      return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


  def convert_timeout_ms(pages: int) -> int:
      """M0R 4's per-page conversion budget; Studio's submitToKei computes the same (M4)."""
      return max(600_000, 3 * (20_000 + 6_300 * pages))


  @pytest.mark.parametrize("workflow", INPUTS)
  def test_each_input_fixture_is_a_valid_request_for_a_known_queue(workflow):
      data = fixture(f"{workflow}.input")
      queues = fixture("queues")
      INPUTS[workflow].model_validate(data["request"])
      assert data["enqueue"]["workflow_name"] == workflow
      assert data["enqueue"]["queue_name"] in queues["queues"]
      assert data["enqueue"]["application_name"] == config.APP_NAME
      assert data["enqueue"]["workflow_id"].startswith(queues["workflow_id_prefixes"][workflow])


  def test_the_extract_fixture_carries_a_request_kei_accepts():
      ExtractRequest.model_validate(fixture("extract.input")["request"]["request"])


  @pytest.mark.parametrize("name", OUTPUTS)
  def test_each_output_fixture_validates(name):
      OUTPUTS[name].model_validate(fixture(name))


  def test_the_failure_codes_are_the_contracts():
      assert set(contracts.Failure.model_fields["code"].annotation.__args__) == set(CODES)


  def test_the_queue_fixture_is_the_worker_configuration():
      queues = fixture("queues")
      assert (queues["application_name"], queues["schema"], queues["application_version"]) == \
          (config.APP_NAME, config.SCHEMA, config.APP_VERSION)
      assert {name: (q["global_concurrency"], q["worker_concurrency"]) for name, q in queues["queues"].items()} == \
          {name: (limit, limit) for name, limit in config.QUEUES.items()}
      assert queues["priorities"] == {"interactive": config.PRIORITY_INTERACTIVE, "batch": config.PRIORITY_BATCH}


  def test_the_deadline_fixture_is_m0r4s_formula():
      deadlines = fixture("deadlines")
      assert [[pages, convert_timeout_ms(pages)] for pages, _ in deadlines["convert"]["cases"]] == \
          deadlines["convert"]["cases"]
      assert deadlines["extract"] == {"article": 10 * 60_000, "catalog": 3 * 3_600_000}


  @pytest.mark.parametrize("request_", [
      {"source": "a.pdf", "source_sha256": "0" * 64, "source_name": "a.pdf", "pages": [1, 2]},
      {"source": "a.pdf", "source_sha256": "XYZ", "source_name": "a.pdf"},
      {"source": "a.pdf", "source_sha256": "0" * 64, "source_name": "a.pdf", "page_source": "spread"},
  ])
  def test_a_malformed_convert_request_is_refused(request_):
      with pytest.raises(ValidationError):
          contracts.ConvertInput.model_validate(request_)


  def test_run_and_extraction_ids_are_single_path_components():
      with pytest.raises(ValidationError):
          contracts.DeleteRunsInput.model_validate({"runs": ["../etc"], "history": []})
      assert contracts.extraction_id_of("kei-extract:x-1") == "x-1"
      for bad in ("kei-extract:../x", "kei-extract:", "kei-convert:x", "kei-extract:a/b"):
          with pytest.raises(contracts.KeiFailure):
              contracts.extraction_id_of(bad)


  def test_config_is_kei_with_patching_and_a_slot_executor():
      assert config.dbos_config("postgresql://kei:x@db:5432/free", "slot-1") == {
          "name": "kei", "system_database_url": "postgresql://kei:x@db:5432/free", "dbos_system_schema": "kei_dbos",
          "application_version": "kei@1", "executor_id": "kei-slot-1", "enable_patching": True, "log_level": "INFO"}
  ```
  Run: `uv run --no-sync pytest -q tests/test_contracts.py`. Expected: FAIL (`No module named 'kei_exp.workflows'`).

- [ ] **Step 3: Implement `config.py`**

  ```python
  """kei's DBOS application: its identity in the shared database `free`, its four lanes and its launch configuration.

  kei owns schema kei_dbos and is its only writer of queue configuration: Studio's clients enqueue by name and never
  call register_queue, whose default `always_update` from a client would overwrite these limits (spec, *Queues*).
  """
  from __future__ import annotations

  import os

  from dbos import DBOS, DBOSConfig, Queue

  APP_NAME = "kei"
  SCHEMA = "kei_dbos"
  APP_VERSION = "kei@1"  # fixed; a changed step sequence uses DBOS.patch(), a version bump needs a drain
  SLOT = os.environ.get("KEI_SLOT", "slot-1")
  CONVERT_LARGE, CONVERT_SMALL, EXTRACT, GC = "kei-convert-large", "kei-convert-small", "kei-extract", "kei-gc"
  # Global limit == worker limit. dbos 3.1.0 counts a worker's concurrency from the process's in-memory set of active
  # workflows, so a cancelled workflow whose native step still runs keeps its lane's slot until the step returns; a
  # global limit alone is counted from PENDING rows, which a cancel changes at once (M0R 4, spec *Physical capacity*).
  QUEUES: dict[str, int] = {CONVERT_LARGE: 1, CONVERT_SMALL: 1, EXTRACT: 2, GC: 1}
  PRIORITY_INTERACTIVE, PRIORITY_BATCH = 1, 10  # kei-extract; dbos 3.1.0 orders by priority with no queue flag
  MAX_RECOVERY_ATTEMPTS = 5  # a PDF that kills the worker must not crash-loop every lane (plan decision 5)


  def executor_id(slot: str) -> str:
      return f"kei-{slot}"


  def dbos_config(database_url: str, slot: str, *, log_level: str = "INFO") -> DBOSConfig:
      return {"name": APP_NAME, "system_database_url": database_url, "dbos_system_schema": SCHEMA,
              "application_version": APP_VERSION, "executor_id": executor_id(slot), "enable_patching": True,
              "log_level": log_level}


  def register_queues(*, polling_interval_sec: float = 1.0) -> dict[str, Queue]:
      """The four lanes; called after DBOS.launch()."""
      return {name: DBOS.register_queue(name, global_concurrency=limit, worker_concurrency=limit,
                                        polling_interval_sec=polling_interval_sec)
              for name, limit in QUEUES.items()}
  ```

- [ ] **Step 4: Implement `contracts.py`**

  ```python
  """The portable JSON kei's workflows take and return (spec, *Studio → kei handoff*, Contract).

  Studio's DBOS client enqueues `convert`, `extract` and `deleteRuns` by name with portable serialization, one JSON
  object each; each returns `{"ok": true, ...}` or `{"ok": false, "code", "reason", "retryable"}`. No PDF, page or
  artifact bytes enter workflow history. tests/fixtures/contracts/ holds the examples both sides check.
  """
  from __future__ import annotations

  from collections.abc import Callable
  from typing import Annotated, Literal

  from dbos import error as dbos_error
  from pydantic import BaseModel, ConfigDict, Field

  from kei_exp.failures import KeiFailure, failure_of
  from kei_exp.runs import COMPONENT  # a file-layout rule; the DBOS-free API reads it from runs too

  CONVERT_PREFIX, EXTRACT_PREFIX, GC_PREFIX = "kei-convert:", "kei-extract:", "kei-gc:"
  FailureCode = Literal["invalid_request", "source_missing", "source_mismatch", "source_unreadable", "too_many_pages",
                        "model_unavailable", "conversion_failed", "conversion_incomplete", "no_result",
                        "stale_generation", "extraction_failed", "cancelled"]
  RunId = Annotated[str, Field(pattern=COMPONENT.pattern)]


  class _Contract(BaseModel):
      model_config = ConfigDict(extra="forbid")


  class ConvertInput(_Contract):
      source: str = Field(min_length=1)  # the staged PDF, relative to KEI_SOURCE_INBOX, which kei reads only
      source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
      source_name: str = Field(min_length=1, max_length=512)
      page_source: Literal["pdf", "ingest"] = "pdf"
      ingest: dict | None = None         # spread settings; page_source ingest only
      model: str | None = None           # the Ingestion Model Choice's ocr role: a kei_exp.models.MODELS key
      layout_model: str | None = None    # its layout role: a kei_exp.cut.LAYOUT_MODELS key
      cut: Literal["auto", "none"] = "auto"
      debug: bool = False


  class ConvertOk(_Contract):
      ok: Literal[True]
      run_id: RunId
      generation: str
      page_count: int
      source_sha256: str
      page_source: Literal["pdf", "ingest"]


  class ExtractInput(_Contract):
      run_id: RunId
      generation: str = Field(min_length=1)  # the parse the extraction was admitted against
      request: dict                          # {schema, options}; validated as kie.extract.run.ExtractRequest


  class ExtractOk(_Contract):
      ok: Literal[True]
      run_id: str
      extraction_id: str
      generation: str
      artifact_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
      model: str                   # the fields model: the model that read the values
      models: dict[str, str]       # per role


  class DeleteRunsInput(_Contract):
      runs: list[RunId] = Field(default_factory=list)   # a pattern per item: "../x" is a ValidationError
      history: list[str] = Field(default_factory=list)  # kei workflow ids whose history may go


  class DeleteRunsOk(_Contract):
      ok: Literal[True]
      deleted_runs: list[str]
      kept_runs: list[str]
      deleted_history: list[str]
      kept_history: list[str]


  class Failure(_Contract):
      ok: Literal[False]
      code: FailureCode
      reason: str
      retryable: bool


  def failure(code: str, reason: str, *, retryable: bool) -> dict:
      return Failure(ok=False, code=code, reason=reason[:2000], retryable=retryable).model_dump()


  def settled(steps: Callable[[], dict], *, default: str) -> dict:
      """What `steps` returned, or the portable failure of what they finally raised. Called from workflow code, so it
      must stay deterministic: the step errors it maps are replayed from their checkpoints. DBOS's own errors
      (and cancellation, a BaseException) propagate."""
      try:
          return steps()
      except dbos_error.DBOSMaxStepRetriesExceeded as exhausted:
          code, reason = failure_of(exhausted.errors[-1] if exhausted.errors else exhausted, default)
          return failure(code, reason, retryable=True)
      except dbos_error.DBOSException:
          raise
      except Exception as error:  # noqa: BLE001 - every step failure becomes the typed outcome Studio records
          code, reason = failure_of(error, default)
          return failure(code, reason, retryable=False)


  def extraction_id_of(workflow_id: str) -> str:
      extraction_id = workflow_id.removeprefix(EXTRACT_PREFIX)
      if extraction_id == workflow_id or not COMPONENT.fullmatch(extraction_id):
          raise KeiFailure("invalid_request", f"{workflow_id!r} is not {EXTRACT_PREFIX}<extraction id>")
      return extraction_id
  ```
  `KeiFailure` is imported above, which is all the test's `contracts.KeiFailure` needs.

- [ ] **Step 5: Verify**

  ```bash
  uv run --no-sync pytest -q tests/test_contracts.py
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uvx ruff check src/kei_exp/workflows tests/test_contracts.py
  python3 -m json.tool tests/fixtures/contracts/convert.input.json >/dev/null   # repeat for each fixture, or loop
  ```
  Expected: pass.

- [ ] **Step 6: Commit**

  ```bash
  git add prototypes/parsing_service/src/kei_exp/workflows prototypes/parsing_service/src/kei_exp/runs.py \
    prototypes/parsing_service/tests/fixtures/contracts prototypes/parsing_service/tests/test_contracts.py
  git commit -m "feat(parsing): define kei's portable workflow contract, lanes and fixtures"
  ```

---

### Task 3: The worker process: slot lock, boot timestamp, launch, `kei-worker worker`, and the in-process test harness

**Files:**
- Create: `prototypes/parsing_service/src/kei_exp/workflows/slot.py` (moved from `jobs/worker.py:31-57`)
- Create: `prototypes/parsing_service/src/kei_exp/workflows/boot.py`
- Create: `prototypes/parsing_service/src/kei_exp/workflows/registered.py`
- Create: `prototypes/parsing_service/src/kei_exp/workflows/cli.py`
- Modify: `prototypes/parsing_service/src/kei_exp/runs.py` (add `INBOX`)
- Modify: `prototypes/parsing_service/src/kei_exp/jobs/worker.py` (import `SlotTaken`, `hold_slot` from `workflows.slot`; delete `LOCK_DIR`, `SlotTaken`, `lock_path`, `hold_slot`)
- Modify: `prototypes/parsing_service/pyproject.toml` (`[project.scripts]` `kei-worker = "kei_exp.workflows.cli:main"`)
- Modify: `prototypes/parsing_service/tests/helpers/slot.py` (`HOLDER` imports `kei_exp.workflows.slot` and sets `runs.RUNS`), `tests/test_jobs_worker.py` (delete the three lock tests 33-73; the `ready` fixture drops `monkeypatch.setattr(worker, "LOCK_DIR", …)` and sets `runs.RUNS` instead)
- Modify: `prototypes/parsing_service/tests/helpers/postgres.py` (add `url`), `tests/conftest.py` (fixture `kei`)
- Create: `prototypes/parsing_service/tests/helpers/kei.py`, `prototypes/parsing_service/tests/test_worker_boot.py`

**Interfaces:**
- Consumes: `config.*` (Task 2).
- Produces: `slot.SlotTaken`, `slot.lock_path(slot) -> Path` (`runs.RUNS / f".worker-{slot}.lock"`, evaluated per call), `slot.hold_slot(slot)`; `boot.BOOT_CLOCK_SQL`, `boot.database_clock_ms(url) -> int`, `boot.set_timestamp(ms)`, `boot.timestamp_ms() -> int`; `cli.serve(slot, database_url, *, until=...)`, `cli.main(argv=None)`; `runs.INBOX: Path` (`KEI_SOURCE_INBOX`, default `source-inbox`); `registered` (importing it registers every workflow; Tasks 5–7 each add one import line); `postgres_helper.url(conninfo) -> str`; test fixture `kei` yielding `tests.helpers.kei.Kei`.

- [ ] **Step 1: Write the failing tests** (`tests/test_worker_boot.py`)

  ```python
  """kei-worker's startup order and the lock only a dead process releases (spec, *kei worker → Startup*)."""
  import contextlib
  import secrets

  import psycopg
  import pytest
  from dbos import DBOS

  from kei_exp import runs
  from kei_exp.workflows import boot, cli, config, slot
  from tests.helpers import kei as kei_helper
  from tests.helpers import postgres as postgres_helper
  from tests.helpers import slot as slot_helper


  @pytest.fixture
  def lock_root(tmp_path, monkeypatch):
      monkeypatch.setattr(runs, "RUNS", tmp_path)
      return tmp_path


  def test_the_lock_lives_beside_the_runs(lock_root):
      assert slot.lock_path("slot-1") == lock_root / ".worker-slot-1.lock"


  def test_one_process_at_a_time_holds_a_slot(lock_root):
      with slot.hold_slot("slot-1"):
          with pytest.raises(slot.SlotTaken), slot.hold_slot("slot-1"):
              pass
          with slot.hold_slot("slot-2"):
              pass


  def test_a_killed_holder_releases_and_a_stopped_one_keeps_its_slot(lock_root):
      holder = slot_helper.holder("slot-1", lock_root)
      try:
          holder.wait_started(timeout=20)
          holder.pause()
          with pytest.raises(slot.SlotTaken), slot.hold_slot("slot-1"):
              pass
          holder.kill()
          holder.reap()
          with slot.hold_slot("slot-1"):
              pass
      finally:
          if holder.process.poll() is None:
              holder.kill()
              holder.reap()


  def test_the_worker_locks_then_reads_the_clock_then_launches_then_registers(monkeypatch):
      order: list[str] = []

      @contextlib.contextmanager
      def hold(name):
          order.append("flock")
          yield
          order.append("release")

      class FakeDBOS:
          def __init__(self, *, config):
              order.append("configure")
              assert config["executor_id"] == "kei-slot-7"

          @staticmethod
          def launch():
              order.append("launch")

          @staticmethod
          def destroy():
              order.append("destroy")

      monkeypatch.setattr(slot, "hold_slot", hold)
      monkeypatch.setattr(boot, "database_clock_ms", lambda url: order.append("clock") or 1234)
      monkeypatch.setattr(cli, "DBOS", FakeDBOS)
      monkeypatch.setattr(config, "register_queues", lambda **_: order.append("queues"))
      cli.serve("slot-7", "postgresql://x", until=lambda: order.append("serving"))
      assert order == ["flock", "clock", "configure", "launch", "queues", "serving", "destroy", "release"]
      assert boot.timestamp_ms() == 1234


  def test_the_worker_refuses_to_start_without_its_database_url(monkeypatch, capsys):
      monkeypatch.delenv("KEI_SYSTEM_DATABASE_URL", raising=False)
      with pytest.raises(SystemExit) as stopped:
          cli.main(["worker"])
      assert stopped.value.code == 2 and "KEI_SYSTEM_DATABASE_URL" in capsys.readouterr().err


  def test_kei_launches_in_kei_dbos_with_its_four_lanes(kei):
      for name, limit in config.QUEUES.items():
          queue = DBOS.retrieve_queue(name)
          assert (queue.global_concurrency, queue.worker_concurrency) == (limit, limit), name
      with psycopg.connect(kei.url) as connection:
          schemas = {row[0] for row in connection.execute("select schema_name from information_schema.schemata")}
      assert "kei_dbos" in schemas and "dbos" not in schemas  # kei never creates Studio's schema


  def test_the_boot_timestamp_is_the_database_clock_before_launch(kei):
      assert 0 < boot.timestamp_ms() <= kei.db_now_ms()


  def test_kei_launches_as_its_restricted_role_and_is_denied_on_public(database, tmp_path, monkeypatch):
      """M2's ensureKeiRole (packages/db/src/kei-role.ts) as SQL: kei has no CREATE on the database, public is revoked,
      and kei_dbos exists, owned by kei. DBOS must launch and migrate inside it."""
      role, password = f"free_test_kei_{secrets.token_hex(4)}", secrets.token_hex(16)
      owner = postgres_helper.url(database)
      with psycopg.connect(owner, autocommit=True) as connection:
          connection.execute(f"CREATE ROLE {role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT "
                             f"PASSWORD '{password}'")
          connection.execute("REVOKE ALL ON SCHEMA public FROM PUBLIC")
          connection.execute(f"CREATE SCHEMA kei_dbos AUTHORIZATION {role}")
      kei_url = postgres_helper.url(database, user=role, password=password)
      try:
          with kei_helper.launched_url(kei_url, tmp_path, monkeypatch):
              with psycopg.connect(kei_url) as connection, pytest.raises(psycopg.errors.InsufficientPrivilege):
                  connection.execute("CREATE TABLE public.kei_probe (id int)")
      finally:
          with psycopg.connect(owner, autocommit=True) as connection:
              connection.execute(f"DROP OWNED BY {role}")
              connection.execute(f"DROP ROLE {role}")
  ```
  Run: `uv run --no-sync pytest -q tests/test_worker_boot.py -m "not postgres"`. Expected: FAIL (`No module named 'kei_exp.workflows.slot'`).

- [ ] **Step 2: Implement `slot.py`, `boot.py`, `registered.py`, `cli.py`, `runs.INBOX`**

  `slot.py`: move `SlotTaken` and `hold_slot` verbatim from `jobs/worker.py:34-57` (keep the message "slot {slot} is held by another process ({path})" and the module docstring's first paragraph), with:
  ```python
  def lock_path(slot: str) -> Path:
      """`KEI_RUNS/.worker-<slot>.lock`: read per call, so a test that moves runs.RUNS moves the lock with it."""
      return runs.RUNS / f".worker-{slot}.lock"
  ```
  `boot.py`:
  ```python
  """kei's boot timestamp: the database clock, read after this process took its slot and before DBOS launched.

  Lanes run beside cleanup, so no queue excludes a cancelled native step that may still write (spec, *kei boot
  boundary*). The flock proves the previous kei process has exited; a workflow it cancelled, or that exceeded its
  recovery attempts, was stamped `updated_at` from the database clock before this instant, so its steps can no longer
  write. deleteRuns compares with this value only (M0R 4: Python-side cancels and deadlines stamp the database clock).
  """
  from __future__ import annotations

  import psycopg

  BOOT_CLOCK_SQL = "select (extract(epoch from clock_timestamp()) * 1000)::bigint"
  _timestamp_ms: int | None = None


  def database_clock_ms(database_url: str) -> int:
      with psycopg.connect(database_url, autocommit=True, connect_timeout=10) as connection:
          return int(connection.execute(BOOT_CLOCK_SQL).fetchone()[0])


  def set_timestamp(value_ms: int) -> None:
      global _timestamp_ms
      _timestamp_ms = value_ms


  def timestamp_ms() -> int:
      if _timestamp_ms is None:
          raise RuntimeError("the kei boot timestamp is read by `kei-worker worker` before DBOS launches")
      return _timestamp_ms
  ```
  `registered.py`: a docstring only for now — `"""Importing this module registers every kei workflow with DBOS; DBOS refuses a registration after launch."""` Tasks 5, 6 and 7 add `from kei_exp.workflows import convert  # noqa: F401`, `extract`, `gc`.
  `cli.py`:
  ```python
  """`kei-worker worker`: take the slot, read the boot timestamp, launch DBOS, register the lanes, serve until signalled.

  DBOS.launch() migrates kei_dbos and recovers this executor's pending workflows (executor `kei-<slot>`, version
  `kei@1`); a crash re-executes the step that was running and reuses every checkpointed one.
  Env: KEI_SYSTEM_DATABASE_URL (role kei on database free), KEI_SLOT, KEI_RUNS, KEI_LOG_LEVEL.
  """
  from __future__ import annotations

  import argparse
  import logging
  import os
  import signal
  import sys
  import threading
  from collections.abc import Callable

  from dbos import DBOS

  from kei_exp.workflows import boot, config, slot

  logger = logging.getLogger(__name__)


  def _until_signalled() -> None:
      stop = threading.Event()
      for number in (signal.SIGTERM, signal.SIGINT):
          signal.signal(number, lambda *_: stop.set())
      stop.wait()


  def serve(slot_name: str, database_url: str, *, until: Callable[[], None] = _until_signalled) -> None:
      logging.basicConfig(level=os.environ.get("KEI_LOG_LEVEL", "INFO"))
      with slot.hold_slot(slot_name):  # first: a second process is refused before it imports the model stack
          logger.info("slot %s taken by pid %s", slot_name, os.getpid())
          import kei_exp.workflows.registered  # noqa: F401 - every workflow is registered before launch
          boot.set_timestamp(boot.database_clock_ms(database_url))
          DBOS(config=config.dbos_config(database_url, slot_name))
          DBOS.launch()
          config.register_queues()
          logger.info("kei worker %s serving", config.executor_id(slot_name))
          try:
              until()
          finally:
              DBOS.destroy()


  def main(argv: list[str] | None = None) -> None:
      parser = argparse.ArgumentParser(prog="kei-worker", description="kei's DBOS worker")
      commands = parser.add_subparsers(dest="command", required=True)
      worker = commands.add_parser("worker", help="Run this slot's worker in the foreground")
      worker.add_argument("--slot", default=config.SLOT, help="Deployment slot: the lock file and the executor ID")
      worker.add_argument("--database-url", default=os.environ.get("KEI_SYSTEM_DATABASE_URL"))
      args = parser.parse_args(argv)
      if not args.database_url:
          parser.error("KEI_SYSTEM_DATABASE_URL (or --database-url) is required")
      try:
          serve(args.slot, args.database_url)
      except slot.SlotTaken as error:
          print(error, file=sys.stderr)
          sys.exit(1)


  if __name__ == "__main__":
      main()
  ```
  `runs.py`: `INBOX = Path(os.environ.get("KEI_SOURCE_INBOX", "source-inbox"))` beside `RUNS`, with a comment "Staged source PDFs Studio writes and kei reads only (the source-inbox volume, M4)."
  `pyproject.toml`: add `kei-worker = "kei_exp.workflows.cli:main"` (keep `kei-jobs` until Task 10), then `uv sync`.

- [ ] **Step 3: Implement the test harness**

  `tests/helpers/postgres.py`:
  ```python
  def url(conninfo: str, *, user: str | None = None, password: str | None = None) -> str:
      """The guarded target as a postgresql:// URL, which DBOS and psycopg both take."""
      from urllib.parse import quote
      fields = checked_conninfo(conninfo)
      user, password = user or fields["user"], password if password is not None else fields.get("password", "")
      return f"postgresql://{quote(user)}:{quote(password)}@{fields['hostaddr']}:{fields['port']}/{fields['dbname']}"
  ```
  Use `url(database, user=role, password=password)` for `kei_url` in Step 1's last test.

  `tests/helpers/kei.py`:
  ```python
  """kei's DBOS worker inside this test process, on one fresh disposable database: the registered workflows, the four
  lanes polled every 0.1 s, the boot timestamp, and a portable client that enqueues as Studio will (M4)."""
  from __future__ import annotations

  import time
  from collections.abc import Callable, Iterator
  from contextlib import contextmanager
  from dataclasses import dataclass
  from pathlib import Path
  from typing import Any

  import psycopg
  from dbos import DBOS, DBOSClient, EnqueueOptions, WorkflowSerializationFormat

  from kei_exp import runs
  from kei_exp.workflows import boot, config
  from tests.helpers import postgres as postgres_helper

  TERMINAL = ("SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED")


  def until(predicate: Callable[[], Any], timeout: float, what: str) -> Any:
      deadline = time.monotonic() + timeout
      while time.monotonic() < deadline:
          if found := predicate():
              return found
          time.sleep(0.02)
      raise AssertionError(f"{what} did not happen within {timeout} s")


  @dataclass
  class Kei:
      url: str
      client: DBOSClient
      runs: Path
      inbox: Path

      def enqueue(self, workflow: str, queue: str, workflow_id: str, request: dict, *, priority: int | None = None,
                  timeout_ms: int | None = None) -> str:
          options: EnqueueOptions = {"workflow_name": workflow, "queue_name": queue, "workflow_id": workflow_id,
                                     "application_name": config.APP_NAME,
                                     "serialization_type": WorkflowSerializationFormat.PORTABLE}
          if priority is not None:
              options["priority"] = priority
          if timeout_ms is not None:
              options["workflow_timeout"] = timeout_ms / 1000  # Python takes seconds; Studio's client milliseconds
          return self.client.enqueue(options, request).get_workflow_id()

      def status(self, workflow_id: str):
          return DBOS.get_workflow_status(workflow_id)

      def wait(self, workflow_id: str, statuses: tuple[str, ...] = TERMINAL, timeout: float = 60.0):
          return until(lambda: (s := self.status(workflow_id)) is not None and s.status in statuses and s,
                       timeout, f"{workflow_id} reaching {statuses}")

      def output(self, workflow_id: str, timeout: float = 60.0) -> dict:
          status = self.wait(workflow_id, timeout=timeout)
          assert status.status == "SUCCESS", (status.status, status.error)
          return status.output

      def steps(self, workflow_id: str) -> list[str]:
          return [step["function_name"] for step in DBOS.list_workflow_steps(workflow_id)]

      def row(self, workflow_id: str) -> dict:
          with psycopg.connect(self.url) as connection:
              cursor = connection.execute("select * from kei_dbos.workflow_status where workflow_uuid = %s",
                                          (workflow_id,))
              names = [column.name for column in cursor.description]
              return dict(zip(names, cursor.fetchone(), strict=True))

      def db_now_ms(self) -> int:
          return boot.database_clock_ms(self.url)


  @contextmanager
  def launched_url(url: str, root: Path, monkeypatch) -> Iterator[Kei]:
      import kei_exp.workflows.registered  # noqa: F401 - registered once per test session, before any launch
      (root / "runs").mkdir(exist_ok=True)
      (root / "inbox").mkdir(exist_ok=True)
      monkeypatch.setattr(runs, "RUNS", root / "runs")
      monkeypatch.setattr(runs, "INBOX", root / "inbox")
      DBOS.destroy()
      boot.set_timestamp(boot.database_clock_ms(url))
      DBOS(config=config.dbos_config(url, "test", log_level="WARNING"))
      DBOS.launch()
      config.register_queues(polling_interval_sec=0.1)
      client = DBOSClient(system_database_url=url, dbos_system_schema=config.SCHEMA, application_name=config.APP_NAME)
      try:
          yield Kei(url, client, root / "runs", root / "inbox")
      finally:
          client.destroy()
          DBOS.destroy()


  @contextmanager
  def launched(conninfo: str, root: Path, monkeypatch) -> Iterator[Kei]:
      with launched_url(postgres_helper.url(conninfo), root, monkeypatch) as kei:
          yield kei
  ```
  `tests/conftest.py`, after the `database` fixture:
  ```python
  @pytest.fixture
  def kei(database: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
      """kei's DBOS worker in this process on a fresh database (tests/helpers/kei.py). Release every blocked step
      before the test ends: DBOS.destroy() does not wait for step threads."""
      from tests.helpers import kei as kei_helper
      with kei_helper.launched(database, tmp_path, monkeypatch) as launched:
          yield launched
  ```
  `tests/helpers/slot.py`: `HOLDER` becomes
  ```python
  HOLDER = (
      "import pathlib, sys, time;"
      "from kei_exp import runs; from kei_exp.workflows import slot;"
      "runs.RUNS = pathlib.Path(sys.argv[2]);"
      "ctx = slot.hold_slot(sys.argv[1]); ctx.__enter__();"
      "print('held', flush=True); time.sleep(600)"
  )
  ```

- [ ] **Step 4: Verify**

  ```bash
  uv run --no-sync pytest -q tests/test_worker_boot.py tests/test_jobs_worker.py tests/test_contracts.py
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uv run --no-sync pytest -q -m "postgres and not live_model"
  uv run --no-sync kei-worker worker 2>&1 | tail -1   # prints the missing-URL usage error, exit 2
  uvx ruff check src/kei_exp/workflows src/kei_exp/runs.py src/kei_exp/jobs/worker.py tests/helpers tests/conftest.py tests/test_worker_boot.py tests/test_jobs_worker.py
  ```
  Expected: all pass. The restricted-role test must pass; if DBOS's launch needs a privilege M2's role lacks, stop and report the failing statement — M2's `ensureKeiRole` must change, not this test.

- [ ] **Step 5: Commit**

  ```bash
  git add prototypes/parsing_service/src/kei_exp/workflows prototypes/parsing_service/src/kei_exp/runs.py \
    prototypes/parsing_service/src/kei_exp/jobs/worker.py prototypes/parsing_service/pyproject.toml prototypes/parsing_service/uv.lock \
    prototypes/parsing_service/tests/helpers prototypes/parsing_service/tests/conftest.py \
    prototypes/parsing_service/tests/test_worker_boot.py prototypes/parsing_service/tests/test_jobs_worker.py
  git commit -m "feat(parsing): start kei's DBOS worker behind its slot lock and database-clock boot timestamp"
  ```

---

### Task 4: Parallel Catalog chunks

**Files:**
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/grounded.py` (`extract_grounded` 158-236)
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/run.py` (`extract` 108-127, `_grounded` 184-200)
- Create: `prototypes/parsing_service/tests/test_catalog_chunks.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `grounded.extract_grounded(evidence, schema, recipe, options, segmentation, chat, counter, *, chunks: int = 1, before_entry: Callable[[], None] | None = None) -> dict` (body gains `"chunks": int`, the pieces actually run, 0 when no entry ran); `run.extract(run_dir, request, chat, *, generation=None, counter=None, chunks=1, before_entry=None) -> dict` (Article ignores both).

- [ ] **Step 1: Write the failing tests** (`tests/test_catalog_chunks.py`)

  ```python
  """A Catalog's entries in contiguous chunks at once: the same artifact as unsplit apart from timing and the chunk
  count (spec, *kei worker → Parallel Catalog chunks*). The model is scripted, so the equality is exact."""
  import pytest
  import requests

  from kei_exp.kie.extract import grounded
  from kei_exp.kie.extract.llm import Reply
  from kei_exp.kie.extract.run import ExtractRequest, extract
  from tests.helpers import catalogue
  from tests.test_extract_grounded import SCHEMA, CountingChat, WordCounter, entry_text, honest

  DOCUMENT_SCHEMA = {**SCHEMA, "schemaNodes": [*SCHEMA["schemaNodes"], {
      "id": "c", "name": "catalogue_title", "type": "string", "valueSource": "document"}]}


  def request(schema=SCHEMA):
      return ExtractRequest.model_validate({"schema": schema, "options": {
          "strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}}})


  def run(case, tmp_path, *, chunks, script=honest, counter=None, schema=SCHEMA, before_entry=None):
      run_dir = catalogue.write(case, tmp_path / f"{case}-{chunks}")
      chat = CountingChat(script)
      return extract(run_dir, request(schema), chat, counter=counter or WordCounter(), chunks=chunks,
                     before_entry=before_entry), chat


  def comparable(result: dict) -> dict:
      body = {key: value for key, value in result.items() if key not in ("started", "seconds", "chunks")}
      body["calls"] = [{**call, "seconds": None} for call in result["calls"]]
      return body


  @pytest.mark.parametrize("case", ["headings", "numbering", "glossary", "continuations", "two-in-one-segment"])
  @pytest.mark.parametrize("chunks", [2, 3, 4])
  def test_chunked_and_unsplit_runs_give_the_same_artifact(case, chunks, tmp_path):
      unsplit, _ = run(case, tmp_path, chunks=1)
      split, _ = run(case, tmp_path, chunks=chunks)
      assert comparable(split) == comparable(unsplit)
      entries = len(unsplit["record_blocks"])
      assert unsplit["chunks"] == min(1, entries) and split["chunks"] == min(chunks, entries)
      assert split["fingerprint"] == unsplit["fingerprint"]  # the chunk count is not part of it


  def test_document_fields_are_extracted_once_and_every_record_merges_them(tmp_path):
      def script(system, user, schema):
          if "catalogue_title" in (schema or {}).get("properties", {}):
              return {"catalogue_title": "Fundchronik"}
          return honest(system, user, schema)
      result, chat = run("headings", tmp_path, chunks=3, script=script, schema=DOCUMENT_SCHEMA)
      assert [call["stage"] for call in result["calls"]].count("document") == 1
      assert sum("catalogue_title" in (call["schema"] or {}).get("properties", {}) for call in chat.calls) == 1
      assert {record["catalogue_title"] for record in result["records"]} == {"Fundchronik"}


  def test_a_record_keeps_its_document_wide_number_in_issues_and_calls(tmp_path):
      def script(system, user, schema):
          if entry_text(user).startswith("5."):
              return Reply(text="not json", input_tokens=10, output_tokens=5, finish="stop", seconds=0.0)
          return honest(system, user, schema)
      result, _ = run("headings", tmp_path, chunks=4, script=script)
      assert [issue["record"] for issue in result["issues"] if issue["code"] == "call_failed"] == [4]
      assert [call["record"] for call in result["calls"] if call["stage"] == "entry"] == [0, 1, 2, 3, 4]


  def test_a_refusal_in_one_chunk_refuses_the_run(tmp_path):
      class Refusing(WordCounter):
          def request_tokens(self, system, user, schema=None):
              return 10**6 if "4. Ddorf" in user else super().request_tokens(system, user, schema)
      result, _ = run("headings", tmp_path, chunks=3, counter=Refusing())
      assert result["completeness"]["processing"] is False and result["complete"] is False
      assert [issue["record"] for issue in result["issues"] if issue["code"] == "window_refused"] == [3]


  def test_a_failed_chunk_fails_the_extraction(tmp_path):
      def script(system, user, schema):
          if entry_text(user).startswith("5."):
              raise requests.ConnectionError("the fields server went away")
          return honest(system, user, schema)
      with pytest.raises(requests.ConnectionError):
          run("headings", tmp_path, chunks=3, script=script)


  def test_before_entry_runs_before_every_entry_and_its_error_ends_the_extraction(tmp_path):
      seen = []

      def before_entry():
          seen.append(1)
          if len(seen) == 3:
              raise RuntimeError("cancelled")
      with pytest.raises(RuntimeError, match="cancelled"):
          run("headings", tmp_path, chunks=1, before_entry=before_entry)
      assert len(seen) == 3


  @pytest.mark.parametrize("count, chunks", [(5, 4), (5, 2), (2, 4), (1, 3), (0, 4), (8, 4)])
  def test_pieces_are_contiguous_balanced_and_never_empty(count, chunks):
      entries = list(range(count))
      pieces = grounded._pieces(entries, chunks)
      assert [entry for piece in pieces for entry in piece] == entries
      assert len(pieces) == min(chunks, count) and all(pieces)
      assert not pieces or max(map(len, pieces)) - min(map(len, pieces)) <= 1


  def test_chunks_must_be_positive(tmp_path):
      with pytest.raises(ValueError):
          run("headings", tmp_path, chunks=0)
  ```
  Run: `uv run --no-sync pytest -q tests/test_catalog_chunks.py`. Expected: FAIL (`extract() got an unexpected keyword argument 'chunks'`). If a fixture name above has fewer entries than a parametrized chunk count, the test's `min(...)` covers it; if a fixture cannot be extracted by `honest` at all (no entry), replace it with another name from `catalogue.names()`.

- [ ] **Step 2: Split `extract_grounded` into prelude, chunks and merge**

  Keep lines 161-181 (clock, counters, `run`, tokenizer probes, bindings, budget checks, `headings`, the three lists, the `schema_exceeds_budget` check) unchanged. Replace the entry loop (lines 182-187) with:
  ```python
      pieces: list[list[tuple[int, Block]]] = []
      if not run.refused:
          document = _document(run)  # once for the whole document; every chunk's records merge it
          pieces = _pieces(list(enumerate(segmentation.blocks)), chunks)
          for part, found in _in_chunks(run, pieces, before_entry,
                                        lambda part, number, block: _block(part, number, block, headings, bindings,
                                                                           segmentation)):
              run.calls += part.calls        # chunk order is entry order: prelude calls, then each chunk's
              run.issues += part.issues
              run.refused = run.refused or part.refused
              for record, block_outcomes, contest in found:
                  outcomes += block_outcomes
                  competitors += contest
                  records.append(merge(record, document, evidence.source_name, schema))
  ```
  Add `"chunks": len(pieces),` to the returned body after `"strategy"`, check `if chunks < 1: raise ValueError("chunks must be at least 1")` at the top, extend the docstring ("`chunks` contiguous runs of entries are extracted at once, each in its own thread with its own `_Run`, because `_Run.call` mutates run state; the segmentation, budget checks, bindings and document fields are computed once; `before_entry` is called before every entry, and what it raises ends the extraction"), and add:
  ```python
  def _pieces(entries: list, chunks: int) -> list[list]:
      """`entries` in at most `chunks` contiguous runs whose sizes differ by at most one; none is empty."""
      count = min(chunks, len(entries))
      bounds = [index * len(entries) // count for index in range(count + 1)] if count else []
      return [entries[bounds[index]:bounds[index + 1]] for index in range(count)]


  def _in_chunks(prelude: _Run, pieces: list[list[tuple[int, Block]]], before_entry: Callable[[], None] | None,
                 work: Callable[[_Run, int, Block], tuple]) -> list[tuple[_Run, list]]:
      """Each piece with its own `_Run`, one thread per piece when there are several. A failed piece stops the others
      at their next entry; the first failure in entry order is raised once every thread has returned."""
      halt = threading.Event()

      def one(piece):
          part = _Run(prelude.evidence, prelude.schema, prelude.recipe, prelude.options, prelude.chat, prelude.counters)
          found = []
          try:
              for number, block in piece:  # the document-wide entry number, so issues and calls name the record
                  if halt.is_set():
                      break
                  if before_entry is not None:
                      before_entry()
                  found.append(work(part, number, block))
          except BaseException:
              halt.set()
              raise
          return part, found

      if len(pieces) <= 1:
          return [one(piece) for piece in pieces]
      with ThreadPoolExecutor(max_workers=len(pieces), thread_name_prefix="catalog-chunk") as pool:
          futures = [pool.submit(one, piece) for piece in pieces]
      for future in futures:
          if (error := future.exception()) is not None:
              raise error
      return [future.result() for future in futures]
  ```
  Imports: `import threading`, `from collections.abc import Callable, Sequence`, `from concurrent.futures import ThreadPoolExecutor`. `fingerprint()` stays as it is (it never reads `chunks`).

  `run.py`: add `chunks: int = 1, before_entry: Callable[[], None] | None = None` to `extract` and `_grounded`, and pass them to `grounded.extract_grounded(..., chunks=chunks, before_entry=before_entry)`. The Article/v1 path does not use them.

- [ ] **Step 3: Verify**

  ```bash
  uv run --no-sync pytest -q tests/test_catalog_chunks.py tests/test_extract_grounded.py tests/test_catalogue_fixtures.py
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uvx ruff check src/kei_exp/kie/extract/grounded.py src/kei_exp/kie/extract/run.py tests/test_catalog_chunks.py
  ```
  Expected: pass; the existing grounded tests are unchanged (the unsplit path runs inline, with no thread).

- [ ] **Step 4: Commit**

  ```bash
  git add prototypes/parsing_service/src/kei_exp/kie/extract/grounded.py prototypes/parsing_service/src/kei_exp/kie/extract/run.py \
    prototypes/parsing_service/tests/test_catalog_chunks.py
  git commit -m "feat(extraction): run a Catalog's entries in parallel contiguous chunks"
  ```

---

### Task 5: The `convert` workflow: model resolution, the staged-source contract, cooperative cancellation

**Files:**
- Create: `prototypes/parsing_service/src/kei_exp/workflows/cancel.py`
- Create: `prototypes/parsing_service/src/kei_exp/workflows/convert.py`
- Modify: `prototypes/parsing_service/src/kei_exp/workflows/registered.py` (import `convert`)
- Modify: `prototypes/parsing_service/src/kei_exp/runs.py` (add `run_id_for`; `execution_for` reads `params["model"]` and `params["layout_model"]` without fallbacks)
- Modify: `prototypes/parsing_service/tests/helpers/kei.py` (add `stage_pdf`, `convert_request`, `Gate`, `BlockingTranscriber`)
- Create: `prototypes/parsing_service/tests/test_convert_workflow.py`

**Interfaces:**
- Consumes: `failures.KeiFailure`, `STEP_RETRY` (Task 1); `contracts.ConvertInput`, `ConvertOk`, `failure`, `settled` (Task 2); `config.MAX_RECOVERY_ATTEMPTS` (Task 2); `runs.INBOX` (Task 3); M2's `kei_exp.models.DEFAULT_OCR_MODEL` and `api.list_ingestion_models`.
- Produces: `runs.run_id_for(workflow_id) -> str`; `cancel.CancelCheck(workflow_id, *, min_interval=1.0)` with `__call__(*, force=False)` and `sink(emit) -> Emit`; steps `convert.resolve_models(model, layout_model) -> {"model", "layout_model"}`, `convert.prepare_run(workflow_id, request: dict, models: dict) -> dict` (the params record, including `id`, `workflow_id`, `page_count`, `source_sha256`), `convert.convert_run(workflow_id, params) -> dict` (a `ConvertOk` dump); workflow `convert` (`convert.convert_workflow(request: dict) -> dict`); `convert.MAX_PAGES`, `convert.MAX_SOURCE_BYTES`, `convert.serving(execution)`. Test helpers: `stage_pdf(inbox, relative, *masks) -> str` (sha256), `convert_request(relative, sha, **overrides) -> dict`, `Gate`, `BlockingTranscriber(gate)`.

- [ ] **Step 1: Write the failing tests** (`tests/test_convert_workflow.py`)

  Fast tests call the steps as plain functions (no DBOS); Postgres tests go through the `kei` fixture.
  ```python
  """kei `convert`: resolve the models, prepare the run from the staged PDF, convert (spec, *kei worker*)."""
  import hashlib
  import json
  import os
  import threading
  from pathlib import Path
  from types import SimpleNamespace

  import pytest
  from fastapi.testclient import TestClient

  from kei_exp import api, runs, runtime
  from kei_exp.cut import DEFAULT_LAYOUT_MODEL
  from kei_exp.failures import KeiFailure
  from kei_exp.kie import runner
  from kei_exp.models import DEFAULT_OCR_MODEL
  from kei_exp.workflows import cancel, config, contracts
  from kei_exp.workflows import convert as workflow
  from tests.helpers import kei as kei_helper
  from tests.helpers.fake import FakeTranscriber, registered
  from tests.helpers.pdfs import mask

  WID = "kei-convert:ingest:project-1:attempt-1"
  FIXTURES = Path(__file__).parent / "fixtures" / "contracts"


  @pytest.fixture
  def roots(tmp_path, monkeypatch):
      monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
      monkeypatch.setattr(runs, "INBOX", tmp_path / "inbox")
      (tmp_path / "runs").mkdir()
      (tmp_path / "inbox").mkdir()
      return tmp_path


  @pytest.fixture
  def fake(monkeypatch):
      monkeypatch.setattr(runtime, "loaded_model", lambda url: (True, "fake/model"))
      with registered(FakeTranscriber()) as transcriber:
          yield transcriber


  def staged(roots, name="p/a.pdf", **overrides):
      sha = kei_helper.stage_pdf(runs.INBOX, name, mask())
      return kei_helper.convert_request(name, sha, **overrides)


  def test_an_omitted_model_is_the_listings_default(monkeypatch):
      monkeypatch.setattr(api, "loaded_model", lambda url: (False, None))
      resolved = workflow.resolve_models(None, None)
      assert resolved == {"model": DEFAULT_OCR_MODEL, "layout_model": DEFAULT_LAYOUT_MODEL}
      listed = TestClient(api.app).get("/api/ingestion-models").json()["defaults"]
      assert listed == {"ocr": resolved["model"], "layout": resolved["layout_model"]}


  @pytest.mark.parametrize("model, layout", [("nope", None), (None, "nope")])
  def test_an_unknown_model_is_an_invalid_request(model, layout):
      with pytest.raises(KeiFailure) as refused:
          workflow.resolve_models(model, layout)
      assert refused.value.code == "invalid_request"


  def test_prepare_run_copies_verifies_and_records_the_request(roots, fake):
      request = staged(roots, model="fake", cut="none")
      params = workflow.prepare_run(WID, request, {"model": "fake", "layout_model": DEFAULT_LAYOUT_MODEL})
      directory = runs.RUNS / runs.run_id_for(WID)
      assert params["id"] == directory.name and params["workflow_id"] == WID
      assert (directory / "input.pdf").read_bytes() == (runs.INBOX / "p/a.pdf").read_bytes()
      assert params["source_sha256"] == request["source_sha256"] and params["page_count"] == 1
      assert json.loads((directory / "params.json").read_text()) == params
      assert params["stream"] is False and params["model"] == "fake" and params["cut"] == "none"


  def test_prepare_run_executed_again_rebuilds_the_same_run(roots, fake):
      request = staged(roots, model="fake", cut="none")
      models = {"model": "fake", "layout_model": DEFAULT_LAYOUT_MODEL}
      first = workflow.prepare_run(WID, request, models)
      (runs.RUNS / first["id"] / "stray").write_text("from the interrupted execution")
      second = workflow.prepare_run(WID, request, models)
      assert second["id"] == first["id"] and not (runs.RUNS / first["id"] / "stray").exists()
      assert sorted(path.name for path in runs.RUNS.iterdir()) == [first["id"]]


  @pytest.mark.parametrize("source", ["../outside.pdf", "/etc/hostname", "link.pdf"])
  def test_a_source_outside_the_inbox_is_refused_before_anything_is_read(roots, source):
      (roots / "outside.pdf").write_bytes(b"%PDF-1.4 secret")
      os.symlink(roots / "outside.pdf", runs.INBOX / "link.pdf")
      request = kei_helper.convert_request(source, "0" * 64)
      with pytest.raises(KeiFailure) as refused:
          workflow.prepare_run(WID, request, {"model": "surya", "layout_model": DEFAULT_LAYOUT_MODEL})
      assert refused.value.code == "invalid_request" and list(runs.RUNS.iterdir()) == []


  @pytest.mark.parametrize("change, code", [
      ({"source": "p/missing.pdf"}, "source_missing"),
      ({"source_sha256": "0" * 64}, "source_mismatch"),
      ({"page_source": "pdf", "ingest": {"split": "spread"}}, "invalid_request"),
  ])
  def test_prepare_run_refuses_what_it_cannot_parse(roots, change, code):
      request = {**staged(roots), **change}
      with pytest.raises(KeiFailure) as refused:
          workflow.prepare_run(WID, request, {"model": "surya", "layout_model": DEFAULT_LAYOUT_MODEL})
      assert refused.value.code == code and list(runs.RUNS.iterdir()) == []


  def test_an_unreadable_or_oversized_pdf_is_refused(roots, digital_pdf, monkeypatch):
      (runs.INBOX / "bad.pdf").write_bytes(b"not a pdf")
      bad = kei_helper.convert_request("bad.pdf", hashlib.sha256(b"not a pdf").hexdigest())
      with pytest.raises(KeiFailure, match="source_unreadable"):
          workflow.prepare_run(WID, bad, {"model": "surya", "layout_model": DEFAULT_LAYOUT_MODEL})
      monkeypatch.setattr(workflow, "MAX_PAGES", 4)  # digital_pdf has eight
      (runs.INBOX / "big.pdf").write_bytes(digital_pdf.read_bytes())
      big = kei_helper.convert_request("big.pdf", hashlib.sha256(digital_pdf.read_bytes()).hexdigest())
      with pytest.raises(KeiFailure, match="too_many_pages"):
          workflow.prepare_run(WID, big, {"model": "surya", "layout_model": DEFAULT_LAYOUT_MODEL})


  def test_convert_run_publishes_the_manifest_and_writes_no_worker_markdown(roots, fake):
      request = staged(roots, model="fake", cut="none")
      params = workflow.prepare_run(WID, request, {"model": "fake", "layout_model": DEFAULT_LAYOUT_MODEL})
      output = workflow.convert_run(WID, params)
      contracts.ConvertOk.model_validate(output)
      directory = runs.RUNS / params["id"]
      manifest = json.loads((directory / "result" / "result.json").read_text())
      assert (output["generation"], output["page_count"]) == (manifest["generation"], 1)
      assert not (directory / "output.md").exists() and not (directory / "tokens.jsonl").exists()


  def test_a_cancel_stops_the_conversion_at_its_next_page_event(roots, fake, monkeypatch):
      cancelled = {"now": False}
      monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(
          workflow_id=WID, get_workflow_status=lambda wid: SimpleNamespace(
              status="CANCELLED" if cancelled["now"] else "PENDING")))
      seen = []

      def cutting(execution, emit):  # stands in for the cut loop: one region event per page, on the step's thread
          for page in range(1, 2001):
              if page == 3:
                  cancelled["now"] = True
              emit({"type": "region", "page": page})
              seen.append(page)
          return ""
      monkeypatch.setattr(runner, "convert", cutting)
      params = workflow.prepare_run(WID, staged(roots, model="fake", cut="none"),
                                    {"model": "fake", "layout_model": DEFAULT_LAYOUT_MODEL})
      monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
      with pytest.raises(KeiFailure) as stopped:
          workflow.convert_run(WID, params)
      assert stopped.value.code == "cancelled" and seen == [1, 2]


  def test_the_cancel_sink_checks_only_on_the_steps_own_thread(monkeypatch):
      reads = []
      monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(
          workflow_id="w", get_workflow_status=lambda wid: reads.append(wid) or SimpleNamespace(status="PENDING")))
      check = cancel.CancelCheck("w", min_interval=0.0)
      sink = check.sink(lambda event: None)
      worker = threading.Thread(target=sink, args=({"type": "region"},))
      worker.start()
      worker.join()
      assert reads == []
      sink({"type": "region"})
      assert reads == ["w"]


  def test_outside_a_workflow_the_check_is_off(monkeypatch):
      monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(workflow_id=None, get_workflow_status=None))
      cancel.CancelCheck("w")(force=True)  # reads nothing, raises nothing


  # --- through DBOS ------------------------------------------------------------------------------------------------


  def enqueue_fixture(kei, request):
      fixture = json.loads((FIXTURES / "convert.input.json").read_text())
      options = fixture["enqueue"]
      return kei.enqueue("convert", options["queue_name"], options["workflow_id"], request,
                         priority=options["priority"], timeout_ms=options["workflow_timeout_ms"])


  def test_the_contract_fixture_converts_through_a_portable_enqueue(kei, fake):
      fixture = json.loads((FIXTURES / "convert.input.json").read_text())
      request = fixture["request"]
      sha = kei_helper.stage_pdf(kei.inbox, request["source"], mask())
      workflow_id = enqueue_fixture(kei, {**request, "source_sha256": sha, "model": "fake", "cut": "none"})
      output = kei.output(workflow_id)
      contracts.ConvertOk.model_validate(output)
      assert set(output) == set(json.loads((FIXTURES / "convert.output.ok.json").read_text()))
      assert output["run_id"] == runs.run_id_for(workflow_id)
      assert kei.steps(workflow_id) == ["resolve_models", "prepare_run", "convert_run"]


  def test_a_refused_source_is_a_typed_failure_not_an_error(kei, fake):
      fixture = json.loads((FIXTURES / "convert.input.json").read_text())
      kei_helper.stage_pdf(kei.inbox, fixture["request"]["source"], mask())
      output = kei.output(enqueue_fixture(kei, {**fixture["request"], "model": "fake"}))  # the fixture's digest
      contracts.Failure.model_validate(output)
      assert (output["code"], output["retryable"]) == ("source_mismatch", False)
      assert set(output) == set(json.loads((FIXTURES / "convert.output.failed.json").read_text()))


  def test_a_malformed_request_is_an_invalid_request(kei):
      output = kei.output(kei.enqueue("convert", config.CONVERT_SMALL, "kei-convert:bad", {"source": "x"}))
      assert (output["ok"], output["code"]) == (False, "invalid_request")


  @pytest.mark.slow
  def test_an_unreachable_model_server_is_retried_three_times_then_reported_retryable(kei, fake, monkeypatch):
      probes = []
      monkeypatch.setattr(runtime, "loaded_model", lambda url: probes.append(url) or (False, None))
      sha = kei_helper.stage_pdf(kei.inbox, "p/a.pdf", mask())
      workflow_id = kei.enqueue("convert", config.CONVERT_SMALL, WID,
                                kei_helper.convert_request("p/a.pdf", sha, model="fake", cut="none"))
      output = kei.output(workflow_id, timeout=60)  # waits 5 s then 10 s between the three attempts
      assert (output["ok"], output["code"], output["retryable"]) == (False, "model_unavailable", True)
      assert len(probes) == 3 and kei.steps(workflow_id).count("prepare_run") == 1
  ```

  Helpers to add to `tests/helpers/kei.py`:
  ```python
  def stage_pdf(inbox: Path, relative: str, *masks) -> str:
      """An image-only PDF (no text layer, so the model path runs) staged as Studio will; its SHA-256."""
      from tests.helpers.pdfs import binary_pdf
      path = inbox / relative
      path.parent.mkdir(parents=True, exist_ok=True)
      binary_pdf(path, *masks)
      return hashlib.sha256(path.read_bytes()).hexdigest()


  def convert_request(source: str, sha: str, **overrides) -> dict:
      return {"source": source, "source_sha256": sha, "source_name": Path(source).name, "page_source": "pdf",
              "ingest": None, "model": None, "layout_model": None, "cut": "auto", "debug": False, **overrides}


  class Gate:
      """Holds chosen workflows' steps inside a native-like call until released; records when each entered and left.
      Keyed by DBOS.workflow_id, which only a sync step's own thread carries: Catalog chunk threads have none, so
      tests keep KEI_CATALOG_CHUNKS unset (1) when a chat double calls a gate."""
      def __init__(self) -> None:
          self.entered: dict[str, float] = {}
          self.left: dict[str, float] = {}
          self._held: dict[str, threading.Event] = {}

      def hold(self, workflow_id: str) -> None:
          self._held[workflow_id] = threading.Event()

      def release(self, workflow_id: str) -> None:
          self._held[workflow_id].set()

      def release_all(self) -> None:
          for event in self._held.values():
              event.set()

      def __call__(self) -> None:
          workflow_id = DBOS.workflow_id
          self.entered[workflow_id] = time.monotonic()
          if (event := self._held.get(workflow_id)) is not None:
              event.wait(timeout=120)
          self.left[workflow_id] = time.monotonic()


  class BlockingTranscriber(FakeTranscriber):
      def __init__(self, gate: Gate) -> None:
          super().__init__()
          self.gate = gate

      def transcribe(self, execution, crops, emit):
          self.gate()
          return super().transcribe(execution, crops, emit)
  ```
  (imports: `hashlib`, `threading`, `from tests.helpers.fake import FakeTranscriber`.)

  Run: `uv run --no-sync pytest -q tests/test_convert_workflow.py -m "not postgres"`. Expected: FAIL (`No module named 'kei_exp.workflows.convert'`).

- [ ] **Step 2: Implement `runs.run_id_for` and `cancel.py`**

  ```python
  def run_id_for(workflow_id: str) -> str:
      """The run a `convert` workflow writes: derived from its ID, so a re-executed prepare_run rebuilds the same
      directory instead of orphaning one, and one path component Studio's RUN_ID accepts."""
      return "run-" + hashlib.sha256(workflow_id.encode()).hexdigest()[:24]
  ```
  In `execution_for`, use `model=params["model"]` and `layout_model=params["layout_model"]` (the params now always carry the resolved models); drop the `or "surya"` / `or DEFAULT_LAYOUT_MODEL` fallbacks and the unused import.

  `cancel.py`:
  ```python
  """Cooperative cancellation inside a step. DBOS cannot interrupt a native call, and a cancelled workflow's running step
  keeps its lane's slot until it returns, so steps ask at their boundaries: twice before model work, at every page event
  of the cut (on the step's own thread, never inside a transcriber's pool), and before every Catalog entry. A native
  call that is already running finishes first (spec, *Cancellation*)."""
  from __future__ import annotations

  import threading
  import time

  from dbos import DBOS

  from kei_exp.failures import KeiFailure
  from kei_exp.progress import Emit, Event

  MIN_INTERVAL = 1.0  # seconds between two status reads of one step


  class CancelCheck:
      def __init__(self, workflow_id: str, *, min_interval: float | None = None) -> None:
          # Off outside a DBOS workflow (the CLI, a unit test calling a step directly). Decided on the step's thread:
          # a chunk thread carries no DBOS context, so the ID is kept here for reads from any thread.
          self._workflow_id = workflow_id if DBOS.workflow_id is not None else None
          self._owner = threading.get_ident()
          self._interval = MIN_INTERVAL if min_interval is None else min_interval
          self._lock = threading.Lock()
          self._next = 0.0

      def __call__(self, *, force: bool = False) -> None:
          """Raise KeiFailure('cancelled') once the workflow is cancelled (explicitly or by its deadline)."""
          if self._workflow_id is None:
              return
          with self._lock:
              now = time.monotonic()
              if not force and now < self._next:
                  return
              self._next = now + self._interval
          status = DBOS.get_workflow_status(self._workflow_id)  # inside a step: read, never checkpointed
          if status is None or status.status == "CANCELLED":
              raise KeiFailure("cancelled", f"workflow {self._workflow_id} was cancelled")

      def sink(self, emit: Emit) -> Emit:
          def checked(event: Event) -> None:
              if threading.get_ident() == self._owner and event["type"] in ("region", "phase"):
                  self()
              emit(event)
          return checked
  ```
  (Read `MIN_INTERVAL` at construction, as above, so a test can set it to 0.)

- [ ] **Step 3: Implement `convert.py`**

  ```python
  """kei `convert`: a staged PDF into a run's canonical result (spec, *kei worker*).

  Three checkpointed steps: resolve_models (the admitted Ingestion Model Choice or kei's default, once, so a recovered
  attempt keeps it), prepare_run (the run directory, the verified source, params.json, the page limit) and convert_run
  (probe the OCR server, resolve native vs OCR, convert). The result is published by rename inside the conversion; a
  re-executed convert_run publishes a new generation over it, and its output names the one it published. No worker
  output.md: the manifest and page files are the product; the standalone CLI keeps its Markdown.
  """
  from __future__ import annotations

  import hashlib
  import logging
  import os
  import shutil
  from pathlib import Path

  from dbos import DBOS, WorkflowSerializationFormat
  from pydantic import ValidationError

  from kei_exp import runs, runtime
  from kei_exp.cut import DEFAULT_LAYOUT_MODEL, LAYOUT_MODELS
  from kei_exp.failures import STEP_RETRY, KeiFailure, TransientBackendError
  from kei_exp.kie import runner
  from kei_exp.kie.stages.ocr import check_ingest, check_knobs
  from kei_exp.models import DEFAULT_OCR_MODEL, MODELS
  from kei_exp.pagefile import read_manifest
  from kei_exp.pages import PdfPages
  from kei_exp.progress import Event
  from kei_exp.transcription.types import DEFAULT_URL, ConversionError, RunParams
  from kei_exp.workflows import config
  from kei_exp.workflows.cancel import CancelCheck
  from kei_exp.workflows.contracts import ConvertInput, ConvertOk, failure, settled

  logger = logging.getLogger(__name__)
  VLLM_URL = os.environ.get("KEI_VLLM_URL", DEFAULT_URL)
  MAX_PAGES = int(os.environ.get("KEI_MAX_PAGES", "2000"))
  MAX_SOURCE_BYTES = int(os.environ.get("KEI_MAX_UPLOAD_BYTES", str(200 * 1024 * 1024)))


  @DBOS.step(name="resolve_models")
  def resolve_models(model: str | None, layout_model: str | None) -> dict:
      """The models this parse runs on: the admitted choice per role, or kei's default, which is the listing's
      (GET /api/ingestion-models). Whether the OCR server serves the model is decided when the conversion runs."""
      ocr, layout = model or DEFAULT_OCR_MODEL, layout_model or DEFAULT_LAYOUT_MODEL
      if ocr not in MODELS:
          raise KeiFailure("invalid_request", f"unknown model {ocr!r}")
      if layout not in LAYOUT_MODELS:
          raise KeiFailure("invalid_request", f"unknown layout model {layout!r}")
      return {"model": ocr, "layout_model": layout}


  @DBOS.step(name="prepare_run")
  def prepare_run(workflow_id: str, request: dict, models: dict) -> dict:
      """The run directory with its verified source and params.json; returns the params, which replay reuses."""
      run_id = runs.run_id_for(workflow_id)
      source = _staged(request["source"])
      directory, staging = runs.RUNS / run_id, runs.RUNS / f".prepare-{run_id}"
      for leftover in (staging, directory):  # an earlier execution of this same step, stopped before its checkpoint
          if leftover.exists():
              shutil.rmtree(leftover)
      staging.mkdir(parents=True)
      try:
          target = staging / "input.pdf"
          digest = _copy(source, target)
          if digest != request["source_sha256"]:
              raise KeiFailure("source_mismatch", f"the staged PDF hashes to {digest}, not {request['source_sha256']}")
          try:
              with PdfPages(target) as pages:
                  count = pages.count
          except Exception as error:  # noqa: BLE001 - pdfium raises its own error types
              raise KeiFailure("source_unreadable", f"not a readable PDF: {error}") from error
          if count > MAX_PAGES:
              raise KeiFailure("too_many_pages", f"the PDF has {count} pages, more than this service's limit of {MAX_PAGES}")
          try:
              check_ingest(request["page_source"], request["ingest"])
              check_knobs(RunParams(pdf=target, model=models["model"], url=VLLM_URL, cut=request["cut"],
                                    layout_model=models["layout_model"], stream=False,
                                    page_source=request["page_source"]))
          except ValueError as error:
              raise KeiFailure("invalid_request", str(error)) from error
          record = MODELS[models["model"]]
          params = {"id": run_id, "workflow_id": workflow_id, "created": runs.now(),
                    "source_name": request["source_name"], "page_count": count, "source_sha256": digest,
                    "transcriber": record.kind, "model": models["model"], "repo": record.repo, "url": VLLM_URL,
                    "cut": request["cut"], "crop_dpi": 250, "layout_model": models["layout_model"],
                    "page_source": request["page_source"], "ingest": request["ingest"], "max_image_size": None,
                    "max_output_tokens": None, "stream": False, "pages": None, "debug": request["debug"]}
          runs.write_json(staging / "params.json", params)
          staging.rename(directory)
      except BaseException:
          shutil.rmtree(staging, ignore_errors=True)
          raise
      return params


  def _staged(relative: str) -> Path:
      """The staged PDF `relative` names, refused unless it stays inside the inbox and is a regular file."""
      root = runs.INBOX.resolve()
      candidate = Path(relative)
      if candidate.is_absolute() or ".." in candidate.parts:
          raise KeiFailure("invalid_request", f"{relative!r} is not a path inside the source inbox")
      path = (root / candidate).resolve()
      if not path.is_relative_to(root):
          raise KeiFailure("invalid_request", f"{relative!r} leads outside the source inbox")
      if not path.is_file():
          raise KeiFailure("source_missing", f"no staged PDF at {relative!r}")
      return path


  def _copy(source: Path, target: Path) -> str:
      digest, written = hashlib.sha256(), 0
      with source.open("rb") as reader, target.open("wb") as writer:
          while chunk := reader.read(1024 * 1024):
              written += len(chunk)
              if written > MAX_SOURCE_BYTES:
                  raise KeiFailure("invalid_request", f"the staged PDF is larger than {MAX_SOURCE_BYTES} bytes")
              digest.update(chunk)
              writer.write(chunk)
      return digest.hexdigest()


  def serving(execution) -> None:
      """Refuse a served execution whose model server is not there (transient) or holds another model (not):
      moved from jobs/tasks.py:138-153, which Task 10 deletes."""
      if execution.model is None:
          return
      reachable, repo = runtime.loaded_model(execution.url)
      if not reachable:
          raise TransientBackendError(f"the model server at {execution.url} is unreachable")
      if repo != execution.repo:
          raise ConversionError(f"the model server has {repo!r} loaded, not the {execution.repo!r} this run needs")


  def _log(event: Event) -> None:
      if event["type"] == "phase":
          logger.info("phase %s (%s)", event["name"], event.get("total"))
      elif event["type"] == "log":
          logger.info("%s", event["text"])


  @DBOS.step(name="convert_run", **STEP_RETRY)
  def convert_run(workflow_id: str, params: dict) -> dict:
      check = CancelCheck(workflow_id)
      check(force=True)  # before anything reads the PDF (jobs/tasks.py:94)
      directory = runs.RUNS / params["id"]
      execution = runs.execution_for(directory, params)
      serving(execution)
      check(force=True)  # resolution read the text layer (jobs/tasks.py:98)
      runner.convert(execution, emit=check.sink(_log))
      manifest = read_manifest(directory / "result")
      return ConvertOk(ok=True, run_id=params["id"], generation=manifest.generation, page_count=manifest.page_count,
                       source_sha256=manifest.recipe["source_sha256"],
                       page_source=manifest.recipe["page_source"]).model_dump()


  @DBOS.workflow(name="convert", max_recovery_attempts=config.MAX_RECOVERY_ATTEMPTS,
                 serialization_type=WorkflowSerializationFormat.PORTABLE)
  def convert_workflow(request: dict) -> dict:
      try:
          parsed = ConvertInput.model_validate(request)
      except ValidationError as error:
          return failure("invalid_request", str(error), retryable=False)
      workflow_id = DBOS.workflow_id

      def steps() -> dict:
          models = resolve_models(parsed.model, parsed.layout_model)
          params = prepare_run(workflow_id, parsed.model_dump(), models)
          return convert_run(workflow_id, params)
      return settled(steps, default="conversion_failed")
  ```
  `registered.py`: add `from kei_exp.workflows import convert  # noqa: F401`.

- [ ] **Step 4: Verify**

  ```bash
  uv run --no-sync pytest -q tests/test_convert_workflow.py -m "not postgres"
  uv run --no-sync pytest -q tests/test_convert_workflow.py -m postgres
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uv run --no-sync pytest -q -m "postgres and not live_model"
  uvx ruff check src/kei_exp/workflows src/kei_exp/runs.py tests/helpers/kei.py tests/test_convert_workflow.py
  ```
  Expected: pass (the retry test takes about 15 s). `tests/test_convert.py:491-501` exercises `execution_for` with params that lack `model`; give those params `"model": "surya", "layout_model": "layout_heron_101"`.

- [ ] **Step 5: Commit**

  ```bash
  git add prototypes/parsing_service/src/kei_exp/workflows prototypes/parsing_service/src/kei_exp/runs.py \
    prototypes/parsing_service/tests/helpers/kei.py prototypes/parsing_service/tests/test_convert_workflow.py \
    prototypes/parsing_service/tests/test_convert.py
  git commit -m "feat(parsing): convert a staged PDF in kei's DBOS convert workflow"
  ```

---

### Task 6: The `extract` workflow; two extractions of one run

**Files:**
- Create: `prototypes/parsing_service/src/kei_exp/workflows/extract.py`
- Modify: `prototypes/parsing_service/src/kei_exp/workflows/registered.py` (import `extract`)
- Modify: `prototypes/parsing_service/tests/helpers/kei.py` (add `converted_run`, `extract_request`)
- Create: `prototypes/parsing_service/tests/test_extract_workflow.py`

**Interfaces:**
- Consumes: Tasks 1, 2, 4 (`extract(..., chunks=, before_entry=)`), 5 (`CancelCheck`).
- Produces: `extract.catalog_chunks(environ) -> int`; `extract.CATALOG_CHUNKS: int`; step `extract.extract_run(workflow_id, run_id, generation, body: dict) -> dict` (an `ExtractOk` dump); workflow `extract` (`extract.extract_workflow(request: dict) -> dict`). Test helpers `converted_run(runs_root, workflow_id, case="headings") -> str` (run ID; a verified catalogue result plus `params.json` naming `workflow_id`) and `extract_request(run_id, generation) -> dict`.

- [ ] **Step 1: Write the failing tests** (`tests/test_extract_workflow.py`)

  ```python
  """kei `extract`: one step over a complete parse, with the same retry policy as convert (spec, *kei worker*)."""
  import hashlib
  import json
  import threading
  from pathlib import Path

  import pytest

  from kei_exp import runs
  from kei_exp.failures import KeiFailure
  from kei_exp.kie.extract import run as extraction
  from kei_exp.kie.extract.evidence import load
  from kei_exp.kie.recipe import load_recipe
  from kei_exp.kie.segmentation import load_segmentation
  from kei_exp.workflows import config, contracts
  from kei_exp.workflows import extract as workflow
  from tests.helpers import catalogue
  from tests.helpers import kei as kei_helper
  from tests.test_extract_grounded import CountingChat, WordCounter, honest

  FIXTURES = Path(__file__).parent / "fixtures" / "contracts"
  WID = "kei-extract:x-1"


  @pytest.fixture
  def scripted(monkeypatch):
      """Every extraction talks to one scripted chat and counts words; a test swaps `state["script"]`."""
      state = {"script": honest}
      monkeypatch.setattr(workflow, "chats_for", lambda options: CountingChat(lambda *a: state["script"](*a)))
      monkeypatch.setattr(extraction, "counter_for", lambda client: WordCounter())
      return state


  @pytest.fixture
  def parsed(tmp_path, monkeypatch, scripted):
      monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
      run_id = kei_helper.converted_run(runs.RUNS, "kei-convert:ingest:p:a")
      return run_id, catalogue.GENERATION


  def test_the_step_publishes_the_artifact_and_names_its_digest(parsed, monkeypatch):
      monkeypatch.setattr(workflow, "CATALOG_CHUNKS", 3)
      run_id, generation = parsed
      body = kei_helper.extract_request(run_id, generation)["request"]
      output = workflow.extract_run(WID, run_id, generation, body)
      contracts.ExtractOk.model_validate(output)
      artifact = runs.RUNS / run_id / "extractions" / "x-1" / "result.json"
      assert output["artifact_sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
      assert json.loads(artifact.read_text())["chunks"] == 3 and output["extraction_id"] == "x-1"


  def test_a_rewritten_parse_is_a_stale_generation_before_any_model_call(parsed, scripted):
      calls = []
      scripted["script"] = lambda *a: calls.append(a) or honest(*a)
      run_id, _ = parsed
      with pytest.raises(KeiFailure) as refused:
          workflow.extract_run(WID, run_id, "another-generation", kei_helper.extract_request(run_id, "g")["request"])
      assert refused.value.code == "stale_generation" and calls == []


  @pytest.mark.parametrize("change, code", [
      ({"run_id": "run-missing"}, "no_result"),
      ({"body": {"schema": {}, "options": {"models": {"fields": "nope"}}}}, "invalid_request"),
      ({"workflow_id": "kei-extract:../x"}, "invalid_request"),
  ])
  def test_what_the_step_refuses(parsed, change, code):
      run_id, generation = parsed
      args = {"workflow_id": WID, "run_id": run_id, "generation": generation,
              "body": kei_helper.extract_request(run_id, generation)["request"], **change}
      with pytest.raises(KeiFailure) as refused:
          workflow.extract_run(**args)
      assert refused.value.code == code


  def test_an_incomplete_parse_has_no_result(parsed):
      run_id, generation = parsed
      manifest = runs.RUNS / run_id / "result" / "result.json"
      data = json.loads(manifest.read_text())
      manifest.write_text(json.dumps({**data, "status": "incomplete", "incomplete": "page 2"}))
      with pytest.raises(KeiFailure) as refused:
          workflow.extract_run(WID, run_id, generation, kei_helper.extract_request(run_id, generation)["request"])
      assert refused.value.code == "no_result"


  @pytest.mark.parametrize("value, chunks", [(None, 1), ("4", 4), ("1", 1)])
  def test_the_chunk_setting(value, chunks):
      assert workflow.catalog_chunks({} if value is None else {"KEI_CATALOG_CHUNKS": value}) == chunks


  @pytest.mark.parametrize("value", ["0", "-2", "four", ""])
  def test_a_bad_chunk_setting_stops_the_worker(value):
      with pytest.raises(ValueError, match="KEI_CATALOG_CHUNKS"):
          workflow.catalog_chunks({"KEI_CATALOG_CHUNKS": value})


  # --- through DBOS ------------------------------------------------------------------------------------------------


  def test_the_contract_fixture_extracts_through_a_portable_enqueue(kei, scripted):
      fixture = json.loads((FIXTURES / "extract.input.json").read_text())
      run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
      request = {**fixture["request"], "run_id": run_id, "generation": catalogue.GENERATION}
      options = fixture["enqueue"]
      output = kei.output(kei.enqueue("extract", options["queue_name"], options["workflow_id"], request,
                                      priority=options["priority"], timeout_ms=options["workflow_timeout_ms"]))
      contracts.ExtractOk.model_validate(output)
      assert set(output) == set(json.loads((FIXTURES / "extract.output.ok.json").read_text()))


  def test_a_stale_generation_is_a_typed_failure(kei, scripted):
      run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
      output = kei.output(kei.enqueue("extract", config.EXTRACT, WID, kei_helper.extract_request(run_id, "old"),
                                      priority=config.PRIORITY_INTERACTIVE))
      assert (output["ok"], output["code"], output["retryable"]) == (False, "stale_generation", False)


  def test_two_extractions_of_one_run_each_publish_and_share_one_valid_segmentation(kei, scripted):
      both_inside = threading.Barrier(2, timeout=30)
      first_call: set[str] = set()

      def script(system, user, schema):
          from dbos import DBOS
          if DBOS.workflow_id not in first_call:  # both extractions are inside their step at once
              first_call.add(DBOS.workflow_id)
              both_inside.wait()
          return honest(system, user, schema)
      scripted["script"] = script
      run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
      ids = [kei.enqueue("extract", config.EXTRACT, f"kei-extract:x-{n}",
                         kei_helper.extract_request(run_id, catalogue.GENERATION), priority=config.PRIORITY_BATCH)
             for n in (1, 2)]
      outputs = [kei.output(workflow_id) for workflow_id in ids]
      directory = kei.runs / run_id
      artifacts = [json.loads((directory / "extractions" / f"x-{n}" / "result.json").read_text()) for n in (1, 2)]
      evidence = load(directory)
      segmentation = load_segmentation(directory, evidence, load_recipe("numbered-catalogue-de@1"))
      assert segmentation is not None
      assert {artifact["segmentation"]["fingerprint"] for artifact in artifacts} == {segmentation.fingerprint}
      assert [output["extraction_id"] for output in outputs] == ["x-1", "x-2"]


  def test_a_cancelled_catalog_stops_before_its_next_entry(kei, scripted, monkeypatch):
      from kei_exp.workflows import cancel
      monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
      gate, calls = kei_helper.Gate(), []
      gate.hold(WID)
      scripted["script"] = lambda *a: calls.append(1) or (gate() if len(calls) == 1 else None) or honest(*a)
      run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
      kei.enqueue("extract", config.EXTRACT, WID, kei_helper.extract_request(run_id, catalogue.GENERATION),
                  priority=config.PRIORITY_INTERACTIVE)
      kei_helper.until(lambda: WID in gate.entered, 30, "the first entry's call")
      from dbos import DBOS
      DBOS.cancel_workflow(WID)
      gate.release(WID)
      assert kei.wait(WID).status == "CANCELLED"
      kei_helper.until(lambda: WID in gate.left, 10, "the blocked call returning")
      assert len(calls) == 1  # the headings fixture has five entries; the second was never asked
  ```

  Helpers (`tests/helpers/kei.py`):
  ```python
  def converted_run(runs_root: Path, workflow_id: str, case: str = "headings") -> str:
      """A finished conversion as prepare_run and convert_run leave it: a verified catalogue result and params.json."""
      from kei_exp import runs as runs_module
      from tests.helpers import catalogue
      run_id = runs_module.run_id_for(workflow_id)
      directory = runs_root / run_id
      catalogue.write(case, directory)
      runs_module.write_json(directory / "params.json", {"id": run_id, "workflow_id": workflow_id,
                                                         "page_source": "pdf", "model": "surya"})
      return run_id


  def extract_request(run_id: str, generation: str) -> dict:
      from tests.test_extract_grounded import SCHEMA
      return {"run_id": run_id, "generation": generation, "request": {"schema": SCHEMA, "options": {
          "strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}}}}
  ```
  Run: `uv run --no-sync pytest -q tests/test_extract_workflow.py -m "not postgres"`. Expected: FAIL (no module).

- [ ] **Step 2: Implement `extract.py`**

  ```python
  """kei `extract`: one step over a complete parse, retried like convert_run (spec, *kei worker*): the manifest must be
  complete, the parse still the admitted generation, the models and recipe known; then the extraction and its
  artifact, published by rename to extractions/<extraction id>/result.json (rewritten whole by a re-execution).
  A Catalog runs its entries in KEI_CATALOG_CHUNKS chunks and checks cancellation before each entry."""
  from __future__ import annotations

  import os
  from collections.abc import Mapping

  from dbos import DBOS, WorkflowSerializationFormat
  from pydantic import ValidationError

  from kei_exp import runs
  from kei_exp.canonical import sha256_file
  from kei_exp.failures import STEP_RETRY, KeiFailure
  from kei_exp.kie.extract.models import chats_for
  from kei_exp.kie.extract.run import ExtractRequest, StaleGeneration, extract, publish_extraction
  from kei_exp.pagefile import ResultError, read_manifest
  from kei_exp.workflows import config
  from kei_exp.workflows.cancel import CancelCheck
  from kei_exp.workflows.contracts import ExtractInput, ExtractOk, extraction_id_of, failure, settled


  def catalog_chunks(environ: Mapping[str, str]) -> int:
      value = environ.get("KEI_CATALOG_CHUNKS", "1")
      try:
          chunks = int(value)
      except ValueError:
          chunks = 0
      if chunks < 1:
          raise ValueError(f"KEI_CATALOG_CHUNKS must be a positive integer, not {value!r}")
      return chunks


  CATALOG_CHUNKS = catalog_chunks(os.environ)


  @DBOS.step(name="extract_run", **STEP_RETRY)
  def extract_run(workflow_id: str, run_id: str, generation: str, body: dict) -> dict:
      extraction_id = extraction_id_of(workflow_id)
      directory = runs.directory_of(run_id)
      if directory is None:
          raise KeiFailure("no_result", f"no run {run_id}")
      try:
          manifest = read_manifest(directory / "result")
      except ResultError as error:
          raise KeiFailure("no_result", f"the run has no complete result to extract from: {error}") from error
      if manifest.status != "success":
          raise KeiFailure("no_result", f"the run's result is incomplete: {manifest.incomplete}")
      try:
          request = ExtractRequest.model_validate(body)
      except ValidationError as error:
          raise KeiFailure("invalid_request", str(error)) from error
      check = CancelCheck(workflow_id)
      check(force=True)
      try:
          result = extract(directory, request, chats_for(request.options), generation=generation,
                           chunks=CATALOG_CHUNKS, before_entry=check)
      except StaleGeneration as error:
          raise KeiFailure("stale_generation", str(error)) from error
      path = publish_extraction(directory, extraction_id, result)
      return ExtractOk(ok=True, run_id=run_id, extraction_id=extraction_id, generation=result["generation"],
                       artifact_sha256=sha256_file(path), model=result["model"], models=result["models"]).model_dump()


  @DBOS.workflow(name="extract", max_recovery_attempts=config.MAX_RECOVERY_ATTEMPTS,
                 serialization_type=WorkflowSerializationFormat.PORTABLE)
  def extract_workflow(request: dict) -> dict:
      try:
          parsed = ExtractInput.model_validate(request)
      except ValidationError as error:
          return failure("invalid_request", str(error), retryable=False)
      workflow_id = DBOS.workflow_id
      return settled(lambda: extract_run(workflow_id, parsed.run_id, parsed.generation, parsed.request),
                     default="extraction_failed")
  ```
  Check that `kei_exp.canonical.sha256_file` is the helper `api.py` uses (it is imported there at line 26). `registered.py`: add `from kei_exp.workflows import extract  # noqa: F401`.

- [ ] **Step 3: Verify**

  ```bash
  uv run --no-sync pytest -q tests/test_extract_workflow.py
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uv run --no-sync pytest -q -m "postgres and not live_model"
  uvx ruff check src/kei_exp/workflows tests/helpers/kei.py tests/test_extract_workflow.py
  ```
  Expected: pass.

- [ ] **Step 4: Commit**

  ```bash
  git add prototypes/parsing_service/src/kei_exp/workflows prototypes/parsing_service/tests/helpers/kei.py \
    prototypes/parsing_service/tests/test_extract_workflow.py
  git commit -m "feat(parsing): extract from a complete parse in kei's DBOS extract workflow"
  ```

---

### Task 7: `deleteRuns` with the kei boot boundary

**Files:**
- Create: `prototypes/parsing_service/src/kei_exp/workflows/gc.py`
- Modify: `prototypes/parsing_service/src/kei_exp/workflows/registered.py` (import `gc`)
- Create: `prototypes/parsing_service/tests/test_delete_runs.py`

**Interfaces:**
- Consumes: `boot.timestamp_ms` (Task 3), `contracts.DeleteRunsInput`, `DeleteRunsOk`, `failure`, `EXTRACT_PREFIX` (Task 2); `params.json`'s `workflow_id` (Task 5).
- Produces: `gc.eligible(status, boot_ms) -> bool`; `gc.MIN_AGE_SECONDS`; step `gc.delete_runs(request: dict) -> dict`; workflow `deleteRuns` (`gc.delete_runs_workflow(request: dict) -> dict`).

- [ ] **Step 1: Write the failing tests** (`tests/test_delete_runs.py`)

  ```python
  """kei `deleteRuns`: a run goes only when every kei workflow that writes it can no longer write (spec, *kei runs and
  history*, *kei boot boundary*)."""
  import itertools
  import os
  import time
  from types import SimpleNamespace

  import pytest
  from dbos import DBOS

  from kei_exp.workflows import boot, config, contracts, gc
  from tests.helpers import kei as kei_helper
  from tests.helpers.pdfs import mask

  BOOT = 1_000_000


  def status(name, updated_at=None):
      return SimpleNamespace(status=name, updated_at=updated_at)


  @pytest.mark.parametrize("found, expected", [
      (None, True), (status("SUCCESS"), True), (status("ERROR"), True),
      (status("CANCELLED", BOOT - 1), True), (status("CANCELLED", BOOT), False), (status("CANCELLED", BOOT + 1), False),
      (status("MAX_RECOVERY_ATTEMPTS_EXCEEDED", BOOT - 1), True),
      (status("MAX_RECOVERY_ATTEMPTS_EXCEEDED", BOOT + 1), False),
      (status("ENQUEUED"), False), (status("PENDING"), False), (status("DELAYED"), False),
  ])
  def test_eligibility_follows_the_boot_boundary(found, expected):
      assert gc.eligible(found, BOOT) is expected


  def age(directory, seconds=gc.MIN_AGE_SECONDS + 60):
      then = time.time() - seconds
      for path in [directory, *directory.rglob("*")]:
          os.utime(path, (then, then))


  GC_IDS = itertools.count(1)


  def delete(kei, runs_=(), history=()):
      return kei.output(kei.enqueue("deleteRuns", config.GC, f"kei-gc:test-{next(GC_IDS)}",
                                    {"runs": list(runs_), "history": list(history)}))


  def converted(kei, workflow_id="kei-convert:ingest:p:a"):
      sha = kei_helper.stage_pdf(kei.inbox, f"{workflow_id[-1]}.pdf", mask())
      kei.enqueue("convert", config.CONVERT_SMALL, workflow_id,
                  kei_helper.convert_request(f"{workflow_id[-1]}.pdf", sha, model="fake", cut="none"))
      return workflow_id


  @pytest.fixture
  def fake(monkeypatch):
      from kei_exp import runtime
      from tests.helpers.fake import registered
      gate = kei_helper.Gate()
      monkeypatch.setattr(runtime, "loaded_model", lambda url: (True, "fake/model"))
      with registered(kei_helper.BlockingTranscriber(gate)):
          yield gate
      gate.release_all()


  def test_an_old_run_whose_conversion_succeeded_is_deleted(kei, fake):
      workflow_id = converted(kei)
      run_id = kei.output(workflow_id)["run_id"]
      age(kei.runs / run_id)
      output = delete(kei, [run_id])
      contracts.DeleteRunsOk.model_validate(output)
      assert output["deleted_runs"] == [run_id] and not (kei.runs / run_id).exists()
      assert not list(kei.runs.glob(".deleting-*"))
      assert delete(kei, [run_id])["deleted_runs"] == [run_id]  # at-least-once: repeating it is harmless


  def test_a_young_run_is_kept(kei, fake):
      run_id = kei.output(converted(kei))["run_id"]
      assert delete(kei, [run_id])["kept_runs"] == [run_id]


  def test_a_run_with_a_cancelled_conversion_waits_for_a_kei_restart(kei, fake):
      workflow_id = "kei-convert:ingest:p:b"
      fake.hold(workflow_id)
      converted(kei, workflow_id)
      kei_helper.until(lambda: workflow_id in fake.entered, 30, "the conversion's native call")
      DBOS.cancel_workflow(workflow_id)
      fake.release(workflow_id)
      from kei_exp import runs
      run_id = runs.run_id_for(workflow_id)
      age(kei.runs / run_id)
      assert delete(kei, [run_id], [workflow_id]) == {
          "ok": True, "deleted_runs": [], "kept_runs": [run_id], "deleted_history": [], "kept_history": [workflow_id]}
      boot.set_timestamp(kei.db_now_ms())  # what the next kei process reads after taking the slot (Task 9 restarts one)
      output = delete(kei, [run_id], [workflow_id])
      assert output["deleted_runs"] == [run_id] and output["deleted_history"] == [workflow_id]
      assert DBOS.get_workflow_status(workflow_id) is None


  def test_a_run_an_unfinished_extraction_reads_is_kept(kei, monkeypatch):
      """Cancelled mid-extraction, before it published anything under the run: the boot boundary still protects it."""
      from kei_exp.kie.extract import run as extraction
      from kei_exp.workflows import extract as extract_workflow
      from tests.test_extract_grounded import CountingChat, WordCounter, honest
      gate, extraction_id = kei_helper.Gate(), "kei-extract:x-9"
      gate.hold(extraction_id)
      monkeypatch.setattr(extract_workflow, "chats_for", lambda options: CountingChat(lambda *a: gate() or honest(*a)))
      monkeypatch.setattr(extraction, "counter_for", lambda client: WordCounter())
      run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:c")
      kei.enqueue("extract", config.EXTRACT, extraction_id,
                  kei_helper.extract_request(run_id, "20260923T000000.000000Z-fixture0"), priority=1)
      kei_helper.until(lambda: extraction_id in gate.entered, 30, "the extraction's first call")
      age(kei.runs / run_id)  # after it published the segmentation, so only the extraction can keep the run
      try:
          assert delete(kei, [run_id])["kept_runs"] == [run_id]   # live
          DBOS.cancel_workflow(extraction_id)
          assert delete(kei, [run_id])["kept_runs"] == [run_id]   # cancelled after boot, step still in its call
      finally:
          gate.release_all()
      kei_helper.until(lambda: extraction_id in gate.left, 30, "the cancelled call returning")
      time.sleep(0.5)  # the step stops at its next entry check and publishes nothing
      age(kei.runs / run_id)
      boot.set_timestamp(kei.db_now_ms())  # the restart that proves the step has stopped
      assert delete(kei, [run_id])["deleted_runs"] == [run_id]


  def test_history_goes_only_for_workflows_that_can_no_longer_write(kei, fake):
      done = converted(kei, "kei-convert:ingest:p:d")
      kei.output(done)
      live = "kei-convert:ingest:p:e"
      fake.hold(live)
      converted(kei, live)
      kei_helper.until(lambda: live in fake.entered, 30, "the live conversion")
      output = delete(kei, history=[done, live])
      assert (output["deleted_history"], output["kept_history"]) == ([done], [live])
      assert DBOS.get_workflow_status(done) is None and DBOS.get_workflow_status(live) is not None


  def test_a_run_id_that_is_not_one_path_component_is_an_invalid_request(kei):
      output = delete(kei, ["../escape"])
      assert (output["ok"], output["code"]) == (False, "invalid_request")
  ```
  Run: `uv run --no-sync pytest -q tests/test_delete_runs.py -m "not postgres"`. Expected: FAIL (no module `gc`).

- [ ] **Step 2: Implement `gc.py`**

  ```python
  """kei `deleteRuns`: remove the run directories and kei workflow history Studio's collectGarbage found unreferenced.

  Studio decides what is unreferenced; kei never reads Studio's schemas. kei rechecks its own workflows: a run goes only
  when every kei workflow that writes it has ended and can no longer write, and nothing in it was written for 24 h.
  SUCCESS and ERROR ended with their steps. CANCELLED (explicit or deadline) and MAX_RECOVERY_ATTEMPTS_EXCEEDED can
  leave a native step writing until the kei process that ran it exits: such a workflow counts only once its updated_at
  (database clock) precedes this process's boot timestamp (boot.py). A failed read deletes nothing.
  """
  from __future__ import annotations

  import shutil
  import time
  from pathlib import Path

  from dbos import DBOS, WorkflowSerializationFormat
  from pydantic import ValidationError

  from kei_exp import runs
  from kei_exp.workflows import boot
  from kei_exp.workflows.contracts import EXTRACT_PREFIX, DeleteRunsInput, DeleteRunsOk, failure

  ENDED = frozenset({"SUCCESS", "ERROR"})
  STOPPED = frozenset({"CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"})
  LIVE = ("ENQUEUED", "PENDING", "DELAYED")
  MIN_AGE_SECONDS = 24 * 3600


  def eligible(status, boot_ms: int) -> bool:
      """Whether a kei workflow can no longer write. An absent one (history already deleted) cannot."""
      if status is None or status.status in ENDED:
          return True
      if status.status in STOPPED:
          return status.updated_at is not None and status.updated_at < boot_ms
      return False


  def _still_extracting(boot_ms: int) -> set[str]:
      """Runs named by an `extract` workflow that may still write: live, or stopped at or after this boot. It may not
      have published anything under the run yet, so its directory cannot tell."""
      found = DBOS.list_workflows(name="extract", status=[*LIVE, *STOPPED], load_input=True, load_output=False)
      return {status.input["args"][0]["run_id"] for status in found
              if not eligible(status, boot_ms) and status.input and status.input["args"]}


  def _writers(directory: Path) -> list[str]:
      """The kei workflows that wrote this run: its conversion (params.json) and every published extraction."""
      params = runs.read_json(directory / "params.json")
      found = [params["workflow_id"]] if params.get("workflow_id") else []
      extractions = directory / "extractions"
      if extractions.is_dir():
          found += [f"{EXTRACT_PREFIX}{entry.name}" for entry in sorted(extractions.iterdir()) if entry.is_dir()]
      return found


  def _last_write(directory: Path) -> float:
      return max(path.stat().st_mtime for path in [directory, *directory.rglob("*")] if path.is_dir())


  def _statuses(workflow_ids: list[str]) -> dict:
      if not workflow_ids:
          return {}
      return {status.workflow_id: status
              for status in DBOS.list_workflows(workflow_ids=workflow_ids, load_input=False, load_output=False)}


  def _sweep() -> None:
      """What an earlier execution of this step left: renamed runs, and prepare_run staging older than a day."""
      for leftover in runs.RUNS.glob(".deleting-*"):
          shutil.rmtree(leftover, ignore_errors=True)
      for leftover in runs.RUNS.glob(".prepare-*"):
          if leftover.stat().st_mtime < time.time() - MIN_AGE_SECONDS:
              shutil.rmtree(leftover, ignore_errors=True)


  @DBOS.step(name="delete_runs")
  def delete_runs(request: dict) -> dict:
      boot_ms = boot.timestamp_ms()
      _sweep()
      extracting = _still_extracting(boot_ms)
      deleted_runs, kept_runs = [], []
      for run_id in request["runs"]:
          directory = runs.RUNS / run_id
          if not directory.exists():
              deleted_runs.append(run_id)  # already gone: an earlier execution of this step, or never written
              continue
          writers = _writers(directory)
          statuses = _statuses(writers)
          if (run_id in extracting or _last_write(directory) > time.time() - MIN_AGE_SECONDS
                  or not all(eligible(statuses.get(writer), boot_ms) for writer in writers)):
              kept_runs.append(run_id)
              continue
          doomed = runs.RUNS / f".deleting-{run_id}"  # hidden: runs.directory_of refuses it at once
          directory.rename(doomed)
          shutil.rmtree(doomed)
          deleted_runs.append(run_id)
      statuses = _statuses(request["history"])
      deleted_history = [wid for wid in request["history"] if eligible(statuses.get(wid), boot_ms)]
      kept_history = [wid for wid in request["history"] if wid not in deleted_history]
      if deleted_history:
          DBOS.delete_workflows(deleted_history)
      return DeleteRunsOk(ok=True, deleted_runs=deleted_runs, kept_runs=kept_runs, deleted_history=deleted_history,
                          kept_history=kept_history).model_dump()


  @DBOS.workflow(name="deleteRuns", serialization_type=WorkflowSerializationFormat.PORTABLE)
  def delete_runs_workflow(request: dict) -> dict:
      try:
          parsed = DeleteRunsInput.model_validate(request)
      except ValidationError as error:
          return failure("invalid_request", str(error), retryable=False)
      return delete_runs(parsed.model_dump())
  ```
  If `DBOS.list_workflows` in 3.1.0 names its status field differently from `status.status` / `status.workflow_id`, or `input` differs from `{"args", "kwargs"}` for a portable workflow, adapt the two accessors and say so in the report; the tests pin the behaviour, not the accessor. `registered.py`: add `from kei_exp.workflows import gc  # noqa: F401`.

- [ ] **Step 3: Verify**

  ```bash
  uv run --no-sync pytest -q tests/test_delete_runs.py
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uv run --no-sync pytest -q -m "postgres and not live_model"
  uvx ruff check src/kei_exp/workflows tests/test_delete_runs.py
  ```
  Expected: pass.

- [ ] **Step 4: Commit**

  ```bash
  git add prototypes/parsing_service/src/kei_exp/workflows prototypes/parsing_service/tests/test_delete_runs.py
  git commit -m "feat(parsing): delete unreferenced runs and history behind kei's boot boundary"
  ```

---

### Task 8: Lanes, physical capacity, deadlines and priority; two conversions in one process

**Files:**
- Modify: `prototypes/parsing_service/src/kei_exp/transcription/surya.py` (`configure` 215-231: extract `settings_for`)
- Create: `prototypes/parsing_service/tests/test_lanes.py`

**Interfaces:**
- Consumes: every workflow (Tasks 5–7), `Gate`, `BlockingTranscriber`, `converted_run`, `extract_request` (test helpers).
- Produces: `surya.settings_for(url: str, max_new_tokens: int, params: dict) -> dict` (what `configure` assigns); no other production change — this task is the regression net for *Physical capacity* and *Queues, deadlines*.

- [ ] **Step 1: Write the failing tests** (`tests/test_lanes.py`)

  ```python
  """kei's lanes: a cancelled step keeps its lane's slot and only its lane's; deadlines behave like cancels; priority
  orders kei-extract; a large and a small conversion share one process without sharing state (spec, *Cancellation →
  Physical capacity*, *Queues, deadlines*, *kei worker → Two conversions in one process*; M0R 4)."""
  import json
  import threading
  import time

  import pytest
  from dbos import DBOS

  from kei_exp import runtime
  from kei_exp.kie.extract import run as extraction
  from kei_exp.models import MODELS, Model
  from kei_exp.transcription.surya import settings_for
  from kei_exp.transcription.types import DEFAULT_URL
  from kei_exp.workflows import config, gc
  from kei_exp.workflows import extract as extract_workflow
  from tests.helpers import kei as kei_helper
  from tests.helpers.fake import registered
  from tests.helpers.pdfs import mask
  from tests.test_contracts import convert_timeout_ms
  from tests.test_extract_grounded import CountingChat, WordCounter, honest

  GENERATION = "20260923T000000.000000Z-fixture0"


  def surya_settings(models) -> set[str]:
      return {json.dumps(settings_for(DEFAULT_URL, record.max_new_tokens, record.params), sort_keys=True)
              for record in models.values() if record.kind == "surya"}


  def test_every_surya_record_makes_configure_set_the_same_process_global_values():
      assert len(surya_settings(MODELS)) <= 1, (
          "two Surya records set different process-global settings (surya.py configure); give Surya per-call "
          "settings before two conversions can run in one process (spec, *Two conversions in one process*)")


  def test_the_surya_check_bites_on_a_second_record_with_other_settings():
      second = {**MODELS, "surya_b": Model("datalab-to/surya-ocr-2", kind="surya", max_new_tokens=4096,
                                            params={"SURYA_GUIDED_LAYOUT": False})}
      assert len(surya_settings(second)) == 2


  @pytest.fixture
  def lanes(kei, monkeypatch):
      """Blocking doubles on every lane, keyed by workflow ID through one gate."""
      gate = kei_helper.Gate()
      monkeypatch.setattr(runtime, "loaded_model", lambda url: (True, "fake/model"))
      monkeypatch.setattr(extract_workflow, "chats_for", lambda options: CountingChat(lambda *a: gate() or honest(*a)))
      monkeypatch.setattr(extraction, "counter_for", lambda client: WordCounter())
      real_sweep = gc._sweep
      monkeypatch.setattr(gc, "_sweep", lambda: gate() or real_sweep())
      run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:fixture:run")
      with registered(kei_helper.BlockingTranscriber(gate)):
          try:
              yield kei, gate, run_id
          finally:
              gate.release_all()


  def job(kei, lane, workflow_id, run_id, *, timeout_ms=None, priority=None):
      if lane in (config.CONVERT_LARGE, config.CONVERT_SMALL):
          name = f"{workflow_id.rsplit(':', 1)[-1]}.pdf"
          sha = kei_helper.stage_pdf(kei.inbox, name, mask(every=7 + len(name)))
          return kei.enqueue("convert", lane, workflow_id,
                             kei_helper.convert_request(name, sha, model="fake", cut="none"), timeout_ms=timeout_ms)
      if lane == config.EXTRACT:
          return kei.enqueue("extract", lane, workflow_id, kei_helper.extract_request(run_id, GENERATION),
                             priority=priority or config.PRIORITY_INTERACTIVE, timeout_ms=timeout_ms)
      return kei.enqueue("deleteRuns", lane, workflow_id, {"runs": [], "history": []}, timeout_ms=timeout_ms)


  PREFIX = {config.CONVERT_LARGE: "kei-convert:", config.CONVERT_SMALL: "kei-convert:",
            config.EXTRACT: "kei-extract:", config.GC: "kei-gc:"}


  @pytest.mark.parametrize("lane", list(config.QUEUES))
  def test_a_cancelled_step_keeps_its_lanes_slot_and_only_its_lanes(lanes, lane):
      kei, gate, run_id = lanes
      blockers = [f"{PREFIX[lane]}{lane}-b{n}" for n in range(config.QUEUES[lane])]
      for blocker in blockers:
          gate.hold(blocker)
          job(kei, lane, blocker, run_id)
      kei_helper.until(lambda: all(b in gate.entered for b in blockers), 30, "every slot of the lane busy")
      victim, follower = blockers[0], f"{PREFIX[lane]}{lane}-follower"
      DBOS.cancel_workflow(victim)
      job(kei, lane, follower, run_id)
      others = {other: job(kei, other, f"{PREFIX[other]}{lane}-other-{other}", run_id)
                for other in config.QUEUES if other != lane}
      for other, workflow_id in others.items():
          assert kei.wait(workflow_id, timeout=15).status == "SUCCESS", other  # the other lanes keep running
      time.sleep(1.5)
      assert kei.status(follower).status == "ENQUEUED" and follower not in gate.entered
      gate.release(victim)
      assert kei.wait(follower, timeout=30).status == "SUCCESS"
      assert gate.entered[follower] >= gate.left[victim]
      assert kei.status(victim).status == "CANCELLED"


  @pytest.mark.parametrize("lane", [config.CONVERT_LARGE, config.CONVERT_SMALL, config.EXTRACT])
  def test_a_deadline_cancels_like_a_cancel_and_the_slot_waits_for_the_step(lanes, lane):
      kei, gate, run_id = lanes
      fillers = [f"{PREFIX[lane]}dl-{lane}-fill{n}" for n in range(config.QUEUES[lane] - 1)]
      for filler in fillers:
          gate.hold(filler)
          job(kei, lane, filler, run_id)
      timed = f"{PREFIX[lane]}dl-{lane}"
      gate.hold(timed)
      job(kei, lane, timed, run_id, timeout_ms=1000)
      kei_helper.until(lambda: timed in gate.entered, 30, "the timed step")
      before = kei.db_now_ms()
      assert kei.wait(timed, timeout=10).status == "CANCELLED"
      after = kei.db_now_ms()
      assert before <= kei.row(timed)["updated_at"] <= after + 1  # stamped from the database clock
      follower = f"{PREFIX[lane]}dl-{lane}-follower"
      job(kei, lane, follower, run_id)
      time.sleep(1.0)
      assert kei.status(follower).status == "ENQUEUED"
      gate.release(timed)
      assert kei.wait(follower, timeout=30).status == "SUCCESS"


  def test_a_deadline_counts_from_dequeue_and_is_the_enqueuers_budget(lanes):
      kei, gate, run_id = lanes
      blocker = "kei-convert:dq-blocker"
      gate.hold(blocker)
      job(kei, config.CONVERT_LARGE, blocker, run_id)
      kei_helper.until(lambda: blocker in gate.entered, 30, "the blocker")
      queued = "kei-convert:dq-queued"
      job(kei, config.CONVERT_LARGE, queued, run_id, timeout_ms=5000)  # room for its own three steps once dequeued
      time.sleep(6.0)  # longer than its budget, still ENQUEUED
      row = kei.row(queued)
      assert (row["status"], row["workflow_deadline_epoch_ms"]) == ("ENQUEUED", None)
      gate.release(blocker)
      assert kei.wait(queued, timeout=30).status == "SUCCESS"
      book = job(kei, config.CONVERT_LARGE, "kei-convert:dq-book", run_id, timeout_ms=convert_timeout_ms(40))
      assert kei.row(book)["workflow_timeout_ms"] == 816_000  # deadlines.json's 40-page budget


  def test_kei_extract_runs_priority_1_before_10_with_fifo_ties(lanes):
      kei, gate, run_id = lanes
      blockers = ["kei-extract:prio-b0", "kei-extract:prio-b1"]
      for blocker in blockers:
          gate.hold(blocker)
          job(kei, config.EXTRACT, blocker, run_id)
      kei_helper.until(lambda: all(b in gate.entered for b in blockers), 30, "both extraction slots busy")
      order_in = [("prio-10a", 10), ("prio-10b", 10), ("prio-1a", 1), ("prio-10c", 10), ("prio-1b", 1)]
      for name, priority in order_in:
          job(kei, config.EXTRACT, f"kei-extract:{name}", run_id, priority=priority)
          time.sleep(0.02)
      gate.release(blockers[0])  # one slot frees; the other stays held
      for name, _ in order_in:
          kei.wait(f"kei-extract:{name}", timeout=60)
      started = sorted((gate.entered[f"kei-extract:{name}"], name) for name, _ in order_in)
      assert [name for _, name in started] == ["prio-1a", "prio-1b", "prio-10a", "prio-10b", "prio-10c"]


  class Overlapping(kei_helper.BlockingTranscriber):
      """Waits in its native call until the other conversion is in its own, when a barrier is set."""
      barrier: threading.Barrier | None = None

      def transcribe(self, execution, crops, emit):
          if self.barrier is not None:
              self.barrier.wait()
          return super().transcribe(execution, crops, emit)


  def comparable(kei, output) -> dict:
      directory = kei.runs / output["run_id"] / "result"
      manifest = json.loads((directory / "result.json").read_text())
      pages = {name: {k: v for k, v in json.loads((directory / "pages" / f"{name}.json").read_text()).items()
                      if k != "generation"} for name in manifest["pages"]}
      kept = {k: v for k, v in manifest.items() if k not in ("generation", "digest", "started", "seconds", "pages")}
      return {"manifest": kept, "pages": pages}


  def test_a_large_and_a_small_conversion_in_one_worker_produce_the_manifests_each_produces_alone(kei, monkeypatch):
      monkeypatch.setattr(runtime, "loaded_model", lambda url: (True, "fake/model"))
      fake = Overlapping(kei_helper.Gate())
      book = kei_helper.stage_pdf(kei.inbox, "book.pdf", mask(every=7))
      small = kei_helper.stage_pdf(kei.inbox, "small.pdf", mask(every=11))

      def convert(lane, workflow_id, name, sha):
          return kei.enqueue("convert", lane, workflow_id,
                             kei_helper.convert_request(name, sha, model="fake", cut="none"))
      with registered(fake):
          alone = [kei.output(convert(config.CONVERT_LARGE, "kei-convert:alone-book", "book.pdf", book)),
                   kei.output(convert(config.CONVERT_SMALL, "kei-convert:alone-small", "small.pdf", small))]
          fake.barrier = threading.Barrier(2, timeout=30)  # passes only if both are converting at once
          together = [convert(config.CONVERT_LARGE, "kei-convert:pair-book", "book.pdf", book),
                      convert(config.CONVERT_SMALL, "kei-convert:pair-small", "small.pdf", small)]
          together = [kei.output(workflow_id) for workflow_id in together]
      assert [comparable(kei, o) for o in together] == [comparable(kei, o) for o in alone]
      assert len({o["run_id"] for o in [*alone, *together]}) == 4  # each conversion has its own run directory
  ```
  (One-page PDFs: `FakeTranscriber` answers one record per conversion, `tests/helpers/fake.py:44`.)

  Run: `uv run --no-sync pytest -q tests/test_lanes.py -m "not postgres"`. Expected: FAIL (`cannot import name 'settings_for'`).

- [ ] **Step 2: Extract `settings_for`**

  In `transcription/surya.py`:
  ```python
  def settings_for(url: str, max_new_tokens: int, params: dict) -> dict:
      """What `configure` assigns to Surya's process-global settings for one record and server. Two conversions in one
      worker share these, so every Surya record must produce the same values (tests/test_lanes.py)."""
      return {"SURYA_INFERENCE_BACKEND": "vllm", "SURYA_INFERENCE_URL": url.removesuffix("/chat/completions"),
              "SURYA_MAX_TOKENS_FULL_PAGE": max_new_tokens, **params}


  def configure(url: str, max_new_tokens: int, params: dict) -> None:
      """(docstring unchanged)"""
      from surya.settings import settings
      for name, value in settings_for(url, max_new_tokens, params).items():
          setattr(settings, name, value)
  ```
  Keep the comment about Surya ignoring `finish_reason` beside `SURYA_MAX_TOKENS_FULL_PAGE` in `settings_for`.

- [ ] **Step 3: Verify**

  ```bash
  uv run --no-sync pytest -q tests/test_lanes.py
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uv run --no-sync pytest -q -m "postgres and not live_model"
  uvx ruff check src/kei_exp/transcription/surya.py tests/test_lanes.py
  ```
  Expected: pass. If the victim's cancel races its claim and the follower starts before the victim's native call (M0R 4 saw this once per lane on "cancel right after claim"), the test waits for `entered` before cancelling, so it must not flake; report any flake with the gate timestamps rather than adding sleeps.

- [ ] **Step 4: Commit**

  ```bash
  git add prototypes/parsing_service/src/kei_exp/transcription/surya.py prototypes/parsing_service/tests/test_lanes.py
  git commit -m "test(parsing): pin kei's lane capacity, deadlines, priority and shared-process conversions"
  ```

---

### Task 9: Worker processes: kill and restart, SIGSTOP, publication crashes

**Files:**
- Create: `prototypes/parsing_service/tests/helpers/kei_worker.py`
- Create: `prototypes/parsing_service/tests/test_worker_recovery.py`

**Interfaces:**
- Consumes: `kei-worker` (Task 3), all workflows, `converted_run`, `stage_pdf`, `convert_request`, `extract_request`.
- Produces: `kei_worker.spawn(slot, *, database_url, runs_root, inbox, control, crash_after=None) -> WorkerProcess` with `.wait_serving()`, `.kill()`, `.pause()`, `.resume()`, `.shutdown()` (never raises), `.log`; `python -m tests.helpers.kei_worker [--crash-after result|artifact] worker ...` as a child entry point.

- [ ] **Step 1: Write the child entry point and the parent helpers** (`tests/helpers/kei_worker.py`)

  ```python
  """A real `kei-worker worker` process with this suite's doubles, for recovery tests.

  Child: `python -m tests.helpers.kei_worker [--crash-after result|artifact] -- worker --slot S --database-url URL`.
  Doubles: the `fake` OCR record (tests/helpers/fake.py) served by a stand-in server; its native call writes
  $KEI_TEST_CONTROL/started-<n> and waits until $KEI_TEST_CONTROL/release exists; extraction talks to the scripted
  `honest` chat and counts words. `--crash-after` SIGKILLs this process right after the first publication of that kind
  (the result manifest, or an extraction artifact); $KEI_TEST_CONTROL/crashed makes it happen once.
  """
  from __future__ import annotations

  import argparse
  import contextlib
  import os
  import signal
  import subprocess
  import sys
  import threading
  import time
  from dataclasses import dataclass, field
  from pathlib import Path

  ROOT = Path(__file__).resolve().parents[2]


  def _install(control: Path, crash_after: str | None) -> None:
      from kei_exp import runtime
      from kei_exp.kie.extract import run as extraction
      from kei_exp.kie.stages import ocr
      from kei_exp.workflows import extract as extract_workflow
      from tests.helpers.fake import FakeTranscriber, registered
      from tests.test_extract_grounded import CountingChat, WordCounter, honest

      class Gated(FakeTranscriber):
          def transcribe(self, execution, crops, emit):
              count = len(list(control.glob("started-*"))) + 1
              (control / f"started-{count}").write_text(str(os.getpid()))
              while not (control / "release").exists():
                  time.sleep(0.05)
              return super().transcribe(execution, crops, emit)

      registered(Gated()).__enter__()  # for the process's lifetime
      runtime.loaded_model = lambda url: (True, "fake/model")
      extract_workflow.chats_for = lambda options: CountingChat(honest)
      extraction.counter_for = lambda client: WordCounter()

      def crashing(module, name, kind):
          original = getattr(module, name)

          def wrapped(*args, **kwargs):
              result = original(*args, **kwargs)
              if crash_after == kind and not (control / "crashed").exists():
                  (control / "crashed").write_text(kind)
                  os.kill(os.getpid(), signal.SIGKILL)
              return result
          setattr(module, name, wrapped)
      crashing(ocr, "write_result", "result")
      crashing(extract_workflow, "publish_extraction", "artifact")


  def main() -> None:
      parser = argparse.ArgumentParser()
      parser.add_argument("--crash-after", choices=["result", "artifact"])
      parser.add_argument("worker_args", nargs=argparse.REMAINDER)
      args = parser.parse_args()
      _install(Path(os.environ["KEI_TEST_CONTROL"]), args.crash_after)
      from kei_exp.workflows import cli
      cli.main([arg for arg in args.worker_args if arg != "--"])


  @dataclass
  class WorkerProcess:
      process: subprocess.Popen[str]
      log: list[str] = field(default_factory=list)

      def __post_init__(self) -> None:
          threading.Thread(target=self._drain, daemon=True).start()

      def _drain(self) -> None:
          assert self.process.stdout is not None
          while line := self.process.stdout.readline():
              self.log.append(line)

      def wait_serving(self, timeout: float = 60) -> None:
          deadline = time.monotonic() + timeout
          while time.monotonic() < deadline:
              if any("serving" in line for line in self.log):
                  return
              if self.process.poll() is not None:
                  raise AssertionError(f"the worker exited with {self.process.returncode}:\n{''.join(self.log)}")
              time.sleep(0.05)
          raise AssertionError(f"the worker did not start serving:\n{''.join(self.log)}")

      def kill(self) -> None:
          os.kill(self.process.pid, signal.SIGKILL)
          self.process.wait(timeout=20)

      def pause(self) -> None:
          os.kill(self.process.pid, signal.SIGSTOP)

      def resume(self) -> None:
          os.kill(self.process.pid, signal.SIGCONT)

      def shutdown(self) -> None:
          """Kill and reap unconditionally; never raises (so it cannot mask a failed assertion)."""
          if self.process.poll() is None:
              with contextlib.suppress(ProcessLookupError):
                  os.kill(self.process.pid, signal.SIGKILL)
          with contextlib.suppress(subprocess.TimeoutExpired):
              self.process.wait(timeout=20)


  def spawn(slot: str, *, database_url: str, runs_root: Path, inbox: Path, control: Path,
            crash_after: str | None = None) -> WorkerProcess:
      command = [sys.executable, "-m", "tests.helpers.kei_worker"]
      if crash_after:
          command += ["--crash-after", crash_after]
      command += ["--", "worker", "--slot", slot, "--database-url", database_url]
      environment = {**os.environ, "KEI_RUNS": str(runs_root), "KEI_SOURCE_INBOX": str(inbox),
                     "KEI_TEST_CONTROL": str(control), "KEI_LOG_LEVEL": "INFO", "PYTHONUNBUFFERED": "1"}
      process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, bufsize=1)
      return WorkerProcess(process)


  if __name__ == "__main__":
      main()
  ```

- [ ] **Step 2: Write the tests** (`tests/test_worker_recovery.py`)

  ```python
  """Recovery across real kei-worker processes: a killed worker's replacement recovers its workflow and re-executes only
  the step that was running; a stopped worker keeps its slot; a crash between a publication and its checkpoint leaves
  one consistent result (spec, *kei worker*, *Rules → Domain writes are idempotent*). No test in this module launches
  DBOS in the test process: that would be a second executor on the same queues."""
  import hashlib
  import json
  import os
  import signal
  import subprocess
  import sys

  import psycopg
  import pytest
  from dbos import DBOSClient, EnqueueOptions, WorkflowSerializationFormat

  from kei_exp import runs
  from kei_exp.workflows import config
  from tests.helpers import kei as kei_helper
  from tests.helpers import kei_worker
  from tests.helpers import postgres as postgres_helper
  from tests.helpers.pdfs import mask

  pytestmark = pytest.mark.slow


  @pytest.fixture
  def site(database, tmp_path):
      paths = {name: tmp_path / name for name in ("runs", "inbox", "control")}
      for path in paths.values():
          path.mkdir()
      workers: list[kei_worker.WorkerProcess] = []
      clients: list[DBOSClient] = []

      def start(crash_after=None):
          worker = kei_worker.spawn("slot-1", database_url=postgres_helper.url(database), runs_root=paths["runs"],
                                    inbox=paths["inbox"], control=paths["control"], crash_after=crash_after)
          workers.append(worker)
          worker.wait_serving()
          return worker

      def client():
          if not clients:  # kei_dbos exists only once a worker has launched
              clients.append(DBOSClient(system_database_url=postgres_helper.url(database),
                                        dbos_system_schema=config.SCHEMA, application_name=config.APP_NAME))
          return clients[0]
      try:
          yield paths, start, client, postgres_helper.url(database)
      finally:
          for worker in workers:
              worker.shutdown()
          for each in clients:
              each.destroy()


  def enqueue(client, workflow, queue, workflow_id, request, priority=None):
      options: EnqueueOptions = {"workflow_name": workflow, "queue_name": queue, "workflow_id": workflow_id,
                                 "application_name": config.APP_NAME,
                                 "serialization_type": WorkflowSerializationFormat.PORTABLE}
      if priority:
          options["priority"] = priority
      return client.enqueue(options, request)


  def final(client, workflow_id, timeout=120):
      return kei_helper.until(lambda: (s := client.retrieve_workflow(workflow_id).get_status()).status in
                              kei_helper.TERMINAL and s, timeout, f"{workflow_id} ending")


  def test_a_killed_worker_is_replaced_and_its_conversion_recovered(site):
      paths, start, client, url = site
      first = start()
      sha = kei_helper.stage_pdf(paths["inbox"], "a.pdf", mask())
      workflow_id = "kei-convert:ingest:p:a"
      enqueue(client(), "convert", config.CONVERT_SMALL, workflow_id,
              kei_helper.convert_request("a.pdf", sha, model="fake", cut="none"))
      kei_helper.until(lambda: (paths["control"] / "started-1").exists(), 60, "the conversion's native call")
      first.kill()
      start()
      kei_helper.until(lambda: (paths["control"] / "started-2").exists(), 60, "the recovered native call")
      (paths["control"] / "release").touch()
      status = final(client(), workflow_id)
      assert status.status == "SUCCESS" and status.output["ok"] is True
      assert status.executor_id == "kei-slot-1"
      steps = [step["function_name"] for step in client().list_workflow_steps(workflow_id)]
      assert steps == ["resolve_models", "prepare_run", "convert_run"]  # each recorded once
      with psycopg.connect(url) as connection:
          attempts = connection.execute("select recovery_attempts from kei_dbos.workflow_status "
                                        "where workflow_uuid = %s", (workflow_id,)).fetchone()[0]
      assert attempts == 2


  def test_a_stopped_worker_keeps_its_slot_and_gets_no_replacement(site):
      paths, start, _, url = site
      running = start()
      running.pause()
      try:
          refused = subprocess.run(
              [sys.executable, "-m", "kei_exp.workflows.cli", "worker", "--slot", "slot-1", "--database-url", url],
              env={**os.environ, "KEI_RUNS": str(paths["runs"])}, capture_output=True, text=True, timeout=60,
              check=False)
          assert refused.returncode != 0
          assert "slot slot-1 is held by another process" in refused.stdout + refused.stderr
      finally:
          running.resume()


  def test_an_extraction_killed_after_publishing_its_artifact_recovers_to_one_artifact(site):
      paths, start, client, _ = site
      crashing = start(crash_after="artifact")
      run_id = kei_helper.converted_run(paths["runs"], "kei-convert:ingest:p:x")
      workflow_id = "kei-extract:x-1"
      enqueue(client(), "extract", config.EXTRACT, workflow_id,
              kei_helper.extract_request(run_id, "20260923T000000.000000Z-fixture0"), priority=1)
      kei_helper.until(lambda: crashing.process.poll() is not None, 60, "the crash after the artifact")
      assert crashing.process.returncode == -signal.SIGKILL
      start()
      status = final(client(), workflow_id)
      assert status.status == "SUCCESS"
      artifact = paths["runs"] / run_id / "extractions" / "x-1" / "result.json"
      assert status.output["artifact_sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
      assert [p.name for p in (paths["runs"] / run_id / "extractions").iterdir()] == ["x-1"]
      assert not list((paths["runs"] / run_id).rglob("*.part"))


  def test_a_conversion_killed_after_publishing_its_result_recovers_to_the_published_generation(site):
      paths, start, client, _ = site
      (paths["control"] / "release").touch()
      crashing = start(crash_after="result")
      sha = kei_helper.stage_pdf(paths["inbox"], "b.pdf", mask())
      workflow_id = "kei-convert:ingest:p:b"
      enqueue(client(), "convert", config.CONVERT_SMALL, workflow_id,
              kei_helper.convert_request("b.pdf", sha, model="fake", cut="none"))
      kei_helper.until(lambda: crashing.process.poll() is not None, 60, "the crash after the result")
      start()
      status = final(client(), workflow_id)
      assert status.status == "SUCCESS"
      manifest = json.loads((paths["runs"] / runs.run_id_for(workflow_id) / "result" / "result.json").read_text())
      assert status.output["generation"] == manifest["generation"]
      assert not list((paths["runs"] / runs.run_id_for(workflow_id)).rglob("*.part"))
  ```
  The kill happens inside the wrapped publication, before the step returns, so DBOS never checkpoints that execution: the replacement must re-execute the step and publish again. Assert that it did — a second `started-*` file for the conversion; for the extraction, the artifact's `started` differs from the one the first process wrote (read it before starting the replacement) — so the test cannot pass vacuously.

- [ ] **Step 3: Verify**

  ```bash
  uv run --no-sync pytest -q tests/test_worker_recovery.py
  uv run --no-sync pytest -q -m "postgres and not live_model"
  uvx ruff check tests/helpers/kei_worker.py tests/test_worker_recovery.py
  ```
  Expected: pass. Every spawned worker is reaped even when an assertion fails (`site`'s `finally`).

- [ ] **Step 4: Commit**

  ```bash
  git add prototypes/parsing_service/tests/helpers/kei_worker.py prototypes/parsing_service/tests/test_worker_recovery.py
  git commit -m "test(parsing): recover kei workflows across killed, stopped and crashing worker processes"
  ```

---

### Task 10: Delete the Procrastinate backend, its routes and projections; the service smoke through DBOS

**Files:**
- Delete: `prototypes/parsing_service/src/kei_exp/jobs/` (all of it; `hold_slot` already lives in `workflows/slot.py`)
- Modify: `prototypes/parsing_service/src/kei_exp/api.py` (see Step 2), `prototypes/parsing_service/src/kei_exp/runs.py` (see Step 2)
- Modify: `prototypes/parsing_service/pyproject.toml`, `uv.lock` (drop `procrastinate`, the `pool` extra of psycopg, `kei-jobs`), `prototypes/parsing_service/package.json`
- Delete tests: `test_jobs_batching.py`, `test_jobs_events.py`, `test_jobs_extraction.py`, `test_jobs_recovery.py`, `test_jobs_schema.py`, `test_jobs_store.py`, `test_jobs_task.py`, `test_jobs_worker.py`, `test_api_jobs.py`, `test_api_extraction.py`, `test_api_lifecycle.py`, `tests/helpers/slot.py`
- Modify tests: `test_pages.py` (394-480), `test_native.py` (161-232), `test_service_smoke.py` (rewrite), `test_worker_boot.py` (its holder test uses `tests/helpers/slot.py`: move `Holder`/`holder` into `tests/helpers/kei_worker.py` first)
- Create: `prototypes/parsing_service/tests/test_api_reads.py`
- Modify: `prototypes/parsing_service/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: an API with routes `GET /api/models`, `/api/extraction-models`, `/api/ingestion-models`, `/api/runs/{id}/result`, `/api/runs/{id}/pages/{n}`, `/api/runs/{id}/extractions/{xid}` (file-only) and no database; `pnpm --filter parsing-service worker` runs `kei-worker worker`; `test:recovery` runs `tests/test_worker_recovery.py`.

- [ ] **Step 1: Write the failing read-API tests** (`tests/test_api_reads.py`)

  ```python
  """The parsing API after kei moved to DBOS: file reads only, no database (spec, *kei worker → Read API*)."""
  import subprocess
  import sys

  import pytest
  from fastapi.testclient import TestClient

  from kei_exp import api, runs
  from tests.helpers import kei as kei_helper


  @pytest.fixture
  def client(tmp_path, monkeypatch):
      monkeypatch.setattr(runs, "RUNS", tmp_path)
      for name in ("KEI_DATABASE_URL", "KEI_SYSTEM_DATABASE_URL"):
          monkeypatch.delenv(name, raising=False)
      with TestClient(api.app) as served:  # the lifespan runs, and needs no database
          yield served


  def test_the_api_process_loads_no_database_client():
      """Neither a driver nor kei's DBOS application: the API can never grow a database import silently."""
      code = ("import sys, kei_exp.api\n"
              "loaded = {name.split('.')[0] for name in sys.modules} | set(sys.modules)\n"
              "print(sorted(loaded & {'psycopg', 'psycopg_pool', 'procrastinate', 'dbos', 'kei_exp.workflows'}))")
      assert subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip() == "[]"


  def test_a_published_extraction_is_served_and_an_unpublished_one_is_404(client, tmp_path):
      run_id = kei_helper.converted_run(tmp_path, "kei-convert:ingest:p:r")
      target = tmp_path / run_id / "extractions" / "x-1" / "result.json"
      assert client.get(f"/api/runs/{run_id}/extractions/x-1").status_code == 404
      target.parent.mkdir(parents=True)
      target.write_text('{"records": []}')
      response = client.get(f"/api/runs/{run_id}/extractions/x-1")
      assert response.status_code == 200 and response.json() == {"records": []}


  @pytest.mark.parametrize("path", ["/api/runs/.deleting-r/result", "/api/runs/run-x/extractions/..%2Fresult.json"])
  def test_hidden_runs_and_escaping_ids_are_not_found(client, path):
      assert client.get(path).status_code == 404


  @pytest.mark.parametrize("method, path", [("post", "/api/runs"), ("get", "/api/runs/run-x"),
                                            ("post", "/api/runs/run-x/extract")])
  def test_the_submission_and_status_routes_are_gone(client, method, path):
      assert getattr(client, method)(path).status_code in (404, 405)


  def test_the_models_route_answers_without_a_store(client):
      assert client.get("/api/models").status_code == 200
  ```
  Run: `uv run --no-sync pytest -q tests/test_api_reads.py`. Expected: FAIL (the lifespan opens the store; the old routes answer).

- [ ] **Step 2: Delete the backend**

  - `rm -r src/kei_exp/jobs`.
  - `api.py`: delete `lifespan`'s store pool and deferring connector (keep `runs.RUNS.mkdir`), `MAX_UPLOAD_BYTES`, `MAX_PAGES` (they live in `workflows/convert.py`), `_stage`, `create_run`, `get_run`, `_extraction_status`, `create_extraction`; replace `get_extraction` with:
    ```python
    @app.get("/api/runs/{run_id}/extractions/{extraction_id}")
    def run_extraction(run_id: str, extraction_id: str) -> FileResponse:
        """A published extraction artifact. Its status is its kei `extract` workflow's, which Studio reads from DBOS."""
        if not runs.COMPONENT.fullmatch(extraction_id):  # runs, not workflows.contracts: that module imports dbos
            raise HTTPException(404, "no such extraction")
        path = run_dir(run_id) / "extractions" / extraction_id / "result.json"
        if not path.is_file():
            raise HTTPException(404, "no such extraction")
        return FileResponse(path, media_type="application/json")
    ```
    Remove every import this leaves unused (`secrets`, `shutil`, `AsyncExitStack`, `File`, `Form`, `UploadFile`, `sha256_file`, `store`, `jobs.app`, `ExtractRequest`, `check_ingest`, `check_knobs`, `PdfPages`, `RunParams`, `read_manifest`, `ResultError`, …; keep what `list_models`, `list_extraction_models`, M2's `list_ingestion_models` and the read routes use). Rewrite the module docstring: "Read-only HTTP over the runs directory and the model registries; kei's work runs in its DBOS worker (`kei_exp.workflows`)."
  - `runs.py`: delete `TERMINAL`, `STATUS_OF`, `UNRECORDED`, `new_id`, `run_tokens`, `_legacy_duration`, `_params_summary`, `summary_of`, `summary`, `is_legacy` and the `math`/`secrets` imports; rewrite the docstring: "What a run is on disk: `runs/<id>/` holds `input.pdf`, `params.json` (the request `prepare_run` recorded), `result/`, `extractions/` and, when asked for, `debug/`. `INBOX` is where Studio stages sources."
  - `pyproject.toml`: `uv remove procrastinate`; change `"psycopg[binary,pool]>=3.2"` to `"psycopg[binary]>=3.2"` (boot.py and the test guard use it); delete `kei-jobs = …`; `uv lock && uv sync`.
  - `package.json`: `"worker": "uv run --no-sync kei-worker worker"`, delete `db:migrate`, `"test:recovery": "uv run --no-sync pytest -q tests/test_worker_recovery.py"`.
  - Tests: delete the files listed above (`rm`, then `git add -A` those paths). In `test_pages.py` delete `api_run`, `run`, `jobs_store` and the four tests that use them (394-480); `prepare_run`'s tests and `test_convert.py:491-501` cover their behaviour (ingest under the run directory, the recorded request). In `test_native.py` rewrite `test_the_native_api_run_reads_the_pdf_without_a_server_a_cut_or_ocr` to stage `digital_pdf` in `runs.INBOX`, call `convert.resolve_models(None, None)`, `convert.prepare_run(...)` with `debug: True` and `convert.convert_run(...)` directly (no database; still `live_model`), keeping the patches that forbid a server, a cut and OCR, and the page-evidence, params and debug-report assertions; drop the event, `summary_of` and `output.md` assertions.
  - Move `Holder`/`holder`/`HOLDER` from `tests/helpers/slot.py` into `tests/helpers/kei_worker.py` and point `test_worker_boot.py` at it before deleting `slot.py`.

- [ ] **Step 3: Rewrite the service smoke through DBOS** (`tests/test_service_smoke.py`)

  Keep the module's evidence assertions and helpers (`smoke_pdf`, `_flat`, `_phrases`, `_locate` may go; `_alive`, `_shutdown` pattern stay). New shape:
  - Docstring: "One parse, end to end, over the real service: a `kei-worker worker` process on the session's disposable PostgreSQL, a portable enqueue as Studio will send it (M4), and the HTTP API reading the result back. No model server takes part: the document is born-digital."
  - Fixture `service(database, tmp_path, monkeypatch)`: `runs_root`, `inbox`; `monkeypatch.setattr(runs, "RUNS", runs_root)`; spawn the **real** CLI (no doubles): `subprocess.Popen([sys.executable, "-m", "kei_exp.workflows.cli", "worker", "--slot", "smoke", "--database-url", url], env={..., "KEI_RUNS": runs_root, "KEI_SOURCE_INBOX": inbox})` wrapped in `kei_worker.WorkerProcess`, `wait_serving()`; a `DBOSClient(application_name="kei", dbos_system_schema="kei_dbos")`; `TestClient(api.app)`.
  - Test: copy `smoke_pdf` to `inbox/project-1/attempt-1.pdf`; `pages = len(pdfium.PdfDocument(...))`; enqueue `convert` with ID `kei-convert:ingest:project-1:attempt-1` on `kei-convert-small` if `pages <= 30` else `kei-convert-large`, portable, `workflow_timeout = convert_timeout_ms(pages) / 1000`, request `{source, source_sha256, source_name: smoke_pdf.name, page_source: "pdf", model: None, layout_model: None, cut: "auto", debug: False}`; poll the status until terminal while `_alive(worker)`; assert SUCCESS, `output["ok"]`, `output["run_id"] == runs.run_id_for(workflow_id)`, `output["source_sha256"]`, `output["page_count"] == pages`.
  - Keep: source kept byte for byte; manifest and page files fetched over HTTP verify through `read_manifest`/`read_page`; `result_version == RESULT_VERSION`; `transcriber == "native"`; segment boxes on their pages; at least one block segment; no `Traceback` in the worker log; no `debug/`.
  - Replace the `output.md` reading-order check and the `_persisted` events check with: `not (directory / "output.md").exists()`, `not (directory / "tokens.jsonl").exists()`, and `json.loads((directory / "params.json").read_text())["workflow_id"] == workflow_id`.

- [ ] **Step 4: README**

  Rewrite `prototypes/parsing_service/README.md`:
  - *Runtime*: API and worker from one image; the API has no database and serves model listings and a run's published files; the worker (`kei-worker worker`) is kei's DBOS application (`kei`, `kei@1`) in schema `kei_dbos` of Studio's database `free`, connected as the restricted `kei` role; Studio enqueues `convert`, `extract` and `deleteRuns` by name with portable JSON (contract and examples in `tests/fixtures/contracts/`) on four lanes (`kei-convert-large`, `kei-convert-small`, `kei-extract` with priority 1 interactive before 10 batch, `kei-gc`), each with its worker limit equal to its global limit; one worker holds `KEI_RUNS/.worker-<slot>.lock` for its lifetime, reads the database clock as its boot timestamp, then launches DBOS, which recovers the slot's pending work; a cancel or deadline stops a step at its next check (before model work, between pages while cutting, between Catalog entries) and a running native call finishes first; `deleteRuns` removes a run only when every kei workflow writing it can no longer write (the boot boundary).
  - *Settings* table: `KEI_SYSTEM_DATABASE_URL` (worker only), `KEI_RUNS`, `KEI_SOURCE_INBOX`, `KEI_SLOT`, `KEI_VLLM_URL`, `KEI_OCR_MODEL`, `KEI_EXTRACT_URL`/`KEI_EXTRACT_MODEL`, `KEI_NUEXTRACT_URL`/`KEI_NUEXTRACT_MODEL`, `KEI_EXTRACT_TIMEOUT`, `KEI_CATALOG_CHUNKS`, `KEI_MAX_UPLOAD_BYTES`/`KEI_MAX_PAGES`. Remove `KEI_DATABASE_URL` and `KEI_ADMISSION_LIMIT`.
  - *HTTP and evidence contract*: remove the `POST /api/runs`, `GET /api/runs/{id}` and `POST …/extract` bullets; describe `convert`'s input (the staged path relative to `KEI_SOURCE_INBOX`, the SHA-256 `prepare_run` verifies, the optional `model` and `layout_model`) and output; `extract`'s input `{run_id, generation, request: {schema, options}}` and its artifact at `extractions/<extraction id>/result.json`, served by `GET /api/runs/{id}/extractions/{extraction_id}` (404 until published; status is the workflow's); Catalog chunks (`KEI_CATALOG_CHUNKS`, the artifact's `chunks`).
  - *Code organization*: `workflows/` (configuration and lanes, portable contracts, `convert`, `extract`, `deleteRuns` with the boot boundary, the slot lock, the `kei-worker` CLI) and `failures.py` replace `jobs/`.
  - *Verification*: `test:recovery` = worker process recovery (kill and restart, SIGSTOP, publication crashes; PostgreSQL); `test:service` = a real native PDF through a `kei-worker` process and DBOS, read back over HTTP (PostgreSQL and Docling models); database tiers launch a DBOS worker in the test process on each fresh database. Diagnostics: `KEI_SYSTEM_DATABASE_URL=… pnpm --filter parsing-service worker` and `pnpm --filter parsing-service serve`; there is no migration command (`DBOS.launch()` migrates `kei_dbos`).
  - Parsing `CLAUDE.md` needs no change ("durable jobs", "Keep the API and worker separate" still hold).

- [ ] **Step 5: Verify**

  ```bash
  uv run --no-sync python -c "import kei_exp.api, kei_exp.workflows.cli"
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uv run --no-sync pytest -q -m "postgres and not live_model"
  uv run --no-sync pytest -q -m "live_model and not postgres"
  uv run --no-sync pytest -q tests/test_service_smoke.py
  grep -rnE "procrastinate|kei_exp\.jobs|kei-jobs|DurableEmit|tokens\.jsonl|KEI_DATABASE_URL|KEI_ADMISSION_LIMIT|cancel_requested|summary_of|is_legacy|UNRECORDED" src tests README.md package.json pyproject.toml
  uvx ruff check src tests/test_api_reads.py tests/test_service_smoke.py tests/test_pages.py tests/test_native.py tests/helpers
  ```
  Expected: every tier passes (the live ones need Docling weights; record it in the report if this host cannot run them — never report them as passed); the grep prints nothing. `pnpm test:service` is now expected red (Ruling 1); do not "fix" `prototypes/studio/e2e/realService.ts`.

- [ ] **Step 6: Commit**

  ```bash
  git add -A prototypes/parsing_service/src/kei_exp/jobs prototypes/parsing_service/tests
  git add prototypes/parsing_service/src/kei_exp/api.py prototypes/parsing_service/src/kei_exp/runs.py \
    prototypes/parsing_service/pyproject.toml prototypes/parsing_service/uv.lock prototypes/parsing_service/package.json \
    prototypes/parsing_service/README.md
  git commit -m "refactor(parsing): remove Procrastinate, the kei job tables and the HTTP submission routes"
  ```

---

### Task 11: Delete the legacy readers: v4 manifests and `options.model`

**Files:**
- Modify: `prototypes/parsing_service/src/kei_exp/pagefile.py:228-230`
- Modify: `prototypes/parsing_service/tests/test_result.py:351-356` (and any other test that reads a v4 manifest through `read_manifest`/`load_result`: `grep -rn "result_version" tests/`)
- Modify: `prototypes/studio/api/_kei_exp.ts:86`, `prototypes/studio/api/_kei_exp.test.ts:125,361,384`, `prototypes/studio/api/source_documents.test.ts:83`, `prototypes/studio/test/fixtures/kei-exp/result.json`
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/run.py:54-68`, `prototypes/parsing_service/src/kei_exp/kie/extract/models.py:34-36,70-72,109-117`, `prototypes/parsing_service/tests/test_extract_models.py:58-…`, `prototypes/parsing_service/README.md` (the "legacy `options.model`" sentence and "Readers still verify original version 4 files")

**Interfaces:**
- Consumes: nothing.
- Produces: `read_manifest` accepts `RESULT_VERSION` (5) only; Studio's `keiExpManifestSchema.result_version` is `z.literal(5)`; `Options` has no `model` field (an `options.model` is refused by `extra="forbid"`); `chats_for` has no legacy branch; `ExtractModel.chat()` takes no model override.

- [ ] **Step 1: Write the failing tests**

  Python (`tests/test_result.py`, replacing the v4-acceptance test at 351-356):
  ```python
  def test_a_version_4_manifest_is_refused(...):   # same fixture arguments as the test it replaces
      ...  # plant result_version 4 in the manifest and the recipe, as lines 351-352 do
      with pytest.raises(ResultError, match="result_version 4"):
          load_result(directory)
  ```
  Python (`tests/test_extract_models.py`, replacing `test_the_legacy_model_runs_every_stage_on_the_instruction_server_under_that_id`):
  ```python
  def test_a_legacy_single_model_is_refused():
      with pytest.raises(ValidationError):
          Options.model_validate({"model": "Qwen/Qwen3.8-27B"})
  ```
  Studio (`api/_kei_exp.test.ts`): in `suryaRun`, `result_version: 5`; delete the two `manifest.result_version = 5` lines (361, 384); add (the schema, not `translate`, is where a manifest is judged — `source_documents.ts:413` `safeParse`s it):
  ```ts
  it('refuses a version 4 manifest', async () => {
    const raw = JSON.parse(await readFile(resolve(FIXTURE, 'result.json'), 'utf8'))
    expect(keiExpManifestSchema.safeParse(raw).success).toBe(true)
    expect(keiExpManifestSchema.safeParse({ ...raw, result_version: 4 }).success).toBe(false)
  })
  ```
  `api/source_documents.test.ts:83`: `result_version: 5`.
  Run: `uv run --no-sync pytest -q tests/test_result.py tests/test_extract_models.py` and `pnpm --filter studio exec vitest run api/_kei_exp.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 2: Delete the readers**

  - `pagefile.py`: `if manifest.result_version != RESULT_VERSION:` with the same message. The version-history comment at 25-30 stays (history).
  - `run.py`: delete `Options.model` (58); `_models_are_served` keeps only `extraction_models.check(self.models or {})`. `Options.dumped()` loses its `model: null` key, so every extraction fingerprint changes: update any recorded or golden fingerprint a test compares (`grep -rn fingerprint tests/ | grep -v catalogue`), regenerating it from the code rather than editing digits by hand.
  - `models.py`: `Choice` loses `model`; `chats_for` loses the legacy branch and its docstring sentence; `ExtractModel.chat(self) -> Chat` builds with `model=self.repo`. `grep -rn "\.chat(" src` to update callers.
  - Studio `_kei_exp.ts:86`: `result_version: z.literal(5),`.
  - Studio fixture: rewrite `result.json` as a real v5 manifest. Write this to `/tmp/v5_fixture.py` and run it from `prototypes/parsing_service` with `uv run --no-sync python /tmp/v5_fixture.py`:
    ```python
    import json
    from pathlib import Path

    from kei_exp.pagefile import load_result
    from kei_exp.result import fingerprint

    directory = Path("../studio/test/fixtures/kei-exp")
    path = directory / "result.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["result_version"] = 5
    data["recipe"]["result_version"] = 5
    data["fingerprint"] = fingerprint(data["recipe"])
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(load_result(directory).manifest.result_version)  # the v5 reader accepts it: prints 5
    ```
    The page files are unchanged: a v5 page's `table` is optional (`pagefile.py:130`), and the `digest` covers the page hashes only. If `load_result` refuses the fixture, report why instead of editing page files by hand.
  - README: delete "Readers still verify original version 4 files." and "The legacy `options.model` still runs every call on the instruction server under that model id."
  - Confirm Studio never sends `options.model`: `grep -n "model" packages/extraction/src/kei-exp.ts | grep -n options` shows only `models`.

- [ ] **Step 3: Verify**

  ```bash
  (cd prototypes/parsing_service && uv run --no-sync pytest -q -m "not postgres and not live_model" \
    && uv run --no-sync pytest -q -m "postgres and not live_model" \
    && uvx ruff check src/kei_exp/pagefile.py src/kei_exp/kie/extract/run.py src/kei_exp/kie/extract/models.py tests/test_result.py tests/test_extract_models.py)
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter extraction typecheck && pnpm --filter extraction test
  grep -rnE "result_version: (4|z\.union)|literal\(4\)|options\.model\b|legacy .?model" prototypes/studio/api prototypes/parsing_service/src prototypes/parsing_service/README.md
  ```
  Expected: all pass; the grep prints nothing.

- [ ] **Step 4: Commit**

  ```bash
  git add prototypes/parsing_service/src/kei_exp/pagefile.py prototypes/parsing_service/src/kei_exp/kie/extract \
    prototypes/parsing_service/tests/test_result.py prototypes/parsing_service/tests/test_extract_models.py \
    prototypes/parsing_service/README.md prototypes/studio/api/_kei_exp.ts prototypes/studio/api/_kei_exp.test.ts \
    prototypes/studio/api/source_documents.test.ts prototypes/studio/test/fixtures/kei-exp/result.json
  git commit -m "refactor: drop the version 4 manifest readers and the legacy single extraction model"
  ```

---

### Task 12: Compose, launcher and safety tests

**Files:**
- Modify: `compose.yaml`, `compose.override.yaml`, `compose.prod.yaml`, `compose.gpu.yaml`
- Modify: `scripts/free.mjs` (421, 547), `scripts/free.test.mjs` (~570, ~590, ~654), `.env.example`
- Modify: `tests/safety.test.mjs` (`assertOwnedParsingTopology` 162-233, the production test 131-160, the development test 235-248)

**Interfaces:**
- Consumes: `kei-worker worker` (Task 3), `KEI_SYSTEM_DATABASE_URL` (Task 3), `KEI_CATALOG_CHUNKS` (Task 6), `KEI_OCR_MODEL` via M2's `DEFAULT_OCR_MODEL`; M2's `FREE_KEI_POSTGRES_PASSWORD` (Studio entrypoint, dev default `kei-development`).
- Produces: the M3 topology: no `parsing_db`, `parsing_migrate` or `parsing-postgres`; `parsing_service` without database settings; `parsing_worker` running `kei-worker worker` as role `kei` on `db:5432/free`, after Studio is healthy; `KEI_OCR_MODEL` on both parsing processes; `KEI_CATALOG_CHUNKS` equal to NuExtract's `--max-num-seqs` on the GPU overlay.

- [ ] **Step 1: Write the failing safety assertions**

  In `tests/safety.test.mjs`, replace the database/migration part of `assertOwnedParsingTopology` (lines 168-185) with:
  ```js
    // kei runs on DBOS in Studio's database: no job database, no migration service, no schema-checking entrypoint.
    for (const gone of ['parsing_db', 'parsing_migrate']) assert.equal(services[gone], undefined, gone)
    assert.equal(config.volumes['parsing-postgres'], undefined)
    assert.equal(services.studio.environment.KEI_EXP_MODEL, undefined, "kei's KEI_OCR_MODEL is the OCR default")
    // The parsing API reads files only: no database URL, password or dependency.
    const api = services.parsing_service
    assert.deepEqual(Object.keys(api.environment).filter((name) => /DATABASE|POSTGRES/.test(name)), [])
    assert.equal(api.depends_on?.db, undefined)
    // kei's worker connects as the restricted kei role to database free; its schema is kei_dbos (M2's entrypoint).
    const kei = new URL(services.parsing_worker.environment.KEI_SYSTEM_DATABASE_URL)
    assert.deepEqual([kei.protocol, kei.username, kei.hostname, kei.port, kei.pathname],
      ['postgresql:', 'kei', 'db', '5432', '/free'])
    assert.ok(kei.password.length > 0)
    assert.deepEqual(services.parsing_worker.command, ['kei-worker', 'worker'])
    // Studio's entrypoint creates the role and schema, so the worker waits for Studio; Studio no longer waits for it.
    assert.equal(services.parsing_worker.depends_on.studio.condition, 'service_healthy')
    assert.equal(services.studio.depends_on.parsing_worker, undefined)
    for (const name of ['parsing_service', 'parsing_worker']) {
      const service = services[name]
      assert.equal(service.entrypoint, undefined, name)
      assert.equal(service.environment.KEI_RUNS, '/app/runs')
      assert.equal(service.environment.KEI_SLOT, 'slot-1')
      assert.equal(service.environment.KEI_OCR_MODEL, 'surya', name)
      assert.ok(service.volumes.some(({ source, target }) => source === 'parsing-runs' && target === '/app/runs'))
      assert.equal(service.ports, undefined, 'the unauthenticated service stays private')
      assert.equal(service.deploy?.resources?.reservations?.devices, undefined)
    }
    assert.equal(services.parsing_service.environment.KEI_SYSTEM_DATABASE_URL, undefined)
    assert.equal(services.parsing_worker.restart, 'unless-stopped')
    assert.equal(services.studio.depends_on.parsing_service.condition, 'service_healthy')
  ```
  In the GPU branch add:
  ```js
      // A Catalog sends as many entry requests at once as NuExtract runs (--max-num-seqs).
      const nuSeqs = services.nuextract_model.command[services.nuextract_model.command.indexOf('--max-num-seqs') + 1]
      assert.equal(services.parsing_worker.environment.KEI_CATALOG_CHUNKS, nuSeqs)
      assert.equal(services.parsing_service.environment.KEI_CATALOG_CHUNKS, undefined)
  ```
  and in the non-GPU branch `assert.equal(services.parsing_worker.environment.KEI_CATALOG_CHUNKS, undefined)`.
  Production test: delete `assert.equal(config.services.parsing_db.environment.POSTGRES_PASSWORD, 'c'.repeat(64))`; add `assert.equal(new URL(config.services.parsing_worker.environment.KEI_SYSTEM_DATABASE_URL).password, 'd'.repeat(64))` (M2's fixture value); remove `FREE_PARSING_POSTGRES_PASSWORD` from `completeProductionEnvironment`.
  Development test: delete the `parsing_db` password assertion; add `assert.equal(new URL(config.services.parsing_worker.environment.KEI_SYSTEM_DATABASE_URL).password, 'kei-development')` and, per parsing service, `assert.ok(!(source.ignore ?? []).includes('kei_exp/jobs/schema.py'))`.
  `scripts/free.test.mjs`: remove `FREE_PARSING_POSTGRES_PASSWORD` from the fixture (~570), the required-fields list (~590) and the hexadecimal loop (~654); add an assertion that `validateProductionEnvironment` no longer mentions it.
  Read M2's safety test `kei role: only Studio receives the kei password, after migrations`. It checks that no service but Studio has the `FREE_KEI_POSTGRES_PASSWORD` *key*, which `parsing_worker` does not have (its password is inside `KEI_SYSTEM_DATABASE_URL`). If it was implemented as a scan of rendered environment *values* instead, exempt exactly `parsing_worker.environment.KEI_SYSTEM_DATABASE_URL` there, with a comment naming this task.
  Run: `node --test scripts/free.test.mjs && pnpm test:safety`. Expected: FAIL.

- [ ] **Step 2: Change the topology**

  `compose.yaml`:
  - `x-parsing-runtime`: delete the `entrypoint` and its two comment lines (22-24); add `KEI_OCR_MODEL: "${KEI_OCR_MODEL:-surya}"` to its `environment` with the comment "# The OCR model of a parse whose owner chose none; the API's listing and `convert` read the same value."
  - Delete `parsing_db` (58-73), `parsing_migrate` (75-82) and `parsing-postgres` (173).
  - `parsing_service`: delete its `depends_on`.
  - `parsing_worker`: `command: ["kei-worker", "worker"]`; replace its `depends_on` with `studio: {condition: service_healthy}` and the comment "# Studio's entrypoint creates kei's role and schema (M2). A replacement worker starts after the old process exits and releases its slot lock; never scale this single slot with replicas." (keep `restart` and `stop_grace_period`).
  - `studio`: delete `KEI_EXP_MODEL` (117) and `parsing_worker` from `depends_on` (142-143).
  `compose.override.yaml`: delete `parsing_db` and `parsing_migrate` (168-174) and the `&parsing-database` anchor; `parsing_service` keeps only `develop: &parsing-watch`; in the watch, delete the `kei_exp/jobs/schema.py` ignore and its comment, and the "Restart pnpm dev after a schema edit…" comment; `parsing_worker`:
  ```yaml
    parsing_worker:
      environment:
        # kei's own role on Studio's database; the password is Studio's FREE_KEI_POSTGRES_PASSWORD (M2).
        KEI_SYSTEM_DATABASE_URL: "postgresql://kei:${FREE_KEI_POSTGRES_PASSWORD:-kei-development}@db:5432/free"
      develop: *parsing-watch
  ```
  `compose.prod.yaml`: delete `parsing_db`, `parsing_migrate` and the anchor; `parsing_service` keeps `restart: unless-stopped`; `parsing_worker.environment.KEI_SYSTEM_DATABASE_URL: "postgresql://kei:${FREE_KEI_POSTGRES_PASSWORD:?FREE_KEI_POSTGRES_PASSWORD must be set to a generated hexadecimal password}@db:5432/free"`.
  `compose.gpu.yaml`: `nuextract_model`'s `--max-num-seqs` value becomes `"${NUEXTRACT_MAX_NUM_SEQS:-4}"`; `parsing_worker.environment` becomes
  ```yaml
      environment:
        <<: *parsing-gpu-env
        # A Catalog extraction runs its entries in as many chunks as NuExtract serves requests at once.
        KEI_CATALOG_CHUNKS: "${NUEXTRACT_MAX_NUM_SEQS:-4}"
  ```
  and its comment "A restarted worker reclaims durable extraction jobs" becomes "A restarted worker recovers its pending workflows, so it starts once the last extraction server is serving."
  `scripts/free.mjs`: delete `FREE_PARSING_POSTGRES_PASSWORD: 'kei',` (421); the loop at 547 becomes `for (const field of ['FREE_POSTGRES_PASSWORD', 'FREE_KEI_POSTGRES_PASSWORD'])`. The stop list at 450 stays (it names no `parsing_db`).
  `.env.example`: delete the `FREE_PARSING_POSTGRES_PASSWORD` line and its comment.

- [ ] **Step 3: Verify**

  ```bash
  node --test scripts/free.test.mjs
  pnpm test:safety
  docker compose -f compose.yaml -f compose.override.yaml config --quiet
  docker compose -f compose.yaml -f compose.prod.yaml -f compose.gpu.yaml config --quiet   # with the prod env from safety's fixture, or skip if it needs secrets
  grep -rnE "parsing_db|parsing_migrate|parsing-postgres|FREE_PARSING_POSTGRES_PASSWORD|kei-jobs|KEI_DATABASE_URL|KEI_EXP_MODEL" compose*.y*ml scripts tests .env.example
  ```
  Expected: tests pass; the grep prints nothing. `docs/operations/*.md` still name `FREE_PARSING_POSTGRES_PASSWORD` and `kei-jobs`; M6 rewrites the operations documents (M2's deferral table), so leave them.

- [ ] **Step 4: Commit**

  ```bash
  git add compose.yaml compose.override.yaml compose.prod.yaml compose.gpu.yaml scripts/free.mjs scripts/free.test.mjs \
    .env.example tests/safety.test.mjs
  git commit -m "chore(compose): run kei's DBOS worker as the kei role and remove the parsing job database"
  ```

---

### Task 13: Verification and bookkeeping

**Files:**
- Create: `docs/validation/2026-09-2X-dbos-m3-verification.md` (the real date)
- Modify: `docs/plans/2026-09-24-unified-durable-execution.md` (the `**M3: kei on DBOS.**` heading), this plan's `Status:` line

- [ ] **Step 1: Run every tier**

  ```bash
  pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety
  (cd prototypes/parsing_service && uv run --no-sync pytest -q -m "postgres and not live_model")
  (cd prototypes/parsing_service && uv run --no-sync pytest -q -m "live_model and not postgres")
  (cd prototypes/parsing_service && uv run --no-sync pytest -q tests/test_service_smoke.py)
  pnpm test:postgres:node   # with the M2 databases recreated
  pnpm test:e2e
  pnpm test:service         # expected red until M4 (Ruling 1): record the failure, do not fix it
  ```
  Expected: everything but `test:service` passes. A tier this host cannot run (Docling weights, Docker) is recorded with the reason, never reported as passed.

- [ ] **Step 2: Residue search**

  ```bash
  grep -rnE "procrastinate|kei_exp\.jobs|kei-jobs|DurableEmit|tokens\.jsonl|parsing_db|parsing_migrate|parsing-postgres|FREE_PARSING_POSTGRES_PASSWORD|KEI_DATABASE_URL|KEI_ADMISSION_LIMIT|cancel_requested|KEI_EXP_MODEL" \
    prototypes packages scripts docker compose*.y*ml tests .env.example --exclude-dir=node_modules
  ```
  Expected residue, each listed in the verification record with its milestone: `prototypes/studio/e2e/realService.ts` (M4), `prototypes/studio/api/source_documents.ts` `KEI_EXP_MODEL`/`DEFAULT_MODEL` and `packages/extraction/src/kei-exp.ts`'s HTTP submission and polling (M4). `docs/operations/*.md` (M6) and historical records under `docs/plans/`, `docs/validation/` and `openspec/changes/archive/` are not residue.

- [ ] **Step 3: Record completion**

  Write the verification record (tested commit, commands, results, skips, expected-red tiers, residue). In the DBOS plan change `**M3: kei on DBOS.**` to `**M3: kei on DBOS — done YYYY-MM-DD (task plan: [2026-09-26-dbos-m3-kei-on-dbos.md](2026-09-26-dbos-m3-kei-on-dbos.md)); Spark measurement pending (Task 14).**`, and this plan's status to `**done YYYY-MM-DD, except Task 14.**`.
  ```bash
  git add docs/validation/2026-09-2X-dbos-m3-verification.md docs/plans/2026-09-24-unified-durable-execution.md \
    docs/plans/2026-09-26-dbos-m3-kei-on-dbos.md
  git commit -m "docs(plans): record DBOS M3 verification"
  ```

---

### Task 14: Spark measurement of Catalog chunks (controller-run later; blocks nothing)

The spec's last M3 test bullet needs the Spark's live model servers. It runs after Task 13, from a throwaway container of the M3 parsing image, with the rev-8 synthetic catalogues only; no production container is changed or restarted without the user's approval. A miss revises the plan (no code fallback) and does not block M4.

**Files:**
- Create: `docs/plans/2026-09-24-unified-durable-execution-evidence/m3-spark/extract_chunks.py` (a copy of `rev8-tests/extract_contention.py`), `run_chunks.sh` (a copy of `rev8-tests/run_extract.sh` that runs `extract_chunks.py` and mounts `~/m3-spark`), `README.md` (results), `results/`

- [ ] **Step 1: Adapt the harness** (in the copy; the rev-8 files stay as recorded)

  - `--chunks K` (default 1) applies to every mode, and `run_extraction` calls `extract(run_dir, request, chats_for(request.options), chunks=chunks)` and records `result["chunks"]`.
  - Delete the `split` mode (M3's own chunking replaces the harness's split, which restarted entry numbering and repeated the document call).
  - Add mode `pair BIG BIG2 SMALL --delay S`: two big Catalogs start together (each with `--chunks`), and the small extraction starts S seconds later in a third thread, as two `kei-extract` slots plus a waiting small extraction would behave.

- [ ] **Step 2: Run on the Spark** (from `~/m3-spark`, after building the image from the tested M3 commit as `free-parsing-m3` and copying the rev-8 `runs/` of `make_catalogues.py`)

  ```bash
  ./run_chunks.sh m3-big-unsplit alone runs/big --chunks 1
  ./run_chunks.sh m3-big-chunks4 alone runs/big --chunks 4
  ./run_chunks.sh m3-small-cat alone runs/small --strategy catalog
  ./run_chunks.sh m3-small-art alone runs/small --strategy article
  ./run_chunks.sh m3-inject-cat inject runs/big runs/small --chunks 4 --small-strategy catalog --delay 30
  ./run_chunks.sh m3-inject-art inject runs/big runs/small --chunks 4 --small-strategy article --delay 30
  ./run_chunks.sh m3-pair pair runs/big runs/big runs/small --chunks 4 --delay 30
  python3 ../rev8-tests/compare_records.py results/m3-big-unsplit.json results/m3-big-chunks4.json
  ```

- [ ] **Step 3: Judge and record**

  Pass when: the 200-entry Catalog with 4 chunks takes at most 130 s (a quarter of rev-8's 434 s, with margin; compare also with this session's unsplit run), with NuExtract's running mean near 4; each injected small extraction finishes within 15 s of its alone time (rev-8: 8.5 s Catalog, 13.8 s Article); `pair` shows how long the small extraction waits behind 8 queued requests ("about one round", spec *kei worker*); record differences between unsplit and chunked records, expected to be borderline `fundart` values only (rev-8: 19–21). Write the numbers and commands into `m3-spark/README.md`, update the M3 status line in the DBOS plan, and commit `docs(plans): record the M3 Catalog chunk measurement on the Spark`.

---

## Traceability: spec M3 → tasks and tests

| Spec item | Task | Test (file :: name) |
|---|---|---|
| `dbos` replaces Procrastinate in `pyproject.toml`/`uv.lock` | 1 (add), 10 (remove) | `test_failures.py` imports; Task 10 residue grep |
| `kei-worker worker` replaces `kei-jobs` | 3, 10, 12 | `test_worker_boot.py::test_the_worker_locks_then_reads_the_clock_then_launches_then_registers`; safety `parsing_worker.command` |
| `workflows/`: registration | 3 | `registered.py`; `test_kei_launches_in_kei_dbos_with_its_four_lanes` |
| `workflows/`: the four queues, worker == global | 2, 3, 8 | `test_the_queue_fixture_is_the_worker_configuration`; `test_kei_launches_in_kei_dbos_with_its_four_lanes`; `test_lanes.py::test_a_cancelled_step_keeps_its_lanes_slot_and_only_its_lanes` (one case per queue) |
| `convert`: prepare + resolve-models + convert steps | 5 | `test_convert_workflow.py` (all) |
| `extract` one step, same retry policy | 6 | `test_extract_workflow.py` (all); `test_failures.py::test_the_step_retry_policy_is_three_attempts_waiting_five_then_ten_seconds` |
| `deleteRuns` with the kei boot boundary | 3 (boot), 7 | `test_delete_runs.py` (all); `test_the_boot_timestamp_is_the_database_clock_before_launch` |
| Portable contracts; fixtures checked by pytest | 2, 5, 6, 7 | `test_contracts.py`; `test_the_contract_fixture_converts_through_a_portable_enqueue`; `test_the_contract_fixture_extracts_through_a_portable_enqueue` |
| `failures.py` holds `classify`; boolean `should_retry` | 1 | `test_failures.py` |
| Cooperative checks read the DBOS status | 4, 5, 6 | `test_a_cancel_stops_the_conversion_at_its_next_page_event`; `test_the_cancel_sink_checks_only_on_the_steps_own_thread`; `test_a_cancelled_catalog_stops_before_its_next_entry` |
| Parallel Catalog chunks (prelude, per-chunk `_Run`, merge) | 4 | `test_catalog_chunks.py` (equivalence, document fields once, document-wide record numbers, refusal, failed chunk) |
| Compose `NUEXTRACT_MAX_NUM_SEQS` and `KEI_CATALOG_CHUNKS`; safety asserts equal | 12 | safety `assertOwnedParsingTopology` GPU branch |
| Ingestion model inputs `model`/`layout_model`, resolved in the first step | 2, 5 | `test_an_omitted_model_is_the_listings_default`; `test_an_unknown_model_is_an_invalid_request` |
| `KEI_OCR_MODEL` on API and worker via one anchor; Studio's `KEI_EXP_MODEL` leaves Compose | 12 | safety `KEI_OCR_MODEL`, `KEI_EXP_MODEL` assertions |
| Test: listing defaults equal `convert`'s | 5 | `test_an_omitted_model_is_the_listings_default` |
| Deleted: `jobs/` except `hold_slot`; kei tables | 3 (move), 10 | Task 10 residue grep; `test_worker_boot.py` lock tests |
| Deleted: `POST /api/runs`, `GET /api/runs/{id}`, `POST …/extract` | 10 | `test_api_reads.py::test_the_submission_and_status_routes_are_gone` |
| Deleted: `DurableEmit`, `tokens.jsonl`, raw recovery SQL, worker `output.md` | 5, 10 | `test_convert_run_publishes_the_manifest_and_writes_no_worker_markdown`; smoke asserts no `output.md`/`tokens.jsonl` |
| Deleted: `runs.py` projections | 10 | residue grep (`summary_of`, `is_legacy`, `UNRECORDED`) |
| Deleted: v4 readers (`pagefile.py:228`, `_kei_exp.ts:86`), fixture as v5 | 11 | `test_a_version_4_manifest_is_refused`; Studio `refuses a version 4 manifest`; `load_result` on the rewritten fixture |
| Deleted: `options.model` branch | 11 | `test_a_legacy_single_model_is_refused` |
| Test: lanes give the same manifests as alone | 8 | `test_a_large_and_a_small_conversion_in_one_worker_produce_the_manifests_each_produces_alone` |
| Test: cancelled step keeps its lane's slot, only its lane's | 8 | `test_a_cancelled_step_keeps_its_lanes_slot_and_only_its_lanes` |
| Test: two extractions of one run | 6 | `test_two_extractions_of_one_run_each_publish_and_share_one_valid_segmentation` |
| Test: Surya `configure()` over `MODELS` | 8 | `test_every_surya_record_makes_configure_set_the_same_process_global_values` (+ the bite test) |
| Test: kill/restart | 9 | `test_a_killed_worker_is_replaced_and_its_conversion_recovered` |
| Test: SIGSTOP | 3, 9 | `test_a_killed_holder_releases_and_a_stopped_one_keeps_its_slot`; `test_a_stopped_worker_keeps_its_slot_and_gets_no_replacement` |
| Test: publication crash | 9 | `test_an_extraction_killed_after_publishing_its_artifact_recovers_to_one_artifact`; `test_a_conversion_killed_after_publishing_its_result_recovers_to_the_published_generation` |
| Test: service smoke admits through DBOS | 10 | `test_service_smoke.py` |
| Spark: 200-entry Catalog in ~¼ time; small extraction beside it | 14 | `m3-spark/` harness |
| *Queues*: deadlines from dequeue, per-page convert budget, priority | 2, 8 | `test_the_deadline_fixture_is_m0r4s_formula`; `test_a_deadline_cancels_like_a_cancel_and_the_slot_waits_for_the_step`; `test_a_deadline_counts_from_dequeue_and_is_the_enqueuers_budget`; `test_kei_extract_runs_priority_1_before_10_with_fifo_ties` |
| *Versions*: `kei@1`, `enable_patching` | 2 | `test_config_is_kei_with_patching_and_a_slot_executor` |
| *kei worker → Startup*: flock, executor `kei-<slot>`, restart recovers | 3, 9 | startup-order test; `status.executor_id == "kei-slot-1"` in the kill test |
| Ruling 2: no `parsing_db`/`parsing_migrate`/volume/API DB env; `free.mjs`; restricted URL; worker waits for Studio | 3, 10, 12 | `test_kei_launches_as_its_restricted_role_and_is_denied_on_public`; `test_the_api_process_loads_no_database_client`; safety assertions; `free.test.mjs` |
| Ruling 2: staged-PDF input contract | 2, 5 | `ConvertInput`; `test_a_source_outside_the_inbox_is_refused_before_anything_is_read` |

## Deferred to M4 and later

| Item | Goes to | Why |
|---|---|---|
| The `source-inbox` volume (Studio rw, `parsing_worker` ro) and `KEI_SOURCE_INBOX` in Compose; Studio's project/attempt staging | M4 | Studio writes it (Ruling 2); kei's side (the path contract) is done |
| `submitToKei` / `pollKei`, the kei `DBOSClient` (`applicationName: 'kei'`), lane choice (`SMALL_DOCUMENT_PAGES`, the count-only pdf.js helper), `convertTimeoutMS` in TypeScript | M4 | Studio side of the handoff; the fixtures pin it |
| node:test side of `tests/fixtures/contracts/` | M4 | Ruling 4 |
| Deleting Studio's `KEI_EXP_MODEL`/`DEFAULT_MODEL` code, HTTP kei polling, `packages/extraction`'s kei HTTP submission; reading the artifact route without a status | M4 | spec M4 *Ingestion and reprocess*, *Reads* |
| `e2e/realService.ts` and `real-service.spec.ts` rewrite; the e2e kei fake's new contract | M4 | Ruling 1 |
| `runExtraction`'s `keiRunId` attribute; cancelling kei children from Studio; late-handoff protection | M4/M6 | spec *Cancellation*, *Late handoffs* |
| Studio's `collectGarbage` that calls `deleteRuns` | M6 | spec *Deletion and garbage collection* (Studio side) |
| Pool-count measurement (kei worker + clients) | M6 verification | spec *Queues → Pools* |
| `docs/operations/deployment.md` and `local-development.md` (`FREE_PARSING_POSTGRES_PASSWORD`, `kei-jobs`, the kei role) | M6 | M2's deferral table |
| M0R 6 pending: a book near 2000 pages (memory, cut time, deadline constants), `page_source=ingest` spreads, Studio chat during kei extraction | Spark, separate | not M3 work; may revise the deadline formula |
| Per-model-call checkpoints; streaming crops into OCR | out of scope | spec *kei worker* |
