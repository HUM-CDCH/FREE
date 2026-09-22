# The job backend spike: Procrastinate

Imported from kei-exp `93b9435c2b9a01a5424758d917c058fc79bbc159`. This document
retains the original internal design or measurements. The service README and
FREE root deployment runbooks govern the current runtime and verification commands.

Date: 2026-09-17. Measured with `scratch/check_jobs.py` as of commit `a550a79` (deleted once the verdict was recorded;
`KEI_PG=1` ran the PostgreSQL scenarios in a throwaway `postgres:17` container) against Procrastinate 3.9.0,
psycopg 3.3.5, on one host.
The task under test is the shape a parse run will have in increment 3: one job per run, pages published one
file at a time by rename and reused across attempts when they verify (schema, recipe fingerprint, digest), the
manifest last, the abort flag polled between pages.

## What the library gives

| Need | Measured |
|---|---|
| Priority | Under one lock, the higher priority runs first whatever was deferred first. Priority is set at defer; there is no call to change it afterwards, so a page-priority hint stays the scheduler's, not the queue's. |
| Duplicate submission | `queueing_lock` refuses a second queued job with the same key (`AlreadyEnqueued`). |
| Cancel a queued job | `cancel_job_by_id` marks it `cancelled`; it never starts and stays in the table. |
| Abort a running job | `cancel_job_by_id(abort=True)` sets `abort_requested`; a sync task sees `context.should_abort()` within the worker's `abort_job_polling_interval`, raises `JobAborted` at its next check and ends `aborted`; nothing is published after that check. |
| Retry | `RetryStrategy(max_attempts=N, retry_exceptions=...)` re-queues the job on the named exceptions; the retry reuses the pages the first attempt published and does only what is missing. `max_attempts=3` ran the job **four** times (one attempt, three retries), and `job.attempts` in the context counts the attempts already finished (0 during the first). |
| Resume after `kill -9` | The killed attempt leaves its job `doing`. A replacement started at once, whose startup reconciliation re-queues the slot's `doing` jobs regardless of heartbeat age, resumed at the next page **0.49 s** after the kill (worker start included), reused the 10 accepted pages unchanged, finished, and the job ended `succeeded` once. Killed between the last page and the manifest, the retry reused all pages and wrote the manifest; killed right after the manifest, the job was already `succeeded` when the replacement looked. |
| Cancellation surviving recovery | A cancel issued while the slot was empty (`doing` job, no worker alive) left `abort_requested` on the row; the replacement's reconciliation ended the job `aborted` without resuming it, the accepted pages kept. |
| Database outage | Paused for 4 s mid-run, the task kept publishing pages (it touches no database between pages), the worker stayed alive and the job ended `succeeded` afterwards. A replacement started while the database was paused waited in its reconciliation and resumed after the unpause. |

## What it does not give

- **The file fence.** The diagnostic: a worker stopped mid-run (`SIGSTOP`), its job re-queued as a heartbeat-based
  stalled-job retry would do after the timeout, a second slot finishing the run; then the first resumed. The zombie
  rewrote the page it was on and **overwrote the manifest** (attempt 2 → 1); its late return failed with
  `Database error.` and the job's terminal status stayed `succeeded`: the row was already terminal, which is all
  the diagnostic shows. `procrastinate_finish_job_v1` (3.9.0 `schema.sql`) updates by job id where the status is
  `todo` or `doing`, with no worker or attempt in the predicate, so a zombie returning while its re-queued job
  is still running would finish the replacement's row too. Nothing fences the files either: an attempt stamp
  shows the overwrite afterwards, it does not prevent it. Supervised exclusive ownership keeps both to one worker.
- **Startup recovery.** Heartbeat-based stalled-job detection is code you write (a periodic task), and a replacement
  started at once would find the dead worker's heartbeat fresh for up to `stalled_worker_timeout`. The reconciliation
  above (re-queue every `doing` job of the slot at startup, end the abort-requested ones) exists because the
  supervisor, not the heartbeat, is what proves the previous worker is gone. Ownership is the queue: a slot serves
  one queue named after it, a run is deferred to the queue of the slot that owns it, and reconciliation reads only
  that queue's `doing` jobs (a job's `worker_id` names a registration a restarted slot does not inherit). Measured:
  a slot restarting beside a healthy neighbour re-queued nothing, and the neighbour's job ran once to success.
- Page scheduling, priority hints while a run is in flight, and publication stay `kei-exp`'s.

## The fence that held: supervised exclusive ownership

One worker per deployment slot, a fixed worker name, and a supervisor (docker's restart policy, or the API process
holding the worker as its child) that starts a worker in the slot only after the previous process has exited and
been reaped. A merely stopped worker never gets a replacement and is the supervisor's to kill. Measured: stopped at
page 5, killed and reaped, replaced: attempt 2 wrote pages 6–20, the job ended `succeeded`, no page was written
twice. Startup reconciliation is a completion barrier: the database is retried until it answers, then the slot's
queue's `doing` jobs are re-queued, then the worker serves.

## Verdict

Adopt for increment 3, with PostgreSQL as a deployment dependency (one container in `docker-compose.spark.yml`,
`docker compose` locally). It removes from `api.py`: the `Job` state machine's queued/running/done/failed
bookkeeping and its `status.json` writes, `worker()` and the in-memory queue, `reconcile()` and the synthetic
restart status event, and gives retry, cancellation, priority and durable admission. It keeps for `kei-exp`: the
run status projected from the job status and the result files, the page scheduler and its priority hints, the
publication of pages and the manifest, and the supervisor rule above. Increment 3 runs one slot on one queue; a
second slot is a second queue, and the API's choice at defer time.
