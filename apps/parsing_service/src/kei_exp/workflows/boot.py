"""kei's boot timestamp: the database clock, read after this process took its slot and before DBOS launched.

Lanes run beside cleanup, so no queue excludes a cancelled native step that may still write (spec, *kei boot
boundary*). The flock proves the previous kei process has exited; a workflow it cancelled, or that exceeded its
recovery attempts, was stamped `updated_at` from the database clock before this instant, so its steps can no longer
write. deleteRuns compares with this value only (M0R 4: Python-side cancels and deadlines stamp the database clock).
"""
from __future__ import annotations

import psycopg

BOOT_CLOCK_SQL = "select (extract(epoch from clock_timestamp()) * 1000)::bigint"
_timestamp_ms: int | None = None


def database_clock_ms(database_url: str) -> int:
    with psycopg.connect(database_url, autocommit=True, connect_timeout=10) as connection:
        return int(connection.execute(BOOT_CLOCK_SQL).fetchone()[0])


def set_timestamp(value_ms: int) -> None:
    global _timestamp_ms
    _timestamp_ms = value_ms


def timestamp_ms() -> int:
    if _timestamp_ms is None:
        raise RuntimeError("the kei boot timestamp is read by `kei-worker worker` before DBOS launches")
    return _timestamp_ms
