"""Discovery feedback includes completed windows even while their peers are still pending."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from copy import deepcopy
from dataclasses import asdict
from inspect import unwrap
from threading import Event

import pytest

from kei_exp.kie.extract import discovery
from kei_exp.kie.extract import calls, unified
from kei_exp.kie.extract.models import Router
from kei_exp.kie.passages import Evidence, Passage
from kei_exp.workflows import durable_extract as worker
from tests.test_durable_extraction import Counter, MemoryLease
from tests.test_extract_grounded import CountingChat
from tests.test_unified_catalog import Model, evidence, request


def source():
    return Evidence(run_id="probe", generation="g1", digest="d1", source_name="numbered.pdf", page_count=2,
                    passages=tuple(Passage(id=f"p{n}_s0", page=n, index=0, text=f"{n}. Site {n}.",
                        label="Text", bbox_pt=(0., 0., 100., 20.), extent="block") for n in (1, 2)))


def reply(user):
    number = "1" if "[L1] 1. Site" in user else "2"
    return {"places": [["L1", "record", number]], "begins_inside_record": False, "ends_inside_record": False}


def test_pipelined_tail_window_is_in_the_last_progress_event():
    class Pending(BaseException):
        pass

    shown = []

    def ask(_record, _system, user, *_):
        if "[L1] 1. Site" in user:
            raise Pending()
        return reply(user)

    result = discovery.discover(source(), "numbered site", lambda *_: True,
        ask, overlap=0, splits=0, by="page", workers=2,
        progress=lambda found, lines: shown.append(deepcopy(found)), frontier=True,
        unanswered=(Pending,))
    assert not result['complete']  # the source tail answered while an earlier window is still pending
    assert shown[-1] == [{"segment": "p2_s0", "label": "2"}], shown


@pytest.mark.parametrize("defaults", [1, 2])
def test_slice_publishes_a_finished_window_before_its_slow_peer(defaults):
    first_returned, second_waiting, release, published = Event(), Event(), Event(), Event()
    shown = []

    def ask(_record, _system, user, *_):
        if "[L1] 1. Site" in user:
            first_returned.set()
            return reply(user)
        second_waiting.set()
        assert release.wait(5), "test cleanup failed to release the slow peer"
        return reply(user)

    # Version 1 uses budget windows; force the same two windows without changing discovery.
    fits = lambda _system, user, _schema: not ("[L1] 1. Site" in user and "[L2] 2. Site" in user)
    def progress(found, lines):
        shown.append(deepcopy(found))
        if {"segment": "p1_s0", "label": "1"} in found:
            published.set()

    with ThreadPoolExecutor(max_workers=1) as runner:
        future = runner.submit(discovery.discover, source(), "numbered site", fits, ask,
            overlap=0, splits=0, by="budget" if defaults == 1 else "page", workers=2,
            progress=progress)
        try:
            assert first_returned.wait(2) and second_waiting.wait(2)
            assert published.wait(0.25), shown
        finally:
            release.set()
            future.result(timeout=5)
    assert [len(found) for found in shown] == sorted(len(found) for found in shown)
    assert shown[-1] == [{"segment": "p1_s0", "label": "1"}, {"segment": "p2_s0", "label": "2"}]


@pytest.mark.parametrize("defaults", [1, 2, 3, 4])
@pytest.mark.parametrize("answered", [0, 1], ids=["first-window", "tail-window"])
def test_durable_planning_publishes_each_checkpoint_while_its_peer_is_pending(monkeypatch, tmp_path, defaults, answered):
    """Exercise the actual planning step, dispatch and CapturePlanner with one committed reply, without inference.

    Version 1's budget admits each long line alone; the other versions use page windows. The first round captures
    both. Only one is answered before the next round, as when the workflow replans after a child completes.
    """
    document = evidence(*(f"{n}. Site{n}. Material: m{n}. " + "detail " * 150 for n in (1, 2)))
    selected = request(defaults=defaults, input_tokens=512, overlap=0)
    lease = MemoryLease(selected.schema_.model_dump(by_alias=True, exclude_none=True))
    lease.state["intent"] = "RUN"
    lease.state["source"]["runId"] = document.run_id
    chat = CountingChat(Model(document))
    events = []
    monkeypatch.setattr(worker, "Lease", lambda *_: nullcontext(lease))
    monkeypatch.setattr(worker, "coordinator", lambda: None)
    monkeypatch.setattr(worker, "effective", lambda _: (selected, Router(chat, chat)))
    monkeypatch.setattr(worker.runs, "directory_of", lambda _: tmp_path)
    monkeypatch.setattr(worker, "load", lambda _: document)
    monkeypatch.setattr(worker.config, "CATALOG_CHUNKS", 2)
    monkeypatch.setattr(unified, "counters_for", lambda _: {role: Counter() for role in ("fields", "reasoning")})
    monkeypatch.setattr(worker, "show", lambda key, value: events.append((key, deepcopy(value))))

    plan = unwrap(worker.plan_next)
    pending = plan("extraction", "attempt")
    assert len(pending["pending"]) == len(lease.units) == 2
    assert all(unit["descriptor"]["stage"] == "discovery" for unit in lease.units.values())
    before = {key: deepcopy(unit["input"]) for key, unit in lease.units.items()}
    unit = next(unit for unit in lease.units.values()
                if f"Site{answered + 1}." in unit["input"]["request"]["body"]["user"])
    body = dict(unit["input"]["request"]["body"])
    body.pop("max_whitespace")
    parsed, attempts = calls.complete(chat, **body, counter=Counter())
    unit["checkpoint"] = {"output": {"parsed": parsed, "calls": [asdict(call) for call in attempts]}}

    still_pending = plan("extraction", "attempt")
    assert len(still_pending["pending"]) == 1
    assert events[-1] == ("discovery", {
        "found": [{"segment": f"p{answered + 1}_s0", "label": f"{answered + 1}."}],
        "windows": [{"capture": still_pending["pending"][0],
                     "lines": [{"segment": f"p{2 - answered}_s0", "start": 0,
                                "end": len(document.passages[1 - answered].text.rstrip())}]}],
    })
    assert {key: unit["input"] for key, unit in lease.units.items()} == before
    assert len(chat.calls) == 1  # Planning only replays the saved reply; it never calls a model.


@pytest.mark.parametrize('start_page', [1, 3, 5])
def test_planned_catalog_calls_start_nearest_the_requested_page(monkeypatch, tmp_path, start_page):
    """Planning and the worker preserve page priority even with more captures than execution slots."""
    from tests.test_durable_calls import Calls, run_loop
    from tests.test_durable_entry_reuse import answer

    document = evidence(*(f'{n}. Site{n}. Material: m{n}.' for n in range(1, 6)))
    selected = request(defaults=5, start_page=start_page)
    lease = MemoryLease(selected.schema_.model_dump(by_alias=True, exclude_none=True))
    lease.state['intent'] = 'RUN'
    lease.state['source']['runId'] = document.run_id
    chat = CountingChat(Model(document))
    monkeypatch.setattr(worker, 'Lease', lambda *_: nullcontext(lease))
    monkeypatch.setattr(worker, 'coordinator', lambda: None)
    monkeypatch.setattr(worker, 'effective', lambda _: (selected, Router(chat, chat)))
    monkeypatch.setattr(worker.runs, 'directory_of', lambda _: tmp_path)
    monkeypatch.setattr(worker, 'load', lambda _: document)
    monkeypatch.setattr(worker.config, 'CATALOG_CHUNKS', 2)
    monkeypatch.setattr(unified, 'counters_for', lambda _: {role: Counter() for role in ('fields', 'reasoning')})
    monkeypatch.setattr(worker, 'show', lambda *_: None)
    plan = unwrap(worker.plan_next)
    pending = plan(f'priority-{start_page}', 'attempt')
    assert all(role == 'reasoning' for role in pending['roles'].values())
    for capture in pending['pending']:
        answer(lease, chat, capture, Counter())
    pending = plan(f'priority-{start_page}', 'attempt')
    units = {unit['id']: unit for unit in lease.units.values()}
    record = lambda capture: units[capture]['input']['request']['body']['record']
    expected = sorted(range(5), key=lambda number: (abs(number + 1 - start_page), number))
    assert [record(capture) for capture in pending['pending']] == expected

    scheduled = Calls({capture: pending['roles'][capture] for capture in pending['pending']})
    first_batch = []
    wait = scheduled.wait_first

    def wait_first(handles, polling_interval_sec):
        if not first_batch:
            first_batch.extend(scheduled.running)
        return wait(handles, polling_interval_sec)

    scheduled.wait_first = wait_first
    assert run_loop(monkeypatch, scheduled, chunks=2) == {'status': 'ACK'}
    assert [record(capture) for capture in first_batch] == expected[:2]
    assert scheduled.peak == {'fields': 2}


def test_planned_catalog_calls_carry_their_entrys_distance_from_the_start_page_as_priority(monkeypatch, tmp_path):
    from tests.test_durable_entry_reuse import answer

    document = evidence(*(f'{n}. Site{n}. Material: m{n}.' for n in range(1, 21)))
    selected = request(defaults=5, start_page=20)
    lease = MemoryLease(selected.schema_.model_dump(by_alias=True, exclude_none=True))
    lease.state['intent'], lease.state['source']['runId'] = 'RUN', document.run_id
    lease.state['effective']['options'] = {'start_page': 20}  # as `worker.effective` pins it
    chat = CountingChat(Model(document))
    monkeypatch.setattr(worker, 'Lease', lambda *_: nullcontext(lease))
    monkeypatch.setattr(worker, 'coordinator', lambda: None)
    monkeypatch.setattr(worker, 'effective', lambda _: (selected, Router(chat, chat)))
    monkeypatch.setattr(worker.runs, 'directory_of', lambda _: tmp_path)
    monkeypatch.setattr(worker, 'load', lambda _: document)
    monkeypatch.setattr(unified, 'counters_for', lambda _: {role: Counter() for role in ('fields', 'reasoning')})
    monkeypatch.setattr(worker, 'show', lambda *_: None)
    plan = unwrap(worker.plan_next)
    pending = plan('distance', 'attempt')
    assert set(pending['priorities'].values()) == {0}  # discovery reads no one page
    while all(role == 'reasoning' for role in pending['roles'].values()):
        for capture in pending['pending']:
            answer(lease, chat, capture, Counter())
        pending = plan('distance', 'attempt')
    units = {unit['id']: unit for unit in lease.units.values()}
    page = {capture: units[capture]['input']['request']['body']['record'] + 1 for capture in pending['pending']}
    assert sorted(page.values()) == list(range(1, 21))
    assert {capture: pending['priorities'][capture] for capture in page} == {
        capture: (20 - page[capture]) // 8 for capture in page}  # pages 1-4 at 2, 5-12 at 1, 13-20 at 0
