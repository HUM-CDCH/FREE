"""The throwaway server and the per-test database: the fixtures every other job test is built on."""
import threading

import psycopg
import pytest

from kei_exp.jobs import schema, store
from kei_exp.jobs.app import QUEUE, queue_of


def test_each_test_gets_an_empty_database(database: str) -> None:
    with psycopg.connect(database) as connection:
        tables = connection.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'").fetchone()
    assert tables == (0,)


def test_a_slot_names_its_own_queue() -> None:
    assert queue_of("slot-2") == "runs-slot-2"
    assert QUEUE.startswith("runs-")


def test_statement_batches_are_uniquely_and_strictly_versioned() -> None:
    """A copy-pasted version number would compile, pass every other test here, and silently never run against
    an already-migrated database: `apply()` skips any batch at or below the recorded version, so a duplicate
    sharing an already-applied number is invisible to it forever. Nothing else in this module would catch that
    — it needs its own assertion, independent of any database."""
    versions = [version for version, _ in schema.STATEMENTS]
    assert versions == sorted(versions), "batches must be listed in increasing version order"
    assert len(versions) == len(set(versions)), f"a version number repeats: {versions!r}"


def test_apply_creates_both_schemas_and_records_its_version(database: str) -> None:
    assert schema.apply(database) == schema.SCHEMA_VERSION
    with psycopg.connect(database) as connection:
        names = {row[0] for row in connection.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")}
    assert "procrastinate_jobs" in names
    assert {"kei_run", "kei_run_job", "kei_attempt", "kei_event", "kei_event_seq"} <= names
    assert schema.version(database) == schema.SCHEMA_VERSION


def test_apply_is_idempotent(database: str) -> None:
    schema.apply(database)
    assert schema.apply(database) == schema.SCHEMA_VERSION  # a second run changes nothing and does not raise


def test_a_run_row_needs_its_slot_and_params(database: str) -> None:
    schema.apply(database)
    with psycopg.connect(database) as connection, pytest.raises(psycopg.errors.NotNullViolation):
        connection.execute("INSERT INTO kei_run (id, slot, params) VALUES ('r', NULL, '{}'::jsonb)")


def test_apply_is_safe_against_a_concurrent_apply_on_an_empty_database(
        database: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Two processes can both observe procrastinate_jobs absent and both try to run its bootstrap DDL, which
    contains unconditional CREATE TYPE / CREATE TABLE — one of them fails on a duplicate object. Reproduce that
    exact interleaving deterministically: synchronise both threads' existence check on a barrier so they answer
    "absent" at the same instant, the way an unlucky pair of real processes might.

    A correctly ordered lock defeats this regardless: the lock is taken before the check, so the second
    thread's check can only run after the first thread's whole migration has committed — by then the barrier
    partner is gone, `barrier.wait` times out, and that thread proceeds alone having already seen the truth.
    """
    barrier = threading.Barrier(2)
    original_has = schema._has

    def synced_has(connection: psycopg.Connection, table: str) -> bool:
        if table == "procrastinate_jobs":
            try:
                barrier.wait(timeout=1.0)
            except threading.BrokenBarrierError:
                pass  # no partner arrived while a lock was held elsewhere: this thread proceeds alone, correctly
        return original_has(connection, table)

    monkeypatch.setattr(schema, "_has", synced_has)

    results: list[int | BaseException] = []
    results_lock = threading.Lock()

    def run() -> None:
        try:
            result = schema.apply(database)
        except Exception as error:  # noqa: BLE001 - capturing whichever error the race produces, if any
            result = error
        with results_lock:
            results.append(result)

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    failures = [result for result in results if isinstance(result, BaseException)]
    assert not failures, f"concurrent apply() should not raise, got: {failures!r}"
    assert results == [schema.SCHEMA_VERSION, schema.SCHEMA_VERSION]
    assert schema.version(database) == schema.SCHEMA_VERSION


def test_apply_to_a_current_database_executes_no_ddl(database: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """An already-current database must not even attempt any DDL on a second apply() — not "attempts it
    harmlessly", actually none at all. A later increment's ALTER TABLE and trigger swap would each take a real
    lock even when their result is already in place, and re-running them on a live system has a concrete
    deadlock path (task-3c-brief.md, finding 2). Count statements through a wrapped `Connection.execute` rather
    than merely asserting no exception: the unfixed flat-STATEMENTS loop also raises nothing on a second call
    (see test_apply_is_idempotent above) even though it re-sends every CREATE statement, so "no exception" does
    not discriminate — "no CREATE/ALTER/DROP left the process" does.
    """
    schema.apply(database)

    statements: list[str] = []
    original_execute = psycopg.Connection.execute

    def spy(self: psycopg.Connection, query, *args, **kwargs):
        statements.append(query if isinstance(query, str) else query.decode())
        return original_execute(self, query, *args, **kwargs)

    monkeypatch.setattr(psycopg.Connection, "execute", spy)

    assert schema.apply(database) == schema.SCHEMA_VERSION

    ddl = [statement for statement in statements if statement.strip().upper().startswith(
        ("CREATE", "ALTER", "DROP", "INSERT INTO KEI_SCHEMA"))]
    assert ddl == [], f"a current database ran statements it should have skipped: {ddl!r}"


def test_apply_refuses_a_database_stamped_with_a_newer_version(database: str) -> None:
    schema.apply(database)
    with psycopg.connect(database) as connection, connection.transaction():
        connection.execute("INSERT INTO kei_schema (version) VALUES (%s)", (schema.SCHEMA_VERSION + 1,))

    with pytest.raises(RuntimeError, match=str(schema.SCHEMA_VERSION + 1)):
        schema.apply(database)


def test_kei_run_job_has_a_unique_index_leading_with_job_id(database: str) -> None:
    schema.apply(database)
    with psycopg.connect(database) as connection:
        row = connection.execute(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'kei_run_job' AND indexname = 'kei_run_job_job'"
        ).fetchone()
    assert row is not None, "kei_run_job_job index is missing"
    assert "UNIQUE" in row[0]
    assert "(job_id)" in row[0]


def test_phase_timing_migration_preserves_old_attempts_without_inventing_timings(database: str, monkeypatch):
    with monkeypatch.context() as old:
        old.setattr(schema, "STATEMENTS", [(v, sql) for v, sql in schema.STATEMENTS if v <= 2])
        old.setattr(schema, "SCHEMA_VERSION", 2)
        schema.apply(database)
    with psycopg.connect(database) as conn:
        conn.execute("INSERT INTO kei_run (id, slot, params) VALUES ('historical', 'test', '{}')")
        conn.execute("INSERT INTO kei_attempt (run_id, attempt, job_id, started, finished, status) "
                     "VALUES ('historical', 1, 1, now() - interval '10 seconds', now(), 'succeeded')")
    schema.apply(database)
    store.close_pool()
    store.open_pool(database)
    try:
        row = store.record("historical")
        assert row.duration_seconds == 10
        assert row.step_timings is None and row.current_step is None
    finally:
        store.close_pool()


def test_version_4_adds_the_extraction_table_on_top_of_version_3(database: str) -> None:
    assert schema.apply(database) == 4
    with psycopg.connect(database) as conn:
        columns = [row[0] for row in conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'kei_extraction' "
            "ORDER BY ordinal_position").fetchall()]
    assert columns == ["id", "run_id", "job_id", "created", "request", "generation", "finished", "error"]
