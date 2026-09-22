"""The run store over PostgreSQL: admission is one transaction, the limit is checked in it, and an unreachable
database is refused rather than guessed at."""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import psycopg
import psycopg_pool
import pytest
from procrastinate import exceptions as procrastinate_exceptions

from kei_exp.jobs import schema, store
from kei_exp.jobs.app import deferring_installed
from kei_exp.jobs.tasks import convert_run

PARAMS = {"id": "r", "created": "2026-09-21T00:00:00Z", "source_name": "main.pdf", "page_count": 3}


@pytest.fixture
def ready(database: str):
    """A database with the schema applied, the store pointed at it, and its process-wide deferring connector
    installed for the test's duration."""
    schema.apply(database)
    store.close_pool()
    store.pool(database)
    try:
        with deferring_installed(database):
            yield database
    finally:
        store.close_pool()


def test_admission_commits_the_run_and_its_job_together(ready: str) -> None:
    job_id = store.admit("run-1", PARAMS, slot="slot-t")
    row = store.record("run-1")
    assert row is not None
    assert (row.id, row.slot, row.job_id, row.job_status) == ("run-1", "slot-t", job_id, "todo")
    with psycopg.connect(ready) as connection:
        queue = connection.execute("SELECT queue_name FROM procrastinate_jobs WHERE id = %s", (job_id,)).fetchone()
    assert queue == ("runs-slot-t",)


def test_a_full_slot_is_refused_and_nothing_is_written(ready: str) -> None:
    for number in range(3):
        store.admit(f"run-{number}", PARAMS, slot="slot-t", limit=3)
    with pytest.raises(store.Full):
        store.admit("run-over", PARAMS, slot="slot-t", limit=3)
    assert store.record("run-over") is None
    assert len(store.records("slot-t")) == 3


def test_the_limit_is_per_slot(ready: str) -> None:
    store.admit("a", PARAMS, slot="slot-a", limit=1)
    store.admit("b", PARAMS, slot="slot-b", limit=1)  # a neighbour's slot is not full
    assert {row.id for row in store.records("slot-a")} == {"a"}


def test_concurrent_admissions_never_exceed_the_limit(ready: str) -> None:
    def submit(number: int) -> str:
        try:
            store.admit(f"race-{number}", PARAMS, slot="slot-r", limit=4)
        except store.Full:
            return "full"
        return "admitted"

    with ThreadPoolExecutor(max_workers=12) as pool:
        outcomes = list(pool.map(submit, range(12)))
    assert outcomes.count("admitted") == 4
    assert len(store.records("slot-r")) == 4


def test_the_admission_limit_needs_the_advisory_lock(ready: str, monkeypatch) -> None:
    """Remove the lock and the limit must break, or the concurrency test proves nothing.

    A test that passes whether or not the mechanism under test is present is not evidence. This one asserts
    the negative directly: with the advisory lock replaced by a no-op, concurrent admissions over-admit.
    """
    monkeypatch.setattr(store, "_take_admission_lock", lambda conn, slot: None)

    def submit(number: int) -> str:
        try:
            store.admit(f"race-{number}", PARAMS, slot="slot-r", limit=4)
        except store.Full:
            return "full"
        return "admitted"

    with ThreadPoolExecutor(max_workers=12) as pool:
        outcomes = list(pool.map(submit, range(12)))
    assert outcomes.count("admitted") > 4, (
        "expected the no-op lock to let concurrent admissions over-admit past the limit of 4")


def test_a_finished_run_frees_its_place(ready: str) -> None:
    store.admit("done-1", PARAMS, slot="slot-t", limit=1)
    with psycopg.connect(ready) as connection:
        connection.execute("UPDATE procrastinate_jobs SET status = 'succeeded'")
        connection.commit()
    store.admit("next-1", PARAMS, slot="slot-t", limit=1)  # the succeeded run no longer counts
    assert len(store.records("slot-t")) == 2


def test_a_taken_run_id_is_a_duplicate_not_a_crash(ready: str) -> None:
    store.admit("twice", PARAMS, slot="slot-t")
    with pytest.raises(store.Duplicate):
        store.admit("twice", PARAMS, slot="slot-t")


def test_a_duplicate_across_slots_is_duplicate_not_an_outage(ready: str, database: str, monkeypatch) -> None:
    """A taken run id is 409, never 503, even while another slot holds the row uncommitted.

    The admission bound is for the advisory-lock wait. While it also covered the INSERTs, a duplicate id
    racing a different slot's open transaction timed out on `kei_run_pkey` and was reported as an outage.

    The advisory lock is per-slot, so it does not order this case the way it orders same-slot admissions: a
    same-slot duplicate always finds the conflicting row already committed (the lock's release is atomic with
    the first transaction's commit) and fails instantly with UniqueViolation. A cross-slot duplicate can instead
    land while the first transaction is still open, and the second INSERT genuinely waits on the row lock.
    """
    monkeypatch.setattr(store, "ADMISSION_LOCK_TIMEOUT_MS", 300)
    holder = psycopg.connect(database)
    outcome: dict = {}

    def waiter() -> None:
        try:
            store.admit("dup-x", PARAMS, slot="slot-b")
        except store.Duplicate as error:
            outcome["result"], outcome["error"] = "duplicate", error
        except store.Unavailable as error:
            outcome["result"], outcome["error"] = "unavailable", error
        else:
            outcome["result"] = "admitted"

    try:
        holder.execute("INSERT INTO kei_run (id, slot, params) VALUES (%s, %s, %s)",
                       ("dup-x", "slot-a", json.dumps(PARAMS)))
        thread = threading.Thread(target=waiter)
        thread.start()
        time.sleep(1)  # let admit() reach and start waiting on kei_run_pkey before the holder resolves it
        holder.commit()
        thread.join(timeout=10)
        assert not thread.is_alive(), "admit() never returned after the holder committed"
    finally:
        holder.rollback()
        holder.close()

    assert outcome.get("result") == "duplicate", outcome


def test_an_unreachable_database_is_unavailable(postgres: str) -> None:
    store.close_pool()
    store.pool("postgresql://kei:kei@127.0.0.1:1/kei")
    try:
        # A connector must be installed for admit() to get past its fail-fast deferrer() check and reach the
        # connection attempt this test means to exercise; its conninfo is never dialled (SyncPsycopgConnector
        # opens no pool of its own here, since every deferral passes connection= explicitly).
        with deferring_installed("postgresql://kei:kei@127.0.0.1:1/kei"), pytest.raises(store.Unavailable):
            store.admit("nowhere", PARAMS)
    finally:
        store.close_pool()


def test_admit_against_an_unmigrated_database_is_not_migrated(database: str) -> None:
    """`database` here has no schema applied at all: admit()'s first query (the unfinished-runs count) names
    `kei_run`, which does not exist, and raises `psycopg.errors.UndefinedTable` — a `ProgrammingError`, not an
    `OperationalError`, so it must be caught by name rather than by the `Unavailable` branch that already
    handles a genuinely unreachable server."""
    store.close_pool()
    store.pool(database)
    try:
        with deferring_installed(database), pytest.raises(store.NotMigrated):
            store.admit("run-nm", PARAMS, slot="slot-t")
    finally:
        store.close_pool()


def test_a_failed_defer_is_unavailable_and_nothing_is_written(ready: str, monkeypatch) -> None:
    """The deferral goes through Procrastinate's own connector, which wraps a driver failure in
    `ConnectorException`, not `psycopg.OperationalError`. admit() must translate that too, or a database
    failure during the defer surfaces as an unhandled exception (a 500) instead of `Unavailable` (a 503)."""
    def boom(**kwargs):
        raise procrastinate_exceptions.ConnectorException("defer failed")

    monkeypatch.setattr(convert_run, "configure", boom)
    with pytest.raises(store.Unavailable):
        store.admit("boom-1", PARAMS, slot="slot-t")
    with psycopg.connect(ready) as connection:
        assert connection.execute("SELECT count(*) FROM kei_run WHERE id = %s", ("boom-1",)).fetchone() == (0,)
        assert connection.execute(
            "SELECT count(*) FROM kei_event_seq WHERE run_id = %s", ("boom-1",)).fetchone() == (0,)
        assert connection.execute(
            "SELECT count(*) FROM kei_run_job WHERE run_id = %s", ("boom-1",)).fetchone() == (0,)


def test_concurrent_first_initialisation_yields_one_open_pool(postgres: str, monkeypatch) -> None:
    """Two racing first callers of `pool()` must not each construct their own pool and orphan the loser:
    initialisation is serialised, so exactly one `ConnectionPool` is ever built.

    `ConnectionPool.__init__` is slowed down so the race window between the "is there a pool yet" check and
    publishing one is wide enough that 8 real threads reliably land inside it; without that, the window is
    only a few bytecodes wide and the unsynchronised original rarely loses the race in a single test run. The
    assertion counts constructions directly rather than trusting what `pool()` returns to each thread, because
    the original code re-reads the shared global on its `.open()` and `return` lines — so even a losing thread
    can end up handed back the eventual winner's pool, which would hide the orphaned construction it caused.
    """
    real_init = psycopg_pool.ConnectionPool.__init__
    constructed: list[psycopg_pool.ConnectionPool] = []
    lock = threading.Lock()

    def slow_init(self, *args, **kwargs):
        time.sleep(0.05)
        real_init(self, *args, **kwargs)
        with lock:
            constructed.append(self)

    monkeypatch.setattr(psycopg_pool.ConnectionPool, "__init__", slow_init)
    store.close_pool()
    barrier = threading.Barrier(8)

    def first(_: int) -> None:
        barrier.wait()
        store.pool(postgres)

    try:
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(first, range(8)))
        assert len(constructed) == 1, f"expected exactly one pool construction, got {len(constructed)}"
        assert store.pool().closed is False
    finally:
        store.close_pool()
        for orphan in constructed:
            if not orphan.closed:
                orphan.close()


def test_open_pool_with_a_conflicting_conninfo_raises(postgres: str) -> None:
    store.close_pool()
    store.open_pool(postgres)
    try:
        with pytest.raises(RuntimeError):
            store.open_pool("postgresql://kei:kei@127.0.0.1:1/kei")
    finally:
        store.close_pool()


def test_open_pool_is_idempotent_for_the_same_conninfo(postgres: str) -> None:
    store.close_pool()
    try:
        first = store.open_pool(postgres)
        second = store.open_pool(postgres)
        assert first is second
    finally:
        store.close_pool()


def test_pool_still_works_with_no_explicit_open(postgres: str) -> None:
    """`open_pool` is optional: a caller that never invokes it still gets a working pool from `pool()` alone,
    exactly as before."""
    store.close_pool()
    try:
        opened = store.pool(postgres)
        assert store.pool() is opened
    finally:
        store.close_pool()


def test_the_admission_lock_wait_is_bounded(ready: str, monkeypatch) -> None:
    """A bounded wait actually expires: with the slot's advisory lock held open on a separate connection, a
    concurrent admit() must raise `Unavailable` rather than block indefinitely, and leave nothing written."""
    monkeypatch.setattr(store, "ADMISSION_LOCK_TIMEOUT_MS", 200)
    holder = psycopg.connect(ready, autocommit=True)
    holder.execute("SELECT pg_advisory_lock(hashtext(%s))", ("kei-admission:slot-t",))
    try:
        start = time.monotonic()
        with pytest.raises(store.Unavailable):
            store.admit("locked-out", PARAMS, slot="slot-t")
        elapsed = time.monotonic() - start
        assert elapsed < 4, f"admit() waited {elapsed}s; the bounded timeout did not apply"
    finally:
        holder.execute("SELECT pg_advisory_unlock(hashtext(%s))", ("kei-admission:slot-t",))
        holder.close()
    assert store.record("locked-out") is None


def test_admit_fails_fast_when_no_connector_is_installed(database: str) -> None:
    """Without `deferring_installed()`, admit() must not silently defer through whatever connector happens to
    be on the shared app; it must fail immediately, naming the missing installation, before it writes anything."""
    schema.apply(database)
    store.close_pool()
    store.pool(database)
    try:
        with pytest.raises(RuntimeError, match="no deferring connector is installed"):
            store.admit("no-connector", PARAMS, slot="slot-t")
        assert store.record("no-connector") is None
    finally:
        store.close_pool()


def test_an_executing_query_times_out_and_the_connection_remains_usable(ready, monkeypatch):
    store.close_pool()
    monkeypatch.setattr(store, "STATEMENT_TIMEOUT_MS", 100)
    store.pool(ready)
    start = time.monotonic()
    with pytest.raises(store.Unavailable, match="statement timeout"), store.connection() as conn:
        conn.execute("SELECT pg_sleep(5)")
    assert time.monotonic() - start < 3
    assert store.records() == []  # the timed-out transaction was rolled back


def test_status_reads_waiting_on_a_table_lock_are_bounded(ready, monkeypatch):
    store.admit("run-locked", PARAMS, slot="slot-t")
    store.close_pool()
    monkeypatch.setattr(store, "STATEMENT_TIMEOUT_MS", 100)
    store.pool(ready)
    with psycopg.connect(ready) as holder:
        holder.execute("LOCK kei_run IN ACCESS EXCLUSIVE MODE")
        with pytest.raises(store.Unavailable, match="statement timeout"):
            store.record("run-locked")
    assert store.record("run-locked").job_status == "todo"
