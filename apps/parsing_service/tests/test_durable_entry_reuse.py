"""A unified Catalog entry finished in an earlier planning round of the attempt is not read or saved again.

Each round plans the attempt from the start (`durable_extract.plan_next`). An entry whose calls are all answered and
whose record is saved is a function of its inputs, the attempt's kept counts and its saved replies; the round lists it
again from what the process kept (`tokens.compiled`) instead of repeating its capture lookups, checks and
publication. Every comparison here is with the same rounds planned without reuse (`tokens.compiled` returning
nothing), under the same completion schedule.
"""
from collections import Counter as Tally, OrderedDict

import pytest

from kei_exp.kie.extract import calls, run, tokens, unified
from kei_exp.kie.extract.durable import Boundary, CapturePlanner, NeedsCall, digest
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.retained import publish_final
from tests.test_durable_extraction import Counter, MemoryLease
from tests.test_extract_grounded import CountingChat
from tests.test_unified_catalog import Model, evidence, request as unified_request, untimed


class Kept(Counter):
    """The scripted counter as a served tokenizer's: its counts are kept per attempt (`tokens.counting`)."""
    _serving = b"words"


def pages(records, per_page):
    return evidence(*("\n".join(f"{n}. Site{n}. Material: m{n}. Find: f{n} ({n % 9 + 1})."
                                for n in range(first, min(records, first + per_page - 1) + 1))
                      for first in range(1, records + 1, per_page)))


def answer(lease, chat, capture, counter):
    unit = next(unit for unit in lease.units.values() if unit["id"] == capture)
    body = dict(unit["input"]["request"]["body"])
    body.pop("max_whitespace")
    parsed, attempts = calls.complete(chat, **body, counter=counter)
    unit["checkpoint"] = {"output": {"parsed": parsed, "calls": [call.__dict__ for call in attempts]}}
    return unit


class Attempt:
    """One attempt planned round by round, each round inside the attempt's count scope, with the wait-first schedule
    `order` picks the next answered call from: the earliest started, the latest, or by capture key either way."""

    def __init__(self, monkeypatch, request, source, *, chunks=2, order="first", reuse=True, label="attempt"):
        self.request, self.source, self.chunks, self.order = request, source, chunks, order
        self.lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
        self.lease.attempt = digest(label)[:32]
        for name, value in (("id", "selection"), ("schemaRevisionId", "revision")):
            self.lease.state["selection"][name] = value
        self.lease.state["source"]["sourceRevisionId"] = "revision"
        self.chat = CountingChat(Model(source))
        self.counter = Kept()
        self.running, self.trace, self.result, self.planner = {}, [], None, None
        tokens.forget(self.lease.attempt)
        self.entries, self.routines = [], []
        original, entry = self.lease.call, unified._Run.entry

        def call(name, *args):
            self.routines.append((name, args[1] if name == "capture_unit" else args[0] if name == "publish_snapshot"
                                  else args[1] if name == "publish_plan" else None))
            return original(name, *args)
        self.lease.call = call

        def spied(run_, number, body, *args, **kwargs):
            self.entries.append((number, kwargs.get("verify", True)))
            return entry(run_, number, body, *args, **kwargs)
        monkeypatch.setattr(unified._Run, "entry", spied)
        if not reuse:
            monkeypatch.setattr(tokens, "compiled", lambda *_: (None, None))

    def plan(self):
        """One planning round: the result, or None when it waits on calls (`NeedsCall`)."""
        self.entries.clear(), self.routines.clear()
        self.planner = CapturePlanner(self.lease, {"fields": self.counter, "reasoning": self.counter})
        made = len(self.chat.calls)
        try:
            with tokens.counting(self.lease.attempt):
                self.result = run.dispatch(None, self.source, self.request,
                                           Router(self.chat, self.chat, self.planner), counter=self.counter,
                                           chunks=self.chunks)
        except NeedsCall:
            self.result = None
        assert len(self.chat.calls) == made, "planning called a model"
        keys = {unit["id"]: key for key, unit in self.lease.units.items()}
        self.trace.append({"pending": [(keys[c], self.lease.units[keys[c]]["descriptor"]["stage"])
                                       for c in sorted(self.planner.pending, key=self.planner.pending.get)],
                           "entries": list(self.entries), "routines": list(self.routines),
                           "scopes": dict(self.planner.scopes)})
        return self.result

    def step(self):
        """Start what the round planned (up to `chunks` per role), then answer one running call."""
        for capture in sorted(self.planner.pending, key=self.planner.pending.get):  # as `extract_workflow` starts them
            role = self.planner.roles[capture]
            if capture not in self.running and sum(each == role for each in self.running.values()) < self.chunks:
                self.running[capture] = role
        keys = {unit["id"]: key for key, unit in self.lease.units.items()}
        started = list(self.running)
        chosen = {"first": started[0], "last": started[-1], "key": min(started, key=keys.get),
                  "reverse-key": max(started, key=keys.get)}[self.order]
        del self.running[chosen]
        unit = answer(self.lease, self.chat, chosen, self.counter)
        self.trace[-1]["answered"] = (unit["descriptor"]["stage"], unit["input"]["request"]["body"]["record"])

    def finish(self, rounds=2000):
        for _ in range(rounds):
            if self.plan() is not None:
                self.lease.state["recordScopes"] = self.planner.scopes
                self.planned = dict(self.lease.publications)
                publish_final(self.lease, self.result)
                return self.result
            self.step()
        raise AssertionError("the attempt never finished")


def observable(attempt):
    """What a round leaves that anyone reads: what it plans, each input it finalizes, every distinct publication and
    plan, the listed scopes, and the artifact. Repeated lookups and identical publications are not observable."""
    return {"pending": [each["pending"] for each in attempt.trace], "scopes": [each["scopes"] for each in attempt.trace],
            "answered": [each.get("answered") for each in attempt.trace],
            "inputs": {key: unit["input"] for key, unit in attempt.lease.units.items()},
            "descriptors": {key: unit["descriptor"] for key, unit in attempt.lease.units.items()},
            "plans": {stage: plan["digest"] for stage, plan in attempt.lease.plans.items()},
            "publications": {identity: digest(each) for identity, each in getattr(attempt, "planned", {}).items()},
            # the final publication's diagnostics hold the run's clock (`started`, `seconds`): compared without them
            "final": sorted(digest([each["values"], {k: v for k, v in each["coverage"].items() if k != "diagnostics"}])
                            for identity, each in attempt.lease.publications.items()
                            if identity not in getattr(attempt, "planned", attempt.lease.publications)),
            "artifact": untimed(attempt.result) if attempt.result is not None else None}


def expected(result, records):
    """The fixture's own answer, independent of either planner: every record, its material and finds, each value
    verified and linked to its source."""
    assert [record["material"] for record in result["records"]] == [f"m{n}" for n in range(1, records + 1)]
    assert [record["finds"] for record in result["records"]] == [[{"name": f"f{n}", "count": n % 9 + 1}]
                                                                 for n in range(1, records + 1)]
    linked = {tuple(link["path"][:3]) for link in result["evidence"]}
    assert all(("records", n, "material") in linked for n in range(records))
    assert not any(issue["code"] in ("verification_unresolved", "call_failed") for issue in result["issues"])


def entry_keys(attempt, number):
    return {key for key, unit in attempt.lease.units.items()
            if unit["input"] and unit["input"]["request"]["body"]["record"] == number
            and unit["descriptor"]["stage"] in ("entry", "verification", "arbitration")}


def finished_entries(attempt):
    """Each entry read verified and saved, and the round that did it."""
    finished = {}
    for index, round_ in enumerate(attempt.trace):
        for number in saved(attempt, round_):
            if (number, True) in round_["entries"]:
                finished.setdefault(number, index)
    return finished


def saved(attempt, round_):
    """The entries whose records a round published (the document's fields are published apart)."""
    return {value["path"][1]: identity for name, identity in round_["routines"] if name == "publish_snapshot"
            and attempt.lease.publications[identity]["coverage"]["primaryScope"] != "document-fields"
            for value in attempt.lease.publications[identity]["values"]}


@pytest.mark.parametrize("defaults", [3, 4])
def test_an_unrelated_completion_does_not_read_or_save_a_finished_entry_again(monkeypatch, defaults):
    attempt = Attempt(monkeypatch, unified_request(defaults=defaults), pages(12, 3), chunks=2)
    expected(attempt.finish(), 12)
    finished = finished_entries(attempt)
    assert set(finished) == set(range(12))
    later = [(number, round_) for number, at in finished.items() for round_ in attempt.trace[at + 1:]]
    assert later, "no round planned after an entry finished"
    for number, round_ in later:
        assert (number, True) not in round_["entries"]
        assert not entry_keys(attempt, number) & {key for name, key in round_["routines"] if name == "capture_unit"}
        assert number not in saved(attempt, round_)
        assert round_["scopes"][number] == attempt.result["discovery"]["entries"][number]["ranges"]


def test_discovery_completing_verifies_the_entries_read_before_it(monkeypatch):
    """Pipelined, an entry read while discovery still asks later windows holds candidates only; the round that sees
    discovery complete reads it again, verified: a phase change is never reused."""
    attempt = Attempt(monkeypatch, unified_request(defaults=3), pages(12, 1), chunks=1)
    expected(attempt.finish(), 12)
    early = {number for round_ in attempt.trace for number, verify in round_["entries"] if not verify}
    assert early, "no entry was read before discovery completed"
    for number in early:
        assert any((number, True) in round_["entries"] for round_ in attempt.trace)
        verified = [key for key in entry_keys(attempt, number)
                    if attempt.lease.units[key]["descriptor"]["stage"] == "verification"]
        assert verified and all(attempt.lease.units[key]["checkpoint"] for key in verified)


SCHEDULES = [(defaults, chunks, order, per_page) for defaults in (1, 2, 3, 4) for chunks in (1, 2)
             for order in ("first", "last", "key", "reverse-key") for per_page in (1, 4)]


@pytest.mark.parametrize("defaults,chunks,order,per_page", SCHEDULES)
def test_reuse_leaves_every_round_as_it_was(monkeypatch, defaults, chunks, order, per_page):
    """The same attempt under the same schedule, planned with and without reuse: every round plans the same calls,
    finalizes the same inputs and lists the same scopes; the publications, plans and artifact are the same. Only
    repeated lookups and publications of unchanged rows go."""
    request, source = unified_request(defaults=defaults), pages(8, per_page)
    with monkeypatch.context() as patched:
        plain = Attempt(patched, request, source, chunks=chunks, order=order, reuse=False)
        plain.finish()
    reused = Attempt(monkeypatch, request, source, chunks=chunks, order=order)
    expected(reused.finish(), 8)
    assert observable(reused) == observable(plain)
    computed = [len(round_["entries"]) for round_ in reused.trace]
    assert sum(computed) < sum(len(round_["entries"]) for round_ in plain.trace)
    removed = Tally(name for round_ in plain.trace for name, _ in round_["routines"])
    removed.subtract(name for round_ in reused.trace for name, _ in round_["routines"])
    assert set(+removed) <= {"publish_plan", "capture_unit", "publish_snapshot"}
    assert all(count >= 0 for count in removed.values())


def test_forgotten_counts_read_finished_entries_again(monkeypatch):
    """A call the server counted otherwise drops the attempt's counts (`drop_stale_counts`): the work planned from
    them goes too, so the next round reads every finished entry again from fresh counts."""
    attempt = Attempt(monkeypatch, unified_request(defaults=3), pages(8, 4))
    for _ in range(12):
        attempt.plan()
        attempt.step()
    finished = set(finished_entries(attempt))
    assert finished
    attempt.plan()
    assert not {number for number, _ in attempt.trace[-1]["entries"]} & finished
    tokens.forget(attempt.lease.attempt)
    attempt.step()
    attempt.plan()
    assert finished <= {number for number, _ in attempt.trace[-1]["entries"]}
    expected(attempt.finish(), 8)


def test_counts_forgotten_while_an_entry_is_read_keep_nothing_from_it(monkeypatch):
    """A call workflow may drop the attempt's counts while a round still reads from them: the entry read meanwhile is
    not kept, so the next round reads it again from fresh counts."""
    attempt = Attempt(monkeypatch, unified_request(defaults=3), pages(8, 4))
    for _ in range(12):
        attempt.plan()
        attempt.step()
    finished = finished_entries(attempt)
    assert finished
    attempt.plan()
    assert not {number for number, _ in attempt.trace[-1]["entries"]} & set(finished)
    tokens.forget(attempt.lease.attempt)  # every finished entry is read again in the next round ...
    first, spied = min(finished), unified._Run.entry

    def stale(run_, number, *args, **kwargs):
        if number == first:  # ... and the counts go again while the first of them is read
            tokens.forget(attempt.lease.attempt)
        return spied(run_, number, *args, **kwargs)
    monkeypatch.setattr(unified._Run, "entry", stale)
    attempt.step()
    attempt.plan()
    monkeypatch.setattr(unified._Run, "entry", spied)
    read = {number for number, _ in attempt.trace[-1]["entries"]}
    assert set(finished) <= read
    attempt.step()
    attempt.plan()
    assert first in {number for number, _ in attempt.trace[-1]["entries"]}
    assert not set(finished) - {first} & {number for number, _ in attempt.trace[-1]["entries"]}
    expected(attempt.finish(), 8)


def test_another_served_tokenizer_reads_finished_entries_again(monkeypatch):
    """Counts are kept per served tokenizer and template (the probe's fingerprint): one the server now renders
    otherwise is another key, so nothing planned from the old counts is reused."""
    attempt = Attempt(monkeypatch, unified_request(defaults=3), pages(8, 4))
    for _ in range(12):
        attempt.plan()
        attempt.step()
    finished = set(finished_entries(attempt))
    assert finished
    attempt.plan()
    assert not {number for number, _ in attempt.trace[-1]["entries"]} & finished
    attempt.counter = type("Redeployed", (Kept,), {"_serving": b"other words"})()
    attempt.step()
    attempt.plan()
    assert finished <= {number for number, _ in attempt.trace[-1]["entries"]}


@pytest.fixture
def isolated_caches(monkeypatch):
    """Count and work retention start empty; no other check's attempt can affect the LRU order."""
    monkeypatch.setattr(tokens, "_attempts", OrderedDict())
    monkeypatch.setattr(tokens, "_compiled", OrderedDict())
    monkeypatch.setattr(tokens, "_kept", 0)


def test_successive_tokenizer_fingerprints_keep_historical_entry_work(monkeypatch, isolated_caches):
    """Each fingerprint compiles another version of every finished entry, without removing the earlier versions;
    returning to any earlier fingerprint reuses its work, so two versions per entry is not a retention bound."""
    records = 4
    attempt = Attempt(monkeypatch, unified_request(defaults=3), pages(records, 2))
    expected(attempt.finish(), records)
    artifact = untimed(attempt.result)
    kept = tokens._compiled[attempt.lease.attempt]
    fingerprints = [attempt.counter._serving, b"second tokenizer", b"third tokenizer", b"fourth tokenizer"]
    for fingerprint in fingerprints[1:]:
        earlier = dict(kept)
        attempt.counter._serving = fingerprint
        assert untimed(attempt.plan()) == artifact
        assert set(attempt.trace[-1]["entries"]) == {(number, True) for number in range(records)}
        assert len(kept) == len(earlier) + records
        assert all(kept[key] is work for key, work in earlier.items())
    assert len(kept) > 2 * records
    for fingerprint in fingerprints:
        attempt.counter._serving = fingerprint
        assert untimed(attempt.plan()) == artifact
        assert not attempt.trace[-1]["entries"]
        assert not saved(attempt, attempt.trace[-1])


def test_compiled_attempts_evict_the_least_recently_used_not_the_oldest_created(isolated_caches):
    """A hit refreshes the work LRU; at CACHED_ATTEMPTS the next attempt evicts the least recently accessed one."""
    counter, work = Kept(), object()
    attempts = [f"work/{number}" for number in range(tokens.CACHED_ATTEMPTS)]
    for attempt in attempts:
        with tokens.counting(attempt):
            place, found = tokens.compiled("entry", [counter])
            assert found is None
            tokens.keep_compiled(place, work)
    with tokens.counting(attempts[0]):
        _, found = tokens.compiled("entry", [counter])
        assert found is work
    assert list(tokens._compiled) == attempts[1:] + attempts[:1]
    with tokens.counting("new work"):
        place, found = tokens.compiled("entry", [counter])
        assert found is None
        tokens.keep_compiled(place, work)
    assert len(tokens._compiled) == tokens.CACHED_ATTEMPTS
    assert list(tokens._compiled) == attempts[2:] + attempts[:1] + ["new work"]
    assert attempts[1] not in tokens._compiled


def test_work_eviction_recomputes_finished_entries_from_the_same_saved_calls(monkeypatch, isolated_caches):
    """An evicted attempt compiles again from its saved replies: no new model call, input, plan or publication."""
    monkeypatch.setattr(tokens, "CACHED_ATTEMPTS", 2)
    records = 4
    attempt = Attempt(monkeypatch, unified_request(defaults=3), pages(records, 2))
    expected(attempt.finish(), records)
    before, earlier = observable(attempt), dict(tokens._compiled[attempt.lease.attempt])
    for other in ("other/1", "other/2"):
        with tokens.counting(other):
            tokens.compiled("entry", [attempt.counter])
    assert attempt.lease.attempt not in tokens._compiled
    expected(attempt.plan(), records)
    assert set(attempt.trace[-1]["entries"]) == {(number, True) for number in range(records)}
    assert set(saved(attempt, attempt.trace[-1])) == set(range(records))
    after = observable(attempt)
    for field in ("inputs", "descriptors", "plans", "publications", "final", "artifact"):
        assert after[field] == before[field], field
    assert attempt.trace[-1]["scopes"] == before["scopes"][-1]
    kept = tokens._compiled[attempt.lease.attempt]
    assert len(kept) == records and kept.keys() <= earlier.keys()
    assert all(work is not earlier[key] for key, work in kept.items())
    attempt.plan()
    assert not attempt.trace[-1]["entries"]
    assert not saved(attempt, attempt.trace[-1])


def test_a_place_evicted_while_work_is_compiled_cannot_restore_or_poison_an_attempt(monkeypatch, isolated_caches):
    """An in-flight place cannot resurrect an evicted attempt or write into its replacement after re-entry."""
    monkeypatch.setattr(tokens, "CACHED_ATTEMPTS", 2)
    counter = Kept()
    with tokens.counting("evicted"):
        stale, _ = tokens.compiled("entry", [counter])
    for other in ("other/1", "other/2"):
        with tokens.counting(other):
            tokens.compiled("entry", [counter])
    assert "evicted" not in tokens._compiled
    with tokens.counting("evicted"):
        tokens.keep_compiled(stale, "stale work")
        assert "evicted" not in tokens._compiled
        fresh, found = tokens.compiled("entry", [counter])
        assert found is None and fresh[0] is not stale[0]
        tokens.keep_compiled(stale, "stale work")
        assert tokens.compiled("entry", [counter])[1] is None
        assert not stale[0]
        work = object()
        tokens.keep_compiled(fresh, work)
        assert tokens.compiled("entry", [counter])[1] is work


def test_count_and_work_lru_evictions_have_independent_lifetimes(monkeypatch, isolated_caches):
    """Count-LRU eviction leaves compiled work; work-LRU eviction leaves counts reusable without another /tokenize."""
    from tests.test_extract_tokens import Chat, Http
    monkeypatch.setattr(tokens, "CACHED_ATTEMPTS", 1)
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1]}})
    counter = tokens.counter_for(Chat("http://retention.test/v1/chat/completions"), http=http)
    work = object()
    with tokens.counting("first"):
        assert counter.request_tokens("system", "user") == 57
        place, _ = tokens.compiled("entry", [counter])
        tokens.keep_compiled(place, work)
    with tokens.counting("second"):
        assert counter.request_tokens("system", "user") == 57
    assert list(tokens._attempts) == ["second"] and tokens.kept() == 1
    with tokens.counting("first"):
        assert tokens.compiled("entry", [counter])[1] is work
    with tokens.counting("second"):
        tokens.compiled("entry", [counter])
    with tokens.counting("third"):
        tokens.compiled("entry", [counter])
    assert list(tokens._compiled) == ["third"] and list(tokens._attempts) == ["second"]
    sent = len(http.sent)
    with tokens.counting("second"):
        assert counter.request_tokens("system", "user") == 57
    assert len(http.sent) == sent


def test_a_failed_publication_is_not_reused(monkeypatch):
    """Reuse begins only once the entry's record is saved: a round whose publication fails keeps nothing, so the next
    round reads the entry again and saves it."""
    attempt = Attempt(monkeypatch, unified_request(defaults=3), pages(8, 4))
    original, failed = attempt.lease.call, []

    def flaky(name, *args):
        if name == "publish_snapshot" and not failed and any(value["path"][1] == 0 and value["modelValue"]
                                                             for value in args[2]):
            failed.append(args[0])
            raise RuntimeError("connection lost")
        return original(name, *args)
    attempt.lease.call = flaky
    for _ in range(200):
        try:
            if attempt.plan() is not None:
                break
        except RuntimeError:
            attempt.trace.append({"routines": [], "entries": [], "failed": True})
            continue
        attempt.step()
    assert failed and attempt.result is not None
    assert failed[0] in attempt.lease.publications
    expected(attempt.result, 8)


def test_a_fresh_process_plans_the_rest_of_the_attempt_alike(monkeypatch):
    """Kept work is the process's own: a recovered attempt in a new process (nothing kept) reads every finished entry
    once more, publishes only what the uninterrupted attempt's same round did first, and plans what it planned."""
    request, source = unified_request(defaults=3), pages(8, 2)
    with monkeypatch.context() as patched:
        plain = Attempt(patched, request, source, reuse=False)
        plain.finish()
    attempt = Attempt(monkeypatch, request, source)
    for _ in range(len(plain.trace) // 2):
        attempt.plan()
        attempt.step()
    monkeypatch.setattr(tokens, "_compiled", type(tokens._compiled)())  # a new process: nothing kept
    monkeypatch.setattr(tokens, "_attempts", type(tokens._attempts)())
    attempt.plan()
    at, recovered = len(attempt.trace) - 1, attempt.trace[-1]
    assert {number for number, verify in recovered["entries"] if verify} >= set(finished_entries(attempt))

    def first(trace, at):
        earlier = {identity for round_ in trace[:at] for name, identity in round_["routines"] if name == "publish_snapshot"}
        return {identity for name, identity in trace[at]["routines"] if name == "publish_snapshot"} - earlier
    assert first(attempt.trace, at) == first(plain.trace, at)
    attempt.step()
    expected(attempt.finish(), 8)
    assert observable(attempt) == observable(plain)


def test_pause_shows_and_stops_as_without_reuse(monkeypatch):
    """A Pause lets the running calls save; the next round lists every finished entry, shows the newly saved ones and
    stops at the first call it may not start, as it does without reuse."""
    def paused(patched, reuse):
        attempt = Attempt(patched, unified_request(defaults=3), pages(12, 3), reuse=reuse)
        for _ in range(14):
            attempt.plan()
            attempt.step()
        attempt.plan()
        attempt.lease.intent = "PAUSE"
        for capture in list(attempt.planner.roles):
            answer(attempt.lease, attempt.chat, capture, attempt.counter)
        with pytest.raises(Boundary):
            with tokens.counting(attempt.lease.attempt):
                planner = CapturePlanner(attempt.lease, {"fields": attempt.counter, "reasoning": attempt.counter})
                run.dispatch(None, attempt.source, attempt.request, Router(attempt.chat, attempt.chat, planner),
                             counter=attempt.counter, chunks=attempt.chunks)
        return observable(attempt) | {"stopped": dict(planner.scopes)}, planner
    with monkeypatch.context() as patched:
        plain, _ = paused(patched, False)
    reused, planner = paused(monkeypatch, True)
    assert reused == plain and planner.scopes


def test_new_guidance_reaches_only_new_captures(monkeypatch):
    """A correction committed while the attempt runs is captured with the requests created after it, never with an
    input already finalized, and a finished entry is not recomposed for it, with or without reuse."""
    request, source = unified_request(defaults=3), pages(8, 2)
    node = next(node for node in request.schema_.model_dump(by_alias=True, exclude_none=True)["schemaNodes"]
                if node["name"] == "material")
    from kei_exp.kie.extract.durable import field_meaning
    candidate = {"id": "correction", "fieldId": node["id"], "meaning": field_meaning(node),
                 "value": "corrected", "grounded": False, "node": node}

    def guided(patched, reuse):
        attempt = Attempt(patched, request, source, reuse=reuse)
        for _ in range(10):
            attempt.plan()
            attempt.step()
        before = {key: unit["input"] for key, unit in attempt.lease.units.items() if unit["input"]}
        attempt.lease.candidates = [{"id": "revision", "candidate": candidate}]
        attempt.finish()
        return attempt, before
    with monkeypatch.context() as patched:
        plain, _ = guided(patched, False)
    reused, before = guided(monkeypatch, True)
    assert observable(reused) == observable(plain)
    assert all(reused.lease.units[key]["input"] == finalized for key, finalized in before.items())
    assert any(unit["input"]["request"].get("examples") for key, unit in reused.lease.units.items()
               if key not in before)


def test_article_reassembles_every_answered_context_when_another_answers(monkeypatch):
    """Article is not reused: each value context's answer is assembled with every context answered before it (from
    their candidates, not from the previous root), so a disagreement shows once its second context answers."""
    from tests.test_record_scope import disagreement_article_input, disagreement_article_reply
    request, source = disagreement_article_input(grounding="quoted")
    asked = []
    original = tokens.compiled
    monkeypatch.setattr(tokens, "compiled", lambda *args: asked.append(args) or original(*args))
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    chat, counter, roots = CountingChat(disagreement_article_reply), Kept(), []
    for _ in range(50):
        planner = CapturePlanner(lease, {"fields": counter, "reasoning": counter})
        published = len(lease.publications)
        try:
            with tokens.counting(lease.attempt):
                result = run.dispatch(None, source, request, Router(chat, chat, planner),
                                      counter={"fields": counter, "reasoning": counter})
            break
        except NeedsCall:
            roots.append([publication["values"] for publication in list(lease.publications.values())[published:]])
            for capture in planner.pending:
                answer(lease, chat, capture, counter)
    assert not asked and len(result["value_contexts"][0]) == 3
    disagreeing = [any("disagreement" in value for values in round_ for value in values) for round_ in roots]
    assert True in disagreeing and disagreeing.index(True) > 0
