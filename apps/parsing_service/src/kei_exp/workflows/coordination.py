"""Protocol 1's bounded pool of short, restricted routine calls.

No connection, transaction or SQL lock spans a model request. The caller's
process lease is separate from the immutable attempt/capture attribution.
"""
from __future__ import annotations

import queue
import threading
from time import monotonic, sleep
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from kei_exp.workflows.storage_text import encode_storage, decode_storage

ROUTINES = frozenset({"capabilities", "claim", "heartbeat", "publish_plan", "capture_unit", "finalize_input",
                     "begin_call", "commit_output", "fail_call", "publish_snapshot", "acknowledge",
                     "resolve_selection", "read_call", "historical_coverage", "read_latest_snapshot", "read_attempt_outcome", "read_deleted_graph"})


class CoordinationPool:
    def __init__(self, url: str, maximum: int = 4):
        if not 1 <= maximum <= 4:
            raise ValueError("coordination pool size must be between 1 and 4")
        self._url = url
        self._slots = threading.BoundedSemaphore(maximum)
        self._idle: queue.LifoQueue = queue.LifoQueue()
        self.process = str(uuid4())

    def call(self, routine: str, *arguments):
        if routine not in ROUTINES:
            raise ValueError("unknown coordination routine")
        with self._slots:
            try:
                connection = self._idle.get_nowait()
            except queue.Empty:
                connection = psycopg.connect(self._url, row_factory=dict_row, connect_timeout=5)
            try:
                with connection.transaction():
                    connection.execute("SET LOCAL TRANSACTION ISOLATION LEVEL READ COMMITTED")
                    connection.execute("SET LOCAL lock_timeout = '5s'")
                    connection.execute("SET LOCAL statement_timeout = '10s'")
                    values = tuple(Jsonb(encode_storage(value)) if isinstance(value, (dict, list)) else value for value in arguments)
                    placeholders = ",".join("%s" for _ in arguments)
                    row = connection.execute(f"SELECT extraction_runtime.{routine}({placeholders}) AS value", values).fetchone()
                    return decode_storage(row["value"])
            except BaseException:
                connection.close()
                raise
            finally:
                if not connection.closed:
                    self._idle.put(connection)

    def ready(self):
        if self.call("capabilities") != {"protocol": 1}:
            raise ValueError("incompatible Extraction coordination protocol")

    def close(self):
        while True:
            try:
                self._idle.get_nowait().close()
            except queue.Empty:
                return


class Lease:
    def __init__(self, pool: CoordinationPool, extraction: str, attempt: str):
        self.pool, self.extraction, self.attempt = pool, extraction, attempt
        # DBOS resumes before a crashed process's 30-second lease expires.
        # Wait without holding a connection or stealing a live owner's epoch.
        # Stale attempts and all other refusals still fail immediately.
        deadline = monotonic() + 40
        while True:
            try:
                self.state = pool.call("claim", extraction, attempt, pool.process)
                break
            except psycopg.errors.LockNotAvailable:
                if monotonic() >= deadline:
                    raise
                sleep(0.25)
        self.epoch = self.state["epoch"]
        self._stop = threading.Event()
        self._error = None
        self._thread = threading.Thread(target=self._renew, name="extraction-lease", daemon=True)

    def _renew(self):
        while not self._stop.wait(5):
            try:
                self.pool.call("heartbeat", self.extraction, self.attempt, self.epoch)
            except Exception as error:
                self._error = error
                return

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        self._thread.join(timeout=15)

    def call(self, routine: str, *args):
        if self._error is not None:
            raise RuntimeError("Extraction lease renewal failed") from None
        return self.pool.call(routine, self.extraction, self.attempt, self.epoch, *args)
