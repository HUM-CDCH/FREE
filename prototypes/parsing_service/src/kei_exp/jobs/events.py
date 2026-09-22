"""Progress/lifecycle events in PostgreSQL, token previews in a shared JSONL file.

Tokens flush after 50 ms or 4 KiB of UTF-8 text, and before every control event. The emitter's lock orders
concurrent producers and the timer. Each control commit records the preceding token-file offset; each token
names the preceding committed event. Together these positions order SSE replay without token DB writes.
"""
from __future__ import annotations

import logging
import threading

from kei_exp import runs
from kei_exp.jobs import store
from kei_exp.jobs.tokens import TokenLog
from kei_exp.progress import Event

logger = logging.getLogger(__name__)

FLUSH_INTERVAL = 0.050
TOKEN_BYTES = 4096


class DurableEmit:
    """An `Emit` writing one attempt's progress and previews, under the single worker slot's file lock.

    The lock covers both buffering and commits, so a timer or another producer cannot overtake a control
    event. A timer failure is raised by the next emit/flush, just like a synchronous write failure.

    Reporting is best-effort against the database alone: an unreachable store loses the events it cannot take
    (and the phase timing `append_events` records with them), never the conversion that is producing the run's
    real output. A token-file failure is still the caller's, since that file is this host's own disk.
    """

    def __init__(self, run_id: str, attempt: int) -> None:
        self.run_id = run_id
        self.attempt = attempt
        self._tokens = TokenLog(runs.RUNS / run_id / "tokens.jsonl")
        self._seq: int | None = None
        self._lock = threading.Lock()
        self._pending: list[Event] = []
        self._bytes = 0
        self._timer: threading.Timer | None = None
        self._error: Exception | None = None
        self._closed = False
        self._outage = False

    def __call__(self, event: Event) -> None:
        with self._lock:
            self._check()
            if event["type"] != "token":
                self._flush_locked()
                # If the commit succeeds but its acknowledgement is lost, a later producer must reload
                # the anchor rather than attach tokens to the event preceding that uncertain commit.
                self._seq = None
                try:
                    saved = store.append_events(self.run_id, self.attempt,
                                                [{**event, "token_offset": self._tokens.offset}])
                except store.Unavailable as error:
                    self._unavailable(error)
                    return
                self._outage = False  # this store answered: the next outage is a new one, worth its own line
                self._seq = saved[0]["seq"]
                return
            if self._seq is None:
                try:
                    self._seq = store.last_event_id(self.run_id)
                except store.Unavailable as error:
                    self._unavailable(error)
                    # Unanchored, like a token emitted before this run's first control event. Sticky until a
                    # control event commits again, so an outage costs one lookup rather than one per token.
                    self._seq = -1
                else:
                    # A page can run for a long time between two control events. While it does, this lookup is
                    # the only call that can see the store come back, so it re-arms the report as a commit does.
                    self._outage = False
            self._pending.append({**event, "seq": self._seq, "attempt": self.attempt})
            self._bytes += len(event["text"].encode("utf-8"))
            if self._bytes >= TOKEN_BYTES:
                self._flush_locked()
            elif self._timer is None:
                self._timer = threading.Timer(FLUSH_INTERVAL, self._flush_timed)
                self._timer.daemon = True
                self._timer.start()

    def flush(self) -> None:
        """Flush pending tokens and surface timer failures before the task reports success."""
        with self._lock:
            self._check()
            self._flush_locked()

    def close(self) -> None:
        """Stop the timer on every task exit. On success the caller has already flushed; on failure any
        remaining provisional tokens are discarded, never written after the attempt exits."""
        with self._lock:
            self._closed = True
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._pending.clear()
            self._bytes = 0

    def _unavailable(self, error: Exception) -> None:
        """Report an outage once, not once per event it swallows: a database that is down is down for many of
        them. The next committed event arms the report again, so a second outage is its own line."""
        if not self._outage:
            self._outage = True
            logger.warning("run %s attempt %s: dropping progress events while the store is unavailable (%s)",
                           self.run_id, self.attempt, error)

    def _check(self) -> None:
        if self._closed:
            raise RuntimeError("event emitter is closed")
        if self._error is not None:
            error, self._error = self._error, None
            raise error

    def _flush_timed(self) -> None:
        with self._lock:
            # cancel() may race a callback already waiting on the lock. That old timer must not flush or
            # cancel a newer batch's timer.
            if threading.current_thread() is not self._timer:
                return
            try:
                self._flush_locked()
            except Exception as error:  # noqa: BLE001 - relay the timer's failure to the conversion thread
                self._error = error

    def _flush_locked(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        pending, self._pending = self._pending, []
        self._bytes = 0
        if pending:
            self._tokens.append(pending)
