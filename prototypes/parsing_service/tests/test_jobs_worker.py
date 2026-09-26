"""Ownership of a slot: the lock that only a dead process releases, and the reconciliation that is the fence.

The spike (docs/job-backend.md) found that nothing in Procrastinate stops a merely stopped worker from returning
and overwriting a replacement's files. The fence is that a replacement cannot start at all until the previous
process has exited and been reaped, which is what an OS file lock held for a process's lifetime gives.
"""
import os
import subprocess
import sys
import time

import pytest

from kei_exp import runs
from kei_exp.jobs import schema, store, worker
from kei_exp.jobs.app import deferring_installed


@pytest.fixture
def ready(database: str, tmp_path, monkeypatch) -> str:
    schema.apply(database)
    store.close_pool()
    store.pool(database)
    monkeypatch.setenv("KEI_RUNS", str(tmp_path))
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    try:
        with deferring_installed(database):
            yield database
    finally:
        store.close_pool()


def test_reconciliation_requeues_only_this_slots_interrupted_jobs(ready: str) -> None:
    store.admit("mine", {"page_count": 1}, slot="slot-1")
    store.admit("theirs", {"page_count": 1}, slot="slot-2")
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'doing'")
        conn.commit()
    assert worker.reconcile("slot-1") == ["mine"]
    with store.connection() as conn:
        statuses = dict(conn.execute(
            "SELECT link.run_id, job.status FROM procrastinate_jobs job "
            "JOIN kei_run_job link ON link.job_id = job.id").fetchall())
    assert statuses == {"mine": "todo", "theirs": "doing"}  # the neighbour's job was not touched


def test_reconciliation_requeues_an_interrupted_extraction_of_this_slot(ready: str) -> None:
    """An extraction's job is recorded in kei_extraction, not kei_run_job, and it is the slot queue's to serve
    all the same: a worker that died mid-extraction leaves it `doing` with nobody left to finish it."""
    store.admit("extracted", {"page_count": 1}, slot="slot-1")
    job = store.admit_extraction("x-1", "extracted", {"schema": {}}, generation="g1")
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'doing' WHERE id = %s", (job,))
        conn.commit()
    assert worker.reconcile("slot-1") == ["extracted"]
    assert store.extraction("x-1").job_status == "todo"
    assert store.record("extracted").job_status == "todo"  # its own conversion job was never `doing` to settle


@pytest.mark.parametrize("started", [False, True])
def test_reconciliation_ends_a_run_cancelled_while_the_slot_was_empty(ready: str, started: bool) -> None:
    job_id = store.admit("stopped", {"page_count": 1}, slot="slot-1")
    if started:
        store.attempt_started("stopped", 1, job_id)
        store.append_events("stopped", 1, [{"type": "phase", "name": "ocr"}])
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'doing'")
        conn.execute("UPDATE kei_run SET cancel_requested = true WHERE id = 'stopped'")
        conn.commit()
    assert worker.reconcile("slot-1") == []  # honoured before resuming: nothing is re-queued
    row = store.record("stopped")
    assert row is not None and row.job_status == "cancelled" and row.finished is not None
    assert row.current_step is None
    assert [timing["step"] for timing in row.step_timings] == (["prepare", "ocr"] if started else ["prepare"])
    last = store.events_after("stopped", -1)[-1]
    assert (last["type"], last["status"]) == ("status", "cancelled")


def test_reconciliation_does_not_look_at_heartbeats(ready: str) -> None:
    """A job is re-queued because this process now owns the slot, not because a heartbeat aged out."""
    store.admit("fresh", {"page_count": 1}, slot="slot-1")
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'doing'")
        conn.commit()
    assert worker.reconcile("slot-1") == ["fresh"]  # however recent the heartbeat is


def test_worker_uses_the_database_url_it_was_given(ready: str, tmp_path) -> None:
    """`--database-url` must reach `serve()`: the CLI used to accept it and then silently run the worker
    against `KEI_DATABASE_URL` instead. `KEI_DATABASE_URL` here is deliberately unreachable, so the worker can
    only start (and print its reconciliation line) by actually using the `--database-url` it was given."""
    env = {**os.environ, "KEI_RUNS": str(tmp_path),
           "KEI_DATABASE_URL": "postgresql://nope:nope@127.0.0.1:1/nope"}
    process = subprocess.Popen(
        [sys.executable, "-m", "kei_exp.jobs.cli", "--database-url", ready, "worker", "--slot", "slot-cli-url"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)
    try:
        deadline = time.monotonic() + 30
        lines: list[str] = []
        reconciled = False
        while time.monotonic() < deadline:
            line = process.stdout.readline() if process.stdout is not None else ""
            if line:
                lines.append(line)
                if "reconciled" in line:
                    reconciled = True
                    break
            elif process.poll() is not None:
                break
        assert reconciled, f"worker did not start against its --database-url:\n{''.join(lines)}"
    finally:
        process.kill()
        process.wait(timeout=20)
