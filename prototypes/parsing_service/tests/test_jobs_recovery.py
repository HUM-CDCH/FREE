"""Recovery across real processes: a killed worker's job is resumed by its replacement, a stopped one gets no
replacement, a neighbour slot is untouched, admission keeps no state in the admitting process, an unreachable
server is refused rather than guessed, and a database outage in the middle of a run does not disturb it.

Every wait is on observable state — a job status, a committed event, a file — never on a duration (docs/job-
backend.md, "The fence that held"). Marked slow: each test spawns at least one real `kei-jobs worker` process
against the session's throwaway PostgreSQL container.
"""
from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from kei_exp.jobs import schema, store
from kei_exp.jobs.app import deferring_installed
from tests.helpers import postgres as postgres_helper
from tests.helpers import slot as slot_helper
from tests.helpers.pdfs import text_pdf

pytestmark = pytest.mark.slow

# Enough pages that the native transcriber's mid-flight window — between a job going "doing" and it finishing —
# is on the order of several seconds on this host (measured ~10s for 300 pages), long enough for a polling
# assertion to observe "doing" and kill the worker before it finishes on its own. A longer sleep is not an
# option (the brief and docs/job-backend.md both rule it out); a bigger source is.
SLOW_PAGE_COUNT = 300


def _shutdown(proc) -> None:
    """Kill and reap a spawned process unconditionally.

    Safe to call on one that already exited, and safe to call from a `finally` that runs after an assertion
    inside the test has failed: it never raises, so it can never mask the real failure and can never leave an
    orphan holding a slot's lock file to wedge every later run of this suite. SIGKILL works even on a process
    currently stopped with SIGSTOP (test_a_stopped_worker_gets_no_replacement), so there is no need to resume
    it first.
    """
    if proc.process.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            os.kill(proc.process.pid, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.process.wait(timeout=20)


@pytest.fixture
def deployment(database: str, tmp_path: Path):
    """A schema, a runs root, and this test process installed as the admitting side, as the API's lifespan
    would be. Copied from the `ready` fixture of tests/test_jobs_store.py: `store.admit()` fails fast unless a
    deferring connector is installed for the process."""
    schema.apply(database)
    store.close_pool()
    store.pool(database)
    runs_root = tmp_path / "runs"
    runs_root.mkdir(parents=True)
    try:
        with deferring_installed(database):
            yield database, runs_root
    finally:
        store.close_pool()


@pytest.mark.live_model
def test_a_killed_worker_is_replaced_and_its_job_resumed(deployment) -> None:
    database, runs_root = deployment
    directory = runs_root / "run-r"
    directory.mkdir(parents=True)
    text_pdf(directory / "input.pdf", [[f"line {n}"] for n in range(SLOW_PAGE_COUNT)])
    store.admit("run-r", {"page_count": SLOW_PAGE_COUNT, "cut": "none", "model": "granite_vision", "debug": False},
                slot="slot-1")

    first = slot_helper.worker("slot-1", database=database, runs_root=runs_root)
    try:
        first.wait_serving(timeout=60)
        slot_helper.until(lambda: (row := store.record("run-r")) is not None and row.job_status == "doing",
                          timeout=60, what="the job starting")
    finally:
        _shutdown(first)

    second = slot_helper.worker("slot-1", database=database, runs_root=runs_root)
    try:
        second.wait_serving(timeout=60)
        # The replacement's startup reconciliation re-queued the interrupted job; it then ran and finished it.
        # The task records its finish before Procrastinate commits the job's terminal state.
        slot_helper.until(lambda: (row := store.record("run-r")) is not None and row.job_status in store.TERMINAL,
                          timeout=180, what="the resumed run finishing")
        row = store.record("run-r")
        assert row is not None and row.job_status == "succeeded"
        events = store.events_after("run-r", -1)
        seqs = [event["seq"] for event in events]
        assert len(set(seqs)) == len(seqs)  # one contiguous stream across both attempts, nothing double-numbered
        assert events[-1]["type"] == "status"
        assert (directory / "output.md").is_file() and (directory / "output.md").stat().st_size > 0
    finally:
        _shutdown(second)


def test_a_stopped_worker_gets_no_replacement(deployment) -> None:
    """A merely stopped worker is the supervisor's to kill, never a replacement's to step over."""
    database, runs_root = deployment
    running = slot_helper.worker("slot-1", database=database, runs_root=runs_root)
    try:
        running.wait_serving(timeout=60)
        running.pause()
        refused = subprocess.run(
            [sys.executable, "-m", "kei_exp.jobs.cli", "worker", "--slot", "slot-1"],
            env={**os.environ, "KEI_DATABASE_URL": database, "KEI_RUNS": str(runs_root), "PYTHONPATH": "src"},
            capture_output=True, text=True, timeout=60, check=False)
        assert refused.returncode != 0
        assert "slot slot-1 is held by another process" in refused.stdout + refused.stderr
    finally:
        _shutdown(running)


def test_an_adjacent_slot_is_untouched(deployment) -> None:
    database, runs_root = deployment
    store.admit("mine", {"page_count": 1}, slot="slot-1")
    store.admit("theirs", {"page_count": 1}, slot="slot-2")
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'doing'")
        conn.commit()

    neighbour = slot_helper.worker("slot-2", database=database, runs_root=runs_root)
    try:
        neighbour.wait_serving(timeout=60)
        row = store.record("mine")
        assert row is not None and row.job_status == "doing"  # slot-1's interrupted job was not reclaimed
    finally:
        _shutdown(neighbour)


def test_a_queued_run_survives_losing_every_connection_the_process_held(deployment) -> None:
    """Admission keeps no run state in process memory: the durability is entirely in PostgreSQL.

    This closes and reopens the store's connection pool in the *same* process — it does not spawn or kill an
    API process, so it does not exercise a real restart. What it proves is narrower and still load-bearing:
    dropping every connection the process held and opening a fresh pool still finds the run, because nothing
    about it lived anywhere but the database.
    """
    database, _runs_root = deployment
    store.admit("run-r", {"page_count": 2}, slot="slot-1")
    store.close_pool()          # every connection this process held is gone
    store.pool(database)        # a fresh pool, with no memory of the one before it
    row = store.record("run-r")
    assert row is not None and row.job_status == "todo"


def test_an_unreachable_server_is_refused_not_guessed(deployment) -> None:
    """Exception translation for a server that refuses the connection outright (nothing listening on the
    port). This is the moment *admission* is refused, before any job is running; it does not cover a database
    outage in the middle of a run — see test_a_paused_database_does_not_disturb_a_running_conversion.
    """
    database, _runs_root = deployment
    store.close_pool()
    store.pool("postgresql://kei:kei@127.0.0.1:1/kei")
    try:
        with pytest.raises(store.Unavailable):
            store.record("run-r")
    finally:
        store.close_pool()
        store.pool(database)


@pytest.mark.live_model
def test_a_paused_database_does_not_disturb_a_running_conversion(deployment, postgres_container: str) -> None:
    """The mid-run database outage the spike measured (docs/job-backend.md, "Database outage"), against this
    implementation rather than the spike's. The spike's task wrote no events at all, so "touches no database
    between pages" was true of it; this task's `DurableEmit` commits control events, and a commit that meets a
    paused server drops its event and logs it rather than failing the attempt, so an emit inside the outage
    window costs progress and never the conversion. The native transcriber under test emits only a few coarse
    phase events (start, "native", "export" — see `transcription/native.py`), none of them per page, so the
    pause lands inside the CPU-bound Docling loop over SLOW_PAGE_COUNT pages and this run makes few database
    calls in the window either way. What the test demonstrates is that the worker *process* survives a paused
    database mid-run and the job still reaches a terminal state once it comes back.

    This is what the spec's validation list means by "database outages" — distinct from
    test_an_unreachable_server_is_refused_not_guessed, which only covers admission being refused before a job
    starts.

    The pause acts on the session's real PostgreSQL container (`docker pause`/`unpause`), so it MUST be undone
    on every exit path: a paused container left behind would wedge every later test in the session. The
    `finally` around the pause calls `postgres_helper.unpause` unconditionally — that function is written to
    never raise — before any assertion in this test is allowed to propagate.
    """
    database, runs_root = deployment
    directory = runs_root / "run-r"
    directory.mkdir(parents=True)
    text_pdf(directory / "input.pdf", [[f"line {n}"] for n in range(SLOW_PAGE_COUNT)])
    store.admit("run-r", {"page_count": SLOW_PAGE_COUNT, "cut": "none", "model": "granite_vision", "debug": False},
                slot="slot-1")

    worker = slot_helper.worker("slot-1", database=database, runs_root=runs_root)
    try:
        worker.wait_serving(timeout=60)
        slot_helper.until(lambda: (row := store.record("run-r")) is not None and row.job_status == "doing",
                          timeout=60, what="the job starting")

        try:
            paused = postgres_helper.pause(postgres_container)
            assert paused.returncode == 0, paused.stderr
            # The spike's window was 4 s; hold the pause at least that long, polling the worker process (not
            # the database, which cannot answer right now) to prove it never dies during the outage.
            deadline = time.monotonic() + 4.0
            while time.monotonic() < deadline:
                assert worker.process.poll() is None, "the worker died while PostgreSQL was paused"
                time.sleep(0.2)
        finally:
            postgres_helper.unpause(postgres_container)

        slot_helper.until(lambda: (row := store.record("run-r")) is not None and row.job_status in store.TERMINAL,
                          timeout=180, what="the run reaching a terminal state after the outage")
        row = store.record("run-r")
        assert row is not None and row.job_status == "succeeded"
    finally:
        _shutdown(worker)
