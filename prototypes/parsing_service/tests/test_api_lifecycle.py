"""Outage and SSE interleavings, without a database or model server."""
import asyncio
import json
import threading
from datetime import UTC, datetime
from types import SimpleNamespace

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


@pytest.mark.parametrize("route", ["/api/runs", "/api/runs/run-live", "/api/runs/run-live/events"])
def test_durable_reads_are_unavailable_not_failed(directory, monkeypatch, route):
    monkeypatch.setattr(store, "records", unavailable)
    monkeypatch.setattr(store, "record", unavailable)
    response = TestClient(api.app).get(route)
    assert response.status_code == 503
    assert response.headers["retry-after"]
    assert runs.UNRECORDED not in response.text
    assert runs.summary(directory) is None
    assert list(runs.replay(directory, -1)) == []


def test_unknown_directory_is_not_a_failed_legacy_run(directory, monkeypatch):
    monkeypatch.setattr(store, "records", list)
    monkeypatch.setattr(store, "record", lambda _: None)
    client = TestClient(api.app)
    assert client.get("/api/runs").json() == []
    assert client.get("/api/runs/run-live").status_code == 404
    assert client.get("/api/runs/run-live/events").status_code == 404


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
    stream = client.get("/api/runs/run-live/events")
    assert stream.status_code == 200 and "event: status" in stream.text


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


@pytest.mark.parametrize("slow_read", ["initial", "events", "poll"])
def test_sse_database_reads_leave_the_event_loop_free(directory, monkeypatch, slow_read):
    released = threading.Event()
    progressed = []
    calls = 0

    def record(_):
        nonlocal calls
        calls += 1
        if (slow_read == "initial" and calls == 1) or (slow_read == "poll" and calls == 2):
            progressed.append(released.wait(timeout=1))
        return SimpleNamespace(job_status="succeeded", finished=datetime.now(UTC))

    def events(*args):
        if slow_read == "events":
            progressed.append(released.wait(timeout=1))
        return []

    monkeypatch.setattr(store, "record", record)
    monkeypatch.setattr(store, "events_after", events)

    async def fetch():
        response = await api.run_events(directory.name)
        return [chunk async for chunk in response.body_iterator]

    async def scenario():
        async def other_request():
            await asyncio.sleep(0.01)
            released.set()
        await asyncio.wait_for(asyncio.gather(fetch(), other_request()), timeout=3)

    asyncio.run(scenario())
    assert progressed and all(progressed), "a database read blocked the unrelated coroutine"


def test_completion_between_event_and_state_reads_replays_the_committed_event(directory, monkeypatch):
    committed = False
    done = {"seq": 0, "type": "status", "status": "done", "error": None, "attempt": 1}

    def events(_, after):
        nonlocal committed
        if not committed:
            committed = True  # worker commits just after the event query's snapshot
            return []
        return [done] if after < 0 else []

    monkeypatch.setattr(store, "events_after", events)
    monkeypatch.setattr(store, "record", lambda _: SimpleNamespace(
        job_status="doing", finished=datetime.now(UTC) if committed else None))
    response = TestClient(api.app).get("/api/runs/run-live/events")
    assert response.text == api.sse(done)
    monkeypatch.setattr(store, "record", lambda _: SimpleNamespace(
        job_status="succeeded", finished=datetime.now(UTC)))
    assert TestClient(api.app).get("/api/runs/run-live/events", headers={"Last-Event-ID": "0"}).text == ""


def test_a_finish_stamp_alone_never_closes_with_running(directory, monkeypatch):
    calls = 0
    done = {"seq": 4, "type": "status", "status": "done", "error": None, "attempt": 1}

    def record(_):
        nonlocal calls
        calls += 1
        return SimpleNamespace(job_status="doing" if calls < 3 else "succeeded", finished=datetime.now(UTC))

    monkeypatch.setattr(store, "record", record)
    monkeypatch.setattr(store, "events_after", lambda _, after: [done] if calls >= 3 and after < 4 else [])
    response = TestClient(api.app).get("/api/runs/run-live/events")
    assert response.text == api.sse(done)


def test_midstream_outage_does_not_emit_a_terminal_status(directory, monkeypatch):
    monkeypatch.setattr(store, "record", lambda _: SimpleNamespace(job_status="doing", finished=None))
    monkeypatch.setattr(store, "events_after", unavailable)
    response = TestClient(api.app).get("/api/runs/run-live/events")
    assert response.status_code == 200  # headers are already sent; reconnect without changing the cursor
    assert "event: status" not in response.text and "id:" not in response.text
