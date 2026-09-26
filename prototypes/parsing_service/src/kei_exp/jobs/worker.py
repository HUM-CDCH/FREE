"""One slot, one worker, one queue: the supervised exclusive ownership the spike settled on.

The lock is an `flock` held on a file for the process's lifetime, because that is the one claim a process cannot
make on another's behalf and cannot keep after it dies: a merely stopped worker keeps it, so it never gets a
replacement and stays the supervisor's to kill, and a killed and reaped one loses it the moment the kernel
closes its descriptors.

Startup reconciliation is a completion barrier rather than a periodic sweep. It re-queues this queue's `doing`
jobs whatever their heartbeat says, because the proof that the previous worker is gone is the lock this process
just took, not an interval. A cancellation that arrived while the slot was empty is honoured here, before
anything is resumed.

Env: KEI_SLOT, KEI_RUNS (the lock lives beside the runs), KEI_DATABASE_URL.
"""
from __future__ import annotations

import logging
import os

import procrastinate

from kei_exp.jobs import store
from kei_exp.jobs.app import DATABASE_URL, SLOT, app, queue_of
from kei_exp.jobs.events import DurableEmit
from kei_exp.workflows.slot import hold_slot

logger = logging.getLogger(__name__)


def reconcile(slot: str) -> list[str]:
    """Settle what the previous worker of `slot` left in flight; return the run ids re-queued, in id order.

    Both kinds of job this queue carries are settled: a run's conversion, recorded in `kei_run_job`, and an
    extraction of a run, recorded in `kei_extraction` and absent from `kei_run_job`. An extraction re-queued
    here simply runs again — its stages read the same committed result and its artifact is rewritten whole —
    and it reports the run it belongs to, so the returned ids stay run ids.

    A run whose cancellation arrived while the slot was empty is ended here instead of resumed: its accepted
    files are kept, and nothing further is published for it. Only its conversion is abandoned that way:
    `_abandon` writes the run's attempt, event and stamp, which are the conversion's to report, and an
    extraction has no cancellation of its own in this slice.

    This updates `procrastinate_jobs.status` with raw SQL rather than through `JobManager.retry_job_by_id` (or
    the equivalent cancel call): reconciliation runs before this process opens its Procrastinate app (`serve()`
    below takes the slot and settles what is in flight first, and only then opens the app to run the worker), so
    there is no job manager here to call. The spike (docs/job-backend.md) measured this ordering directly: the
    database is retried until it answers, then the slot's queue's `doing` jobs are settled, then the worker
    serves — settling is a barrier the app's own machinery is not yet available to perform.
    """
    queue = queue_of(slot)
    with store.connection() as conn:
        interrupted = conn.execute(
            "SELECT job.id, link.run_id, run.cancel_requested FROM procrastinate_jobs job "
            "JOIN kei_run_job link ON link.job_id = job.id JOIN kei_run run ON run.id = link.run_id "
            "WHERE job.queue_name = %s AND job.status = 'doing' "
            "UNION ALL "
            # An extraction is always resumed, never abandoned: false is the cancellation flag it does not have.
            "SELECT job.id, extraction.run_id, false FROM procrastinate_jobs job "
            "JOIN kei_extraction extraction ON extraction.job_id = job.id "
            "WHERE job.queue_name = %s AND job.status = 'doing' "
            "ORDER BY 2", (queue, queue)).fetchall()
    requeued: list[str] = []
    for job_id, run_id, cancelled in interrupted:
        if cancelled:
            _abandon(job_id, run_id)
            continue
        with store.connection() as conn:
            conn.execute("UPDATE procrastinate_jobs SET status = 'todo' WHERE id = %s AND status = 'doing'",
                         (job_id,))
            conn.commit()
        requeued.append(run_id)
        logger.info("slot %s re-queued the interrupted job %s of run %s", slot, job_id, run_id)
    return requeued


def _abandon(job_id: int, run_id: str) -> None:
    """End a cancelled run that no worker is serving: its job, its attempt, its event and its stamp.

    The interrupted job was marked `doing` without ever going through `tasks.execute`'s own `attempt_started`
    call (this process is settling what a *previous* worker left, not running the attempt itself), so the
    attempt row `attempt_finished` updates may not exist yet. Create it only when missing: restarting an
    existing attempt here would erase its recorded duration and phase boundaries.
    """
    row = store.record(run_id)
    number = max(row.attempt, 1) if row is not None else 1
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'cancelled' WHERE id = %s", (job_id,))
        conn.commit()
    if row is None or row.attempt == 0:
        store.attempt_started(run_id, number, job_id)
    store.attempt_finished(run_id, number, "cancelled", None)
    emit = DurableEmit(run_id, number)
    emit({"type": "status", "status": "cancelled", "error": None})
    emit.flush()
    store.finish_run(run_id)


def serve(slot: str = SLOT, database_url: str = DATABASE_URL) -> None:
    """Take the slot, settle what the last worker left, then serve this slot's queue until signalled.

    `database_url` is threaded all the way through, to the store's pool and to the Procrastinate app's
    connector, rather than left to whatever `KEI_DATABASE_URL` happened to resolve to at import time: a caller
    that migrates one database with `--database-url` and starts the worker with the same option must land on
    that same database, not silently read its queue from another one.
    """
    logging.basicConfig(level=os.environ.get("KEI_LOG_LEVEL", "INFO"))
    with hold_slot(slot):
        logger.info("slot %s taken by pid %s", slot, os.getpid())
        store.open_pool(database_url)
        try:
            requeued = reconcile(slot)
            logger.info("slot %s reconciled: %s", slot, ", ".join(requeued) or "nothing in flight")
            connector = procrastinate.PsycopgConnector(conninfo=database_url)
            with app.replace_connector(connector) as scoped, scoped.open():
                scoped.run_worker(queues=[queue_of(slot)], name=f"kei-{slot}", concurrency=1,
                                  listen_notify=True, install_signal_handlers=True)
        finally:
            # Opened explicitly above, so it is closed explicitly here: left open, its background threads
            # block process exit for their own idle timeout, turning a Ctrl+C into a slow, warning-laden stop.
            store.close_pool()
