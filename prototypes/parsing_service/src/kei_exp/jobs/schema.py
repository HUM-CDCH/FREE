"""kei-exp's own tables beside Procrastinate's, and the one command that puts both in place.

Procrastinate owns a job's queue status; these tables own what a job's status cannot say: what the run was asked
for, which jobs have served it, what each attempt did, and the ordered events a subscriber replays. Statements
are grouped into version batches, numbered and append-only: a released batch is never edited, a change is a new
batch at a higher version, and applying an already-current schema executes no DDL at all.
"""
from __future__ import annotations

import psycopg
from procrastinate.schema import SchemaManager

# Version batches, in order. Each is (version, statements-for-that-version). A released batch is never edited —
# a change is a new batch appended here at version max(...) + 1. `apply()` runs only the batches above whatever
# is already recorded in `kei_schema`, under a lock that serialises the whole check-then-act against every other
# process migrating the same database.
STATEMENTS: list[tuple[int, list[str]]] = [
    (1, [
        # kei_schema itself: the table that records which batches have been applied.
        """
        CREATE TABLE IF NOT EXISTS kei_schema (version integer PRIMARY KEY)
        """,
        # the run, its jobs, its attempts and its events
        """
        CREATE TABLE IF NOT EXISTS kei_run (
            id               text PRIMARY KEY,
            slot             text NOT NULL,
            created          timestamptz NOT NULL DEFAULT now(),
            params           jsonb NOT NULL,
            cancel_requested boolean NOT NULL DEFAULT false,
            finished         timestamptz
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS kei_run_job (
            run_id   text   NOT NULL REFERENCES kei_run (id) ON DELETE CASCADE,
            job_id   bigint NOT NULL,
            attempt  integer NOT NULL,
            deferred timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (run_id, job_id)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS kei_attempt (
            run_id   text    NOT NULL REFERENCES kei_run (id) ON DELETE CASCADE,
            attempt  integer NOT NULL,
            job_id   bigint  NOT NULL,
            started  timestamptz NOT NULL DEFAULT now(),
            finished timestamptz,
            status   text,
            error    text,
            PRIMARY KEY (run_id, attempt)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS kei_event (
            run_id  text    NOT NULL REFERENCES kei_run (id) ON DELETE CASCADE,
            seq     bigint  NOT NULL,
            attempt integer NOT NULL,
            body    jsonb   NOT NULL,
            PRIMARY KEY (run_id, seq)
        )
        """,
        # The allocator row is its own table so that numbering an event takes a row lock on it and nothing
        # else: two emitters of one run serialize here, and emitters of different runs never meet.
        """
        CREATE TABLE IF NOT EXISTS kei_event_seq (
            run_id text PRIMARY KEY REFERENCES kei_run (id) ON DELETE CASCADE,
            next   bigint NOT NULL DEFAULT 0
        )
        """,
        """
        CREATE INDEX IF NOT EXISTS kei_run_slot_created ON kei_run (slot, created DESC)
        """,
    ]),
    (2, [
        # A later increment adds a trigger on procrastinate_jobs that runs `WHERE job_id = NEW.id` against
        # kei_run_job on every job status transition, while holding Procrastinate's own job lock, against
        # history this integration deliberately never prunes. kei_run_job's only index is its primary key
        # (run_id, job_id), whose leading column is run_id — useless for a job_id lookup. UNIQUE because one
        # job belongs to exactly one run, an invariant that trigger will assume. This is a different
        # constraint from the (run_id, attempt) uniqueness plan C's retry path records on kei_attempt — same
        # table family, different column, different purpose.
        """
        CREATE UNIQUE INDEX IF NOT EXISTS kei_run_job_job ON kei_run_job (job_id)
        """,
    ]),
    (3, [
        # Phase boundaries measured from the attempt's start. NULL means the old worker recorded none;
        # keep that distinction instead of inventing a breakdown for historical attempts.
        "ALTER TABLE kei_attempt ADD COLUMN phases jsonb",
    ]),
    (4, [
        # One row per extraction: the job identity FREE polls by, the request it was admitted with, and the
        # parse generation it was admitted against — `result.new_generation()`'s string, not a counter. The
        # generation is the immutable parse this extraction is a reference into: the job refuses to run over
        # another one (a re-queued conversion rewrites `result/` under the same fingerprint), because the
        # evidence it would publish would not resolve in the generation the client was told about. The result
        # itself is a file under the run directory (plan B rule 7): no per-stage tables.
        """
        CREATE TABLE IF NOT EXISTS kei_extraction (
            id text PRIMARY KEY,
            run_id text NOT NULL REFERENCES kei_run (id),
            job_id bigint NOT NULL,
            created timestamptz NOT NULL DEFAULT now(),
            request jsonb NOT NULL,
            generation text NOT NULL,
            finished timestamptz,
            error text
        )
        """,
        "CREATE INDEX IF NOT EXISTS kei_extraction_run ON kei_extraction (run_id)",
    ]),
]

SCHEMA_VERSION = max(version for version, _ in STATEMENTS)


def apply(conninfo: str) -> int:
    """Put Procrastinate's schema and kei-exp's in place, and record the version applied. Idempotent, and safe
    to call from two processes at once against the same database: the whole check-then-act runs under a
    transaction-level advisory lock taken before the first existence check, so a second caller either finds
    nothing left to do or waits for the first to finish rather than racing it.

    A database already at `SCHEMA_VERSION` executes no DDL: only batches above the recorded version run.
    Refuses a database stamped with a version newer than this build understands — that means the code was
    rolled back without rolling back the database, which should fail loudly rather than run against a schema
    it does not know.
    """
    with psycopg.connect(conninfo) as connection, connection.transaction():
        _take_schema_lock(connection)
        current = _applied_version(connection)
        if current > SCHEMA_VERSION:
            raise RuntimeError(
                f"database schema is at version {current}, but this build only understands up to "
                f"{SCHEMA_VERSION}; roll the code forward or roll the database back")
        if not _has(connection, "procrastinate_jobs"):
            connection.execute(SchemaManager.get_schema())
        for batch_version, statements in STATEMENTS:
            if batch_version <= current:
                continue
            for statement in statements:
                connection.execute(statement)
            connection.execute("INSERT INTO kei_schema (version) VALUES (%s) ON CONFLICT DO NOTHING",
                               (batch_version,))
    return SCHEMA_VERSION


def version(conninfo: str) -> int:
    """The highest schema version applied, or 0 when kei-exp's schema is not there at all."""
    with psycopg.connect(conninfo) as connection:
        return _applied_version(connection)


def _applied_version(connection: psycopg.Connection) -> int:
    if not _has(connection, "kei_schema"):
        return 0
    row = connection.execute("SELECT max(version) FROM kei_schema").fetchone()
    return (row[0] if row and row[0] is not None else 0)


def _has(connection: psycopg.Connection, table: str) -> bool:
    row = connection.execute("SELECT to_regclass(%s) IS NOT NULL", (f"public.{table}",)).fetchone()
    return bool(row and row[0])


def _take_schema_lock(connection: psycopg.Connection) -> None:
    """Serialise the whole migration (existence checks and all) across every process applying this schema.

    Transaction-level, not session-level: it releases on commit, on rollback, and on process death, so it can
    never linger on a pooled connection that gets reused. Uses the TWO-32-bit-key form of
    `pg_advisory_xact_lock`, which PostgreSQL defines as a namespace distinct from the single-64-bit-key form
    `store._take_admission_lock` uses (`pg_advisory_xact_lock(hashtext('kei-admission:<slot>'))`). That makes a
    collision between the migration lock and an admission lock structurally impossible, not merely unlikely —
    keep the two-key form even though a single key would look simpler.
    """
    connection.execute("SELECT pg_advisory_xact_lock(hashtext('kei-exp-schema'), 1)")
