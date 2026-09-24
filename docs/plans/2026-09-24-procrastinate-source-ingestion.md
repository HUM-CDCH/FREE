# Procrastinate-backed Source Document ingestion

**Superseded (not implemented) by
[2026-09-24-unified-durable-execution.md](2026-09-24-unified-durable-execution.md):**
one Postgres and one job technology (DBOS) replace the two Procrastinate
schemas proposed here.

Date: 2026-09-24. Claude (Opus 5.5) and Codex (gpt-6-astra) wrote independent
drafts, which were merged using the user's decisions and cross-reviewed. This
replaces [2026-09-23-durable-source-ingestion.md](2026-09-23-durable-source-ingestion.md),
whose Studio TypeScript lease loop is rejected below.

## Problem

1. While one large PDF parses, nothing else gets parsed.
2. Refreshing the Project page makes the in-progress parse disappear.

Causes (verified, see the superseded plan for detail):
- **The browser runs one upload at a time.** `sourceIngestionMachine` is a
  single in-memory queue that handles one item at a time
  (`prototypes/studio/src/sourceIngestionMachine.ts:145`).
- **Nothing durable tracks the run.** Studio holds the kei run only inside a
  POST that polls for up to 30 minutes (`api/source_documents.ts:337`). The
  run id is never stored.
- **The Parsing Service runs one job at a time.** It has one worker, one queue
  and `concurrency=1` (`jobs/worker.py:145`), with no cancel route.

## User decisions (2026-09-24)

- **Studio's side runs on Procrastinate too.** A Studio-side Python worker with
  its own Procrastinate schema in Studio's `free` database. Its tasks run
  one-shot Node commands, so TypeScript keeps Studio's domain rules.
- **Native lane for all native PDFs.** Born-digital PDFs are parsed on a CPU
  lane (small documents first), separate from the GPU OCR lane.

## Topology and boundaries

- **Two PostgreSQL servers.** Studio uses `db/free` and kei uses
  `parsing_db/kei` (`compose.yaml:43`, :60). Dev and prod keep them separate
  (`compose.override.yaml:23`, `compose.prod.yaml:22`).
- **Each side owns its own Procrastinate schema.** There are no transactions
  across the two databases and no SQL access across them. kei is reached only
  over its HTTP API. Studio never reads kei's `procrastinate_jobs`.
- **Studio's API queues jobs by calling `procrastinate_defer_jobs_v1` directly
  in SQL**, in the same transaction that inserts the operation row. The
  function takes one argument, `procrastinate_defer_jobs_v1(jobs
  procrastinate_job_to_defer_v1[]) RETURNS bigint[]`. The composite type's
  field order is `queue_name, task_name, priority, lock, queueing_lock, args,
  scheduled_at` (`schema.sql:48`, :118). This ties Studio to one schema
  version, so it goes through one narrow adapter module. Its tests check the
  typed-array call, the field order and how the returned id is read, pinned to
  that version.
- **LISTEN/NOTIFY is only for waking workers.** Persisted rows are the
  authority. Library events hold only job id, type and time
  (`schema.sql:90–95`), so they are not a progress feed.

## What Procrastinate replaces, and what stays custom

| Concern | Uses | Custom (and why) |
|---|---|---|
| Execution lifecycle | job status `todo/doing/succeeded/failed/cancelled/aborted` | Studio keeps *domain* completion: the Source Document and the receipt |
| Cancel queued / running | `procrastinate_cancel_job_v1` SQL (`abort=True`) + `should_abort()` | `JobManager.cancel_job_by_id` has no `connection=` (`manager.py:350`), so the SQL function is called inside the domain transaction |
| Retry / backoff | `RetryStrategy` on classified transient errors | "Parser still running" is an observation, not a failure, so it never uses up a retry. Note: `max_attempts=2` means 3 executions (`retry.py:194`) |
| Priority | `priority=` at defer (fetch order is `priority DESC, id ASC`, `schema.sql:248`) | Priority classes are chosen by the server, never by the client |
| Lane moves | The task raises `JobRetry(RetryDecision(queue=other))`, and the worker makes the only state transition | Never call `JobManager.retry_job` from inside the running task: `finish_job` accepts `todo`, so the worker would then mark the moved job succeeded (`schema.sql:264`) |
| Reconcile / sweep | Periodic tasks with a stable id, an execution `lock`, a `queueing_lock` to bound the backlog, and a `timestamp` argument. Deduplication is per task + id + tick, not per execution | Each sweep reads the full outstanding state with fair pagination, so a missed tick loses nothing (`periodic.py:200–240`) |
| Job-row retention | none in these phases | Builtin `remove_old_jobs` has no domain filter, and run and extraction status left-join job rows (`jobs/store.py:240`, :345). Pruning would turn retained results into `unknown`. Not scheduled until pruning excludes domain-linked jobs |
| Idempotency | `queueing_lock` as a second safeguard only | `submission_key → run` mapping, because `queueing_lock` covers only `todo` jobs (`schema.sql:99–102`) |
| Ownership, revisions, deletion | none | Domain rules the queue knows nothing about |
| Progress details, token replay | none | Not present in `procrastinate_events` |
| File safety | none | The flock supervisor. Database locks don't fence filesystem writers (`job-backend.md` "file fence") |

**kei bookkeeping to remove now:**
- `kei_run.cancel_requested`, replaced by Procrastinate's abort/status state.
- `kei_run.finished` and the custom terminal events as a second completion
  authority. Status is projected from job status instead.

**Keep:** `kei_run` (parameters, source identity, slot, artifacts), progress
events and tokens.

**Later, separately validated:** folding `kei_run_job` and `kei_attempt` into
job references.

## Phase 1: Parsing Service primitives (existing Studio keeps working)

Files: `K/api.py`, `jobs/{schema,store,tasks,worker}.py`, `runs.py` (`K/` =
`prototypes/parsing_service/src/kei_exp/`). Existing runs must keep working
across the schema change.

1. **Replayable admission.**
   - A `submission_key` and fingerprint are committed together with the run and
     its deferred job (the admission transaction already exists,
     `jobs/store.py:205–221`). The fingerprint covers the source sha256 and the
     normalized settings.
   - Same key and same fingerprint returns the existing run in any state, and
     this is checked *before* the capacity check. A different fingerprint
     returns 409.
   - Also pass `queueing_lock` as a second safeguard.
   - Add lookup and cancel by `submission_key`, plus a **revocation tombstone**.
     This covers a cancel that arrives before the submission's acknowledgement.
   - When an acknowledgement is lost, the staged bytes are never deleted
     (`api.py:253`).
2. **One admission budget.** Runs and extractions count the same unfinished
   jobs (`jobs/store.py:207` vs :322).
3. **Cancellation through Procrastinate.**
   - `POST /api/runs/{id}/cancel` and `…/by-key/{key}/cancel` call the cancel
     SQL function inside the domain transaction.
   - Pass an abort callback down through `kie/runner.py`, cutting, OCR and
     transcription, checking between pages.
   - **Gate before canonical publication inside OCR** (`kie/stages/ocr.py:179`),
     not just before `output.md`.
   - `should_abort()` reads cached worker state (`job_context.py:71`). The final
     gate re-reads the authoritative job row, and an unreachable database means
     "don't publish". This replaces the fail-open check at `tasks.py:156`.
   - Native conversion is one Docling call for the whole document
     (`native.py:215`), so the escape hatch is to stop the worker (documented
     in `docs/operations/`).
4. **Recovery that goes through the library.** Take the flock first. Then:
   - jobs with `abort_requested` become `aborted`,
   - other interrupted jobs retry through a library transition.

   This replaces the raw `doing → todo` at `worker.py:81–100`, which neither
   counts the attempt nor honours abort. No page-resume is claimed: the service
   promises a whole-job rerun (parsing `README.md:19`).
5. **Status.** `GET /api/runs/{id}` returns the projected state (with `aborted`
   shown as `cancelled`), phase, units and attempt. Queue rank is **not** part of
   this phase's gate. It moves to item 11b: it adds scheduling semantics and
   doesn't enable cancellation.
6. **No cleanup in Phase 1.** Job-row pruning and run-directory deletion both
   wait:
   - Pruning waits for a domain-aware filter (see the table).
   - Directory deletion waits for Phase 2's retain/release protocol, a backfill
     of existing Studio references, and protection for unacknowledged
     admissions.
   - Until then, legacy runs are kept.

Gate: a queued cancel never executes. A running cancel publishes nothing after
the gate. A restart honours an abort. Canonical Evidence is unchanged.
**Operator value on day one:** you can cancel today's stuck run through the API.

## Phase 2: durable Studio ingestion on Procrastinate (fixes symptom 2)

7. **DB (`packages/db`).**
   - Add a migration after `20260923T1946_source_reprocessing` that installs
     Procrastinate's schema into `free`. The worker's `procrastinate schema`
     version must match the migration, and startup checks this.
   - Add a `SourceIngestion` table:
     - owner and project
     - immutable request identity (fingerprint)
     - retained input reference
     - kei `submission_key` and run id
     - reprocess target and expected representation
     - Studio job ids
     - cancellation intent
     - completion receipt
     - failure code and `retryable` flag
     - `retryOf`
     - timestamped observations

     There are **no** lease, attempt or backoff columns; those belong to
     Procrastinate. Add a `SourceIngestionObligation` table (remote
     revoke/cancel and file cleanup) that outlives deletion.
   - Update `contract.prisma` and the artifacts, and add
     `source-ingestion-store.ts` and the adapter `procrastinate-sql.ts`.
8. **Admission (Studio API).**
   - Validate (MIME, magic bytes, 100 MiB), then reserve the per-researcher
     byte/count budget, serialized. Replays don't reserve twice.
   - Retain the bytes on `studio-data` before answering. Then, in one
     transaction, insert the operation and defer `submit_ingestion`, and return
     `202 { ingestion }`.
   - The budget is released when the bytes or pins are released, not when the
     job ends.
9. **Studio worker** (`prototypes/studio/jobs/{app,tasks,worker}.py` +
   `server/source-ingestion-command.ts`, in a Studio worker image with Node and
   Python).
   - `submit_ingestion` does a replayable kei submit and stores the run id. If
     the acknowledgement is lost, it retries with the same key.
   - A periodic `reconcile_ingestions` (stable id plus lock) polls unfinished
     runs in bounded batches. It records observations and, once a run is ready,
     defers `finalize_ingestion` transactionally.
   - `finalize_ingestion` runs `node … source-ingestion-command finalize <id>`:
     - verify the source/manifest/page hashes and the generation, using the
       functions extracted from `source_documents.ts:393` and `_kei_exp.ts:470`,
     - **retain the package first**,
     - then commit the document or revision together with operation completion
       in one transaction.

     The package is protected from cleanup until that commit, which refactors
     the post-commit compensation at `project-store.ts:1464–1505`.
   - Queues: `studio-control` (submit and reconcile) and `studio-finalize`
     (concurrency 1: synchronous ZIP work and several in-memory copies,
     `artifact-store.ts:151`).
   - **Crash recovery is specified, not assumed.** Procrastinate's startup
     only prunes stale worker records; it never re-queues their `doing` jobs
     (`schema.sql:553`). So the Studio worker copies kei's supervisor model:
     - It takes one `flock` per Studio slot and holds it for its lifetime.
       SIGSTOP keeps ownership, and there is no takeover based on heartbeats.
     - Before fetching jobs, it runs a startup reconciliation that resolves the
       slot's `doing` jobs:
       - `submit_ingestion`: re-submit **by its existing `submission_key`**,
         since kei replays it and returns the same run id.
       - `finalize_ingestion`: resume **by its receipt**. Already committed
         means succeeded. A retained but uncommitted package is re-verified,
         then committed.
       - Jobs with `abort_requested` become `aborted`.
     - The Node child runs in its own process group and is killed with its
       group when the job aborts or the worker exits (`PR_SET_PDEATHSIG` or an
       equivalent parent-death signal). Tests check that no child outlives its
       lock holder.
   - The worker has access to `free`, `studio-data` and kei's HTTP API. It gets
     no kei database, no parsing volume, no model credentials and no GPU.
10. **Gates inside this phase (none deferred).**
    - **Reprocess.**
      - Pin the original PDF and replay by fingerprint.
      - The completion transaction locks the Source Document and checks the
        expected current representation (`project-store.ts:1556–1630`).
      - A stale target becomes a visible conflict.
      - Historical revisions are never changed.
    - **Deletion.**
      - Serialized against admission and finalize.
      - Before the cascade, write obligations that hold the submission key even
        when there is no run id yet. These revoke the remote submission, abort
        local jobs, and remove unreferenced bytes after writers stop.
      - Parser generations that representations or extractions reference are
        kept through explicit retain/release, never by age.
    - **Retry.**
      - Transient submit/finalize failures retry through `RetryStrategy`.
      - A user retry of a failed parse creates a new operation and key with
        `retryOf`.
      - A retry of packaging reuses the finished parse.
      - An invalid PDF or a stale reprocess target is not retryable.
      - When retries run out, obligations stay visible to the reconciler and to
        operators.
    - **Cancel.** Commit the Studio intent, then cancel the local job through
      SQL, and let an obligation deliver the kei cancel by key.
11. **API and browser.**
    - **(11b) Queue rank.** kei reports an observed position among eligible
      jobs (queue, `scheduled_at`, priority, id, blocking locks) with an
      observation time. Delayed and lock-blocked jobs are labelled as such, and
      no other researcher's metadata is exposed.
    - Upload and reprocess return 202. Add owned list/get/cancel/retry routes
      (`shared/sourceIngestion.contract.ts`, `server/api-dispatcher.ts`, and the
      ownership tests). **Reads never start work.**
    - The browser machine becomes `waiting → uploading → acknowledged |
      uploadFailed`, with at most 3 upload actors, each released on 202.
    - Cards are hydrated from server state and polled while anything is
      unfinished.
    - Labels: Queued · N ahead (as of …) / Processing / Saving / Failed (Retry)
      / Cancelling (elapsed).
    - No `File` objects are persisted, and the browser never completes a parse.

Gate: refresh, a Studio web or worker restart, a parser outage, delete, cancel,
reprocess conflicts, budget races and retry all behave correctly.

## Phase 3: native CPU lane (fixes symptom 1 for born-digital PDFs)

12. **Queues and workers.**
    - `runs-slot-1-gpu` (OCR through vLLM) and `runs-slot-1-native` (all native
      PDFs), each with its own flock'd worker and `concurrency=1`. Never run
      replicas against one slot.
    - Inside the native lane, `priority` is a page-count class, small first. It
      is set by the server at defer.
    - Extraction work is routed explicitly to the model lane. It doesn't inherit
      its run's parse lane.
13. **Routing without making admission expensive.**
    - Admission stays cheap by contract (`api.py:164–170`): the native/OCR
      decision is not made there.
    - Admission defers `route_run` to a bounded `runs-slot-1-control` queue,
      served by its own process with small concurrency and no model access.
    - `route_run` runs `has_native_text` (`native.py:33`).
    - **Handoff transaction (one ownership rule used everywhere).** In one kei
      transaction, `route_run`:
      - checks for a revocation or cancel (and stops if one exists),
      - persists the routing evidence,
      - defers exactly one lane job,
      - **switches the run's authoritative job link** from the router job to
        the lane job.

      Today reads pick the linked job with `attempt DESC LIMIT 1`
      (`jobs/store.py:241`), so this becomes an explicit `authoritative` flag.
      Status, cancel, recovery, replay and admission counting all read that
      flag.
    - The router job reports nothing to the researcher. A replayed router whose
      handoff already committed does nothing.
    - At execution, the lane worker re-resolves (`runs.execution_for` stays
      authoritative, `runs.py:64`). If the lane is wrong, the task **raises
      `JobRetry(RetryDecision(queue=other))`** before touching any model, and
      the worker makes the only state transition.
    - A lane move uses up one attempt, so the `RetryStrategy` budgets allow for
      one move.
    - If abort is requested during a move, the job ends `aborted`, not moved.
      The lane task checks `should_abort()` before raising `JobRetry`.
14. **CPU safety.** The native path forces
    `AcceleratorOptions(device=AcceleratorDevice.CPU)` (`native.py:216`, as
    `cut.py:90` already does). Compose also gives the worker no GPU, but that
    is not guaranteed in dev or when running on the host. Cap threads and memory
    on the native worker, and keep it away from the GPU endpoints.
15. **Compose.** Add the `parsing_worker_native` and `parsing_worker_control`
    services (no `&gpu`), and update the overlays, slot recovery (per lane) and
    queue-rank projection.

Gate:
- A small native PDF **finishes while a large OCR run is active**.
- A queued small native PDF **runs before queued large native PDFs** once the
  active native job finishes. Concurrency is 1, so it never interrupts that job.
- No GPU-memory regression, and no recovery interference between slots. **Rollback:** drain the native and control queues
and send routing back to the GPU lane. Durable ingestion is unaffected.

**Still limited after Phase 3:** a small *scanned* PDF still waits behind a
large OCR run. Cancel is the escape. A second GPU slot needs measured vLLM
capacity.

## Tests (repository tiers, `README.md:104`)

- **Unit:**
  - fingerprints and replay/conflict
  - retry classification and routing
  - upload actors and hydration
  - publication gating
  - subprocess abort and error mapping
  - the SQL adapter checked against the pinned Procrastinate version
- **PostgreSQL:**
  - concurrent admission and budgets, atomic deferral
  - lost acknowledgements, cancel racing submission (tombstone)
  - delete vs. finalize, reprocess conflicts
  - retry exhaustion, duplicate periodic runs, lane handoff
- **Python and DB wiring:**
  - `test_jobs_{store,task,worker,events,recovery}.py`
  - new Studio-worker pytest
  - wire the Studio ingestion checks **and the WIP reprocessing check** into
    `packages/db/package.json:13`
- **Recovery:**
  - kill the Python worker and the Node child separately
  - SIGSTOP with no takeover
  - DB outages
  - neighbouring healthy slots
  - a crash after publication
- **E2E / service:** `project-navigation.spec.ts` and `real-service.spec.ts`
  cover:
  - multiple uploads and refresh
  - a >30-min logical duration
  - worker restart
  - cancel and delete
  - a small native PDF next to a large OCR run
  - unchanged Evidence

## Rollout

- Drain, stop, run the forward migrations (both databases), then start.
  Starting includes the new workers' health and schema-version checks.
- In-flight long POSTs have no durable association, so drain them rather than
  inventing ownership. Old tabs must reload, and the long-polling path is
  removed at cutover.
- Record an ADR in `docs/adr/`, and track the open decisions in an Issue or
  OpenSpec change.
- Phase order: 1 → 2 → 3. Phase 1 alone already lets an operator cancel today's
  stuck run.

## Open questions

1. The storage budget per researcher and globally, and how long failed inputs
   are kept.
2. The page-count classes for native-lane priority, and the starvation limit
   for large native documents.
3. CPU and RSS budget for two extra worker processes on the Spark box.
4. The cancellation latency target, given that native conversion is a single
   Docling call.
5. Procrastinate upgrade policy now that two schemas and the SQL adapter depend
   on the version.

## Risks

- Packaging and supervising a Node + Python worker image.
- Coupling to Procrastinate's SQL version.
- Mistakes in cleanup references.
- Native conversion that can't be interrupted.
- Starvation under small-first priority.
- The routing handoff creating duplicate jobs.

## Review log

- 2026-09-24. Claude and Codex (gpt-6-astra) wrote independent drafts. They
  diverged on who finalizes (a TS lease loop vs. a Studio Procrastinate worker)
  and on the lane shape (all native vs. small native only). The user chose the
  Studio Procrastinate worker and a native lane for all native PDFs.
- Codex adversarial review: no P0, 7 findings, all accepted after checking them
  against Procrastinate 3.9.0:
  1. Lane moves use `JobRetry(RetryDecision(queue=…))`, not
     `JobManager.retry_job` (its `finish_job` accepts `todo`).
  2. `remove_old_jobs` is removed from Phase 1, because it would erase status
     that joins on job rows.
  3. Run-directory cleanup is deferred until retain/release exists.
  4. Studio worker crash recovery is specified: flock, startup reconcile by key
     and receipt, and the child process tied to its parent.
  5. The `route_run` handoff switches an explicit authoritative job link in one
     transaction.
  6. The `procrastinate_defer_jobs_v1` signature is corrected (typed array,
     `queue_name` first).
  7. The Phase 3 gate is corrected for concurrency 1.

  Also: queue rank moved out of Phase 1, periodic tasks got a lock, a
  `queueing_lock` and a timestamp, and two line references were fixed.
