"""The API over the durable store: a 202 means committed, a full slot is a 429, an unreachable store is a 503,
and a run recorded before this change is still listed and still replays from its files.

Admission is deliberately cheap: it validates the request and the PDF's own limits, records what was asked for
and commits. It reads no text layer and asks no model server anything — the worker resolves the recipe and
checks the server when the run actually runs.
"""
import json
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kei_exp import api, runs
from kei_exp.canonical import sha256_file
from kei_exp.cut import DEFAULT_LAYOUT_MODEL
from kei_exp.jobs import schema, store
from kei_exp.jobs.events import DurableEmit
from kei_exp.kie.stages import ocr
from kei_exp.models import MODELS


@pytest.fixture
def client(database: str, tmp_path: Path, monkeypatch) -> TestClient:
    schema.apply(database)
    store.close_pool()
    store.pool(database)
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    monkeypatch.setattr(api, "VLLM_URL", "http://127.0.0.1:1/v1/chat/completions")
    # The lifespan opens (or, since store.pool() above already opened one, confirms) the pool by this name and
    # installs the deferring connector for the process's lifetime; it must agree with the pool already open for
    # this test's throwaway database, or open_pool() would refuse it as a conflicting conninfo.
    monkeypatch.setattr(api, "DATABASE_URL", database)
    with TestClient(api.app) as test_client:
        yield test_client
    store.close_pool()


def test_a_submission_is_committed_before_it_answers(client: TestClient, digital_pdf: Path) -> None:
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "debug": "false"})
    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "queued"
    row = store.record(body["id"])
    assert row is not None and row.job_status == "todo"
    assert (runs.RUNS / body["id"] / "input.pdf").is_file()
    assert (runs.RUNS / body["id"] / "params.json").is_file()
    assert not (runs.RUNS / body["id"] / "status.json").exists()  # no new run writes one


def test_a_submission_without_debug_defaults_to_off(client: TestClient, digital_pdf: Path) -> None:
    """The HTTP default is debug=false: an omitted field records that in the run's params, and the worker
    resolves no debug_dir for it (runs.execution_for), so debug output is opt-in rather than the default."""
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none"})  # no "debug" field at all
    assert response.status_code == 202
    body = response.json()
    assert body["params"]["debug"] is False
    row = store.record(body["id"])
    assert row is not None and row.params["debug"] is False
    execution = runs.execution_for(runs.RUNS / body["id"], row.params)
    assert execution.debug_dir is None


def test_a_submission_is_accepted_while_the_model_server_is_unreachable(
        client: TestClient, scan_pdf: Path, monkeypatch) -> None:
    """A temporary model outage must not stop a valid document from queueing.

    The fixture is a scan, so the request really does name a served model (a PDF with a text layer would take
    the native path in the worker whatever the request said), and `api.VLLM_URL` points at a refused port.
    Admission does not merely tolerate the outage: it asks the server nothing at all.
    """
    probed: list[str] = []

    def unreachable(url: str) -> tuple[bool, None]:
        probed.append(url)
        return False, None

    monkeypatch.setattr(api, "loaded_model", unreachable)
    with scan_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("scan.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "debug": "false"})
    assert response.status_code == 202, response.text
    assert probed == [], "admission must not probe the model server"
    row = store.record(response.json()["id"])
    assert row is not None and row.job_status == "todo"  # queued, with the server down


def test_a_submission_never_reads_the_text_layer(client: TestClient, digital_pdf: Path, monkeypatch) -> None:
    """Native-vs-OCR is resolved once, by the worker: admission never opens the PDF's text layer, which on a
    long document is the expensive part of the old submission."""
    def never(*_args, **_kwargs):
        raise AssertionError("admission read the PDF's text layer")

    monkeypatch.setattr(ocr, "has_native_text", never)
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "debug": "false"})
    assert response.status_code == 202, response.text
    assert store.record(response.json()["id"]) is not None


def test_an_upload_over_the_byte_limit_answers_413(client: TestClient, digital_pdf: Path, monkeypatch) -> None:
    monkeypatch.setattr(api, "MAX_UPLOAD_BYTES", 1024)
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "debug": "false"})
    assert response.status_code == 413, response.text
    assert "1024" in response.json()["detail"]
    assert not [path for path in runs.RUNS.iterdir() if path.is_dir()]  # no run directory
    assert not list(runs.RUNS.glob(".upload-*")), list(runs.RUNS.iterdir())  # and no staged upload either


def test_a_pdf_over_the_page_limit_answers_400(client: TestClient, digital_pdf: Path, monkeypatch) -> None:
    monkeypatch.setattr(api, "MAX_PAGES", 4)  # the fixture has eight
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "debug": "false"})
    assert response.status_code == 400, response.text
    assert "8" in response.json()["detail"] and "4" in response.json()["detail"]
    assert not [path for path in runs.RUNS.iterdir() if path.is_dir()]
    assert not list(runs.RUNS.glob(".upload-*")), list(runs.RUNS.iterdir())


def test_the_recorded_request_is_what_the_worker_resolves(client: TestClient, digital_pdf: Path,
                                                          monkeypatch) -> None:
    """The row admission commits is the request of record: every field `runs.execution_for` reads, plus the
    identity of the source. The transcriber and repo it names are the requested model's, not a resolution —
    the worker's resolution is the authoritative one, and on this text-layer PDF it disagrees."""
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "crop_dpi": "300",
                                     "max_image_size": "800", "max_output_tokens": "1024", "stream": "false",
                                     "page_from": "2", "page_to": "3", "debug": "true"})
    assert response.status_code == 202, response.text
    params = response.json()["params"]
    record = MODELS["granite_vision"]
    assert (params["model"], params["transcriber"], params["repo"]) == ("granite_vision", record.kind, record.repo)
    assert params["url"] == api.VLLM_URL and params["source_name"] == "main.pdf"
    assert (params["cut"], params["crop_dpi"], params["layout_model"]) == ("none", 300, DEFAULT_LAYOUT_MODEL)
    assert (params["max_image_size"], params["max_output_tokens"], params["stream"]) == (800, 1024, False)
    assert (params["pages"], params["page_source"], params["debug"]) == ([2, 3], "pdf", True)
    directory = runs.RUNS / params["id"]
    assert params["page_count"] == 8 and params["source_sha256"] == sha256_file(directory / "input.pdf")
    assert params["source_sha256"] == sha256_file(digital_pdf)  # the source is the upload, byte for byte
    row = store.record(params["id"])
    assert row is not None and row.params == params == runs.read_json(directory / "params.json")

    # The worker resolves that row. This PDF has a text layer, so its execution is the native one, whatever
    # the recorded request names: the recorded transcriber is what was asked for, not what will run.
    assert runs.execution_for(directory, row.params).transcriber == "native"
    monkeypatch.setattr(ocr, "has_native_text", lambda *_args, **_kwargs: False)
    execution = runs.execution_for(directory, row.params)
    assert (execution.transcriber, execution.model, execution.repo) == (record.kind, "granite_vision", record.repo)
    assert (execution.url, execution.cut, execution.crop_dpi) == (api.VLLM_URL, "none", 300)
    assert (execution.max_image_size, execution.max_output_tokens, execution.stream) == (800, 1024, False)
    assert execution.pages == (2, 3) and execution.page_source == "pdf" and execution.ingest_dir is None
    assert execution.pdf == directory / "input.pdf" and execution.debug_dir == directory / "debug"
    assert execution.result_dir == directory / "result"


def test_the_source_pdf_is_served_back_byte_for_byte(client: TestClient, digital_pdf: Path) -> None:
    """`source_sha256` in the params and in the result's recipe identifies the input bytes; a consumer that
    holds the hash must be able to fetch those very bytes again, so the run's own copy is served as it is."""
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "debug": "false"})
    assert response.status_code == 202, response.text
    run_id = response.json()["id"]
    served = client.get(f"/api/runs/{run_id}/source.pdf")
    assert served.status_code == 200, served.text
    assert served.headers["content-type"] == "application/pdf"
    assert served.content == digital_pdf.read_bytes()
    assert sha256_file(digital_pdf) == response.json()["params"]["source_sha256"]


def test_a_historical_run_without_its_source_pdf_answers_404(client: TestClient) -> None:
    """A run directory that kept no `input.pdf` (a historical run whose upload was reclaimed) has no source to
    serve: 404, rather than an empty or partial body a consumer could hash."""
    directory = runs.RUNS / "20260101-000000-surya-abcd"
    directory.mkdir(parents=True)
    runs.write_json(directory / "params.json", {"id": directory.name, "created": "2026-01-01T00:00:00+00:00",
                                                "source_name": "old.pdf", "page_count": 2, "transcriber": "surya",
                                                "model": "surya", "cut": "auto", "crop_dpi": 250,
                                                "layout_model": "layout_heron_101", "page_source": "pdf"})
    assert client.get(f"/api/runs/{directory.name}/source.pdf").status_code == 404
    assert client.get("/api/runs/20260101-000000-surya-none/source.pdf").status_code == 404  # no such run


def test_a_full_slot_answers_429(client: TestClient, digital_pdf: Path, monkeypatch) -> None:
    monkeypatch.setattr(api, "ADMISSION_LIMIT", 0)
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "debug": "false"})
    assert response.status_code == 429
    assert not [path for path in runs.RUNS.iterdir() if path.is_dir()]  # nothing was left behind


def test_an_unreachable_store_answers_503(client: TestClient, digital_pdf: Path, monkeypatch) -> None:
    def unavailable(*_args, **_kwargs):
        raise store.Unavailable("connection refused")
    monkeypatch.setattr(store, "admit", unavailable)
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "debug": "false"})
    assert response.status_code == 503


def test_a_lost_acknowledgement_does_not_strand_a_committed_run(client: TestClient, digital_pdf: Path, monkeypatch) -> None:
    """PostgreSQL can commit the admission and then lose the connection before this process reads the
    acknowledgement: `store.admit` surfaces that exactly like a submission that never reached the database at
    all (`Unavailable`), and the two are not distinguishable from here. Deleting the upload on the strength of
    a guess would, on the "it actually committed" branch of that guess, strand a queued database job whose
    `input.pdf` no longer exists on disk and whose detail endpoint would 404."""
    real_admit = store.admit

    def commits_then_loses_the_acknowledgement(run_id, params, *, slot, limit):
        real_admit(run_id, params, slot=slot, limit=limit)  # genuinely committed
        raise store.Unavailable("connection reset while reading the acknowledgement")

    monkeypatch.setattr(store, "admit", commits_then_loses_the_acknowledgement)
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "debug": "false"})
    assert response.status_code == 503
    [directory] = [path for path in runs.RUNS.iterdir() if path.is_dir()]
    assert (directory / "input.pdf").is_file()  # not stranded: the committed run's source is still on disk
    row = store.record(directory.name)
    assert row is not None and row.job_status == "todo"  # genuinely queued, whatever this response said


def test_an_unmigrated_database_is_refused_without_stranding_a_run_directory(
        client: TestClient, digital_pdf: Path, monkeypatch) -> None:
    """`store.NotMigrated` names a query that cannot have committed anything (the table it referenced does not
    exist), unlike `Unavailable`: cleaning up here is safe, and the response should tell the operator what to
    run."""
    def not_migrated(*_args, **_kwargs):
        raise store.NotMigrated('relation "kei_run" does not exist')
    monkeypatch.setattr(store, "admit", not_migrated)
    with digital_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                               data={"model": "granite_vision", "cut": "none", "debug": "false"})
    assert response.status_code == 503
    assert "kei-jobs schema --apply" in response.json()["detail"]
    assert not [path for path in runs.RUNS.iterdir() if path.is_dir()]  # safe to clean up: nothing committed


def test_a_historical_file_only_run_is_still_listed_and_replayed(client: TestClient) -> None:
    directory = runs.RUNS / "20260101-000000-surya-abcd"
    directory.mkdir(parents=True)
    runs.write_json(directory / "params.json", {"id": directory.name, "created": "2026-01-01T00:00:00+00:00",
                                                "source_name": "old.pdf", "page_count": 2, "transcriber": "surya",
                                                "model": "surya", "cut": "auto", "crop_dpi": 250,
                                                "layout_model": "layout_heron_101", "page_source": "pdf"})
    runs.write_json(directory / "status.json", {"status": "done", "started": "2026-01-01T00:00:00+00:00",
                                               "finished": "2026-01-01T00:01:00+00:00", "error": None,
                                               "duration_seconds": 60.0, "step_timings": None,
                                               "current_step": None, "input_tokens": 5, "output_tokens": 7})
    (directory / "events.jsonl").write_text(
        json.dumps({"seq": 0, "type": "log", "text": "from the file"}) + "\n"
        + json.dumps({"seq": 1, "type": "status", "status": "done", "error": None}) + "\n", encoding="utf-8")
    listed = client.get("/api/runs").json()
    assert [run["id"] for run in listed] == [directory.name]
    assert listed[0]["status"] == "done" and listed[0]["output_tokens"] == 7
    stream = client.get(f"/api/runs/{directory.name}/events").text
    assert "from the file" in stream and '"status": "done"' in stream


def test_read_routes_survive_an_unreachable_store(client: TestClient) -> None:
    """A complete list needs the database; an identifiable historical run remains readable on its own."""
    directory = runs.RUNS / "20260101-000000-surya-abcd"
    directory.mkdir(parents=True)
    runs.write_json(directory / "params.json", {"id": directory.name, "created": "2026-01-01T00:00:00+00:00",
                                                "source_name": "old.pdf", "page_count": 2, "transcriber": "surya",
                                                "model": "surya", "cut": "auto", "crop_dpi": 250,
                                                "layout_model": "layout_heron_101", "page_source": "pdf"})
    runs.write_json(directory / "status.json", {"status": "done", "started": "2026-01-01T00:00:00+00:00",
                                               "finished": "2026-01-01T00:01:00+00:00", "error": None,
                                               "duration_seconds": 60.0, "step_timings": None,
                                               "current_step": None, "input_tokens": 5, "output_tokens": 7})
    (directory / "events.jsonl").write_text(
        json.dumps({"seq": 0, "type": "log", "text": "from the file"}) + "\n"
        + json.dumps({"seq": 1, "type": "status", "status": "done", "error": None}) + "\n", encoding="utf-8")

    store.close_pool()
    store.pool("postgresql://kei:kei@127.0.0.1:1/kei")  # refused: nothing listens there
    try:
        listed = client.get("/api/runs")
        assert listed.status_code == 503

        detail = client.get(f"/api/runs/{directory.name}")
        assert detail.status_code == 200
        assert detail.json()["status"] == "done"

        stream = client.get(f"/api/runs/{directory.name}/events")
        assert stream.status_code == 200
        assert "from the file" in stream.text and '"status": "done"' in stream.text
    finally:
        store.close_pool()


def test_a_historical_run_that_never_finished_gets_a_synthesised_terminal_status(client: TestClient) -> None:
    """A run recorded before this backend existed, whose API died mid-flight: `status.json` never reached a
    terminal status and the log never wrote a status event either. `replay()` must still end the stream with a
    synthesised one, `GET /api/runs/{id}` must report the run as failed with the UNRECORDED reason, and the run
    must be readable without either file being rewritten to say so."""
    directory = runs.RUNS / "20260101-000000-surya-dead"
    directory.mkdir(parents=True)
    runs.write_json(directory / "params.json", {"id": directory.name, "created": "2026-01-01T00:00:00+00:00",
                                                "source_name": "old.pdf", "page_count": 2, "transcriber": "surya",
                                                "model": "surya", "cut": "auto", "crop_dpi": 250,
                                                "layout_model": "layout_heron_101", "page_source": "pdf"})
    runs.write_json(directory / "status.json", {"status": "running", "started": "2026-01-01T00:00:00+00:00"})
    (directory / "events.jsonl").write_text(
        json.dumps({"seq": 0, "type": "log", "text": "starting"}) + "\n"
        + json.dumps({"seq": 1, "type": "log", "text": "still going"}) + "\n", encoding="utf-8")
    before = (directory / "status.json").read_bytes()

    stream = client.get(f"/api/runs/{directory.name}/events").text
    blocks = [block for block in stream.split("\n\n") if block.strip()]
    assert blocks, "expected at least one SSE event"
    last = blocks[-1]
    assert "event: status" in last
    assert '"status": "failed"' in last and runs.UNRECORDED in last

    body = client.get(f"/api/runs/{directory.name}").json()
    assert body["status"] == "failed"
    assert body["error"] == runs.UNRECORDED

    after = (directory / "status.json").read_bytes()
    assert after == before  # a historical run is readable WITHOUT being rewritten
    assert json.loads(after)["status"] == "running"


def test_a_database_run_is_listed_with_its_job_status(client: TestClient, digital_pdf: Path) -> None:
    with digital_pdf.open("rb") as handle:
        run_id = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                             data={"model": "granite_vision", "cut": "none", "debug": "false"}).json()["id"]
    assert [run["id"] for run in client.get("/api/runs").json()] == [run_id]
    assert client.get(f"/api/runs/{run_id}").json()["status"] == "queued"
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'doing'")
        conn.commit()
    assert client.get(f"/api/runs/{run_id}").json()["status"] == "running"


@pytest.mark.parametrize("outcome", ["succeeded", "failed", "aborted"])
def test_step_timings_survive_completion_and_reopening_the_store(client: TestClient, database: str, outcome: str):
    params = {"id": "timed", "created": runs.now()}
    (runs.RUNS / "timed").mkdir()
    runs.write_json(runs.RUNS / "timed" / "params.json", params)
    job_id = store.admit("timed", params)
    queued = client.get("/api/runs/timed").json()
    assert queued["duration_seconds"] is None
    assert queued["step_timings"] is None and queued["current_step"] is None

    store.attempt_started("timed", 1, job_id)
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'doing' WHERE id = %s", (job_id,))
        conn.execute("UPDATE kei_attempt SET started = now() - interval '20 seconds' WHERE run_id = 'timed'")
    preparing = client.get("/api/runs/timed").json()
    assert preparing["current_step"] == "prepare"
    assert preparing["step_timings"] == [{"step": "prepare", "seconds": preparing["duration_seconds"]}]

    emit = DurableEmit("timed", 1)
    for phase in ["cut", "ocr", "cut", "ocr", "ocr", "export"]:
        emit({"type": "phase", "name": phase})
        emit({"type": "token", "page": 1, "text": "unrelated"})
    live = client.get("/api/runs/timed").json()
    assert live["current_step"] == "export"
    assert [timing["step"] for timing in live["step_timings"]] == ["prepare", "cut", "ocr", "export"]
    assert live["step_timings"][0]["seconds"] >= 20
    assert all(timing["seconds"] > 0 for timing in live["step_timings"])
    assert sum(timing["seconds"] for timing in live["step_timings"]) == pytest.approx(live["duration_seconds"])

    emit.flush()
    store.attempt_finished("timed", 1, outcome, None)
    # The attempt has stopped even before Procrastinate updates its job status.
    completed = client.get("/api/runs/timed").json()
    assert completed["current_step"] is None
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = %s WHERE id = %s", (outcome, job_id))
    store.close_pool()
    store.open_pool(database)
    for saved in [client.get("/api/runs/timed").json(), client.get("/api/runs").json()[0]]:
        assert saved["step_timings"] == completed["step_timings"]
        assert saved["duration_seconds"] == completed["duration_seconds"]
        assert saved["current_step"] is None


def test_step_timings_belong_only_to_the_latest_attempt(client: TestClient):
    params = {"id": "retry-timing", "created": runs.now()}
    (runs.RUNS / params["id"]).mkdir()
    runs.write_json(runs.RUNS / params["id"] / "params.json", params)
    job_id = store.admit(params["id"], params)
    store.attempt_started(params["id"], 1, job_id)
    DurableEmit(params["id"], 1)({"type": "phase", "name": "ocr"})
    store.attempt_finished(params["id"], 1, "failed", "connection refused")
    waiting = client.get(f"/api/runs/{params['id']}").json()
    assert waiting["current_step"] is None
    assert [timing["step"] for timing in waiting["step_timings"]] == ["prepare", "ocr"]

    store.attempt_started(params["id"], 2, job_id)
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'doing' WHERE id = %s", (job_id,))
    DurableEmit(params["id"], 2)({"type": "phase", "name": "native"})
    retrying = client.get(f"/api/runs/{params['id']}").json()
    assert retrying["current_step"] == "native"
    assert [timing["step"] for timing in retrying["step_timings"]] == ["prepare", "native"]

    # A killed worker may restart the same attempt number; its old phases must be cleared too.
    store.attempt_started(params["id"], 2, job_id)
    restarted = client.get(f"/api/runs/{params['id']}").json()
    assert restarted["current_step"] == "prepare"
    assert [timing["step"] for timing in restarted["step_timings"]] == ["prepare"]


def test_run_page_boxes_reads_live_region_events_for_a_database_run(client: TestClient, digital_pdf: Path) -> None:
    """A durable run writes no events.jsonl; its pre-publication region events live in the store instead, and
    `run_page_boxes` must read them from there rather than from a file that will never exist for this run —
    otherwise the boxes overlay stays empty for the whole run instead of filling in live."""
    with digital_pdf.open("rb") as handle:
        run_id = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                             data={"model": "granite_vision", "cut": "none", "debug": "false"}).json()["id"]
    emit = DurableEmit(run_id, attempt=1)
    emit({"type": "region", "page": 1, "unit": 0, "crop": 1, "order": 0, "kind": "text",
          "bbox": [10.0, 20.0, 30.0, 40.0], "width": 100, "height": 200, "ink": 0.5})
    emit.flush()

    body = client.get(f"/api/runs/{run_id}/pages/1/boxes").json()
    assert body["published"] is False  # no result yet
    assert len(body["regions"]) == 1
    region = body["regions"][0]
    assert (region["crop"], region["unit"], region["kind"]) == (1, 0, "text")
    assert region["bbox"] == [10.0, 20.0, 30.0, 40.0]


def test_run_page_boxes_survives_an_unreachable_store(client: TestClient, digital_pdf: Path) -> None:
    """`run_page_boxes` re-opened FIX 1's failure mode by adding an unguarded `store.record(run_id)`: a
    historical, file-only run needs no database at all, and an unreachable store must degrade the overlay to
    the file fallback rather than 500. Pointed at a refused port, like the equivalent FIX 1 test."""
    directory = runs.RUNS / "20260101-000000-surya-abcd"
    directory.mkdir(parents=True)
    (directory / "input.pdf").write_bytes(digital_pdf.read_bytes())
    runs.write_json(directory / "params.json", {"id": directory.name, "created": "2026-01-01T00:00:00+00:00",
                                                "source_name": "old.pdf", "page_count": 2, "transcriber": "surya",
                                                "model": "surya", "cut": "auto", "crop_dpi": 250,
                                                "layout_model": "layout_heron_101", "page_source": "pdf"})
    store.close_pool()
    store.pool("postgresql://kei:kei@127.0.0.1:1/kei")  # refused: nothing listens there
    try:
        response = client.get(f"/api/runs/{directory.name}/pages/1/boxes")
        assert response.status_code == 200
        assert response.json()["published"] is False
    finally:
        store.close_pool()


def test_run_page_boxes_does_not_query_events_once_the_page_is_published(
        client: TestClient, digital_pdf: Path, monkeypatch) -> None:
    """`page_geometry` never reads `events` once a result exists (kei_exp/boxes.py); a published page must
    cost the store nothing, not pull a streaming run's whole token history on every poll to find events it
    will throw away."""
    with digital_pdf.open("rb") as handle:
        run_id = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                             data={"model": "granite_vision", "cut": "none", "debug": "false"}).json()["id"]
    pages_dir = runs.RUNS / run_id / "result" / "pages"
    pages_dir.mkdir(parents=True)
    runs.write_json(pages_dir / "1.json", {"units": [], "segments": []})

    def must_not_be_called(*_args, **_kwargs):
        raise AssertionError("events_after must not be called once the page result is published")
    monkeypatch.setattr(store, "events_after", must_not_be_called)
    monkeypatch.setattr(store, "record", must_not_be_called)

    response = client.get(f"/api/runs/{run_id}/pages/1/boxes")
    assert response.status_code == 200
    assert response.json()["published"] is True


def test_events_stream_stops_without_inventing_a_missing_status_event(
        client: TestClient, digital_pdf: Path) -> None:
    """A finished job without an event closes the stream; its outcome remains available from GET /runs/id."""
    with digital_pdf.open("rb") as handle:
        run_id = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                             data={"model": "granite_vision", "cut": "none", "debug": "false"}).json()["id"]
    store.finish_run(run_id)
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'failed' WHERE id = "
                     "(SELECT job_id FROM kei_run_job WHERE run_id = %s)", (run_id,))
        conn.commit()

    outcome: dict = {}

    def fetch() -> None:
        outcome["response"] = client.get(f"/api/runs/{run_id}/events")

    thread = threading.Thread(target=fetch)
    thread.start()
    thread.join(timeout=10)
    assert not thread.is_alive(), "GET .../events never returned: the SSE loop polled forever"
    response = outcome["response"]
    assert response.status_code == 200
    assert response.text == ""
    assert store.events_after(run_id, -1) == []
    assert client.get(f"/api/runs/{run_id}").json()["status"] == "failed"


def test_the_event_stream_delivers_a_history_longer_than_one_page(client: TestClient, digital_pdf: Path) -> None:
    """`store.events_after` answers at most `store.EVENT_PAGE` events, so the SSE loop reads pages until a
    short one. A finished run is where a bounded read shows: the loop closes the stream as soon as it sees the
    terminal job status, so whatever it has not read by then — a long document's pages and regions run to
    thousands of events — would simply never be sent."""
    with digital_pdf.open("rb") as handle:
        run_id = client.post("/api/runs", files={"pdf": ("main.pdf", handle, "application/pdf")},
                             data={"model": "granite_vision", "cut": "none", "debug": "false"}).json()["id"]
    total = 2 * store.EVENT_PAGE + 7
    store.append_events(run_id, 1, [{"type": "log", "text": f"line {number}"} for number in range(total)])
    store.finish_run(run_id)
    with store.connection() as conn:
        conn.execute("UPDATE procrastinate_jobs SET status = 'succeeded' WHERE id = "
                     "(SELECT job_id FROM kei_run_job WHERE run_id = %s)", (run_id,))
        conn.commit()

    response = client.get(f"/api/runs/{run_id}/events")
    assert [line[4:] for line in response.text.splitlines() if line.startswith("id: ")] == \
        [str(seq) for seq in range(total)]


def test_the_api_no_longer_has_a_queue_or_a_registry() -> None:
    for gone in ("Job", "jobs", "work", "worker", "run_job", "submit", "prepare", "reconcile", "active"):
        assert not hasattr(runs, gone), f"runs.{gone} should have gone with the in-process queue"
