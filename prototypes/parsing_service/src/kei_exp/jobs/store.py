"""Every query kei-exp makes over its own tables, and the admission transaction that makes a run durable.

A run is admitted by writing its row and deferring its job in one transaction on one connection, so a committed
run always has a job and a committed job always has a run: there is no window in which a restart could read
either half alone. Procrastinate's `configure(connection=...)` puts the insert into that same transaction.

Env: KEI_DATABASE_URL (through `kei_exp.jobs.app`).
"""
from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime

import psycopg
import psycopg_pool
from procrastinate import exceptions as procrastinate_exceptions

from kei_exp.jobs.app import ADMISSION_LIMIT, DATABASE_URL, SLOT, deferrer, queue_of
from kei_exp.progress import Event

UNFINISHED = ("todo", "doing")
TERMINAL = ("succeeded", "failed", "cancelled", "aborted")


def redact(conninfo: str) -> str:
    """`conninfo` down to its host and dbname: safe to print or log, unlike the string itself, which carries
    the password in the clear (`open_pool`'s conflict message, `kei-jobs schema`'s own printed conninfo)."""
    try:
        parsed = psycopg.conninfo.conninfo_to_dict(conninfo)
    except psycopg.ProgrammingError:
        return "<unparseable conninfo>"
    return f"host={parsed.get('host', '?')} dbname={parsed.get('dbname', '?')}"


# How long an admission waits on its slot's advisory lock before giving up. Bounded so that a burst of
# concurrent admissions to one slot cannot each hold a pooled connection indefinitely and starve unrelated
# reads (record/records/events_after) of a connection to check out. `_take_admission_lock` resets `lock_timeout`
# to its default immediately after taking the lock, so this bound covers only that wait: `SET LOCAL` would
# otherwise stay in force for the rest of the transaction, and a duplicate-id INSERT that waits briefly on a
# *different* slot's uncommitted row (the advisory lock is per-slot, so it does not order that case) would
# then surface as a manufactured Unavailable instead of the UniqueViolation that means Duplicate.
ADMISSION_LOCK_TIMEOUT_MS = 5000

# How long a checkout waits for a pooled connection (psycopg_pool.ConnectionPool's own `timeout`, default 30 s).
# FastAPI runs a sync route like `list_runs`/`get_run` in a 40-slot threadpool; at the 30 s default, a burst of
# polls against a dead store can hold every slot for 30 s each and stop the API answering anything at all,
# including routes (like /api/models) that never touch the store. 5 s fails a dead store fast instead.
POOL_CHECKOUT_TIMEOUT = 5.0
# Bound queries after checkout as well, including waits on table/row locks. Longer than the admission lock
# timeout so that contention there retains its specific diagnostic. Applied only to this application's pool.
STATEMENT_TIMEOUT_MS = 10000

# How many events one `events_after` answers. A run's history is unbounded (a long document's phases, pages and
# regions), and a reader that asked for all of it would hold a whole run's events in memory — and in the SSE
# loop, in one poll's response — whatever its size. Readers page instead.
EVENT_PAGE = 500


class Unavailable(RuntimeError):
    """PostgreSQL could not be reached: the caller does not know whether it is full, and must not guess."""


class Full(RuntimeError):
    """The slot already holds its limit of unfinished runs."""


class Duplicate(RuntimeError):
    """A run with this id is already recorded."""


class NotMigrated(RuntimeError):
    """PostgreSQL is reachable, but kei-exp's schema is not there: `kei-jobs schema --apply` was never run
    against this database. Distinct from `Unavailable`: the query that raised this cannot have committed
    anything, because the table it named does not exist."""


@dataclass(frozen=True)
class RunRow:
    """A run as the database holds it, with the status of the job serving it."""
    id: str
    slot: str
    created: datetime
    params: dict
    cancel_requested: bool
    finished: datetime | None
    job_id: int | None
    job_status: str | None       # todo | doing | succeeded | failed | cancelled | aborted
    attempt: int                 # attempts recorded so far; 0 before the first starts
    error: str | None            # the last attempt's error
    duration_seconds: float | None  # the newest attempt's elapsed time; None before any attempt has started
    step_timings: list[dict] | None
    current_step: str | None


_pool: psycopg_pool.ConnectionPool | None = None
_pool_conninfo: str | None = None
_pool_lock = threading.Lock()


def _build(conninfo: str) -> psycopg_pool.ConnectionPool:
    """Construct and open a pool, but do not publish it: the caller assigns `_pool` only once this returns,
    so nothing can observe a pool that is not yet open."""
    built = psycopg_pool.ConnectionPool(conninfo, min_size=1, max_size=8, open=False,
                                        kwargs={"autocommit": False, "connect_timeout": 5,
                                                "options": f"-c statement_timeout={STATEMENT_TIMEOUT_MS}"},
                                        timeout=POOL_CHECKOUT_TIMEOUT)
    built.open()
    return built


def pool(conninfo: str | None = None) -> psycopg_pool.ConnectionPool:
    """The process's connection pool, made on first use. `conninfo` only takes effect when there is none.

    Safe to call from several threads at once: initialisation is serialised, and the pool is published only
    after it is open, so no caller can ever observe a pool that exists but is not yet open.
    """
    global _pool, _pool_conninfo
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            built = _build(conninfo or DATABASE_URL)
            _pool_conninfo = conninfo or DATABASE_URL
            _pool = built
    return _pool


def open_pool(conninfo: str) -> psycopg_pool.ConnectionPool:
    """Open the process's pool explicitly, for a caller (the API's lifespan) that wants to name the conninfo
    rather than leave it to whichever request happens to call `pool()` first.

    Idempotent for the same conninfo; raises `RuntimeError` if a pool is already open for a *different* one,
    since silently keeping the first caller's connection string would hide a real configuration mistake.
    """
    global _pool, _pool_conninfo
    with _pool_lock:
        if _pool is not None:
            if conninfo != _pool_conninfo:
                raise RuntimeError(
                    f"a pool is already open for a different conninfo; cannot open_pool({redact(conninfo)})")
            return _pool
        built = _build(conninfo)
        _pool_conninfo = conninfo
        _pool = built
    return _pool


def close_pool() -> None:
    """Close the process's pool, if any, and forget its conninfo. Must not be called while requests may still
    be using the pool: a checkout racing this close can be handed a connection mid-teardown."""
    global _pool, _pool_conninfo
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None
            _pool_conninfo = None


@contextmanager
def connection() -> Iterator[psycopg.Connection]:
    """A pooled connection; an unreachable server is `Unavailable` rather than a driver error in a route."""
    try:
        with pool().connection() as conn:
            yield conn
    except (psycopg.OperationalError, psycopg_pool.PoolTimeout) as error:
        raise Unavailable(str(error)) from error


def _take_admission_lock(conn: psycopg.Connection, slot: str) -> None:
    """Serialise admissions of one slot across every process: the count below must see every commit that has
    already taken this lock and released it, so the limit cannot be passed by a race.

    The wait is bounded by `ADMISSION_LOCK_TIMEOUT_MS`: without it, a burst of admissions to one slot could
    each hold a pooled connection while blocked here, starving unrelated reads of a connection to check out.
    """
    # SET does not accept query parameters, so this is built with an f-string rather than passed as one; it is
    # not user input, only the int constant above (or a test's monkeypatched int), so there is nothing to inject.
    conn.execute(f"SET LOCAL lock_timeout = '{int(ADMISSION_LOCK_TIMEOUT_MS)}ms'")
    conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"kei-admission:{slot}",))
    # The bound exists for the advisory-lock wait alone: reset it immediately after taking the lock. `SET
    # LOCAL` would otherwise stay in force for the rest of the transaction, so a duplicate-id INSERT that
    # waits briefly on another (different-slot) transaction's uncommitted row would surface as a manufactured
    # LockNotAvailable/Unavailable instead of the UniqueViolation that means Duplicate.
    conn.execute("SET LOCAL lock_timeout TO DEFAULT")


def admit(run_id: str, params: dict, *, slot: str = SLOT, limit: int = ADMISSION_LIMIT) -> int:
    """Record the run and defer its job in one transaction; return the job id. `Full` when the slot is at its
    limit, `Duplicate` when the id is taken, `Unavailable` when PostgreSQL cannot be reached, `NotMigrated`
    when it can be reached but `kei-jobs schema --apply` was never run against it.

    The count and the insert share the transaction, and the count takes the slot's lock first, so two admissions
    of one slot are ordered against each other and the limit cannot be passed by a race.
    """
    from kei_exp.jobs.tasks import convert_run

    deferrer()  # fail fast and by name if this process never installed a deferring connector, rather than
    # silently deferring through whatever connector happens to be on the shared app (the worker's async one).

    try:
        with connection() as conn, conn.transaction():
            _take_admission_lock(conn, slot)
            (unfinished,) = conn.execute(
                "SELECT count(*) FROM kei_run run JOIN kei_run_job link ON link.run_id = run.id "
                "JOIN procrastinate_jobs job ON job.id = link.job_id "
                "WHERE run.slot = %s AND job.status = ANY(%s)", (slot, list(UNFINISHED))).fetchone()
            if unfinished >= limit:
                raise Full(f"slot {slot} already holds {unfinished} unfinished runs (limit {limit})")
            try:
                conn.execute("INSERT INTO kei_run (id, slot, params) VALUES (%s, %s, %s)",
                             (run_id, slot, json.dumps(params)))
            except psycopg.errors.UniqueViolation as error:
                raise Duplicate(f"run {run_id} is already recorded") from error
            conn.execute("INSERT INTO kei_event_seq (run_id) VALUES (%s)", (run_id,))
            job = convert_run.configure(queue=queue_of(slot), connection=conn).defer(run_id=run_id)
            conn.execute("INSERT INTO kei_run_job (run_id, job_id, attempt) VALUES (%s, %s, 1)",
                         (run_id, job))
    except psycopg.errors.UndefinedTable as error:
        # A ProgrammingError, not an OperationalError: the query that raised it named a table (kei_run,
        # procrastinate_jobs, ...) that does not exist, so nothing in this transaction could have committed.
        # Distinct from Unavailable, whose caller cannot assume that: see NotMigrated's docstring.
        raise NotMigrated(str(error)) from error
    except psycopg.errors.LockNotAvailable as error:
        raise Unavailable(f"slot {slot} is busy: could not take its admission lock in time") from error
    except (psycopg.OperationalError, procrastinate_exceptions.ConnectorException) as error:
        raise Unavailable(str(error)) from error
    return job


_SELECT = """
SELECT run.id, run.slot, run.created, run.params, run.cancel_requested, run.finished,
       link.job_id, job.status,
       coalesce(a.attempt, 0), a.error,
       extract(epoch FROM coalesce(a.finished, now()) - a.started)::float8,
       a.phases, a.finished
FROM kei_run run
LEFT JOIN LATERAL (SELECT job_id FROM kei_run_job WHERE run_id = run.id ORDER BY attempt DESC LIMIT 1) link ON true
LEFT JOIN procrastinate_jobs job ON job.id = link.job_id
LEFT JOIN LATERAL (SELECT * FROM kei_attempt WHERE run_id = run.id ORDER BY attempt DESC LIMIT 1) a ON true
"""


def record(run_id: str) -> RunRow | None:
    """One run with the status of the job serving it, or None when this store has no such run."""
    with connection() as conn:
        row = conn.execute(f"{_SELECT} WHERE run.id = %s", (run_id,)).fetchone()
    return _row(row) if row else None


def records(slot: str | None = None) -> list[RunRow]:
    """Every run of the store, newest first; of one slot when named."""
    where, args = ("WHERE run.slot = %s", (slot,)) if slot else ("", ())
    with connection() as conn:
        rows = conn.execute(f"{_SELECT} {where} ORDER BY run.created DESC", args).fetchall()
    return [_row(row) for row in rows]


def _row(row: tuple) -> RunRow:
    duration, phases, finished = row[10:13]
    timings, current_step = None, None
    if phases:
        seconds: dict[str, float] = {}
        for index, phase in enumerate(phases):
            end = phases[index + 1]["elapsed"] if index + 1 < len(phases) else duration
            start = min(duration, max(0.0, phase["elapsed"]))
            seconds[phase["step"]] = seconds.get(phase["step"], 0.0) + max(0.0, min(duration, end) - start)
        timings = [{"step": step, "seconds": elapsed} for step, elapsed in seconds.items()]
        if finished is None and row[7] == "doing":
            current_step = phases[-1]["step"]
    return RunRow(id=row[0], slot=row[1], created=row[2], params=row[3], cancel_requested=row[4], finished=row[5],
                  job_id=row[6], job_status=row[7], attempt=row[8], error=row[9], duration_seconds=duration,
                  step_timings=timings, current_step=current_step)


@dataclass(frozen=True)
class ExtractionRow:
    """One extraction: its request, the parse generation it was admitted against, its job and how it ended."""
    id: str
    run_id: str
    created: datetime
    request: dict
    generation: str              # the manifest's generation at admission; the job refuses to run over another
    job_id: int
    job_status: str | None
    finished: datetime | None
    error: str | None


def admit_extraction(extraction_id: str, run_id: str, request: dict, *, generation: str,
                     limit: int = ADMISSION_LIMIT) -> int:
    """Record the extraction and defer its job on the run's own slot queue in one transaction; return the job id.

    The slot is the run's, read from its row rather than taken from the caller: an extraction reads the files
    of `runs/<run_id>`, which are the slot's worker's to serve, and the process admitting it (the API) may be
    configured for another slot entirely. There is nothing for a caller to choose here.

    `generation` is the parse generation the caller admitted this extraction against — the one it reported to
    the client — and it is stored rather than re-read when the job runs: `result/` can be rewritten in between
    (a conversion re-queued by `worker.reconcile` mints a new generation under the same fingerprint), and an
    extraction that silently followed the rewrite would publish evidence into a parse its client never saw.

    `LookupError` when the store has no such run (a historical file-only run cannot be extracted through the
    store), `Full` when that slot's queue holds `limit` unfinished jobs of either kind, `Duplicate` when the id
    is taken, `Unavailable` and `NotMigrated` as `admit` raises them.
    """
    from kei_exp.jobs.tasks import extract_run

    deferrer()
    try:
        with connection() as conn, conn.transaction():
            # Before the lock, because the lock is this run's slot's: `kei_run.slot` is written once, at the
            # run's own admission, and never updated, so reading it here cannot be raced.
            row = conn.execute("SELECT slot FROM kei_run WHERE id = %s", (run_id,)).fetchone()
            if row is None:
                raise LookupError(f"no run {run_id} in this store")
            (slot,) = row
            _take_admission_lock(conn, slot)
            # Every unfinished job of the slot's queue, parses and extractions alike: both contend for the one
            # worker that serves it. `admit()`'s own count stays as it is.
            (unfinished,) = conn.execute(
                "SELECT count(*) FROM procrastinate_jobs WHERE queue_name = %s AND status = ANY(%s)",
                (queue_of(slot), list(UNFINISHED))).fetchone()
            if unfinished >= limit:
                raise Full(f"slot {slot} already holds {unfinished} unfinished jobs (limit {limit})")
            job = extract_run.configure(queue=queue_of(slot), connection=conn).defer(extraction_id=extraction_id)
            try:
                conn.execute("INSERT INTO kei_extraction (id, run_id, job_id, request, generation) "
                             "VALUES (%s, %s, %s, %s, %s)",
                             (extraction_id, run_id, job, json.dumps(request), generation))
            except psycopg.errors.UniqueViolation as error:
                raise Duplicate(f"extraction {extraction_id} is already recorded") from error
    except psycopg.errors.UndefinedTable as error:
        raise NotMigrated(str(error)) from error
    except psycopg.errors.LockNotAvailable as error:
        raise Unavailable(f"slot {slot} is busy: could not take its admission lock in time") from error
    except (psycopg.OperationalError, procrastinate_exceptions.ConnectorException) as error:
        raise Unavailable(str(error)) from error
    return job


_EXTRACTION = """
SELECT x.id, x.run_id, x.created, x.request, x.generation, x.job_id, job.status, x.finished, x.error
FROM kei_extraction x LEFT JOIN procrastinate_jobs job ON job.id = x.job_id
"""


def _extraction_row(row: tuple) -> ExtractionRow:
    return ExtractionRow(id=row[0], run_id=row[1], created=row[2], request=row[3], generation=row[4], job_id=row[5],
                         job_status=row[6], finished=row[7], error=row[8])


def extraction(extraction_id: str) -> ExtractionRow | None:
    with connection() as conn:
        row = conn.execute(f"{_EXTRACTION} WHERE x.id = %s", (extraction_id,)).fetchone()
    return _extraction_row(row) if row else None


def extractions_of(run_id: str) -> list[ExtractionRow]:
    """The run's extractions, newest first. The id breaks a tie: two admitted in the same transaction (or
    inside one clock tick) would otherwise come back in whatever order the scan happened to produce."""
    with connection() as conn:
        rows = conn.execute(f"{_EXTRACTION} WHERE x.run_id = %s ORDER BY x.created DESC, x.id DESC",
                            (run_id,)).fetchall()
    return [_extraction_row(row) for row in rows]


def extraction_finished(extraction_id: str, error: str | None) -> None:
    """Stamp how the extraction ended. `ValueError` when it matched no row."""
    with connection() as conn:
        cursor = conn.execute("UPDATE kei_extraction SET finished = now(), error = %s WHERE id = %s",
                              (error, extraction_id))
        if cursor.rowcount == 0:
            raise ValueError(f"extraction_finished matched no row for {extraction_id!r}")
        conn.commit()


def append_events(run_id: str, attempt: int, events: list[Event]) -> list[Event]:
    """Number `events` and insert them in one transaction; return them with their `seq` and `attempt`.

    The allocator row is updated first, which takes its row lock for the rest of the transaction, so a second
    emitter of the same run waits there and cannot commit a lower number after a higher one. Emitters of other
    runs touch other rows and never wait.
    """
    if not events:
        return []
    with connection() as conn, conn.transaction():
        (start,) = conn.execute(
            "UPDATE kei_event_seq SET next = next + %s WHERE run_id = %s RETURNING next - %s",
            (len(events), run_id, len(events))).fetchone()
        # seq and attempt are the allocator's to decide, not a producer's: they go last so they override
        # anything of the same name an event dict happens to already carry (e.g. runs.Job._record's own
        # in-process "seq" field), rather than silently losing to it.
        numbered = [{**event, "seq": start + offset, "attempt": attempt}
                    for offset, event in enumerate(events)]
        conn.cursor().executemany(
            "INSERT INTO kei_event (run_id, seq, attempt, body) VALUES (%s, %s, %s, %s)",
            [(run_id, event["seq"], attempt, json.dumps(event, ensure_ascii=False)) for event in numbered])
        for event in events:
            if event["type"] == "phase":
                # Record the boundary with its event, on the same database clock as the attempt's duration.
                # Consecutive repeats (e.g. cut per page) remain one interval. No token history is needed
                # when the runs table polls these timings.
                conn.execute(
                    "UPDATE kei_attempt SET phases = phases || jsonb_build_array(jsonb_build_object("
                    "'step', %s::text, 'elapsed', extract(epoch FROM clock_timestamp() - started))) "
                    "WHERE run_id = %s AND attempt = %s AND finished IS NULL "
                    "AND phases->-1->>'step' IS DISTINCT FROM %s",
                    (event["name"], run_id, attempt, event["name"]))
    return numbered


def events_after(run_id: str, after: int, *, event_type: str | None = None,
                 limit: int = EVENT_PAGE) -> list[Event]:
    """The run's committed events with a sequence greater than `after`, in order, at most `limit` of them; only
    those of `event_type` when given (e.g. "region", for a caller like `api.run_page_boxes` that never looks at
    anything else).

    A full page may not be the end of the history: a caller that wants all of it asks again from the last
    sequence it received, until a page comes back short (`api._committed`).
    """
    query = "SELECT body FROM kei_event WHERE run_id = %s AND seq > %s"
    params: list[str | int] = [run_id, after]
    if event_type is not None:
        query += " AND body->>'type' = %s"
        params.append(event_type)
    params.append(limit)
    with connection() as conn:
        rows = conn.execute(f"{query} ORDER BY seq LIMIT %s", params).fetchall()
    return [row[0] for row in rows]


def last_event_id(run_id: str) -> int:
    """Anchor a new emitter's first tokens when it has not yet emitted a control event."""
    with connection() as conn:
        (seq,) = conn.execute("SELECT next - 1 FROM kei_event_seq WHERE run_id = %s", (run_id,)).fetchone()
    return seq


def attempt_started(run_id: str, attempt: int, job_id: int) -> None:
    with connection() as conn:
        conn.execute("INSERT INTO kei_attempt (run_id, attempt, job_id, phases) "
                     "VALUES (%s, %s, %s, '[{\"step\": \"prepare\", \"elapsed\": 0}]') "
                     "ON CONFLICT (run_id, attempt) DO UPDATE SET started = now(), finished = NULL, "
                     "status = NULL, error = NULL, phases = EXCLUDED.phases", (run_id, attempt, job_id))
        conn.commit()


def attempt_finished(run_id: str, attempt: int, status: str, error: str | None) -> None:
    """Record how the attempt ended. Raises `ValueError` if it matched no row: a lost or mismatched attempt
    must not be allowed to look recorded."""
    with connection() as conn:
        cursor = conn.execute("UPDATE kei_attempt SET finished = now(), status = %s, error = %s "
                              "WHERE run_id = %s AND attempt = %s", (status, error, run_id, attempt))
        if cursor.rowcount == 0:
            raise ValueError(f"attempt_finished matched no row for run {run_id!r} attempt {attempt}")
        conn.commit()


def finish_run(run_id: str) -> None:
    """Stamp the run as over. The job's own status stays Procrastinate's; this is only when it stopped mattering."""
    with connection() as conn:
        conn.execute("UPDATE kei_run SET finished = now() WHERE id = %s AND finished IS NULL", (run_id,))
        conn.commit()


def cancel_requested(run_id: str) -> bool:
    with connection() as conn:
        row = conn.execute("SELECT cancel_requested FROM kei_run WHERE id = %s", (run_id,)).fetchone()
    return bool(row and row[0])
