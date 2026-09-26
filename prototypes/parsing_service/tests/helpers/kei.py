"""kei's DBOS worker inside this test process, on one fresh disposable database: the registered workflows, the four
lanes polled every 0.1 s, the boot timestamp, and a portable client that enqueues as Studio will (M4)."""
from __future__ import annotations

import hashlib
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
from dbos import DBOS, DBOSClient, EnqueueOptions, WorkflowSerializationFormat

from kei_exp import runs
from kei_exp.workflows import boot, config
from tests.helpers import postgres as postgres_helper
from tests.helpers.fake import FakeTranscriber

TERMINAL = ("SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED")


def until(predicate: Callable[[], Any], timeout: float, what: str) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if found := predicate():
            return found
        time.sleep(0.02)
    raise AssertionError(f"{what} did not happen within {timeout} s")


@dataclass
class Kei:
    url: str
    client: DBOSClient
    runs: Path
    inbox: Path

    def enqueue(self, workflow: str, queue: str, workflow_id: str, request: dict, *, priority: int | None = None,
                timeout_ms: int | None = None) -> str:
        options: EnqueueOptions = {"workflow_name": workflow, "queue_name": queue, "workflow_id": workflow_id,
                                   "application_name": config.APP_NAME,
                                   "serialization_type": WorkflowSerializationFormat.PORTABLE}
        if priority is not None:
            options["priority"] = priority
        if timeout_ms is not None:
            options["workflow_timeout"] = timeout_ms / 1000  # Python takes seconds; Studio's client milliseconds
        return self.client.enqueue(options, request).get_workflow_id()

    def status(self, workflow_id: str):
        return DBOS.get_workflow_status(workflow_id)

    def wait(self, workflow_id: str, statuses: tuple[str, ...] = TERMINAL, timeout: float = 60.0):
        return until(lambda: (s := self.status(workflow_id)) is not None and s.status in statuses and s,
                     timeout, f"{workflow_id} reaching {statuses}")

    def output(self, workflow_id: str, timeout: float = 60.0) -> dict:
        status = self.wait(workflow_id, timeout=timeout)
        assert status.status == "SUCCESS", (status.status, status.error)
        return status.output

    def steps(self, workflow_id: str) -> list[str]:
        return [step["function_name"] for step in DBOS.list_workflow_steps(workflow_id)]

    def row(self, workflow_id: str) -> dict:
        with psycopg.connect(self.url) as connection:
            cursor = connection.execute("select * from kei_dbos.workflow_status where workflow_uuid = %s",
                                        (workflow_id,))
            names = [column.name for column in cursor.description]
            return dict(zip(names, cursor.fetchone(), strict=True))

    def db_now_ms(self) -> int:
        return boot.database_clock_ms(self.url)


@contextmanager
def launched_url(url: str, root: Path, monkeypatch) -> Iterator[Kei]:
    import kei_exp.workflows.registered  # noqa: F401 - registered once per test session, before any launch
    (root / "runs").mkdir(exist_ok=True)
    (root / "inbox").mkdir(exist_ok=True)
    monkeypatch.setattr(runs, "RUNS", root / "runs")
    monkeypatch.setattr(runs, "INBOX", root / "inbox")
    DBOS.destroy()
    boot.set_timestamp(boot.database_clock_ms(url))
    DBOS(config=config.dbos_config(url, "test", log_level="WARNING"))
    DBOS.launch()
    config.register_queues(polling_interval_sec=0.1)
    client = DBOSClient(system_database_url=url, dbos_system_schema=config.SCHEMA, application_name=config.APP_NAME)
    try:
        yield Kei(url, client, root / "runs", root / "inbox")
    finally:
        client.destroy()
        DBOS.destroy()


@contextmanager
def launched(conninfo: str, root: Path, monkeypatch) -> Iterator[Kei]:
    with launched_url(postgres_helper.url(conninfo), root, monkeypatch) as kei:
        yield kei


def stage_pdf(inbox: Path, relative: str, *masks) -> str:
    """An image-only PDF (no text layer, so the model path runs) staged as Studio will; its SHA-256."""
    from tests.helpers.pdfs import binary_pdf
    path = inbox / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    binary_pdf(path, *masks)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def convert_request(source: str, sha: str, **overrides) -> dict:
    return {"source": source, "source_sha256": sha, "source_name": Path(source).name, "page_source": "pdf",
            "ingest": None, "model": None, "layout_model": None, "cut": "auto", "debug": False, **overrides}


def converted_run(runs_root: Path, workflow_id: str, case: str = "headings") -> str:
    """A finished conversion as prepare_run and convert_run leave it: a verified catalogue result and params.json."""
    from tests.helpers import catalogue
    run_id = runs.run_id_for(workflow_id)
    directory = runs_root / run_id
    catalogue.write(case, directory)
    runs.write_json(directory / "params.json", {"id": run_id, "workflow_id": workflow_id,
                                                "page_source": "pdf", "model": "surya"})
    return run_id


def extract_request(run_id: str, generation: str) -> dict:
    from tests.test_extract_grounded import SCHEMA
    return {"run_id": run_id, "generation": generation, "request": {"schema": SCHEMA, "options": {
        "strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}}}}


class Gate:
    """Holds chosen workflows' steps inside a native-like call until released; records when each entered and left.
    Keyed by DBOS.workflow_id, which only a sync step's own thread carries: Catalog chunk threads have none, so
    tests keep KEI_CATALOG_CHUNKS unset (1) when a chat double calls a gate."""
    def __init__(self) -> None:
        self.entered: dict[str, float] = {}
        self.left: dict[str, float] = {}
        self._held: dict[str, threading.Event] = {}

    def hold(self, workflow_id: str) -> None:
        self._held[workflow_id] = threading.Event()

    def release(self, workflow_id: str) -> None:
        self._held[workflow_id].set()

    def release_all(self) -> None:
        for event in self._held.values():
            event.set()

    def __call__(self) -> None:
        workflow_id = DBOS.workflow_id
        self.entered[workflow_id] = time.monotonic()
        if (event := self._held.get(workflow_id)) is not None:
            event.wait(timeout=120)
        self.left[workflow_id] = time.monotonic()


class BlockingTranscriber(FakeTranscriber):
    def __init__(self, gate: Gate) -> None:
        super().__init__()
        self.gate = gate

    def transcribe(self, execution, crops, emit):
        self.gate()
        return super().transcribe(execution, crops, emit)
