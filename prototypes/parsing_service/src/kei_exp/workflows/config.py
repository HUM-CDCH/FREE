"""kei's DBOS application: its identity in the shared database `free`, its four lanes and its launch configuration.

kei owns schema kei_dbos and is its only writer of queue configuration: Studio's clients enqueue by name and never
call register_queue, whose default `always_update` from a client would overwrite these limits (spec, *Queues*).
"""
from __future__ import annotations

import os
from collections.abc import Mapping

from dbos import DBOS, DBOSConfig, Queue

APP_NAME = "kei"
SCHEMA = "kei_dbos"
APP_VERSION = "kei@1"  # fixed; a changed step sequence uses DBOS.patch(), a version bump needs a drain
SLOT = os.environ.get("KEI_SLOT", "slot-1")
CONVERT_LARGE, CONVERT_SMALL, EXTRACT, GC = "kei-convert-large", "kei-convert-small", "kei-extract", "kei-gc"
# Global limit == worker limit. dbos 3.1.0 counts a worker's concurrency from the process's in-memory set of active
# workflows, so a cancelled workflow whose native step still runs keeps its lane's slot until the step returns; a
# global limit alone is counted from PENDING rows, which a cancel changes at once (M0R 4, spec *Physical capacity*).
QUEUES: dict[str, int] = {CONVERT_LARGE: 1, CONVERT_SMALL: 1, EXTRACT: 2, GC: 1}
PRIORITY_INTERACTIVE, PRIORITY_BATCH = 1, 10  # kei-extract (durable attempts); dbos 3.1.0 orders by priority with no queue flag
MAX_RECOVERY_ATTEMPTS = 5  # a PDF that kills the worker must not crash-loop every lane (plan decision 5)
# Each Catalog chunk is a thread with one model request in flight. Compose sets the count to NuExtract's --max-num-seqs
# (default 4); a value past this bound is a typo, and would open that many threads and connections per Catalog.
MAX_CATALOG_CHUNKS = 64
# Developer tracing to Phoenix (docs/operations/local-development.md): DBOS exports its workflow and step spans and the
# extraction model calls under them; unset, nothing is traced. Traces only: logs keep their redacting filter.
TRACES_ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")


def catalog_chunks(environ: Mapping[str, str]) -> int:
    value = environ.get("KEI_CATALOG_CHUNKS", "1")
    try:
        chunks = int(value)
    except ValueError:
        chunks = 0
    if not 1 <= chunks <= MAX_CATALOG_CHUNKS:
        raise ValueError(f"KEI_CATALOG_CHUNKS must be an integer from 1 to {MAX_CATALOG_CHUNKS}, not {value!r}")
    return chunks


# The durable planner's Catalog chunk count, read once at worker import (a bad value fails the worker's boot).
CATALOG_CHUNKS = catalog_chunks(os.environ)


def executor_id(slot: str) -> str:
    return f"kei-{slot}"


def dbos_config(database_url: str, slot: str, *, log_level: str = "INFO") -> DBOSConfig:
    return {"name": APP_NAME, "system_database_url": database_url, "dbos_system_schema": SCHEMA,
            "application_version": APP_VERSION, "executor_id": executor_id(slot), "enable_patching": True,
            "log_level": log_level,
            **({"enable_otlp": True, "otlp_traces_endpoints": [TRACES_ENDPOINT]} if TRACES_ENDPOINT else {})}


def register_queues(*, polling_interval_sec: float = 1.0) -> dict[str, Queue]:
    """The four lanes; called after DBOS.launch()."""
    return {name: DBOS.register_queue(name, global_concurrency=limit, worker_concurrency=limit,
                                      polling_interval_sec=polling_interval_sec)
            for name, limit in QUEUES.items()}
