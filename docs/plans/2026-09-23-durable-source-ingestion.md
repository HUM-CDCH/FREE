# Durable, non-blocking Source Document ingestion

Date: 2026-09-23 · **Superseded by [2026-09-24-procrastinate-source-ingestion.md](2026-09-24-procrastinate-source-ingestion.md).** · Drafted by Claude (Opus 5.5) and Codex (gpt-6-astra), merged and cross-reviewed.

## Problem

1. While one large PDF parses, nothing else gets parsed.
2. Refreshing the Project page makes the in-progress parse disappear.

## Diagnosis

- **Browser serializes uploads.** One app-wide `sourceIngestionMachine`
  (`prototypes/studio/src/sourceIngestionMachine.ts`, created in
  `ProjectContextsProvider.tsx:293`). `startNext` promotes one item and the
  machine stays in `ingesting` until that POST settles. `items` starts empty and
  is never persisted, so a refresh loses the queue.
- **The HTTP request owns completion.** `parseSourceDocument`
  (`api/source_documents.ts:456`) submits the kei-exp run, polls it inside the
  request (`completedRun`, :337), then packages and publishes. The signal is
  `AbortSignal.timeout(30 min)`, not the request's signal. A browser disconnect
  still completes while Studio lives, but a >30-min parse (504) or a Studio
  restart orphans the run. Studio never persists the `runId`.
- **Parsing Service runs one job at a time per slot.** Procrastinate queue
  `runs-slot-1`, one flock'd worker, `concurrency=1` (`jobs/worker.py:137`).
  Mostly FIFO, but delayed retries change eligibility and Extractions share the
  queue. Admission is asymmetric: runs count only runs, extractions count all
  jobs (`jobs/store.py:207` vs :322).
- **Cancellation is missing.** `cancel_requested` exists but no route sets it.
  The checks bracket the whole conversion, and the post-conversion check fails
  open on a DB outage (`jobs/tasks.py:94`, :156).

## Decision: a Studio-owned durable operation, finished by a boot-time runtime loop

PostgreSQL owns pending ingestions. A background runtime, started and stopped
with the Studio host exactly like the Extraction runtime (`server/host.ts:109`,
`server/developmentHost.ts:47`), claims due rows with fenced, expiring leases
and advances them one step per tick.

Rejected alternatives:
- **Client-driven finishing:** dies with the tab, which is the current bug.
- **Read-triggered dispatcher** (`_project_operations.ts` `kick()` on read):
  completion would depend on visits, and reads would do remote work.
- **Finishing inside the Python worker:** kei would need Studio's DB and
  artifact-store credentials, crossing the service boundary.
- **Raising worker concurrency:** there is one GPU/vLLM (see the `fix(gpu)`
  memory caps), and it does not fix durability.

States: `awaiting_submission → queued → running → finalizing → completed`. Any
unfinished state can go `→ cancelling → cancelled`. Permanent errors become
`failed`. A temporarily unavailable service or DB schedules a retry and marks
progress stale. It never fabricates a failure.

## Phases

Phase 1 fixes **symptom 2** (a refresh loses the job) and makes queued work
durable. It does **not** fix symptom 1 on its own: with a single worker, other
uploads still wait behind the giant PDF. **Phase 2 fixes symptom 1** by giving
the user a way out through cancellation. Each phase is safe to ship alone.
Codex's review (below) moved deletion, reprocess guarantees, budgets and the
retry contract into Phase 1 for that reason.

### Phase 1: lifecycle-safe durable ingestion (fixes symptom 2)

1. **Contract and ADR.** Add `shared/sourceIngestion.contract.ts` and an ADR in
   `docs/adr/`. Operation identity is distinct from Source Document identity.
   Pending operations are listed but cannot be selected for Extraction.
   **Completion order:** retain and verify the canonical package on disk first.
   Then, in one DB transaction, commit the Source Document or revision together
   with `operation = completed`. Files are never inside a transaction. A
   package that is pending or not referenced is protected from cleanup until
   the commit or until it is recovered as an orphan (current behavior commits
   first and compensates: `project-store.ts:1498`).
2. **DB (`packages/db`).** Add a new migration after
   `20260923T1946_source_reprocessing`; don't rewrite that WIP migration. Add a
   `SourceIngestion` table:
   - id, Project Context FK, unique `(projectContextId, ingestionKey)`
   - kind (upload | reprocess), request fingerprint, `retryOf` (nullable)
   - name, sha256, size, layout/settings, retained-input reference
   - status, parser run id, progress snapshot and observation time
   - failure code, message and a `retryable` flag
   - next-retry time, lease token and expiry
   - reprocess target and expected representation
   - result document and representation ids

   Also add a `SourceIngestionObligation` table (remote cancel and file cleanup)
   that **outlives** project deletion. Update `contract.prisma` and the emitted
   artifacts, and add `source-ingestion-store.ts`.
3. **Server-side admission budget.** Before retaining the upload and answering
   202, enforce per-researcher limits on pending bytes and pending count. The
   check is serialized (advisory lock) and counts replays once. A terminal
   operation releases its budget when its input is released. The limits are
   configuration (see open question 1). Over the budget → 429, and the browser
   keeps the file in its local queue.
4. **Retain the upload before acknowledging.** Stage the PDF on the durable
   Studio volume (temporary file, then atomic rename). Keep the MIME,
   magic-byte and 100 MiB checks. A reprocess pins its target's retained PDF. A
   reference-aware sweeper removes staged files that were never committed.
5. **Replayable parser submission.** `POST /api/runs` accepts a
   `submission_key` and stores the key→run mapping and fingerprint atomically
   with `store.admit`.
   - Same key and same input returns the existing run, even when the queue is
     full.
   - Same key with different input returns 409.

   This closes the lost-acknowledgement window at `api.py:253`. Procrastinate's
   `queueing_lock` is **not enough on its own**. It refuses a second job only
   while the first is still queued (`todo`; `job-backend.md`, "Duplicate
   submission"). A retry that arrives after the job started or finished would be
   admitted and run again. So the mapping table stays. Also pass
   `queueing_lock=submission_key` at defer as a second safeguard. In the same
   change, **make admission counting consistent** (runs and extractions count
   the same unfinished jobs: `jobs/store.py:207` vs :322).
6. **Studio runtime** `api/_source_ingestion_runtime.ts`. Wire it into
   `host.ts` and `developmentHost.ts`, with dispose on reload.
   - Leases are fenced. Each tick does one step (submit / poll once / finalize)
     and then reschedules.
   - **Start with one finalizer**, run separately from the submit/poll
     scheduler so packaging never stalls polling. Measure peak RSS and
     event-loop delay before raising it: packaging holds JSON, an uncompressed
     ZIP and the unpacked verification data, with synchronous ZIP steps
     (`artifact-store.ts:156`, :203).
   - Remove the overall 30-min deadline and keep per-call deadlines and
     `Retry-After`.
   - Split `source_documents.ts` into admission plus reusable verify/translate/
     package functions.
7. **Retry contract.** Replaying a key returns the same operation, including a
   failure. `POST …/source-ingestions/:id/retry` is allowed only when
   `retryable` is set. It creates a **new** operation (new `ingestionKey` and
   `submission_key`, `retryOf` = old id) that reuses the retained input. A
   refresh keeps the Retry button because it is driven by the server.
   - Retryable: service unavailable, timeout, transient parse failure.
   - Not retryable: invalid PDF, a hash or provenance mismatch, a reprocess
     conflict.
8. **Deletion is lifecycle-safe.** Deleting a Source Document or Project:
   - takes the operation row lock, so it is serialized with finalize,
   - marks unfinished operations `cancelled`, which blocks publication,
   - writes a remote-cancel obligation (holding the run id) and file-cleanup
     obligations that survive the cascade,
   - and only then cascades (extend `project-store.ts:852` and :890).

   The runtime discharges the obligations. Until Phase 2 lands, the remote
   cancel is best effort: the run finishes and its result is discarded. Parser
   generations that Extractions reference are never deleted.
9. **Reprocessing keeps today's guarantees (acceptance gate).**
   - `requestKey` becomes `ingestionKey`. The fingerprint covers kind, target,
     expected revision and layout.
   - Replay keeps the current behavior (`project-store.ts:1557`).
   - The expected-head check runs inside the completion transaction
     (`project-store.ts:1596`), and a stale reprocess becomes a visible conflict.
   - Tests cover concurrent reprocess and replay.
10. **Studio API.**
    - Upload and reprocess POSTs return `202 { ingestion }`. Replay returns the
      same operation.
    - Project Context detail includes non-terminal and recently failed
      ingestions.
    - Add an owned `GET …/source-ingestions/:id`.
    - Update `api-dispatcher.ts` and the ownership tests. Never expose raw parser
      run lookup.
11. **Client.**
    - `sourceIngestionMachine` owns only the byte upload, with ~3 concurrent
      uploads. A slot is released on 202, not when parsing finishes.
    - Cards come from the server, hydrated on load and polled while anything is
      unfinished.
    - Labels: Uploading / Queued / Processing / Saving / Failed (Retry).
    - A refresh before the 202 requires choosing the file again. After the 202,
      the card is restored.

### Phase 2: cancellation (fixes symptom 1)

12. **Parsing Service** `POST /api/runs/{id}/cancel`, idempotent. **This uses
    Procrastinate's own cancel/abort, which the spike measured on 3.9.0
    (`job-backend.md` table). Don't build a new mechanism.**
    - One transaction sets `kei_run.cancel_requested` (the flag reconcile and
      `_abandon` already read) and calls
      `JobManager.cancel_job_by_id(job_id, abort=True)`.
    - A `todo` job becomes `cancelled`, so it never starts. `cancelled` is in
      `TERMINAL`, so the job stops counting against admission right away.
    - A `doing` job gets `abort_requested`. The tasks already run with
      `pass_context=True` (`tasks.py:195`, :249), so the page loop calls
      `context.should_abort()` between pages and raises `JobAborted`. It ends
      `aborted`, and it is not retried. **The gap:** today `tasks.py` checks only
      kei's own flag, before and after the whole conversion (`tasks.py:94`). It
      never calls `should_abort()`. Thread the context down to the page loops
      (`kie/runner.py`, `stages/ocr.py`, transcription).
    - The run status projection maps `aborted` to `cancelled`.
    - Replace the fail-open publication check (`tasks.py:156`) with a final
      `should_abort()` check before the manifest is published. The spike
      measured that nothing is published after that check.
    - **Escape hatch for uninterruptible native conversion:** if cancellation
      isn't acknowledged within a deadline, the documented operator procedure
      is to stop the worker. Startup reconcile then abandons the run, because
      `cancel_requested` is already set (`worker.py` `_abandon`). This is
      written in `docs/operations/`. "Cancelling" never stays indefinitely: the
      UI shows "Cancel requested — waiting for the parser" with the elapsed
      time.
13. **Studio cancel.** `POST …/source-ingestions/:id/cancel`.
    - Commits the intent. An obligation delivers it to the Parsing Service,
      retrying until it succeeds.
    - Before submission, it cancels locally.
    - Serialized against finalize: whichever commits first wins.
    - The client shows a Cancel button on Queued and Processing cards.

14. **Queue rank (cheap, so it's back in).** Procrastinate fetches the next job
    with `ORDER BY priority DESC, id ASC` among `todo` jobs whose
    `scheduled_at` has passed. The rank is a count over `procrastinate_jobs`
    using that same order, on the slot's queue, covering runs and Extractions
    alike. `GET /api/runs/{id}` returns it with an observation time.

### Deferred (not planned)

- **Page-count priority.** It is cheap because Procrastinate already supports
  it: pass `priority=` at defer (for example, higher for fewer pages), and the
  fetch order honours it. Priority is fixed at defer time, and it only reorders
  jobs that are waiting. It **cannot interrupt** the giant PDF that is already
  running, so cancel is still the only way to free the worker. This is a
  product call (open question 2), not an engineering cost.
- One active reprocess per Source Document as a policy. Phase 1 already
  guarantees correctness through the expected-head check.

## Tests

- **Unit:**
  - machine concurrency and hydration
  - replay/conflict rules, backoff, cancel-vs-finalize race
  - hash rejection
  - host start/stop/reload of the runtime
- **Python:** `test_api_jobs.py`, `test_jobs_store.py` (submission key races,
  cancel), `test_jobs_task.py`, `test_jobs_worker.py` (cancel during
  reconcile).
- **PostgreSQL:** new `source-ingestion.postgres.check.ts` covering:
  - admission races and lease fencing
  - atomic publication and revision conflicts
  - deletion

  Wire it, **and the WIP reprocessing check**, into `packages/db/package.json`
  (it currently names only `project-store.postgres.check.ts`).
- **E2E:** `e2e/project-navigation.spec.ts` covers two uploads, refresh, and the
  card restored and completed. `e2e/real-service.spec.ts` covers restarting
  Studio and the worker mid-run, then eventual publication. The old 30-min
  boundary is tested with controlled time.

## Rollout

- Use the existing stop → migrate → start cutover. Don't create pending rows for
  historical documents.
- Drain in-flight long POSTs before stopping the old Studio, or accept losing
  them. Their parser runs can't be attached automatically because the old
  Studio never stored a runId→project mapping.
- Old tabs must reload. No second long-polling code path is kept.
- Don't: persist `File` objects or machine snapshots, raise proxy timeouts, or
  raise worker concurrency.

## Open questions for the user

1. **Budget:** how many pending bytes and pending uploads per researcher (for
   example 500 MiB / 10), and how long failed or cancelled operations stay
   visible (for example 7 days)?
2. **Symptom 1 beyond cancel:** is "cancel the giant one" enough, or do you
   want small documents to overtake big ones? That means priority, which is
   deferred above.
3. **Cancel deadline** before the operator procedure applies to native
   conversion (for example 5 min)?
4. **Today's stuck run:** can it be drained, or should it be cancelled by hand
   now (set `cancel_requested` + restart the worker)?

## Review log

- Codex (gpt-6-astra) adversarial review, 2026-09-23. It found no P0 and eight
  P1/P2 issues. All eight were accepted:
  - Deletion, reprocess guarantees, the budget, the retry contract and
    consistent admission counting moved into Phase 1.
  - The transaction wording was corrected.
  - The finalizer starts at 1.
  - Queue rank was deferred.
  - The claim that Phase 1 fixes symptom 1 was withdrawn.
- Follow-up (user question, 2026-09-23): the Procrastinate 3.9.0 features the
  spike measured are now used instead of rebuilding them:
  - `cancel_job_by_id(abort=True)` + `should_abort()` for cancellation
  - `ORDER BY priority DESC, id` for queue rank
  - `priority=` for the deferred page-count ordering
  - `queueing_lock` as a second safeguard only

  The key→run mapping table stays, because `queueing_lock` covers only jobs
  still in `todo`.
