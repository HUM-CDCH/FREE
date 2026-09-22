"""An extraction is admitted as one job of the run's slot, runs the stages over the run's result, and publishes
one artifact; a failure is recorded on its row. Over real PostgreSQL; the model is the scripted fake."""
import dataclasses
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests

from kei_exp import runs
from kei_exp.jobs import schema, store, tasks
from kei_exp.jobs.app import deferring_installed
from kei_exp.kie.extract.run import ExtractRequest
from kei_exp.pagefile import read_manifest
from kei_exp.result import write_result
from tests.helpers.chat import FakeChat
from tests.helpers.synthetic import cases

TREE = {"recordDescription": "A synthetic entry.", "schemaNodes": [
    {"id": "t", "name": "text", "type": "string"}, {"id": "f", "name": "filename", "type": "string",
                                                    "valueSource": "source-filename"}]}


@pytest.fixture
def parsed(database: str, tmp_path: Path, digital_pdf: Path, monkeypatch) -> str:
    """A store with one admitted run whose directory already holds a complete canonical result.

    Two departures from the synthetic case as `cases()` builds it, both so that the run is the one this fixture
    claims. Its first page's record carries an `incomplete` reason, which makes the whole manifest incomplete and
    `evidence.load`'s `require_complete=True` refuse it before a passage is read (tests/test_extract_evidence
    drops it the same way); and `synthetic.execution` names its source "scan.pdf", while this run is over
    `main.pdf` and the artifact's `source-filename` field is asserted below to be exactly that.
    """
    schema.apply(database)
    store.close_pool()
    store.pool(database)
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    run = cases()["hand-built"](digital_pdf, tmp_path / "run-p")
    first, *rest = run.outcome.pages
    outcome = dataclasses.replace(run.outcome, pages=[dataclasses.replace(first, incomplete=None), *rest])
    source = dataclasses.replace(run.source, name=digital_pdf.name)
    write_result(outcome, run.execution, run.inventory, source, ingest_digest=run.ingest_digest,
                 directory=tmp_path / "run-p" / "result")
    params = {"id": "run-p", "created": runs.now(), "source_name": source.name, "page_count": source.page_count,
              "model": "surya", "cut": "auto", "page_source": "pdf", "stream": False, "pages": None, "debug": False}
    runs.write_json(tmp_path / "run-p" / "params.json", params)
    with deferring_installed(database):
        store.admit("run-p", params, slot="slot-x")
        yield "run-p"
    store.close_pool()


def script(system, user, schema):
    if "records" in schema.get("properties", {}):
        return {"records": [{"text": "Grüße"}]}
    if "starts" in schema.get("properties", {}):
        return {"starts": ["B1"], "end": None}
    if "text" in schema.get("properties", {}):
        return {"text": "Grüße"}
    return {label: "NONE" for label in schema["properties"]}


def extraction_jobs() -> int:
    with store.connection() as conn:
        (count,) = conn.execute("SELECT count(*) FROM procrastinate_jobs WHERE task_name = 'extract_run'").fetchone()
    return count


def generation_of(run_id: str) -> str:
    """The generation the run's result currently names: what an admission pins its extraction to."""
    return read_manifest(runs.RUNS / run_id / "result").generation


def test_an_extraction_is_admitted_with_its_own_job_on_the_runs_queue(parsed):
    """The queue is the run's own slot's, read from its row — never this process's `KEI_SLOT`."""
    assert store.SLOT != "slot-x", "the fixture's run is deliberately not on this process's default slot"
    job = store.admit_extraction("x-1", parsed, {"schema": TREE, "options": {}}, generation=generation_of(parsed))
    row = store.extraction("x-1")
    assert row is not None and row.run_id == parsed and row.job_id == job and row.job_status == "todo"
    assert row.request["schema"] == TREE and row.finished is None and row.error is None
    # The generation the admission was made against is the row's, not re-read at attempt time: an extraction
    # is a reference into one parse, and the artifact's evidence only resolves in that one.
    assert row.generation == generation_of(parsed)
    assert [r.id for r in store.extractions_of(parsed)] == ["x-1"]
    with store.connection() as conn:
        (queue, task) = conn.execute("SELECT queue_name, task_name FROM procrastinate_jobs WHERE id = %s",
                                     (job,)).fetchone()
    assert queue == "runs-slot-x" and task == "extract_run"


def test_an_unknown_run_or_a_repeated_id_is_refused_without_a_job(parsed):
    generation = generation_of(parsed)
    with pytest.raises(LookupError):
        store.admit_extraction("x-2", "no-such-run", {"schema": TREE}, generation=generation)
    store.admit_extraction("x-3", parsed, {"schema": TREE}, generation=generation)
    before = extraction_jobs()
    assert before == 1, "the unknown run deferred nothing"
    with pytest.raises(store.Duplicate):
        store.admit_extraction("x-3", parsed, {"schema": TREE}, generation=generation)
    assert extraction_jobs() == before, "the duplicate's job was rolled back with the row insert that refused it"
    assert store.extraction("x-2") is None


def test_the_slot_limit_counts_extractions_with_the_runs(parsed):
    with pytest.raises(store.Full):  # the run itself is unfinished
        store.admit_extraction("x-4", parsed, {"schema": TREE}, generation=generation_of(parsed), limit=1)


def test_the_task_runs_the_stages_and_publishes_the_artifact(parsed, tmp_path, monkeypatch):
    fake = FakeChat(script)
    monkeypatch.setattr(tasks, "chat_for", lambda options: fake)
    store.admit_extraction("x-5", parsed, ExtractRequest.model_validate({"schema": TREE}).model_dump(by_alias=True),
                           generation=generation_of(parsed))
    tasks.execute_extraction("x-5")
    artifact = tmp_path / parsed / "extractions" / "x-5" / "result.json"
    result = json.loads(artifact.read_text(encoding="utf-8"))
    assert result["records"] and result["records"][0]["filename"] == "main.pdf"
    assert result["run_id"] == parsed and result["fingerprint"]
    row = store.extraction("x-5")
    assert row.finished is not None and row.error is None
    assert fake.calls, "the scripted model was consulted"


def test_a_failed_extraction_records_its_error_and_raises_classified(parsed, monkeypatch):
    def refused(options):
        raise requests.ConnectionError("model server down")
    monkeypatch.setattr(tasks, "chat_for", refused)
    store.admit_extraction("x-6", parsed, {"schema": TREE}, generation=generation_of(parsed))
    with pytest.raises(tasks.TransientBackendError):
        tasks.execute_extraction("x-6")
    row = store.extraction("x-6")
    assert row.finished is not None and "model server down" in row.error


def test_an_extraction_server_answering_503_is_retried_while_a_400_fails_the_extraction(parsed, monkeypatch):
    """The whole path, not just `classify`: what `OpenAIChat` raises for a refusing server is a
    `requests.HTTPError`, and a loading or proxied vLLM answering 503 must keep its retry budget while a
    request that server will never accept fails the extraction with its status recorded."""
    def answering(status):
        def refuse(system, user, schema):
            raise requests.HTTPError(f"{status} Error: for url", response=SimpleNamespace(status_code=status))
        return refuse

    generation = generation_of(parsed)
    monkeypatch.setattr(tasks, "chat_for", lambda options: FakeChat(answering(503)))
    store.admit_extraction("x-9", parsed, {"schema": TREE}, generation=generation)
    with pytest.raises(tasks.TransientBackendError):
        tasks.execute_extraction("x-9")
    assert "503" in store.extraction("x-9").error

    monkeypatch.setattr(tasks, "chat_for", lambda options: FakeChat(answering(400)))
    store.admit_extraction("x-10", parsed, {"schema": TREE}, generation=generation)
    with pytest.raises(Exception) as caught:
        tasks.execute_extraction("x-10")
    assert not isinstance(caught.value, tasks.TransientBackendError)
    assert "400" in store.extraction("x-10").error


def test_an_incomplete_result_fails_the_extraction_directly(parsed, tmp_path, digital_pdf, monkeypatch):
    run = cases()["capped"](digital_pdf, tmp_path / "run-c")
    write_result(run.outcome, run.execution, run.inventory, run.source, ingest_digest=run.ingest_digest,
                 directory=tmp_path / "run-c" / "result")
    runs.write_json(tmp_path / "run-c" / "params.json", {"id": "run-c", "created": runs.now()})
    store.admit("run-c", {"id": "run-c"}, slot="slot-x")
    store.admit_extraction("x-7", "run-c", {"schema": TREE}, generation=generation_of("run-c"))
    monkeypatch.setattr(tasks, "chat_for", lambda options: FakeChat(script))
    with pytest.raises(Exception) as caught:
        tasks.execute_extraction("x-7")
    assert not isinstance(caught.value, tasks.TransientBackendError)
    assert "incomplete" in store.extraction("x-7").error


def test_a_result_rewritten_after_admission_fails_the_extraction_without_a_model_call(parsed, tmp_path,
                                                                                      digital_pdf, monkeypatch):
    """The admitted generation is the contract: a re-converted run is another parse, not this extraction's.

    The window README documents (a worker killed after `write_result` published a complete manifest but before
    Procrastinate marked the conversion done) re-queues the conversion, which mints a NEW generation under the
    same fingerprint while this extraction is still queued behind it. The client holds the first generation's
    page files and a 202 that named it, so the evidence this extraction would publish would point into a parse
    the client cannot resolve: it fails terminally and asks for a resubmission instead.
    """
    admitted = generation_of(parsed)
    fake = FakeChat(script)
    monkeypatch.setattr(tasks, "chat_for", lambda options: fake)
    store.admit_extraction("x-8", parsed, ExtractRequest.model_validate({"schema": TREE}).model_dump(by_alias=True),
                           generation=admitted)
    run = cases()["hand-built"](digital_pdf, tmp_path / parsed)  # the same recipe, converted again
    first, *rest = run.outcome.pages
    outcome = dataclasses.replace(run.outcome, pages=[dataclasses.replace(first, incomplete=None), *rest])
    source = dataclasses.replace(run.source, name=digital_pdf.name)
    write_result(outcome, run.execution, run.inventory, source, ingest_digest=run.ingest_digest,
                 directory=tmp_path / parsed / "result")
    assert generation_of(parsed) != admitted, "the rewrite must really be another generation"
    with pytest.raises(Exception) as caught:
        tasks.execute_extraction("x-8")
    assert not isinstance(caught.value, tasks.TransientBackendError)  # a resubmission, not another attempt
    row = store.extraction("x-8")
    assert row.finished is not None and admitted in row.error and generation_of(parsed) in row.error
    assert fake.calls == [], "the mismatch was refused before any model call"
    assert not (tmp_path / parsed / "extractions" / "x-8").exists(), "and nothing was published"


def test_a_missing_extraction_is_a_programming_error(parsed):
    with pytest.raises(ValueError, match="no extraction"):
        tasks.execute_extraction("x-none")
