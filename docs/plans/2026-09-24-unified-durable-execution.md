# One Postgres, one job technology: FREE on DBOS

Status: approved 2026-09-24 after Codex (`gpt-6-astra`) review round 1. M0 spike done (findings below); **paused before M1 for a fresh review of the plan and of alternatives.**
Supersedes `docs/plans/2026-09-24-procrastinate-source-ingestion.md` (not
implemented).

## Context

FREE runs **three** durable job mechanisms plus one non-durable long poll. The
2026-09-24 plan would add a fourth:

| Mechanism | Where | Verified problems |
|---|---|---|
| kei Procrastinate 3.9.0 (`convert_run`, `extract_run`) | Python, `parsing_db/kei` | no cancel route; no idempotency; raw-SQL `doing→todo` recovery (`jobs/worker.py:80-101`); status LEFT JOINs job rows |
| `ExtractionJob` lease worker | TS, in the Studio web process (`packages/extraction/src/job-worker.ts`) | a Studio restart reruns from scratch and **orphans** the kei extraction, which keeps holding kei's only slot; cancel only stops Studio's polling; a 503 retry can admit a duplicate (`kei-exp.ts:276`) |
| `BatchSchemaSuggestion` pump | TS singleton (`api/_project_operations.ts`) | kicked only by HTTP handlers (including GETs); never at boot |
| Source ingestion | a 30-min polling POST (`api/source_documents.ts:337`) | not durable; the run id is never stored |

**Outcome:**
- One PostgreSQL server and one durable-execution technology (DBOS).
- Two DBOS apps, each owning its own system schema:
  - `studio` (TypeScript), in `free.dbos`;
  - `kei` (Python), in kei's own schema.
- Studio drives kei through a `DBOSClient`, using deterministic workflow ids.

All existing background work is ported **with the same behaviour**. These
things fall out of the port:
- one scheduler model;
- cancel reaches kei, and there are no orphaned runs;
- no lost handoff between a committed row and its workflow (commit, idempotent enqueue, reconcile);
- no lease loops;
- Studio orchestration survives a restart.

**What this does *not* buy:** throughput, which stays model-bound on one GPU;
and atomicity for files, HTTP artifact reads and model calls. Those stay
idempotent steps.

## Decisions (user, 2026-09-24)

1. **DBOS in both apps.** Rejected alternatives:
   - one Procrastinate with an HTTP relay;
   - Studio orchestrating a stateless kei;
   - Hatchet or Temporal;
   - Absurd;
   - a hand-rolled queue;
   - a TS port of Procrastinate's worker.
2. **Scope:** unification with the same behaviour. Follow-ups:
   - (A) the ingestion UX: 202, cards that survive a refresh, parallel uploads, cancel/retry buttons, deletion obligations, budgets;
   - (B) lanes: a native CPU lane, an extraction lane, page-class priority, queue rank.
3. **Studio workflows run in a separate `studio_worker` compose service.**
4. **Credentials move to PostgreSQL**, encrypted with `FREE_CREDENTIAL_KEY`.
5. **App-owned DBOS schemas on one Postgres server** (the Codex P0). kei's role touches only its own schema.

## Target architecture

```
db (postgres:17)  database free
  public     Studio tables incl. SourceIngestion, ModelCredential   role postgres
  dbos       DBOS app "studio" system schema                        role postgres
  kei_dbos   DBOS app "kei" system schema (or db `kei` on the same   role kei (owner; nothing else)
             server if dbos-py cannot name a schema — M0)

migrate          Studio image, one-shot: Prisma Next migrate -> studio DBOS schema -> kei role + schema
parsing_migrate  kei image, one-shot: kei DBOS schema migration (as kei)
studio           web. Enqueues Studio workflows in its domain transactions; best-effort cancels
studio_worker    DBOS app "studio" + DBOSClient(kei): ingestSource, reprocessSource,
                 runExtraction, suggestSchemaBatch, reconcile, sweepInbox, retention
parsing_service  kei API: artifacts + model catalogs; no database
parsing_worker   DBOS app "kei": convert, extract on queue "kei" (concurrency 1, FIFO); flock'd slot
volumes: source-inbox (new; studio rw, studio_worker rw, parsing_worker ro) + existing
```

**Rules**

1. **Execution state lives in DBOS; outcomes live in domain rows.**
   - Every operation has a Studio row (`SourceIngestion`, `ExtractionJob`, `BatchSchemaSuggestion`), which is the outcome authority.
   - Code reads DBOS state only for *non-terminal* rows: the reconciler, and progress.
2. **Workflow inputs are ids of committed rows.**
   - Studio workflows take the row id, plus an attempt number where relevant.
   - Step 1 re-reads the row and exits if it is missing or already terminal.
   - Credentials and research content never enter Studio workflow payloads.
3. **Deterministic, attempt-scoped workflow ids.** `ingest:<ingestionId>`, `extract:<jobId>`, `suggest:<batchId>:<attempt>`, `kei-convert:<ingestionId>`, `kei-extract:<jobId>`.
4. **Commit, then enqueue; the reconciler relays** (user decision after M0 item 6: Prisma Next 0.16 cannot run `dbos.enqueue_workflow` inside its transactions).
   - The web handler commits the domain row, then calls `DBOSClient.enqueue` with the row's deterministic workflow id. M0 proved re-enqueueing an existing id is a no-op in every state.
   - If the process dies between the two, `reconcile` enqueues every non-terminal row that has had no workflow for 30 s. The worst case is about a minute of delay after a crash.
   - `server/dbos.ts` is the only module that enqueues or cancels. There is no SQL adapter, and nothing depends on the `dbos.enqueue_workflow` signature.
   - Handing work to kei is an idempotent step. No transaction crosses the two apps.
5. **An explicit cross-language contract.**
   - kei workflows take and return portable JSON, with `{ok: true, …} | {ok: false, code, reason, retryable}`. Timestamps cross as ISO-8601 strings (a Python `datetime` arrives as one; M0 item 11).
   - Exceptions mean crashes.
   - Fixtures in `prototypes/parsing_service/tests/fixtures/contracts/` are checked by both pytest and node:test.
6. **The acceptance boundary is Studio's commit.**
   - kei artifacts become visible only when a Studio transaction commits under the operation's row lock, after re-checking status, ownership and the reprocess head.
   - kei's in-conversion cancel checks only save compute. kei keeps today's fail-open post-conversion policy (`jobs/tasks.py:156`).

### Queues (same behaviour as today)

| App | Queue | Limit | Workflows | Parity note |
|---|---|---|---|---|
| kei | `kei` | global 1, FIFO | `convert`, `extract` | today's single slot; today's queue is FIFO across parse and extraction, so no kei-side priority |
| studio | `studio-extract` | global 1, priority (interactive 1, batch 10; FIFO ties) | `runExtraction` | today one worker claims INTERACTIVE before BATCH_MEMBER, oldest first (`postgres-persistence.ts:1075`); the timeout starts at dequeue, i.e. at "claim" |
| studio | `studio-ingest` | none | `ingestSource`, `reprocessSource` | the browser still serializes uploads |
| studio | `studio-suggest` | global 1 | `suggestSchemaBatch` | the same as the one pump |
| studio | scheduled | — | `reconcile` (every minute), `sweepInbox` (daily), `retention` (daily) | new backstops |

kei's admission cap of 32 (`jobs/store.py:207,321`) is dropped. With Studio
submitting one extraction at a time and the browser submitting one upload at a
time, kei's queue can't grow unbounded. Budgets belong to follow-up A.

### Workflows

**`kei.convert(request)`** (dequeued FIFO)
- `run_id` is derived from the workflow id and the request's `created_at`, so a replay reuses the same directory.
- Steps:
  1. `prepare`, idempotent: create the run directory, copy and verify `source-inbox/<file>` → `input.pdf`, write `params.json`, and validate the size, page count ≤ 2000 and the page range.
  2. `convert`, **one step**: model probe, `ocr.resolve`, `kie.runner.convert`, `output.md`. A replay re-probes and re-resolves, which fixes the stale-checkpoint finding. `should_retry` = `classify`, moved to `kei_exp/failures.py` (it imports `store.Unavailable` today, `tasks.py:61`). Up to 3 executions, backing off from 5 s, like today's `RetryStrategy`.
  3. Return `{ok, run_id, generation, page_count, source_sha256, page_source}`, with the generation read from the published manifest.
- A crash after publication but before the checkpoint republishes a newer generation, atomically. Studio finalizes only the generation returned by the completed workflow.
- Cancel checks sit between pages (best-effort).

**`kei.extract(request)`**
- **One step**: manifest `success`, the generation pin (`StaleGeneration`), model and recipe checks, `kie/extract/run.py:extract`, then publish the artifact.
- Returns `{ok, artifact: {path, sha256}, models}`.
- Cancel checks sit between records.
- It works on legacy run directories: it reads only files, never `kei_run`.

**Studio → kei handoff steps**, shared by the ingest and extraction workflows
- `submitToKei`: re-check that the row is still RUNNING (a cancelled operation never admits a child), then `keiClient.enqueue` with the deterministic id and portable args. Idempotent (M0).
- `pollKei` in a loop: each step waits at most 30 s on `retrieveWorkflow(id).getResult()`. A Studio cancel or timeout therefore takes effect within 30 s, and a Studio restart just re-polls.
- If kei ended CANCELLED, ERROR or MAX_RECOVERY, the step maps that to a typed failure.

**`studio.runExtraction(jobId)`** replaces `ExtractionJobWorker`.
- Steps: `start` (RUNNING, `startedAt`), then `submitToKei`, then `pollKei`, then `complete`.
- `complete`: GET the artifact from kei; validate it with the `kei-exp.ts` validation; then, in a transaction that takes a `FOR UPDATE` row lock and requires the row to be RUNNING, insert the `Extraction` and set COMPLETED. Otherwise discard.
- Typed failures run `fail()` with today's codes.
- Timeout: 10 min for Article, 3 h for Catalog (`job-worker.ts:143-149`), passed as `workflowTimeoutMS` (`timeoutMS` is silently ignored; M0 item 7).

**`studio.suggestSchemaBatch(batchId, attempt)`** replaces the pump, keeping its semantics (`_project_operations.ts:74-253`).
- One step per unfinished source. It **continues after an individual source fails** and records that failure.
- Then `merge`, with its own model timeout.
- The batch FAILS if any source failed.
- Retry, in the existing handler: one transaction runs `attempt += 1`, resets only unfinished sources (`project-store.ts:1796`) and enqueues `suggest:<batchId>:<attempt>`.
- The worker reads model configuration and credentials fresh in each step.

**`studio.ingestSource(ingestionId)` / `reprocessSource(ingestionId)`** replace the in-request poll. The web handler:
1. Validates as today: MIME, magic bytes, 100 MiB, ownership.
2. Stages the PDF into `source-inbox` (temp file, then atomic rename).
3. In **one transaction**, finds the latest `SourceIngestion` attempt for `(project, kind, key)`:
   - a different fingerprint gives **409** (today's `IngestionKeyConflictError`; the reprocess fingerprint stays `source_reprocess.ts:71`);
   - a non-terminal attempt is joined;
   - SUCCEEDED gives today's replay response (**201** for an upload, **200** for a reprocess replay);
   - FAILED inserts attempt n+1 and enqueues it (like today's retry, which submits a new kei run).
4. Awaits the workflow with a 30-min cap.
5. Maps the result through today's full response matrix: 201/200/400/404/409/413/422/502/503/504, the error codes, and the `no-store` headers.

The workflow:
1. `start`.
2. `submitToKei`, then `pollKei`.
3. `finalize`: fetch the manifest and pages, verify (`_kei_exp.ts:189-211`, `:477-497`), translate, and pack and save (`artifact-store.ts:151,232`). Then run `store.ingestSourceDocument` / `reprocessSourceDocument` in a transaction that locks the `SourceIngestion` row and sets SUCCEEDED with the result ids. That transaction also re-checks ownership and the expected head (`project-store.ts:1595`). A lost race discards the package, as today (`source_documents.ts:682`, `source_reprocess.ts:133`).
4. `cleanupInbox`.

Content-hash dedup across keys stays inside the store (`project-store.ts:1430`).

**Intentional behaviour change:** a timed-out request (504) no longer stops the
work, so the Source Document can appear later. Update the timeout case in
`source_documents.test.ts:766` accordingly; every other handler assertion stays.

### Cancellation, terminal outcomes, recovery

- **Extraction cancel** (`DELETE /api/extractions/:id`, INTERACTIVE only, as today).
  - One transaction sets QUEUED or RUNNING → FAILED `cancelled` and records `cancelRequestedAt`. This is the same end state as today, reached sooner.
  - After the commit, best-effort `cancelWorkflow` on `extract:<id>` and `kei-extract:<id>`.
  - `complete()` refuses a row that is no longer RUNNING.
- **`studio.reconcile`** (scheduled, single instance) is the backstop for every engine-terminal path. It scans only non-terminal rows and active kei workflows:
  0. A non-terminal row with no Studio workflow after a 30 s grace is enqueued under its deterministic id (the commit-then-enqueue relay, Rule 4).
  1. A non-terminal row whose Studio workflow ended CANCELLED, ERROR, timeout or MAX_RECOVERY is set to FAILED with a typed code (`timeout`, `interrupted`, `recovery_exhausted`).
  2. A Studio workflow that is PENDING or ENQUEUED but whose row is terminal or deleted is cancelled.
  3. A kei workflow that is ENQUEUED or PENDING (via `keiClient.listWorkflows`) whose owning row, parsed from its id, is terminal or missing is cancelled.
  4. It never deletes anything, and a DB error skips the tick.
- **Deletion.** Project and source cascades delete the operation rows. Running workflows then find no row at their next step and exit, discarding staged packages. The reconciler cancels their kei children.
- **`sweepInbox`** deletes inbox files older than 24 h that no non-terminal `SourceIngestion` references. It deletes nothing if the reference query fails.
- **kei worker.**
  - It takes a flock on `runs/.worker-<slot>.lock` before `DBOS.launch()` and holds it for its lifetime. It reuses `hold_slot` (`jobs/worker.py:42-57`). SIGSTOP keeps ownership.
  - Its executor id is fixed at `kei-<slot>`, and a restart recovers its PENDING workflows.
  - This replaces `reconcile` and the raw SQL.
- **studio_worker.** Executor id `studio-worker`, one replica, `restart: unless-stopped`.
- **Versions and retention.**
  - `applicationVersion` is pinned per app (`studio@1`, `kei@1`). Bump it for any replay-affecting change to a workflow's code or its contract, and a bump requires draining that app first.
  - The `retention` workflow removes DBOS workflow rows older than 30 days in both schemas. The window must be longer than the longest workflow (3 h).
  - Pool sizes are capped: 5 each for the Studio DBOS pool, the kei client, the web and kei. That keeps the total well under `max_connections`.

### Credentials

- **Storage.** `public.ModelCredential(connectionId, revision, ciphertext, iv, authTag, createdAt)`, PK `(connectionId, revision)`, AES-256-GCM.
  - A random 12-byte IV per write; AAD = `connectionId:revision`.
  - The key is `FREE_CREDENTIAL_KEY` (64 hex characters), given to `studio` and `studio_worker` only.
- **Consistent snapshot** (the Codex split-store finding).
  - Every connection in `model-config.json` names its `credentialRevision`.
  - Apply order: insert the new revision, then write the config naming it, then delete the superseded revisions.
  - Readers resolve the revision named by the config they read.
  - An earlier config shape fails closed and offers the confirmed reset, as today.
- **Interface.**
  - `CredentialStore` (`api/_keyring.ts`) keeps its interface; the new implementation is `api/_credentials.ts`.
  - A wrong key or tampered ciphertext gives `503 credential_store_unavailable`, logged with a distinct reason, and replaces `keyring_unavailable` everywhere.
  - Rotation is out of scope: re-enter the credentials.
- **Removed:** `@napi-rs/keyring`, `dbus-daemon`, `gnome-keyring`, and the entrypoint unlock plus the `XDG_RUNTIME_DIR`/`DBUS_*` variables.

## Milestones

One branch and one cutover, with no temporary adapters. Each milestone ends
with its test tier green.

**M0: throwaway spike (gate).**
- Setup: in the scratchpad, against a disposable loopback `free_test_dbos_spike`, with `@dbos-inc/dbos-sdk@5.0.2` (Node 24) and `dbos==3.0.0` (Python 3.13), also run inside the ARM64 kei image.
- Verify:
  1. A TS `DBOSClient` pointed at kei's schema enqueues a portable Python workflow. Re-enqueueing the same id while ENQUEUED, PENDING, SUCCESS, ERROR or CANCELLED behaves predictably, and a named-args call works (`enqueueWorkflowWithOptionsPortable`).
  2. Bounded `getResult` polling inside a step; cancelling the awaiting Studio workflow takes effect within one poll.
  3. Killing the kei worker mid-step, then restarting it with the same executor id, re-runs that step. The flock blocks a second process.
  4. Dbos-py either supports a custom system schema name (`kei_dbos`) or needs a separate database.
  5. A step whose side effect committed (a Prisma write, a rename, an enqueue) before its checkpoint is re-executed on replay (at-least-once).
  6. `dbos.enqueue_workflow` through Prisma Next `raw` inside `database.transaction`: rollback, commit, a duplicate id, and parameters for portable args, app name, version, priority, timeout and dedup.
  7. Timeouts start at dequeue and survive a restart. Priority direction and FIFO ties hold across recovery.
  8. Recovery is scoped per app and executor.
  9. The `kei` role can launch, owns only its schema, and is denied on `free.public` and `free.dbos`.
  10. The retention/GC API exists in both SDKs.
  11. Portable JSON works for Python dates, optional fields and multi-MB results.
  12. A wrong-version startup fails safely.
  13. Connection counts per process are as budgeted.
- Any failure: stop and bring it to the user. The fallback is one Procrastinate with an HTTP relay.

**M1: platform.**
- **Compose** (`compose.yaml`, `compose.override.yaml`, `compose.prod.yaml`, `compose.gpu.yaml`):
  - remove `parsing_db` and `parsing-postgres`;
  - repurpose `parsing_migrate`;
  - add `migrate`, `studio_worker` and `source-inbox`;
  - all apps depend on both migrate services;
  - `parsing_service` loses its database environment variables and the `kei-jobs schema &&` entrypoint.
- **`studio_worker`** gets:
  - `extra_hosts host.docker.internal:host-gateway` (`compose.yaml:132`);
  - the deployment-model environment from the GPU overlay;
  - `CLAUDE_CODE_OAUTH_TOKEN`;
  - the `studio-data`, `studio-config` (`CODEX_HOME`) and `studio-claude` volumes;
  - no proxy network and no published ports.
- **Migrate:**
  - move `db:init` out of `docker/studio-entrypoint.sh`;
  - create the `kei` role and schema idempotently with a `DO` block. The password comes from `FREE_PARSING_POSTGRES_PASSWORD`, renamed `FREE_KEI_POSTGRES_PASSWORD`.
  - Migrate reruns on every `up`, and a failed migrate blocks every app.
- **`scripts/free.mjs`:**
  - `studio_worker` joins the stop and restart handling (`:445-462`);
  - keep build-before-stop;
  - wait on the readiness of both workers;
  - `FREE_CREDENTIAL_KEY`: dev uses a fixed value; prod requires 64 hex characters (like `:547`);
  - password renames.
- **`packages/db`:**
  - `contract.prisma`: add `SourceIngestion` (project FK with cascade, kind, key, attempt, fingerprint, input fields, reprocess target and expected representation, status, failure, result ids, timestamps; unique `(projectContextId, kind, key, attempt)`) and the revisioned `ModelCredential`;
  - drop the `ExtractionJob` lease and checkpoint columns and claim indexes, and the `BatchSchemaSuggestion` lease columns;
  - add a `BatchSchemaSuggestion.attempt` column.
  - A new migration after `20260923T1946_source_reprocessing` marks non-terminal jobs and batches FAILED with code `platform_cutover` and `retryable`.
  - Regenerate the artifacts, and fix the stale `migrations/app/refs/db.json`.
- **Credentials:**
  - `api/_credentials.ts`, then update every caller and test: `_provider.ts`, `_model_config.ts` (plus the credential revision in the config shape), `model_probe.ts`, `_model_config.test.ts`, `model_probe.test.ts`, `e2e/model-configuration.spec.ts`;
  - remove the Dockerfile packages and the dependency, and update `pnpm-lock.yaml`.
- **Safety tests** (`tests/safety.test.mjs:155,168-185,232,258`):
  - kei's URL points at `kei@db`;
  - `studio_worker` isolation;
  - no database environment variables on `parsing_service`;
  - prod requires the key, and a wrong key fails at startup;
  - migrate rerun behaviour.

**M2: kei on DBOS.**
- **Dependencies and packaging:**
  - `pyproject.toml` + `uv.lock`: `procrastinate` → `dbos==3.0.0`;
  - the `kei-jobs` entry point becomes `kei-worker` (`worker`, `migrate`);
  - update `prototypes/parsing_service/package.json:12-13`.
- **New `src/kei_exp/workflows/`:**
  - `app.py`: config, queue, executor id, version, schema;
  - `convert.py`, `extract.py`;
  - `contracts.py`: pydantic models matching the fixtures.
- **New modules:**
  - `src/kei_exp/worker.py`: flock, then `DBOS.launch()`, listening to the `kei` queue only;
  - `src/kei_exp/failures.py`: `classify`.
- **Pipeline threading:** a `should_stop()` callback through `kie/runner.py`, `kie/stages/ocr.py`, the transcription loops and the Catalog record loop. Progress goes through `DBOS.set_event("progress", …)` from the existing emit points.
- **Delete:**
  - `src/kei_exp/jobs/`;
  - `tokens.jsonl` and SSE;
  - the `kei_*` tables;
  - the legacy file-only runs in `runs.py`.
- **`api.py`:**
  - drop the admission, status, list, SSE and extraction admission/status routes;
  - keep the artifact and catalog routes;
  - add `GET /api/runs/{id}/extractions/{xid}/result`.
- **Tests:**
  - replace `test_jobs_*` and `test_api_jobs.py` with `test_workflows_{convert,extract}.py`, `test_worker_recovery.py` (kill/restart, SIGSTOP, a crash after publication before the checkpoint), `test_contracts.py`, and `test_legacy_run_extract.py` (an extraction on a pre-cutover run directory fixture);
  - rewrite `tests/test_service_smoke.py:221,285` to use workflows instead of `POST /api/runs` and SSE;
  - keep the `free_test_parsing_*` guard.

**M3: Studio worker and extractions.**
- **New `prototypes/studio/server/worker.ts`**, with a build entry point: config, stores, provider runtime, registration of the workflows and schedules, `DBOS.setConfig` (name, executor id, version, `systemDatabaseSchemaName: 'dbos'`, `listenQueues`, pool size), plus the `keiClient`. `DBOS.shutdown()` on SIGTERM.
- **New `server/dbos.ts`:** the web's `DBOSClient`, `enqueueAfterCommit(workflow, id, args)` and best-effort cancel.
- **New `packages/extraction/src/workflows.ts`** (`runExtraction`) and a shared `kei-handoff.ts` (`submitToKei`, `pollKei`).
- **Host wiring:** `server/host.ts:62,110-116` and `server/developmentHost.ts` lose the runtime. In dev, `studio_worker` runs under tsx `--watch`.
- **`postgres-persistence.ts`:** `scheduleInteractiveExtraction`, `scheduleBatch` and `postgres-suggested-batch.ts` return the committed ids, and their callers enqueue after the commit. Delete `claim`/`renew`/`checkpoint` (`:1075-1236`). `complete` gains the lock and the RUNNING guard.
- **`kei-exp.ts`:** keep the catalog GET, the artifact GET and the validation; delete POST and polling.
- **Delete:**
  - `job-worker.ts`;
  - the `runtime.ts` wake;
  - `api/_extraction_runtime.ts`, after re-homing the exports its importers use: `api/extraction_models.ts`, `api/document_reopen.ts`, `api/batch_schema_suggestions.ts`, `api/extractions.ts`, `api/batch_extractions.ts`.
- **Tests:** update `_extraction_runtime.test.ts` (removed), `extractions.test.ts`, `batch_extractions.test.ts`, `durable_operations.test.ts`, `extraction_models.test.ts`, `server/researcher-project-ownership.test.ts` and `vite.config.test.ts`.

**M4: Schema-suggestion batches.**
- **New `prototypes/studio/workflows/suggestSchemaBatch.ts`.**
- **Delete** the pump and every `kick()` (`batch_schema_suggestions.ts:136,149,168,266`). Reads never start work any more.
- **Simplify** `createInternalProjectWorkerStore` (`project-store.ts:2090-2292`) to plain domain functions.

**M5: Ingestion and reprocess.**
- **New `workflows/{ingestSource,reprocessSource}.ts`**, plus a `source-ingestion-store.ts` in `packages/db`.
- **Move** verify/translate/package (`source_documents.ts:393-581`) into shared functions.
- **Handlers** (`source_documents.ts:583-698`, `source_reprocess.ts`): stage, transact, await and map. Delete `submittedRun`, `completedRun` and `parsingRequest`.
- **Unchanged:** the browser machine and the transport.

**M6: Docs, test wiring, CI.**
- **New ADR** `docs/adr/0012-one-durable-execution-layer.md`, recording the decisions and the rejected options, and the plan copy. Mark the Procrastinate plan superseded.
- **Update:**
  - `README.md`: contract #7 and #10, and the extraction-execution section (cancel now reaches the service);
  - `docs/operations/{deployment,local-development}.md`: the backup set is the `free` dump + `parsing-runs` + `studio-data` + `studio-config` + `studio-claude`, with the credential key held separately. Also: reset wipes workflow state; the version/drain rule; `dbos workflow list`; the cutover runbook.
  - `docs/architecture/current.c4` and its README, `prototypes/parsing_service/{README,CLAUDE}.md`, and `job-backend.md` (mark it superseded);
  - the openspec `durable-extraction-jobs` text.
- **Test wiring:**
  - `e2e/realService.ts:150-231`, `playwright*.config.ts`, `e2e/playwrightWebServer.ts`, `playwrightStack.ts` and `playwright.compose.yaml` start migrate and both workers where specs need background work;
  - wire `source-reprocessing.postgres.check.ts` into `packages/db/package.json:13`;
  - `.github/workflows/verify.yml` and `scripts/test-ci.mjs` migrate both DBOS schemas into the test databases.

## Verification

- **Checks:** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:safety`.
- **`pnpm test:postgres`:**
  - the `SourceIngestion` replay matrix: same key with different bytes gives 409; a different key with the same bytes dedups; a reprocess fingerprint mismatch; concurrent retries; a replay after deletion;
  - commit-then-enqueue: a rolled-back row is never enqueued; a crash between commit and enqueue is picked up by `reconcile` within one tick; a double enqueue runs once;
  - cancel racing `complete`;
  - interactive before batch with FIFO ties;
  - suggestion parity: it continues after a source fails; retry keeps completed sources; the merge timeout;
  - reconciler rows 1–3;
  - kei's negative permissions;
  - credential revision snapshots, and wrong-key/tamper;
  - the Parsing Service workflow, recovery and legacy-run tests.
- **`pnpm test:e2e`** and **`pnpm test:service`** (real kei worker plus Studio web and worker):
  1. a native PDF parses end to end with unchanged Evidence;
  2. killing `parsing_worker` mid-convert, then restarting it, publishes the returned generation, and Studio commits one Source Document;
  3. killing `studio_worker` while it polls, then restarting it, produces no second kei extraction;
  4. cancel stops kei, and no orphan holds the slot;
  5. cancel before `submitToKei` never enqueues kei;
  6. a request dropped mid-parse still commits;
  7. a deleted project cancels its kei work within one reconcile tick.
- **Manual:** `pnpm dev` through upload, refresh, extraction, cancel, and a suggestion batch; `dbos workflow list` against both schemas.

## Rollout (cutover runbook)

1. **Build the new images.** The old stack keeps serving.
2. **Stop `studio`.** This is the admission fence: it stops the web, the old in-process extraction worker and the pump. In-flight long POSTs die, and their kei runs finish unreferenced.
3. **Wait until Procrastinate has no `todo` or `doing` jobs**, then stop the parsing API and worker.
4. **Back up:** `pg_dump` both `free` and `kei`, plus the volumes.
5. **`up` the new stack.** Migrate marks the leftovers `platform_cutover`.
6. **Verify:** an extraction on a pre-cutover document; re-enter the Model Connection credentials.
7. **Rollback:** the old images, a restore of the `free` dump, and the retained `parsing-postgres` volume. Delete that volume only after verification.

## Risks

- **DBOS cross-language maturity and at-least-once steps.** Gated by M0; every step is idempotent by design, and both SDK versions are pinned and upgraded together.
- **One server shares resources with authentication and review.** Mitigated by pool caps and retention, with DBOS polling measured in M0.
- **Credential re-entry at cutover.** Losing the key means re-entering the credentials.
- **Shared CLI homes between `studio` and `studio_worker`:** watch for token-refresh races.
- **Native Docling conversion is still one uninterruptible call:** stopping the worker is the documented escape.

## Out of scope (follow-ups)

- **A:** the ingestion UX on top of `SourceIngestion`: 202, hydration, parallel uploads, cancel/retry UI, deletion obligations, budgets.
- **B:** lanes (`kei-native`, `kei-ocr`, `kei-extract`), page-class priority, queue rank.
- **Page- and record-level steps.** Resume *inside* a conversion or Catalog run; today and after this plan, a crash reruns the step.
- **Existing bug:** extraction retry jobs throw `invalid_retry` (`module.ts:198`).

## M0 findings (2026-09-24)

The spike ran on x86_64 against a throwaway `postgres:17`. It used
`@dbos-inc/dbos-sdk@5.0.2` (Node 24.21) and `dbos==3.0.0` (Python 3.13). The
code stays in the session scratchpad and is not kept.

| # | Result | Evidence |
|---|---|---|
| 1 | Pass | The TS client enqueues portable Python workflows, both positional and keyword-only (`enqueuePortable(opts, [], {tag})`). **Re-enqueueing an existing id is a no-op in every state:** SUCCESS and ERROR are not rerun, PENDING and ENQUEUED run once, and CANCELLED stays cancelled. So retries need attempt-scoped ids, as planned. |
| 2 | Pass | A Studio workflow awaits kei through bounded `pollKei` steps. After a Studio cancel, no poll ran later than 1.5 s. The cancel does **not** cascade to the kei workflow, which stayed PENDING; this confirms the explicit cancel and the reconciler. Killing Studio mid-poll resumes it, and kei executes once. |
| 3 | Pass | Killing kei mid-step, then restarting it, re-executes that step (2 executions, `recovery_attempts=2`) and the workflow succeeds. A second process gets `SLOT_TAKEN` from the flock. |
| 4 | Pass | `dbos_system_schema: "kei_dbos"` works. The `kei` role migrates and owns only its schema. |
| 5 | Pass | A step whose side effect ran before its checkpoint is re-executed after a kill, so steps are at-least-once. |
| 6 | **Partial** | `dbos.enqueue_workflow` exists in both schemas. In a plain `pg` transaction, a rollback leaves nothing, a commit enqueues (priority, timeout, `portable_json`), and a duplicate id is idempotent. **But Prisma Next 0.16's `raw` tag only builds typed expressions** (`raw\`…\`.returns(codec)`). I found no public way to run this statement inside `database.transaction`. |
| 7 | Pass | Priority 1 runs before 10, and FIFO ties hold after a restart. The TS option is **`workflowTimeoutMS`**; `timeoutMS` is silently ignored. The timeout starts at dequeue and is enforced at the next step boundary (4 s → cancelled at +5.0 s with 1 s steps). The **absolute deadline survives a restart** (cancelled at +4.9 s); a recovered workflow returns to ENQUEUED. |
| 8 | Pass | No kei rows appear in `free.dbos`, and the Studio process never ran kei work. |
| 9 | Pass | The `kei` role is denied (42501) on `public` tables, on `dbos.workflow_status` and on `CREATE` in `public`. |
| 10 | Pass (no built-in) | The CLI has no retention command and `garbage_collect` is internal. The retention workflow uses the public `listWorkflows` (terminal, older than the cutoff) and `deleteWorkflows` on both schemas. |
| 11 | Pass | A 5 MiB result with nulls round-trips in about 1 s. **A Python `datetime` arrives as an ISO string**, so the contract declares ISO strings. |
| 12 | Pass | A `kei@1` workflow stays ENQUEUED under a `kei@2` worker. A worker with `run_migrations: false` refuses to start on an unmigrated schema ("requires 114"). |
| 13 | Pass | Connections per process: the kei worker holds 4, and the Studio worker 3 plus 1 per client pool. |
| ARM64 | Packaging only | The TS SDK is pure JS. `greenlet`, `sqlalchemy`, `psycopg-binary` and `pyyaml` have `cp313` aarch64 manylinux wheels. The runtime check on Spark happens at deploy. |

## Review log

- **2026-09-24, Codex `gpt-6-astra` read-only review of the first draft:** 1 P0, 12 P1, 1 P2.
  - **P0 (kei's DML on a shared `dbos` schema could rewrite Studio checkpoints):** resolved by the user's decision for app-owned schemas on one server.
  - **Accepted:**
    - the reconciler, and terminal outcomes written by the web and the reconciler;
    - a minimal `SourceIngestion` row;
    - attempt-scoped ids;
    - fingerprint conflicts;
    - deterministic run ids with one-step convert/extract (no stale probe checkpoint);
    - Studio's commit as the acceptance boundary, keeping kei's fail-open gate;
    - `studio-extract` at concurrency 1 with priority, and a FIFO kei queue;
    - late success as an explicit change, with the full status matrix;
    - deletion and sweeper rules;
    - credential revisions;
    - the cutover fence and rollback;
    - the missing importers, callers, tests, lockfiles, Playwright stack, worker environment and launcher;
    - 13 M0 questions.
  - **Answered rather than changed:**
    - "one server does not require one schema" (adopted);
    - the throughput gain (none claimed);
    - atomicity limits (stated);
    - the backup wording (fixed).
