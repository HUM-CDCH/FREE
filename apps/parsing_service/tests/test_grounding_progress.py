"""Independent citation checks are captured together and publish each reply as it arrives.

Durable planning reads in turn (`CapturePlanner.complete` replays a saved reply or captures the call and raises
`NeedsCall`). `grounding.verify` and `routing.verify_routed` capture every independent batch of a round before they
yield, so the worker runs them beside each other within its per-role limit, and read each reply already saved
meanwhile; a round whose grouping follows the earlier replies (the fallback batches, the next routed unit) waits
for every one of them, so the captured calls are the direct run's, whatever order the replies arrive in.
"""
import inspect
import threading
from contextlib import nullcontext
from copy import deepcopy
from dataclasses import asdict, replace
from time import monotonic, sleep
from types import SimpleNamespace

import pytest

from kei_exp.kie.extract import calls, grounding, run
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.durable import Boundary, CapturePlanner, NeedsCall
from kei_exp.kie.extract.grounding import spans
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.routing import value_origins, verify_routed
from kei_exp.kie.extract.schema import Schema
from kei_exp.pagefile import PageTable, TableCell
from kei_exp.workflows import durable_extract as worker
from tests.test_durable_extraction import Counter, MemoryLease
from tests.test_extract_grounded import CountingChat
from tests.test_extract_stages import SCHEMA, evidence, passages


def article(count):
    """`count` string fields of one Article record, each read as `value<n>`: four claims make one quoted batch."""
    schema = Schema.model_validate({"recordDescription": "An article", "schemaNodes": [
        {"id": f"field{i}", "name": f"field{i}", "type": "string"} for i in range(count)]})
    return schema, {f"field{i}": f"value{i}" for i in range(count)}


def attested(_system, _user, reply):
    """Every claim supported by its first offered label, quoting the word every candidate holds."""
    return {claim: {"label": rule["properties"]["label"]["enum"][0], "quote": "value", "attribution": True}
            for claim, rule in reply["properties"].items()}


def table(values):
    """A one-column table, one data cell per value: each claim's precise candidate is its cell, which hides the
    table (the claim's fallback, offered once the precise round leaves it unsupported)."""
    text = "\n".join(values) + "\n"
    cells = [TableCell(cell_id=f"r{row}_c0", row=row, column=0, rowspan=1, colspan=1, role="data", text=value,
                       start=text.index(value), end=text.index(value) + len(value), bbox_pt=None)
             for row, value in enumerate(values)]
    return [replace(passages([text])[0], label="Table",
                    table=PageTable(rows=len(values), columns=1, cells=cells, producer="docling"))]


def planned(lease, chat, ground):
    """A planning round: its planner and the grounding it runs, `ground(router, counter)`."""
    def plan():
        planner = CapturePlanner(lease, {"fields": Counter(), "reasoning": Counter()})
        return planner, lambda: ground(Router(chat, chat, planner), Counter())
    return plan


def answered(lease, chat, capture):
    """The worker's call for `capture`: its saved exact request answered by `chat`, committed as its checkpoint."""
    unit = next(unit for unit in lease.units.values() if unit["id"] == capture)
    body = dict(unit["input"]["request"]["body"])
    body.pop("max_whitespace")
    parsed, attempts = calls.complete(chat, **body, counter=Counter())
    unit["checkpoint"] = {"output": {"parsed": parsed, "calls": [asdict(call) for call in attempts]}}


def finished(lease, chat, plan):
    """Planning rounds until the grounding returns, every pending capture answered between rounds (the worker runs
    them beside each other): each yielding round's pending count, then the result."""
    pending = []
    for _ in range(20):
        planner, execute = plan()
        try:
            result = execute()
        except NeedsCall:
            pending.append(len(planner.pending))
            for capture in planner.pending:
                answered(lease, chat, capture)
            continue
        return pending, result
    raise AssertionError("grounding never completed")


def dumped(result):
    """A grounding result with its calls as the artifact reports them, comparable across a replay."""
    links, made, *rest = result
    return (links, [asdict(call) for call in made], *rest)


def test_independent_quote_batches_are_ready_together_and_a_late_reply_is_shown_first():
    schema, fields = article(8)
    source = passages([" ".join(fields.values())])
    lease = MemoryLease(schema.model_dump(by_alias=True, exclude_none=True))
    chat = CountingChat(lambda _system, _user, reply: {claim: {"label": rule["properties"]["label"]["enum"][0],
        "quote": source[0].text, "attribution": True} for claim, rule in reply["properties"].items()})
    shown = []
    plan = planned(lease, chat, lambda router, counter: grounding.quoted(source, fields, schema, router, record=0,
        counter=counter, projected=True, on_batch=lambda links: shown.extend(link.path for link in links)))
    planner, execute = plan()
    with pytest.raises(NeedsCall):
        execute()
    assert len(planner.pending) == 2  # both independent batches may use the worker's existing concurrency limit
    assert not chat.calls
    original = deepcopy(lease.units)
    late = list(lease.units.values())[-1]
    answered(lease, chat, late["id"])
    planner, execute = plan()
    with pytest.raises(NeedsCall):
        execute()
    assert len(planner.pending) == 1
    assert shown == [("records", 0, f"field{i}") for i in range(4, 8)]
    assert len(chat.calls) == 1
    assert all(unit["input"] == original[key]["input"] for key, unit in lease.units.items())
    pending, result = finished(lease, chat, plan)
    direct = grounding.quoted(source, fields, schema, CountingChat(chat.script), record=0, counter=Counter(),
                              projected=True)
    assert pending == [1] and dumped(result) == dumped(direct)  # the replay reads every reply, in batch order
    assert [link.path[-1] for link in result[0]] == [f"field{i}" for i in range(8)]


def test_a_pause_inside_a_round_keeps_its_captured_batch_and_captures_the_rest_on_resume():
    schema, fields = article(8)
    source = passages([" ".join(fields.values())])
    lease = MemoryLease(schema.model_dump(by_alias=True, exclude_none=True))
    chat = CountingChat(attested)
    paused = []

    class Pausing(Counter):
        def request_tokens(self, system, user, schema=None):
            if "C5 (" in user and not paused:  # the second batch is counted once the first is captured
                paused.append(lease.intent)
                lease.intent = "PAUSE"
            return super().request_tokens(system, user, schema)
    plan = planned(lease, chat, lambda router, counter: grounding.quoted(source, fields, schema, router, record=0,
        counter=Pausing(), projected=True))
    planner, execute = plan()
    with pytest.raises(Boundary):  # no further call may start: the round ends at once, as before
        execute()
    assert len(planner.pending) == 1 and len(lease.units) == 1
    first = deepcopy(next(iter(lease.units.values())))
    lease.intent = "RUN"
    pending, result = finished(lease, chat, plan)
    assert pending == [2]  # the batch captured before the pause, unchanged, beside the one the pause refused
    assert next(iter(lease.units.values()))["input"] == first["input"]
    assert dumped(result) == dumped(grounding.quoted(source, fields, schema, CountingChat(attested), record=0,
                                                     counter=Counter(), projected=True))


def precise_then_fallback(_system, _user, reply):
    """The second claim of each batch is unsupported by its cell alone (the precise round) and supported once the
    table is offered too (the fallback round, whose batches group every such claim of the record)."""
    answer = {}
    for claim, rule in reply["properties"].items():
        offered = rule["properties"]["label"]["enum"]
        if "E1" not in offered and claim in ("C2", "C6"):
            answer[claim] = {"label": "NONE", "quote": "", "attribution": False}
        else:
            answer[claim] = {"label": offered[0], "quote": "value", "attribution": True}
    return answer


def test_the_fallback_round_waits_for_every_precise_reply_and_the_replay_is_the_direct_run():
    schema, fields = article(8)
    source = table(list(fields.values()))
    lease = MemoryLease(schema.model_dump(by_alias=True, exclude_none=True))
    chat = CountingChat(precise_then_fallback)
    shown, proofs = [], []

    def plan():
        proofs.clear()
        planner = CapturePlanner(lease, {"fields": Counter(), "reasoning": Counter()})
        return planner, lambda: grounding.quoted(source, fields, schema, Router(chat, chat, planner), record=0,
            counter=Counter(), projected=True, proofs=proofs,
            on_batch=lambda links: shown.append([link.path[-1] for link in links]))
    planner, execute = plan()
    with pytest.raises(NeedsCall):
        execute()
    assert len(planner.pending) == 2 and len(lease.units) == 2
    answered(lease, chat, list(lease.units.values())[1]["id"])  # the second batch replies first
    planner, execute = plan()
    with pytest.raises(NeedsCall):
        execute()
    assert len(planner.pending) == 1 and len(lease.units) == 2  # no fallback batch yet: C2's reply is pending
    assert shown == [["field4", "field6", "field7"]]
    pending, result = finished(lease, chat, plan)
    assert pending == [1, 1]  # the first batch; then the fallback batch [C2, C6], once both replies are in
    direct_chat, direct_proofs = CountingChat(precise_then_fallback), []
    direct = grounding.quoted(source, fields, schema, direct_chat, record=0, counter=Counter(), projected=True,
                              proofs=direct_proofs)
    assert dumped(result) == dumped(direct) and proofs == direct_proofs
    assert [link.path[-1] for link in result[0]] == [f"field{i}" for i in (0, 2, 3, 4, 6, 7, 1, 5)]
    assert [unit["input"]["request"]["body"]["user"] for unit in lease.units.values()] == [
        call["user"] for call in direct_chat.calls]  # the same three calls, the fallback grouped as the direct run's
    assert shown[-3:] == [["field0", "field2", "field3"], ["field4", "field6", "field7"], ["field1", "field5"]]


@pytest.mark.parametrize("reply", [Reply("not json", 10, 5, "stop", 0.0), ["not", "an", "object"]],
                         ids=["failed", "malformed"])
def test_a_failed_or_malformed_batch_is_read_beside_its_pending_peers_as_in_a_direct_run(reply):
    schema, fields = article(8)
    source = passages([" ".join(fields.values())])
    script = lambda system, user, reply_schema: reply if "C1 (" in user else attested(system, user, reply_schema)
    lease = MemoryLease(schema.model_dump(by_alias=True, exclude_none=True))
    chat = CountingChat(script)
    shown = []
    plan = planned(lease, chat, lambda router, counter: grounding.quoted(source, fields, schema, router, record=0,
        counter=counter, projected=True, on_batch=lambda links: shown.append([link.path[-1] for link in links])))
    planner, execute = plan()
    with pytest.raises(NeedsCall):
        execute()
    first, late = lease.units.values()
    answered(lease, chat, late["id"])
    planner, execute = plan()
    with pytest.raises(NeedsCall):
        execute()
    assert shown == [["field4", "field5", "field6", "field7"]]
    answered(lease, chat, first["id"])
    shown.clear()
    pending, result = finished(lease, chat, plan)
    assert pending == [] and shown == [[], ["field4", "field5", "field6", "field7"]]
    assert dumped(result) == dumped(grounding.quoted(source, fields, schema, CountingChat(script), record=0,
                                                     counter=Counter(), projected=True))
    failed = isinstance(reply, Reply)
    assert result[1][0].ok is not failed and len(result[1]) == 2
    assert [issue.code for issue in result[2]] == ["call_failed" if failed else "missing_claim"] * 4


def test_routed_units_of_a_round_are_captured_together_and_the_next_round_waits_for_every_reply():
    source = passages(["Hill background", "Other subject: year 1827", "Hill: eighteen twenty-seven"])
    contexts = [Context((passage,)) for passage in source]
    fields = {"site": "Hill", "year": 1827}
    origins = value_origins([fields], fields, {"site": "Hill"}, [source[0].id])

    def reason(_system, user, reply):
        supported = ("(site)" in user and "Hill background" in user) or ("(year)" in user and "eighteen" in user)
        return {claim: {"label": "E1" if supported else "NONE", "attribution": supported}
                for claim in reply["properties"]}
    # The year was read in the second unit: the first round checks the site in its unit and the year in another.
    routed = lambda chat, counter: verify_routed(contexts, fields, SCHEMA, chat, origins=origins,
        value_contexts=[contexts[1]], record=3, counter=counter, verifier=spans, record_context="Hill")
    lease = MemoryLease(SCHEMA.model_dump(by_alias=True, exclude_none=True))
    chat = CountingChat(reason)
    plan = planned(lease, chat, routed)
    planner, execute = plan()
    with pytest.raises(NeedsCall):
        execute()
    assert len(planner.pending) == 2
    year = next(unit for unit in lease.units.values() if "(year)" in unit["input"]["request"]["body"]["user"])
    answered(lease, chat, year["id"])
    planner, execute = plan()
    with pytest.raises(NeedsCall):
        execute()
    assert len(planner.pending) == 1 and len(lease.units) == 2  # the year's next unit waits for the site's reply
    pending, result = finished(lease, chat, plan)
    direct_chat = CountingChat(reason)
    direct = routed(direct_chat, Counter())
    assert dumped(result) == dumped(direct) and all(route["supported"] for route in result[3])
    assert len(lease.units) == len(direct_chat.calls) >= 3
    assert pending == [1] * (len(direct_chat.calls) - 1)  # the site's unit, then one more unit of the year per round


def scheduled(monkeypatch, lease, chat, ground, *, chunks, delay):
    """The worker's attempt loop (`extract_workflow`) over the planner: each pending capture is answered on a thread
    after `delay` seconds, up to `chunks` per role at once, as the worker runs its call workflows. Each planning
    round's pending count, how many calls started before the first wait, and the wall time."""
    pending, started, threads, before_wait = [], [], {}, []

    def plan(extraction, attempt):
        planner = CapturePlanner(lease, {"fields": Counter(), "reasoning": Counter()})
        try:
            ground(Router(chat, chat, planner), Counter())
        except NeedsCall:
            pending.append(len(planner.pending))
            return {"pending": sorted(planner.pending, key=lambda key: planner.pending[key]), "roles": planner.roles}
        pending.append(0)
        return {"result": {"records": [], "completeness": {"processing": True}}, "scopes": planner.scopes}

    def start(workflow, extraction, attempt, capture, priority):
        def call():
            sleep(delay)
            answered(lease, chat, capture)
        threads[capture] = threading.Thread(target=call)
        threads[capture].start()
        started.append(capture)
        return SimpleNamespace(workflow_id=capture)

    def wait_first(handles, polling_interval_sec):
        if not before_wait:
            before_wait.append(len(started))
        while all(threads[handle.workflow_id].is_alive() for handle in handles):
            sleep(0.005)
        return handles[0]
    monkeypatch.setattr(worker.config, "CATALOG_CHUNKS", chunks)
    monkeypatch.setattr(worker.DBOS, "deprecate_patch", lambda name: name == "extract-wait-first")
    monkeypatch.setattr(worker.DBOS, "start_workflow", start)
    monkeypatch.setattr(worker.DBOS, "wait_first", wait_first)
    monkeypatch.setattr(worker, "SetWorkflowID", lambda workflow_id: nullcontext())
    monkeypatch.setattr(worker, "settled", lambda ids: {each: True for each in ids if not threads[each].is_alive()})
    monkeypatch.setattr(worker, "plan_next", plan)
    monkeypatch.setattr(worker, "publish_result", lambda *_: None)
    monkeypatch.setattr(worker, "acknowledge", lambda e, a, complete, failure: (complete, failure))
    clock = monotonic()
    status = inspect.unwrap(worker.extract_workflow)({"protocol": 1, "extraction_id": "x", "attempt_id": "a"})
    return status, pending, before_wait[0], monotonic() - clock


@pytest.mark.parametrize("chunks", [1, 4])
def test_the_worker_starts_a_rounds_independent_batches_together_within_its_per_role_limit(monkeypatch, chunks):
    schema, fields = article(16)  # four quoted batches
    source = passages([" ".join(fields.values())])
    lease = MemoryLease(schema.model_dump(by_alias=True, exclude_none=True))
    chat = CountingChat(attested)
    delay = 0.2
    status, pending, before_wait, elapsed = scheduled(monkeypatch, lease, chat, lambda router, counter:
        grounding.quoted(source, fields, schema, router, record=0, counter=counter, projected=True),
        chunks=chunks, delay=delay)
    print(f"\nchunks={chunks}: the first round yielded {pending[0]} calls, {before_wait} started before the first "
          f"wait; {len(pending)} planning rounds, {len(lease.units)} calls of {delay}s, {elapsed:.2f}s in all")
    assert status == {"status": (True, None)}
    assert pending[0] == 4 and before_wait == min(4, chunks)  # every batch yields at once; the limit is unchanged
    assert pending[-1] == 0 and len(lease.units) == len(chat.calls) == 4  # the wall time is printed, not asserted


def test_a_round_retains_one_union_of_its_links_and_a_pause_leaves_the_last_snapshot_standing():
    """Article retains the links a planning round read once it has read every saved reply: a snapshot never shows
    fewer links than the one before it, whatever order the replies arrive in, and a round a pause ends (`Boundary`)
    leaves the last snapshot standing."""
    schema = {"recordDescription": "An article", "schemaNodes": [
        {"id": f"field{i}", "name": f"field{i}", "type": "string"} for i in range(12)]}  # three quoted batches
    request = run.ExtractRequest.model_validate({"schema": schema, "options": {
        "strategy": "article", "article": {"grounding": "quoted"}}})
    fields = {f"field{i}": f"value{i}" for i in range(12)}
    source = evidence(passages([" ".join(fields.values())]))
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    chat = CountingChat(lambda system, user, reply: attested(system, user, reply) if "### Claims" in user else fields)
    plan = planned(lease, chat, lambda router, counter: run.dispatch(None, source, request, router,
        counter={"fields": counter, "reasoning": counter}))

    def linked():
        """The fields each snapshot published so far shows evidence for, in publication order."""
        return [sorted(value["fieldId"] for value in publication["values"] if value["evidence"])
                for publication in lease.publications.values()]
    for _ in range(10):  # the root is read first; then the three batches are captured together
        planner, execute = plan()
        with pytest.raises(NeedsCall):
            execute()
        batches = [unit for unit in lease.units.values() if "### Claims" in unit["input"]["request"]["body"]["user"]]
        if batches:
            break
        for capture in planner.pending:
            answered(lease, chat, capture)
    assert len(batches) == 3 and set(planner.pending) == {unit["id"] for unit in batches}
    first, second, third = batches
    answered(lease, chat, third["id"])
    planner, execute = plan()
    with pytest.raises(NeedsCall):
        execute()
    assert linked()[-1] == sorted(f"field{i}" for i in range(8, 12))  # the late batch alone, as soon as it is read
    published = len(lease.publications)
    answered(lease, chat, first["id"])
    lease.intent = "PAUSE"  # the first batch is read, the second may not start: the round ends before the third
    planner, execute = plan()
    with pytest.raises(Boundary):
        execute()
    assert len(lease.publications) == published  # nothing retained: the snapshot with the third batch stands
    lease.intent = "RUN"
    planner, execute = plan()
    with pytest.raises(NeedsCall):
        execute()
    assert len(planner.pending) == 1
    assert linked()[-1] == sorted(f"field{i}" for i in (*range(4), *range(8, 12)))  # one union for the round
    answered(lease, chat, second["id"])
    planner, execute = plan()
    execute()
    assert linked()[-1] == sorted(f"field{i}" for i in range(12))
    snapshots = [set(each) for each in linked() if each]
    assert all(before <= after for before, after in zip(snapshots, snapshots[1:]))  # never fewer than before
