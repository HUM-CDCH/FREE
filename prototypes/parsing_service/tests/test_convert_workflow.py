"""kei `convert`: resolve the models, prepare the run from the staged PDF, convert (spec, *kei worker*)."""
import hashlib
import json
import os
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from dbos import error as dbos_error
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from kei_exp import api, runs, runtime
from kei_exp.failures import KeiFailure
from kei_exp.kie import runner
from kei_exp.models import DEFAULT_OCR_MODEL
from kei_exp.regions import DEFAULT_LAYOUT_MODEL
from kei_exp.workflows import cancel, config, contracts
from kei_exp.workflows import convert as workflow
from tests.helpers import kei as kei_helper
from tests.helpers.fake import FakeTranscriber, registered
from tests.helpers.pdfs import mask

WID = "kei-convert:ingest:project-1:attempt-1"
FIXTURES = Path(__file__).parent / "fixtures" / "contracts"


@pytest.fixture
def roots(tmp_path, monkeypatch):
    monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
    monkeypatch.setattr(runs, "INBOX", tmp_path / "inbox")
    (tmp_path / "runs").mkdir()
    (tmp_path / "inbox").mkdir()
    return tmp_path


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setattr(runtime, "loaded_model", lambda url: (True, "fake/model"))
    with registered(FakeTranscriber()) as transcriber:
        yield transcriber


def staged(roots, name="p/a.pdf", **overrides):
    sha = kei_helper.stage_pdf(runs.INBOX, name, mask())
    return kei_helper.convert_request(name, sha, **overrides)


def test_an_omitted_model_is_the_listings_default(monkeypatch):
    monkeypatch.setattr(api, "loaded_model", lambda url: (False, None))
    resolved = workflow.resolve_models(None, None)
    assert resolved == {"model": DEFAULT_OCR_MODEL, "layout_model": DEFAULT_LAYOUT_MODEL}
    assert resolved["layout_model"] == "layout_heron_101"  # kei's layout default, which Studio's M2 listing shows
    listed = TestClient(api.app).get("/api/ingestion-models").json()["defaults"]
    assert listed == {"ocr": resolved["model"], "layout": resolved["layout_model"]}


@pytest.mark.parametrize("model, layout", [("nope", None), (None, "nope")])
def test_an_unknown_model_is_an_invalid_request(model, layout):
    with pytest.raises(KeiFailure) as refused:
        workflow.resolve_models(model, layout)
    assert refused.value.code == "invalid_request"


def test_prepare_run_copies_verifies_and_records_the_request(roots, fake):
    request = staged(roots, model="fake", cut="none")
    params = workflow.prepare_run(WID, request, {"model": "fake", "layout_model": DEFAULT_LAYOUT_MODEL})
    directory = runs.RUNS / runs.run_id_for(WID)
    assert params["id"] == directory.name and params["workflow_id"] == WID
    assert (directory / "input.pdf").read_bytes() == (runs.INBOX / "p/a.pdf").read_bytes()
    assert params["source_sha256"] == request["source_sha256"] and params["page_count"] == 1
    assert json.loads((directory / "params.json").read_text()) == params
    assert params["stream"] is False and params["model"] == "fake" and params["cut"] == "none"


def test_prepare_run_executed_again_rebuilds_the_same_run(roots, fake):
    request = staged(roots, model="fake", cut="none")
    models = {"model": "fake", "layout_model": DEFAULT_LAYOUT_MODEL}
    first = workflow.prepare_run(WID, request, models)
    (runs.RUNS / first["id"] / "stray").write_text("from the interrupted execution")
    second = workflow.prepare_run(WID, request, models)
    assert second["id"] == first["id"] and not (runs.RUNS / first["id"] / "stray").exists()
    assert sorted(path.name for path in runs.RUNS.iterdir()) == [first["id"]]


@pytest.mark.parametrize("source", ["../outside.pdf", "/etc/hostname", "link.pdf"])
def test_a_source_outside_the_inbox_is_refused_before_anything_is_read(roots, source):
    (roots / "outside.pdf").write_bytes(b"%PDF-1.4 secret")
    os.symlink(roots / "outside.pdf", runs.INBOX / "link.pdf")
    request = kei_helper.convert_request(source, "0" * 64)
    with pytest.raises(KeiFailure) as refused:
        workflow.prepare_run(WID, request, {"model": "surya", "layout_model": DEFAULT_LAYOUT_MODEL})
    assert refused.value.code == "invalid_request" and list(runs.RUNS.iterdir()) == []


@pytest.mark.parametrize("change, code", [
    ({"source": "p/missing.pdf"}, "source_missing"),
    ({"source_sha256": "0" * 64}, "source_mismatch"),
    ({"page_source": "pdf", "ingest": {"split": "spread"}}, "invalid_request"),
])
def test_prepare_run_refuses_what_it_cannot_parse(roots, change, code):
    request = {**staged(roots), **change}
    with pytest.raises(KeiFailure) as refused:
        workflow.prepare_run(WID, request, {"model": "surya", "layout_model": DEFAULT_LAYOUT_MODEL})
    assert refused.value.code == code and list(runs.RUNS.iterdir()) == []


def test_an_unreadable_or_oversized_pdf_is_refused(roots, digital_pdf, monkeypatch):
    (runs.INBOX / "bad.pdf").write_bytes(b"not a pdf")
    bad = kei_helper.convert_request("bad.pdf", hashlib.sha256(b"not a pdf").hexdigest())
    with pytest.raises(KeiFailure, match="source_unreadable"):
        workflow.prepare_run(WID, bad, {"model": "surya", "layout_model": DEFAULT_LAYOUT_MODEL})
    monkeypatch.setattr(workflow, "MAX_PAGES", 4)  # digital_pdf has eight
    (runs.INBOX / "big.pdf").write_bytes(digital_pdf.read_bytes())
    big = kei_helper.convert_request("big.pdf", hashlib.sha256(digital_pdf.read_bytes()).hexdigest())
    with pytest.raises(KeiFailure, match="too_many_pages"):
        workflow.prepare_run(WID, big, {"model": "surya", "layout_model": DEFAULT_LAYOUT_MODEL})


def test_convert_run_publishes_the_manifest_and_writes_no_worker_markdown(roots, fake):
    request = staged(roots, model="fake", cut="none")
    params = workflow.prepare_run(WID, request, {"model": "fake", "layout_model": DEFAULT_LAYOUT_MODEL})
    output = workflow.convert_run(WID, params)
    contracts.ConvertOk.model_validate(output)
    directory = runs.RUNS / params["id"]
    manifest = json.loads((directory / "result" / "result.json").read_text())
    assert (output["generation"], output["page_count"]) == (manifest["generation"], 1)
    assert not (directory / "output.md").exists() and not (directory / "tokens.jsonl").exists()


def test_a_cancel_stops_the_conversion_at_its_next_page_event(roots, fake, monkeypatch):
    cancelled = {"now": False}
    monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(
        workflow_id=WID, get_workflow_status=lambda wid: SimpleNamespace(
            status="CANCELLED" if cancelled["now"] else "PENDING")))
    seen = []

    def cutting(execution, emit):  # stands in for the cut loop: one region event per page, on the step's thread
        for page in range(1, 2001):
            if page == 3:
                cancelled["now"] = True
            emit({"type": "region", "page": page})
            seen.append(page)
        return ""
    monkeypatch.setattr(runner, "convert", cutting)
    params = workflow.prepare_run(WID, staged(roots, model="fake", cut="none"),
                                  {"model": "fake", "layout_model": DEFAULT_LAYOUT_MODEL})
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    with pytest.raises(KeiFailure) as stopped:
        workflow.convert_run(WID, params)
    assert stopped.value.code == "cancelled" and seen == [1, 2]


def test_a_cancel_stops_the_ingest_at_its_next_spread(tmp_path, monkeypatch):
    """The ingest reads every spread of a book before OCR starts: each spread is a check, not only the phases."""
    cancelled = {"now": False}
    monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(
        workflow_id=WID, get_workflow_status=lambda wid: SimpleNamespace(
            status="CANCELLED" if cancelled["now"] else "PENDING")))
    seen = []

    def ingesting(pdf, cfg, doc_dir, on_spread=None):  # stands in for the ingest's spread loop
        for spread in range(1, 201):
            if spread == 3:
                cancelled["now"] = True
            on_spread(spread, 200)
            seen.append(spread)
        raise AssertionError("the ingest read every spread of a cancelled conversion")
    monkeypatch.setattr(runner, "ingest_step", ingesting)
    execution = SimpleNamespace(page_source="ingest", ingest_dir=tmp_path, pdf=tmp_path / "input.pdf", ingest=None)
    check = cancel.CancelCheck(WID, min_interval=0.0)
    with pytest.raises(KeiFailure) as stopped:
        runner.convert(execution, emit=check.sink(lambda event: None))
    assert stopped.value.code == "cancelled" and seen == [1, 2]


def test_the_cancel_sink_checks_only_on_the_steps_own_thread(monkeypatch):
    reads = []
    monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(
        workflow_id="w", get_workflow_status=lambda wid: reads.append(wid) or SimpleNamespace(status="PENDING")))
    check = cancel.CancelCheck("w", min_interval=0.0)
    sink = check.sink(lambda event: None)
    worker = threading.Thread(target=sink, args=({"type": "region"},))
    worker.start()
    worker.join()
    assert reads == []
    sink({"type": "region"})
    assert reads == ["w"]


SECRET = "sk-test-cancel-status-read"


def unreadable_status(*, after: list[bool] | None = None):
    """A status read that fails like a restarting PostgreSQL (dbos 3.1.0 does not retry reads), once `after[0]` is
    set; the driver's message carries a synthetic secret the log must not repeat."""
    def read(wid):
        if after is None or after[0]:
            raise OperationalError("SELECT status", {}, Exception(f"server closed the connection; password={SECRET}"))
        return SimpleNamespace(status="PENDING")
    return read


@pytest.mark.parametrize("failing", [{"type": "region", "page": 2}, {"type": "phase", "name": "export", "total": None}])
def test_an_unreadable_status_fails_open_and_the_conversion_publishes(roots, fake, monkeypatch, caplog, failing):
    """kei's fail-open post-conversion policy (spec, *Cancellation*): a database restart during the cut, or at the
    export phase after OCR, is not a cancel; the conversion goes on and publishes."""
    broken = [False]
    monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(workflow_id=WID, get_workflow_status=unreadable_status(
        after=broken)))
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    original = runner.convert

    def converting(execution, emit):
        emit({"type": "region", "page": 1})
        broken[0] = True  # from the event under test on
        emit(failing)
        emit({"type": "region", "page": 3})
        return original(execution, emit)
    monkeypatch.setattr(runner, "convert", converting)
    params = workflow.prepare_run(WID, staged(roots, model="fake", cut="none"),
                                  {"model": "fake", "layout_model": DEFAULT_LAYOUT_MODEL})
    with caplog.at_level("WARNING", logger=cancel.__name__):
        output = workflow.convert_run(WID, params)
    contracts.ConvertOk.model_validate(output)
    assert (runs.RUNS / params["id"] / "result" / "result.json").is_file()
    warnings = [record for record in caplog.records if record.name == cancel.__name__]
    assert len(warnings) == 1 and "OperationalError" in warnings[0].getMessage()  # once per step
    assert SECRET not in caplog.text


def test_dboss_own_error_still_stops_the_step_at_its_next_check(roots, fake, monkeypatch):
    """After a SIGTERM, DBOS.destroy() makes every read raise DBOSException: the lame-duck step stops at its next
    check instead of running on until SIGKILL (recovery re-runs it)."""
    destroyed = [False]

    def read(wid):
        if destroyed[0]:
            raise dbos_error.DBOSException("No DBOS was created yet")
        return SimpleNamespace(status="PENDING")
    monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(workflow_id=WID, get_workflow_status=read))
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    seen = []

    def cutting(execution, emit):
        for page in range(1, 11):
            if page == 3:
                destroyed[0] = True
            emit({"type": "region", "page": page})
            seen.append(page)
        return ""
    monkeypatch.setattr(runner, "convert", cutting)
    params = workflow.prepare_run(WID, staged(roots, model="fake", cut="none"),
                                  {"model": "fake", "layout_model": DEFAULT_LAYOUT_MODEL})
    with pytest.raises(dbos_error.DBOSException):
        workflow.convert_run(WID, params)
    assert seen == [1, 2] and not (runs.RUNS / params["id"] / "result").exists()


def test_outside_a_workflow_the_check_is_off(monkeypatch):
    monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(workflow_id=None, get_workflow_status=None))
    cancel.CancelCheck("w")(force=True)  # reads nothing, raises nothing


# --- through DBOS ------------------------------------------------------------------------------------------------


def enqueue_fixture(kei, request):
    fixture = json.loads((FIXTURES / "convert.input.json").read_text())
    options = fixture["enqueue"]
    return kei.enqueue("convert", options["queue_name"], options["workflow_id"], request,
                       priority=options["priority"], timeout_ms=options["workflow_timeout_ms"])


def test_the_contract_fixture_converts_through_a_portable_enqueue(kei, fake):
    fixture = json.loads((FIXTURES / "convert.input.json").read_text())
    request = fixture["request"]
    sha = kei_helper.stage_pdf(kei.inbox, request["source"], mask())
    workflow_id = enqueue_fixture(kei, {**request, "source_sha256": sha, "model": "fake", "cut": "none"})
    output = kei.output(workflow_id)
    contracts.ConvertOk.model_validate(output)
    assert set(output) == set(json.loads((FIXTURES / "convert.output.ok.json").read_text()))
    assert output["run_id"] == runs.run_id_for(workflow_id)
    assert kei.steps(workflow_id) == ["resolve_models", "prepare_run", "convert_run"]


def test_a_refused_source_is_a_typed_failure_not_an_error(kei, fake):
    fixture = json.loads((FIXTURES / "convert.input.json").read_text())
    kei_helper.stage_pdf(kei.inbox, fixture["request"]["source"], mask())
    output = kei.output(enqueue_fixture(kei, {**fixture["request"], "model": "fake"}))  # the fixture's digest
    contracts.Failure.model_validate(output)
    assert (output["code"], output["retryable"]) == ("source_mismatch", False)
    assert set(output) == set(json.loads((FIXTURES / "convert.output.failed.json").read_text()))


def test_a_malformed_request_is_an_invalid_request(kei):
    output = kei.output(kei.enqueue("convert", config.CONVERT_SMALL, "kei-convert:bad", {"source": "x"}))
    assert (output["ok"], output["code"]) == (False, "invalid_request")


@pytest.mark.slow
def test_an_unreachable_model_server_is_retried_three_times_then_reported_retryable(kei, fake, monkeypatch):
    probes = []
    monkeypatch.setattr(runtime, "loaded_model", lambda url: probes.append(url) or (False, None))
    sha = kei_helper.stage_pdf(kei.inbox, "p/a.pdf", mask())
    workflow_id = kei.enqueue("convert", config.CONVERT_SMALL, WID,
                              kei_helper.convert_request("p/a.pdf", sha, model="fake", cut="none"))
    output = kei.output(workflow_id, timeout=60)  # waits 5 s then 10 s between the three attempts
    assert (output["ok"], output["code"], output["retryable"]) == (False, "model_unavailable", True)
    assert len(probes) == 3 and kei.steps(workflow_id).count("prepare_run") == 1
