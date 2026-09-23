"""The extraction routes: admission against a finished run, the status a client polls, the artifact it reads,
and one extraction driven through a real Procrastinate worker across a transient failure and its retry."""
import dataclasses
import json
from pathlib import Path

import procrastinate
import pytest
import requests
from fastapi.testclient import TestClient

from kei_exp import api, runs
from kei_exp.jobs import schema, store, tasks
from kei_exp.jobs.app import app as jobs
from kei_exp.jobs.app import queue_of
from kei_exp.pagefile import read_manifest
from kei_exp.result import write_result
from tests.helpers.chat import FakeChat
from tests.helpers.slot import until
from tests.helpers.synthetic import cases
from tests.test_jobs_extraction import TREE, script


def complete_result(pdf: Path, directory: Path) -> None:
    """The hand-built case with its first page's `incomplete` reason cleared, as tests/test_jobs_extraction's
    `parsed` does: left in, it makes the whole manifest incomplete, and the route rightly refuses the run."""
    run = cases()["hand-built"](pdf, directory)
    first, *rest = run.outcome.pages
    outcome = dataclasses.replace(run.outcome, pages=[dataclasses.replace(first, incomplete=None), *rest])
    write_result(outcome, run.execution, run.inventory, run.source, ingest_digest=run.ingest_digest,
                 directory=directory / "result")


@pytest.fixture
def client(database: str, tmp_path: Path, digital_pdf: Path, monkeypatch) -> TestClient:
    """The API over a store holding one admitted run with a complete result, plus a historical file-only run."""
    schema.apply(database)
    store.close_pool()
    store.pool(database)
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    # As in tests/test_api_jobs.py: the lifespan opens (here, confirms) the pool by this name and installs the
    # deferring connector, so it must name the pool already open for this test's throwaway database.
    monkeypatch.setattr(api, "DATABASE_URL", database)
    for name in ("run-p", "run-h"):
        complete_result(digital_pdf, tmp_path / name)
        runs.write_json(tmp_path / name / "params.json", {"id": name, "created": runs.now()})
    runs.write_json(tmp_path / "run-h" / "status.json", {"status": "done"})  # a historical run: files only
    with TestClient(api.app) as test_client:
        store.admit("run-p", {"id": "run-p"}, slot=api.SLOT)
        yield test_client
    store.close_pool()


def test_a_finished_run_admits_an_extraction_and_answers_202(client, tmp_path):
    response = client.post("/api/runs/run-p/extract", json={"schema": TREE})
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["run_id"] == "run-p" and body["status"] == "queued" and body["generation"]
    row = store.extraction(body["id"])
    assert row.run_id == "run-p"
    # The generation the 202 reports is the one the job is pinned to, not merely the one the route happened to
    # read: a result rewritten before the job runs is refused rather than silently extracted from.
    assert row.generation == body["generation"] == read_manifest(tmp_path / "run-p" / "result").generation
    listed = client.get("/api/runs/run-p/extractions").json()
    assert [item["id"] for item in listed] == [body["id"]] and listed[0]["status"] == "queued"


def test_the_status_route_serves_the_artifact_once_the_job_is_done(client, tmp_path, monkeypatch):
    extraction_id = client.post("/api/runs/run-p/extract", json={"schema": TREE}).json()["id"]
    pending = client.get(f"/api/runs/run-p/extractions/{extraction_id}").json()
    assert pending["status"] == "queued" and pending["result"] is None and pending["error"] is None
    monkeypatch.setattr(tasks, "chat_for", lambda options: FakeChat(script))
    tasks.execute_extraction(extraction_id)
    with store.connection() as conn:  # the worker would have moved the job; stand in for it
        conn.execute("UPDATE procrastinate_jobs SET status = 'succeeded' WHERE id = %s",
                     (store.extraction(extraction_id).job_id,))
        conn.commit()
    done = client.get(f"/api/runs/run-p/extractions/{extraction_id}").json()
    assert done["status"] == "done" and done["finished"] and done["error"] is None
    artifact = tmp_path / "run-p" / "extractions" / extraction_id / "result.json"
    assert done["result"] == json.loads(artifact.read_text(encoding="utf-8"))


def test_a_failed_job_reports_its_error_and_no_result(client, monkeypatch):
    extraction_id = client.post("/api/runs/run-p/extract", json={"schema": TREE}).json()["id"]
    store.extraction_finished(extraction_id, "model server down")
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'failed' WHERE id = %s",
                     (store.extraction(extraction_id).job_id,))
        conn.commit()
    failed = client.get(f"/api/runs/run-p/extractions/{extraction_id}").json()
    assert failed["status"] == "failed" and failed["error"] == "model server down" and failed["result"] is None


def test_a_retrying_job_shows_neither_the_failed_attempts_finish_nor_its_error(client):
    """The row keeps a failed attempt's stamp until the retry ends; the job's status is what the client sees."""
    extraction_id = client.post("/api/runs/run-p/extract", json={"schema": TREE}).json()["id"]
    store.extraction_finished(extraction_id, "model server down")  # the first attempt; the job is queued again
    for job_status, status in (("todo", "queued"), ("doing", "running")):
        with store.connection() as conn:
            conn.execute("UPDATE procrastinate_jobs SET status = %s WHERE id = %s",
                         (job_status, store.extraction(extraction_id).job_id))
            conn.commit()
        retrying = client.get(f"/api/runs/run-p/extractions/{extraction_id}").json()
        assert retrying["status"] == status and retrying["finished"] is None and retrying["error"] is None
        listed = client.get("/api/runs/run-p/extractions").json()
        assert listed[0]["finished"] is None and listed[0]["error"] is None


def run_the_queue(database: str) -> None:
    """This slot's queue through the deployment's own worker, in this process, until nothing is due.

    `worker.serve()`'s machinery without its slot lock and its `wait=True`: the same app, the same connector,
    the same `run_worker`, so Procrastinate fetches the job, runs the task, applies `extract_run`'s own
    `RetryStrategy` and moves `procrastinate_jobs` itself — none of which a test that calls
    `execute_extraction` directly or moves the job status by hand SQL exercises. In process rather than the
    `tests/helpers/slot.worker` child the recovery tests spawn, because this test's first attempt has to fail
    on command: the chat is monkeypatched, and a child process cannot be. `wait=False` makes the worker stop
    once nothing is fetchable, which is what lets the test look at the queued retry between the attempts.
    """
    connector = procrastinate.PsycopgConnector(conninfo=database)
    with jobs.replace_connector(connector) as scoped, scoped.open():
        scoped.run_worker(queues=[queue_of(api.SLOT)], name="kei-test", concurrency=1, wait=False,
                          listen_notify=False, install_signal_handlers=False)


def test_the_worker_retries_a_transient_failure_and_the_client_only_ever_sees_a_queued_extraction(
        client, database, tmp_path, monkeypatch):
    """The retry rule end to end, through Procrastinate rather than by hand.

    Three parts have to agree for `GET .../extractions/{id}` to stay honest across a retry: `execute_extraction`
    stamps `finished`/`error` even on a failure it raises as retryable, the task's `RetryStrategy` puts the job
    back to `todo`, and the second attempt's success clears that stale stamp through `extraction_finished(id,
    None)`. Here the first attempt's chat refuses the connection and the second answers, and the client sees
    `queued` with no `finished` and no `error` in between — never the failed attempt's leftovers.
    """
    answers = []

    def flaky(system, user, schema):
        answers.append(user)
        if len(answers) == 1:  # a model server still loading: the one failure class that is retried
            raise requests.ConnectionError("the extraction server is unreachable")
        return script(system, user, schema)

    monkeypatch.setattr(tasks, "chat_for", lambda options: FakeChat(flaky))
    assert tasks.extract_run.retry_strategy.max_attempts == 2, "the deployed budget this test spends"
    assert tasks.TransientBackendError in tasks.extract_run.retry_strategy.retry_exceptions
    extraction_id = client.post("/api/runs/run-p/extract", json={"schema": TREE}).json()["id"]
    job_id = store.extraction(extraction_id).job_id

    run_the_queue(database)  # the first attempt fails; its own strategy re-queues the job
    with store.connection() as conn:
        (status, attempts) = conn.execute("SELECT status, attempts FROM procrastinate_jobs WHERE id = %s",
                                          (job_id,)).fetchone()
    assert (status, attempts) == ("todo", 1), "Procrastinate itself put the job back for a second attempt"
    row = store.extraction(extraction_id)
    assert row.finished is not None and "unreachable" in row.error  # the stale stamp the client must not see
    queued = client.get(f"/api/runs/run-p/extractions/{extraction_id}").json()
    assert queued["status"] == "queued" and queued["finished"] is None and queued["error"] is None
    assert queued["result"] is None
    assert client.get("/api/runs/run-p/extractions").json()[0]["error"] is None

    def due() -> bool:  # the strategy's own delay, waited out on the row it wrote, not on a duration
        with store.connection() as conn:
            (ready,) = conn.execute("SELECT scheduled_at <= now() FROM procrastinate_jobs WHERE id = %s",
                                    (job_id,)).fetchone()
        return bool(ready)

    until(due, timeout=60, what="the retry becoming due")
    run_the_queue(database)  # the second attempt: the same job, a chat that answers

    done = client.get(f"/api/runs/run-p/extractions/{extraction_id}").json()
    assert done["status"] == "done" and done["finished"] and done["error"] is None
    assert done["result"]["records"], "the artifact the retry published is what the route serves"
    row = store.extraction(extraction_id)
    assert row.error is None and row.finished is not None  # the failed attempt's stamp was cleared
    artifact = tmp_path / "run-p" / "extractions" / extraction_id / "result.json"
    assert done["result"] == json.loads(artifact.read_text(encoding="utf-8"))
    with store.connection() as conn:
        (status,) = conn.execute("SELECT status FROM procrastinate_jobs WHERE id = %s", (job_id,)).fetchone()
    assert status == "succeeded" and len(answers) > 1, "both attempts really ran"


def test_an_extraction_is_read_only_under_its_own_run(client):
    extraction_id = client.post("/api/runs/run-p/extract", json={"schema": TREE}).json()["id"]
    assert client.get(f"/api/runs/run-h/extractions/{extraction_id}").status_code == 404
    assert client.get("/api/runs/run-p/extractions/x-nope").status_code == 404
    assert client.get("/api/runs/no-such-run/extractions").status_code == 404


def test_a_historical_file_only_run_cannot_be_extracted(client):
    response = client.post("/api/runs/run-h/extract", json={"schema": TREE})
    assert response.status_code == 404 and "store" in response.json()["detail"]


def test_a_run_without_a_complete_result_is_refused(client, tmp_path, digital_pdf):
    run = cases()["capped"](digital_pdf, tmp_path / "run-c")
    write_result(run.outcome, run.execution, run.inventory, run.source, ingest_digest=run.ingest_digest,
                 directory=tmp_path / "run-c" / "result")
    runs.write_json(tmp_path / "run-c" / "params.json", {"id": "run-c", "created": runs.now()})
    store.admit("run-c", {"id": "run-c"}, slot=api.SLOT)
    assert client.post("/api/runs/run-c/extract", json={"schema": TREE}).status_code == 409
    (tmp_path / "run-c" / "result" / "result.json").unlink()
    assert client.post("/api/runs/run-c/extract", json={"schema": TREE}).status_code == 409


def test_a_malformed_body_is_refused_before_admission(client):
    assert client.post("/api/runs/run-p/extract", json={"schema": {"recordDescription": "x", "schemaNodes": [
        {"id": "a", "name": "a", "type": "array"}]}}).status_code == 422
    assert client.post("/api/runs/run-p/extract", json={"options": {}}).status_code == 422
    schema_ = {"recordDescription": "x", "schemaNodes": [{"id": "a", "name": "a", "type": "string"}]}
    for options in ({"strategy": "catalog", "catalog": {"recipe": "no-such-recipe@1"}},
                    {"strategy": "article", "catalog": {"recipe": "numbered-catalogue-de@1"}}):
        assert client.post("/api/runs/run-p/extract", json={"schema": schema_, "options": options}).status_code == 422
    assert store.extractions_of("run-p") == []


def test_an_unreachable_store_answers_503(client, monkeypatch):
    def down(*args, **kwargs):
        raise store.Unavailable("refused")
    monkeypatch.setattr(store, "admit_extraction", down)
    monkeypatch.setattr(store, "extraction", down)
    monkeypatch.setattr(store, "extractions_of", down)
    assert client.post("/api/runs/run-p/extract", json={"schema": TREE}).status_code == 503
    assert client.get("/api/runs/run-p/extractions/x-1").status_code == 503
    listing = client.get("/api/runs/run-p/extractions")
    assert (listing.status_code, listing.headers.get("retry-after")) == (503, "1")
