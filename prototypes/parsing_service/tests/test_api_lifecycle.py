"""Outage and legacy-run reads, without a database or model server."""
import json

import pytest
from fastapi.testclient import TestClient

from kei_exp import api, runs
from kei_exp.jobs import store


@pytest.fixture
def directory(tmp_path, monkeypatch):
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    directory = tmp_path / "run-live"
    directory.mkdir()
    runs.write_json(directory / "params.json", {"id": directory.name, "created": runs.now()})
    return directory


def unavailable(*args, **kwargs):
    raise store.Unavailable("database offline")


def test_durable_reads_are_unavailable_not_failed(directory, monkeypatch):
    monkeypatch.setattr(store, "record", unavailable)
    response = TestClient(api.app).get("/api/runs/run-live")
    assert response.status_code == 503
    assert response.headers["retry-after"]
    assert runs.UNRECORDED not in response.text
    assert runs.summary(directory) is None


def test_unknown_directory_is_not_a_failed_legacy_run(directory, monkeypatch):
    monkeypatch.setattr(store, "record", lambda _: None)
    assert TestClient(api.app).get("/api/runs/run-live").status_code == 404


@pytest.mark.parametrize("marker", ["status.json", "events.jsonl"])
def test_identifiable_legacy_runs_remain_readable(directory, monkeypatch, marker):
    monkeypatch.setattr(store, "record", unavailable)
    if marker == "status.json":
        runs.write_json(directory / marker, {"status": "done"})
    else:
        (directory / marker).write_text(json.dumps({"seq": 0, "type": "log", "text": "interrupted"}) + "\n")
    client = TestClient(api.app)
    response = client.get("/api/runs/run-live")
    assert response.status_code == 200
    assert response.json()["status"] == ("done" if marker == "status.json" else "failed")


def test_published_artifacts_do_not_need_the_store(directory, monkeypatch):
    monkeypatch.setattr(store, "record", unavailable)
    (directory / "result" / "pages").mkdir(parents=True)
    artifacts = {"output.md": "# Accepted\n", "result/result.json": '{"schema_version":4}',
                 "result/pages/1.json": '{"page":1}'}
    client = TestClient(api.app)
    for path, route in [("output.md", "output.md"), ("result/result.json", "result"),
                        ("result/pages/1.json", "pages/1")]:
        (directory / path).write_text(artifacts[path])
        response = client.get(f"/api/runs/run-live/{route}")
        assert response.status_code == 200 and response.content == artifacts[path].encode()
