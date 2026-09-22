"""The durable event stream: numbering is serialized per run, replay is by sequence, and two emitters of one run
never commit out of order."""
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

import psycopg
import pytest

from kei_exp import runs
from kei_exp.jobs import schema, store, tokens
from kei_exp.jobs.app import deferring_installed
from kei_exp.jobs.events import DurableEmit

PARAMS = {"page_count": 1}


@pytest.fixture
def run(database: str, tmp_path, monkeypatch) -> str:
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    (tmp_path / "run-e").mkdir()
    schema.apply(database)
    store.close_pool()
    store.pool(database)
    try:
        with deferring_installed(database):
            store.admit("run-e", PARAMS, slot="slot-e")
            yield "run-e"
    finally:
        store.close_pool()


def test_events_are_numbered_from_zero_and_replayed_in_order(run: str) -> None:
    emit = DurableEmit(run, attempt=1)
    emit({"type": "phase", "name": "cut", "total": 2})
    emit({"type": "log", "text": "hello"})
    emit.flush()
    replayed = store.events_after(run, -1)
    assert [event["seq"] for event in replayed] == [0, 1]
    assert [event["type"] for event in replayed] == ["phase", "log"]
    assert store.events_after(run, 0) == replayed[1:]


def test_the_allocator_overrides_a_producers_own_seq_and_attempt(run: str) -> None:
    """The sequence is the allocator's to decide; an event that carries its own must not win.

    `runs.Job._record` numbers events with exactly these field names, so a producer arriving from that
    vocabulary is a realistic source of a colliding key rather than a hypothetical one.
    """
    emit = DurableEmit(run, attempt=3)
    emit({"type": "log", "text": "stowaway", "seq": 999, "attempt": 7})
    emit.flush()
    stored = store.events_after(run, -1)
    assert [(event["seq"], event["attempt"]) for event in stored] == [(0, 3)]


def test_every_event_carries_its_attempt(run: str) -> None:
    DurableEmit(run, attempt=1)({"type": "log", "text": "first"})
    DurableEmit(run, attempt=2)({"type": "log", "text": "second"})
    assert [event["attempt"] for event in store.events_after(run, -1)] == [1, 2]


def test_concurrent_emitters_produce_one_contiguous_sequence(run: str) -> None:
    def shout(number: int) -> None:
        DurableEmit(run, attempt=1)({"type": "log", "text": f"line {number}"})

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(shout, range(64)))
    numbers = [event["seq"] for event in store.events_after(run, -1)]
    assert numbers == list(range(64))  # no gap, no repeat, whatever the interleaving


def test_concurrent_pages_keep_tokens_on_disk_and_only_controls_in_postgres(run: str, monkeypatch) -> None:
    batches = []
    append = store.append_events

    def record_batch(run_id, attempt, batch):
        batches.append(len(batch))
        return append(run_id, attempt, batch)

    monkeypatch.setattr(store, "append_events", record_batch)
    with closing(DurableEmit(run, attempt=1)) as emit:
        def page(number):
            emit({"type": "page_start", "page": number})
            for index in range(200):
                emit({"type": "token", "page": number, "unit": 0, "crop": number,
                      "text": f"{number}:{index}é "})
            emit({"type": "page_end", "page": number})

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(page, range(1, 5)))
        emit({"type": "status", "status": "done"})
        emit.flush()

    saved = store.events_after(run, -1)
    assert [event["seq"] for event in saved] == list(range(9))
    assert all(event["type"] != "token" for event in saved)
    previews, _ = tokens.read_after(runs.RUNS / run / "tokens.jsonl", 0, saved[-1]["seq"])
    combined = sorted([*saved, *previews], key=lambda event: (event["seq"], event["token_offset"]))
    assert all(event["attempt"] == 1 for event in saved)
    assert saved[-1]["type"] == "status"
    for number in range(1, 5):
        page_events = [event for event in combined if event.get("page") == number]
        assert page_events[0]["type"] == "page_start"
        assert page_events[-1]["type"] == "page_end"
        page_tokens = page_events[1:-1]
        assert all(event["type"] == "token" and event["unit"] == 0 and event["crop"] == number for event in page_tokens)
        assert "".join(event["text"] for event in page_tokens) == "".join(f"{number}:{index}é " for index in range(200))
    assert store.events_after(run, 3) == saved[4:]
    assert sum(batches) == len(saved)
    assert batches == [1] * 9  # 800 tokens cause zero database writes


def test_events_after_answers_at_most_one_bounded_page(run: str) -> None:
    """No read of a run's history is unbounded: the caller asks again for the page after the one it holds."""
    store.append_events(run, 1, [{"type": "log", "text": f"line {number}"}
                                 for number in range(store.EVENT_PAGE + 10)])
    page = store.events_after(run, -1)
    assert [event["seq"] for event in page] == list(range(store.EVENT_PAGE))
    assert [event["seq"] for event in store.events_after(run, page[-1]["seq"])] == \
        list(range(store.EVENT_PAGE, store.EVENT_PAGE + 10))
    assert store.events_after(run, -1, limit=3) == page[:3]
    assert store.events_after(run, -1, event_type="log", limit=3) == page[:3]
    assert store.events_after(run, -1, event_type="phase", limit=3) == []


def test_an_attempt_records_how_it_ended(run: str) -> None:
    row = store.record(run)
    assert row is not None and row.job_id is not None
    store.attempt_started(run, 1, row.job_id)
    store.attempt_finished(run, 1, "failed", "vLLM unreachable")
    after = store.record(run)
    assert after is not None and (after.attempt, after.error) == (1, "vLLM unreachable")


def test_attempt_finished_raises_when_it_matches_no_row(run: str) -> None:
    """A lost or mismatched attempt (no `attempt_started` for it, or the wrong attempt number) must not be
    allowed to look recorded: the UPDATE affecting zero rows has to surface, not silently succeed."""
    with pytest.raises(ValueError, match=re.escape(f"run {run!r} attempt 1")):
        store.attempt_finished(run, 1, "failed", "never started")


def test_a_failed_append_rolls_the_allocator_back(run: str, database: str) -> None:
    """The allocator and the insert are one transaction, so a failed insert must un-spend the number.

    An unserialisable payload fails inside `json.dumps`, after the UPDATE has already incremented `next` —
    exactly the window where a split transaction would leak a consumed sequence number.
    """
    with pytest.raises(TypeError):
        store.append_events(run, 1, [{"type": "bad", "payload": object()}])
    with psycopg.connect(database) as conn:
        assert conn.execute("SELECT next FROM kei_event_seq WHERE run_id = %s", (run,)).fetchone() == (0,)
        assert conn.execute("SELECT count(*) FROM kei_event WHERE run_id = %s", (run,)).fetchone() == (0,)


def test_phase_timing_and_its_event_commit_together(run: str) -> None:
    store.attempt_started(run, 1, store.record(run).job_id)
    # The second phase fails after the first one's event and timing update. All of it must roll back.
    with pytest.raises(KeyError):
        store.append_events(run, 1, [{"type": "phase", "name": "ocr"}, {"type": "phase"}])
    assert store.events_after(run, -1) == []
    assert [timing["step"] for timing in store.record(run).step_timings] == ["prepare"]
    [phase] = store.append_events(run, 1, [{"type": "phase", "name": "ocr"}])
    assert phase["seq"] == 0
    assert [timing["step"] for timing in store.record(run).step_timings] == ["prepare", "ocr"]


def test_cancellation_is_a_flag_on_the_run(run: str) -> None:
    assert store.cancel_requested(run) is False
    with store.connection() as conn:
        conn.execute("UPDATE kei_run SET cancel_requested = true WHERE id = %s", (run,))
        conn.commit()
    assert store.cancel_requested(run) is True
