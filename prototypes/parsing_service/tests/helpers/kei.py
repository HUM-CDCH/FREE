"""kei's DBOS worker inside this test process, on one fresh disposable database: the registered workflows, the four
lanes polled every 0.1 s, the boot timestamp, and a portable client that enqueues as Studio will (M4)."""
from __future__ import annotations

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
