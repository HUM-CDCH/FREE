"""Token-file batching boundaries, ordering and failures without a database or model server."""
import json
import logging
import threading
from contextlib import closing

import pytest

from kei_exp import runs
from kei_exp.jobs import events, store, tokens


@pytest.fixture
def stream(tmp_path, monkeypatch):
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    directory = tmp_path / "run"
    directory.mkdir()
    committed = []

    def append(run, attempt, batch):
        numbered = [{**event, "seq": len(committed) + i, "attempt": attempt} for i, event in enumerate(batch)]
        assert all(event["type"] != "token" for event in batch)
        committed.extend(numbered)
        return numbered

    monkeypatch.setattr(store, "append_events", append)
    monkeypatch.setattr(store, "last_event_id", lambda _: len(committed) - 1)
    return directory / "tokens.jsonl", committed


@pytest.fixture
def buffered(stream, monkeypatch):
    monkeypatch.setattr(events, "FLUSH_INTERVAL", 60)
    with closing(events.DurableEmit("run", 1)) as emit:
        yield emit, *stream


def read(path):
    return tokens.read_after(path, 0, 100)[0]


def test_tokens_flush_at_four_kib_of_utf8_text(buffered):
    emit, path, committed = buffered
    token = {"type": "token", "page": 1, "text": "é" * 1024}
    emit(token)
    assert not path.exists()
    emit(token)
    saved = read(path)
    assert [event["text"] for event in saved] == [token["text"], token["text"]]
    assert saved[-1]["token_offset"] == path.stat().st_size
    assert committed == []  # 4096 bytes trigger a file write, never a DB write
    emit.flush()
    assert read(path) == saved


@pytest.mark.parametrize("kind", ["phase", "region", "page_start", "page_end", "page_stats", "log", "status"])
def test_every_control_event_follows_pending_tokens(buffered, kind):
    emit, path, committed = buffered
    for page, text in [(1, "a"), (2, "b"), (1, "c")]:
        emit({"type": "token", "page": page, "unit": 2, "crop": page, "text": text})
    emit({"type": kind})
    saved = read(path)
    assert [event["text"] for event in saved] == ["a", "b", "c"]
    assert all(event["seq"] == -1 and event["attempt"] == 1 for event in saved)
    assert committed == [{"type": kind, "seq": 0, "attempt": 1, "token_offset": path.stat().st_size}]


def test_flush_copies_producer_event_and_anchors_tokens_to_the_preceding_control(buffered):
    emit, path, committed = buffered
    emit({"type": "page_start", "page": 1})
    token = {"type": "token", "page": 1, "text": "original", "seq": 999, "attempt": 7}
    emit(token)
    token["text"] = "changed after emit"
    emit.flush()
    assert read(path) == [{"type": "token", "page": 1, "text": "original", "seq": 0, "attempt": 1,
                           "token_offset": path.stat().st_size}]
    assert len(committed) == 1


def test_a_lone_token_flushes_without_waiting_for_another_event(stream, monkeypatch):
    path, committed = stream
    flushed = threading.Event()
    append = tokens.TokenLog.append

    def observed(self, batch):
        append(self, batch)
        flushed.set()

    monkeypatch.setattr(tokens.TokenLog, "append", observed)
    with closing(events.DurableEmit("run", 1)) as emit:
        emit({"type": "token", "page": 1, "text": "idle stream"})
        assert flushed.wait(timeout=1), "the 50 ms deadline needs a timer, not another token"
        assert read(path)[0]["text"] == "idle stream"
        assert committed == []


def test_a_control_cannot_overtake_a_timer_write(stream, monkeypatch):
    path, committed = stream
    writing, release, control_started, control_done = (threading.Event() for _ in range(4))
    append = tokens.TokenLog.append

    def blocked(self, batch):
        writing.set()
        assert release.wait(timeout=2)
        append(self, batch)

    monkeypatch.setattr(tokens.TokenLog, "append", blocked)
    with closing(events.DurableEmit("run", 1)) as emit:
        def finish():
            control_started.set()
            emit({"type": "page_end", "page": 1})
            control_done.set()

        emit({"type": "token", "page": 1, "text": "pending"})
        assert writing.wait(timeout=1)
        thread = threading.Thread(target=finish)
        thread.start()
        try:
            assert control_started.wait(timeout=1)
            assert not control_done.wait(timeout=0.05)
            assert committed == []
        finally:
            release.set()
            thread.join(timeout=2)
        assert control_done.is_set()
        assert read(path)[0]["text"] == "pending"
        assert committed[0]["token_offset"] == path.stat().st_size


def test_a_cancelled_timer_cannot_flush_a_newer_batch(stream, monkeypatch):
    path, committed = stream
    entered, release = threading.Event(), threading.Event()
    flush_timed = events.DurableEmit._flush_timed

    def delayed(self):
        entered.set()
        assert release.wait(timeout=2)
        flush_timed(self)

    monkeypatch.setattr(events.DurableEmit, "_flush_timed", delayed)
    with closing(events.DurableEmit("run", 1)) as emit:
        emit({"type": "token", "page": 1, "text": "first"})
        old_timer = emit._timer
        try:
            assert entered.wait(timeout=1)
            emit({"type": "page_end", "page": 1})
            monkeypatch.setattr(events, "FLUSH_INTERVAL", 60)
            emit({"type": "token", "page": 1, "text": "second"})
        finally:
            release.set()
            old_timer.join(timeout=2)
        assert [event["text"] for event in read(path)] == ["first"]
        emit.flush()
        assert [event["text"] for event in read(path)] == ["first", "second"]
        assert len(committed) == 1


@pytest.mark.parametrize("next_call", ["emit", "flush"])
def test_a_timer_failure_is_raised_to_the_conversion_thread(stream, monkeypatch, next_call):
    path, committed = stream
    attempted = threading.Event()

    def fail(self, batch):
        attempted.set()
        raise OSError("disk full")

    monkeypatch.setattr(tokens.TokenLog, "append", fail)
    failure = {"type": "status", "status": "failed"}
    with closing(events.DurableEmit("run", 1)) as emit:
        emit({"type": "token", "page": 1, "text": "unwritten"})
        assert attempted.wait(timeout=1)
        with pytest.raises(OSError, match="disk full"):
            emit.flush() if next_call == "flush" else emit(failure)
        emit(failure)
        assert committed[0]["status"] == "failed"
        assert read(path) == []


def test_closing_a_failed_attempt_cancels_its_pending_timer(buffered):
    emit, path, committed = buffered
    emit({"type": "token", "page": 1, "text": "provisional"})
    timer = emit._timer
    emit.close()
    timer.join(timeout=1)
    assert not timer.is_alive()
    assert committed == [] and not path.exists()
    with pytest.raises(RuntimeError, match="closed"):
        emit({"type": "token", "page": 1, "text": "late"})


def test_restart_keeps_complete_lines_and_discards_a_torn_utf8_tail(stream):
    path, committed = stream
    with closing(events.DurableEmit("run", 1)) as emit:
        emit({"type": "page_start", "page": 1})
        emit({"type": "token", "page": 1, "text": "first é"})
        emit.flush()
    original = path.read_bytes()
    with path.open("ab") as file:
        file.write(b'{"type":"token","text":"\xc3')
    assert len(read(path)) == 1  # neither JSON nor UTF-8 parsing sees the unfinished line
    with closing(events.DurableEmit("run", 2)) as emit:
        emit({"type": "page_start", "page": 1})
        emit({"type": "token", "page": 1, "text": "second é"})
        emit({"type": "status", "status": "done"})
    assert path.read_bytes().startswith(original)
    assert [(event["text"], event["attempt"], event["seq"]) for event in read(path)] == [
        ("first é", 1, 0), ("second é", 2, 1)]
    assert committed[1]["token_offset"] == len(original)


def test_tokens_reload_their_anchor_after_a_lost_control_commit_acknowledgement(buffered, monkeypatch):
    emit, path, committed = buffered
    emit({"type": "phase", "name": "ocr"})
    append = store.append_events

    def lose_ack(run, attempt, batch):
        append(run, attempt, batch)
        raise store.Unavailable("lost acknowledgement")

    monkeypatch.setattr(store, "append_events", lose_ack)
    emit({"type": "page_start", "page": 1})  # committed, its acknowledgement lost: dropped here, not raised
    emit({"type": "token", "page": 1, "text": "concurrent producer"})
    emit.flush()
    assert read(path)[0]["seq"] == committed[-1]["seq"] == 1


def test_a_store_outage_drops_progress_without_disturbing_the_conversion(buffered, monkeypatch, caplog):
    """Progress is best-effort: an unreachable database must not reach the conversion producing real output.

    Both database calls an emit can make fail here — the control commit and the token anchor — and neither the
    dropped control event nor the outage itself is allowed to surface as an exception to the caller.
    """
    emit, path, committed = buffered

    def unavailable(*_args, **_kwargs):
        raise store.Unavailable("connection refused")

    monkeypatch.setattr(store, "append_events", unavailable)
    monkeypatch.setattr(store, "last_event_id", unavailable)
    with caplog.at_level(logging.WARNING, logger=events.__name__):
        emit({"type": "phase", "name": "ocr"})
        emit({"type": "token", "page": 1, "text": "still previewed"})
        emit({"type": "page_end", "page": 1})
        emit.flush()
    assert committed == []
    assert [event["text"] for event in read(path)] == ["still previewed"]
    assert len(caplog.records) == 1, "an outage is logged once, not once per dropped event"


def test_the_emitter_commits_again_once_the_store_is_back(buffered, monkeypatch, caplog):
    emit, _path, committed = buffered
    append, outage = store.append_events, True

    def sometimes(run, attempt, batch):
        if outage:
            raise store.Unavailable("connection refused")
        return append(run, attempt, batch)

    monkeypatch.setattr(store, "append_events", sometimes)
    with caplog.at_level(logging.WARNING, logger=events.__name__):
        emit({"type": "phase", "name": "ocr"})       # dropped
        outage = False
        emit({"type": "phase", "name": "export"})    # committed again
        outage = True
        emit({"type": "status", "status": "done"})   # dropped, and a second outage is worth its own line
    assert [(event["type"], event.get("name")) for event in committed] == [("phase", "export")]
    assert len(caplog.records) == 2


def test_a_recovery_seen_only_by_a_token_still_lets_the_next_outage_be_logged(buffered, monkeypatch, caplog):
    """Any successful store call re-arms the report, not only a committed control event.

    A page can run for a long time between two control events, emitting nothing but tokens, and their anchor
    lookup is then the only thing that sees the store come back. Re-arming on the commit alone would fold that
    recovery's two distinct outages into one log line, and the second would go unreported.
    """
    emit, _path, committed = buffered
    anchor, down = store.last_event_id, True

    def unavailable(*_args, **_kwargs):
        raise store.Unavailable("connection refused")

    def anchor_when_up(run_id):
        if down:
            raise store.Unavailable("connection refused")
        return anchor(run_id)

    monkeypatch.setattr(store, "append_events", unavailable)
    monkeypatch.setattr(store, "last_event_id", anchor_when_up)
    with caplog.at_level(logging.WARNING, logger=events.__name__):
        emit({"type": "phase", "name": "ocr"})                     # the first outage: dropped and reported
        down = False                                               # the store comes back ...
        emit({"type": "token", "page": 1, "text": "only tokens"})  # ... and only this anchor lookup sees it
        down = True
        emit({"type": "status", "status": "done"})                 # a second, distinct outage: its own line
    assert committed == []
    assert len(caplog.records) == 2


def test_a_partial_file_line_waits_for_its_newline(tmp_path):
    path = tmp_path / "tokens.jsonl"
    line = json.dumps({"type": "token", "page": 1, "text": "é", "seq": -1}, ensure_ascii=False).encode()
    path.write_bytes(line[:-3])
    assert tokens.read_after(path, 0, -1) == ([], 0)
    with path.open("ab") as file:
        file.write(line[-3:] + b"\n")
    read, offset = tokens.read_after(path, 0, -1)
    assert read[0]["text"] == "é" and offset == len(line) + 1
