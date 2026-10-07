"""Cooperative cancellation inside a step. DBOS cannot interrupt a native call, and a cancelled workflow's running step
keeps its lane's slot until it returns, so a conversion asks at its boundaries: twice before model work, at every
spread of the ingest and every page event of the cut (on the step's own thread, never inside a transcriber's pool). A
native call that is already running finishes first (spec, *Cancellation*). Durable Extraction attempts stop at their
coordination lease boundaries instead (`durable_extract`).

A status read that fails is not a cancel: dbos 3.1.0 does not retry reads, so a PostgreSQL restart reaches the step
here, and kei's fail-open policy (spec, *Cancellation*) keeps the work going; the next check reads again. DBOS's own
errors are the exception: after a SIGTERM, DBOS.destroy() makes every read raise one, and the step stops at its next
check (nothing is recorded after destroy, so recovery runs it again)."""
from __future__ import annotations

import logging
import threading
import time

from dbos import DBOS
from dbos import error as dbos_error

from kei_exp.failures import KeiFailure
from kei_exp.progress import Emit, Event

logger = logging.getLogger(__name__)

MIN_INTERVAL = 1.0  # seconds between two status reads of one step
CHECKED = frozenset({"region", "phase", "spread"})  # the events a conversion's own thread emits as it goes


class CancelCheck:
    def __init__(self, workflow_id: str, *, min_interval: float | None = None) -> None:
        # Off outside a DBOS workflow (the CLI, a unit test calling a step directly). Decided on the step's thread:
        # a worker thread carries no DBOS context, so the ID is kept here for reads from any thread.
        self._workflow_id = workflow_id if DBOS.workflow_id is not None else None
        self._owner = threading.get_ident()
        self._interval = MIN_INTERVAL if min_interval is None else min_interval
        self._lock = threading.Lock()
        self._next = 0.0
        self._warned = False

    def __call__(self, *, force: bool = False) -> None:
        """Raise KeiFailure('cancelled') once the workflow is cancelled (explicitly or by its deadline)."""
        if self._workflow_id is None:
            return
        with self._lock:
            now = time.monotonic()
            if not force and now < self._next:
                return
            self._next = now + self._interval
        try:
            status = DBOS.get_workflow_status(self._workflow_id)  # inside a step: read, never checkpointed
        except dbos_error.DBOSException:
            raise
        except Exception as error:  # noqa: BLE001 - fail open; the driver's message may quote the URL, never logged
            with self._lock:
                warned, self._warned = self._warned, True
            if not warned:
                logger.warning("the status of %s could not be read (%s); the step goes on and asks again at its "
                               "next check", self._workflow_id, type(error).__name__)
            return
        if status is None or status.status == "CANCELLED":
            raise KeiFailure("cancelled", f"workflow {self._workflow_id} was cancelled")

    def sink(self, emit: Emit) -> Emit:
        def checked(event: Event) -> None:
            if threading.get_ident() == self._owner and event["type"] in CHECKED:
                self()
            emit(event)
        return checked
