"""Replay and reconnect across the database control log and token JSONL file."""
import asyncio
import json
from contextlib import closing
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from kei_exp import api, runs
from kei_exp.jobs import store, tokens
from kei_exp.jobs.events import DurableEmit


@pytest.fixture
def stream(tmp_path, monkeypatch):
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    directory = tmp_path / "run-json"
    directory.mkdir()
    runs.write_json(directory / "params.json", {"id": directory.name})
    saved = []

    def append(run_id, attempt, batch):
        numbered = [{**event, "seq": len(saved) + i, "attempt": attempt} for i, event in enumerate(batch)]
        saved.extend(numbered)
        return numbered

    monkeypatch.setattr(store, "append_events", append)
    monkeypatch.setattr(store, "last_event_id", lambda _: len(saved) - 1)
    monkeypatch.setattr(store, "record", lambda _: SimpleNamespace(
        job_status="succeeded" if saved and saved[-1]["type"] == "status" else "doing", finished=None))
    monkeypatch.setattr(store, "events_after", lambda _, after: [event for event in saved if event["seq"] > after])
    with closing(DurableEmit(directory.name, 1)) as emit:
        yield directory, emit, saved


def data(text):
    return [json.loads(line.removeprefix("data: ")) for line in text.splitlines() if line.startswith("data: ")]


def test_reconnect_after_each_control_or_coalesced_token_has_no_gaps_or_repeats(stream):
    directory, emit, saved = stream
    emit({"type": "page_start", "page": 1})
    emit({"type": "token", "page": 1, "text": "héllo "})
    emit.flush()
    first_offset = (directory / "tokens.jsonl").stat().st_size
    emit({"type": "token", "page": 1, "text": "world"})
    emit({"type": "page_end", "page": 1})
    emit({"type": "status", "status": "done"})
    client = TestClient(api.app)
    url = f"/api/runs/{directory.name}/events"
    response = client.get(url)
    replay = data(response.text)
    assert [event["type"] for event in replay] == ["page_start", "token", "page_end", "status"]
    assert replay[1]["text"] == "héllo world"
    assert all(event["type"] != "token" for event in saved)
    ids = [line[4:] for line in response.text.splitlines() if line.startswith("id: ")]
    assert len(ids) == len(set(ids)) == 4
    for index, cursor in enumerate(ids):
        assert data(client.get(url, headers={"Last-Event-ID": cursor}).text) == replay[index + 1:]
        assert data(client.get(url, params={"after": cursor}).text) == replay[index + 1:]
    rest = data(client.get(url, headers={"Last-Event-ID": f"0:{first_offset}"}).text)
    assert rest[0]["text"] == "world"  # reconnect inside what a later full replay would coalesce
    assert rest[1:] == replay[2:]
    assert data(client.get(url, params={"after": ids[2]}, headers={"Last-Event-ID": ids[0]}).text) == replay[3:]


def test_live_tokens_arrive_without_another_database_event(stream):
    directory, emit, saved = stream
    emit({"type": "page_start", "page": 1})

    async def scenario():
        response = await api.run_events(directory.name)
        iterator = response.body_iterator
        assert data(await anext(iterator))[0]["type"] == "page_start"
        emit({"type": "token", "page": 1, "text": "live"})
        emit.flush()
        token = data(await asyncio.wait_for(anext(iterator), 1))[0]
        assert token["text"] == "live" and token["seq"] == 0
        assert len(saved) == 1
        emit({"type": "status", "status": "done"})
        assert [event["type"] for chunk in [chunk async for chunk in iterator] for event in data(chunk)] == ["status"]

    asyncio.run(scenario())


def test_file_read_cannot_overtake_a_control_missing_from_the_database_snapshot(stream, monkeypatch):
    directory, emit, saved = stream
    emit({"type": "phase", "name": "ocr"})
    calls = 0

    def events_after(_, after):
        nonlocal calls
        calls += 1
        batch = [event for event in saved if event["seq"] > after]
        if calls == 1:
            emit({"type": "page_start", "page": 1})
            emit({"type": "token", "page": 1, "text": "later snapshot"})
            emit.flush()
        elif calls == 2:
            emit({"type": "status", "status": "done"})
        return batch

    monkeypatch.setattr(store, "events_after", events_after)
    replay = data(TestClient(api.app).get(f"/api/runs/{directory.name}/events").text)
    assert [event["type"] for event in replay] == ["phase", "page_start", "token", "status"]
    assert [api._position(event) for event in replay] == sorted(api._position(event) for event in replay)


def test_completion_reread_drains_tokens_before_the_terminal_event(stream, monkeypatch):
    directory, emit, _ = stream
    calls = 0

    def record(_):
        nonlocal calls
        calls += 1
        if calls == 2:
            emit({"type": "token", "page": 1, "text": "final"})
            emit({"type": "status", "status": "done"})
        return SimpleNamespace(job_status="doing", finished=True if calls >= 2 else None)

    monkeypatch.setattr(store, "record", record)
    replay = data(TestClient(api.app).get(f"/api/runs/{directory.name}/events").text)
    assert [event["type"] for event in replay] == ["token", "status"]
    assert replay[0]["text"] == "final"


def test_a_restarted_emitter_and_api_replay_the_file_without_prior_memory(stream):
    directory, emit, _ = stream
    emit({"type": "page_start", "page": 1})
    emit({"type": "token", "page": 1, "text": "old attempt"})
    emit.flush()
    old_offset = (directory / "tokens.jsonl").stat().st_size
    emit.close()
    with closing(DurableEmit(directory.name, 2)) as restarted:
        restarted({"type": "page_start", "page": 1})
        restarted({"type": "token", "page": 1, "text": "new attempt"})
        restarted({"type": "status", "status": "done"})
    replay = data(TestClient(api.app).get(f"/api/runs/{directory.name}/events",
                                        headers={"Last-Event-ID": f"0:{old_offset}"}).text)
    assert [event["type"] for event in replay] == ["page_start", "token", "status"]
    assert replay[1]["text"] == "new attempt" and replay[1]["attempt"] == 2


def test_old_database_token_rows_and_numeric_reconnect_ids_remain_readable(stream):
    directory, _, saved = stream
    saved.extend([{"seq": 0, "type": "token", "page": 1, "text": "old"},
                  {"seq": 1, "type": "status", "status": "done"}])
    client = TestClient(api.app)
    url = f"/api/runs/{directory.name}/events"
    assert data(client.get(url).text) == saved
    assert data(client.get(url, headers={"Last-Event-ID": "0"}).text) == saved[1:]


def test_a_partial_file_line_waits_for_its_newline(stream):
    directory, _, _ = stream
    path = directory / "tokens.jsonl"
    line = json.dumps({"type": "token", "page": 1, "text": "é", "seq": -1}, ensure_ascii=False).encode()
    path.write_bytes(line[:-3])
    assert tokens.read_after(path, 0, -1) == ([], 0)
    with path.open("ab") as file:
        file.write(line[-3:] + b"\n")
    read, offset = tokens.read_after(path, 0, -1)
    assert read[0]["text"] == "é" and offset == len(line) + 1
