"""Cooperative cancellation inside a step. DBOS cannot interrupt a native call, and a cancelled workflow's running step
keeps its lane's slot until it returns, so steps ask at their boundaries: twice before model work, at every page event
of the cut (on the step's own thread, never inside a transcriber's pool), and between the records of an extraction
(before every Catalog entry, from its chunk threads too). A native call that is already running finishes first (spec,
*Cancellation*)."""
from __future__ import annotations

import threading
import time

from dbos import DBOS

from kei_exp.failures import KeiFailure
from kei_exp.progress import Emit, Event

MIN_INTERVAL = 1.0  # seconds between two status reads of one step


class CancelCheck:
    def __init__(self, workflow_id: str, *, min_interval: float | None = None) -> None:
        # Off outside a DBOS workflow (the CLI, a unit test calling a step directly). Decided on the step's thread:
        # a chunk thread carries no DBOS context, so the ID is kept here for reads from any thread.
        self._workflow_id = workflow_id if DBOS.workflow_id is not None else None
        self._owner = threading.get_ident()
        self._interval = MIN_INTERVAL if min_interval is None else min_interval
        self._lock = threading.Lock()
        self._next = 0.0

    def __call__(self, *, force: bool = False) -> None:
        """Raise KeiFailure('cancelled') once the workflow is cancelled (explicitly or by its deadline)."""
        if self._workflow_id is None:
            return
        with self._lock:
            now = time.monotonic()
            if not force and now < self._next:
                return
            self._next = now + self._interval
        status = DBOS.get_workflow_status(self._workflow_id)  # inside a step: read, never checkpointed
        if status is None or status.status == "CANCELLED":
            raise KeiFailure("cancelled", f"workflow {self._workflow_id} was cancelled")

    def sink(self, emit: Emit) -> Emit:
        def checked(event: Event) -> None:
            if threading.get_ident() == self._owner and event["type"] in ("region", "phase"):
                self()
            emit(event)
        return checked
