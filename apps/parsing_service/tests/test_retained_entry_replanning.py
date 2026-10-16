"""Synthetic contract checks for the frozen retained-entry planning validation harness."""
import copy
import json
from collections import Counter, OrderedDict
from types import SimpleNamespace

import pytest

from experiments.extraction import retained_entry_replanning as replay


@pytest.fixture
def frozen():
    return {
        "attempt": "synthetic-attempt",
        "state": {"selection": {"id": "selection-1"}},
        "effective": {"strategy": "catalog"},
        "plans": {"entry": {"digest": "plan-digest", "manifest": {"entries": ["entry-1"]}}},
        "captures": [{
            "id": "capture-1", "unitKey": "entry-1",
            "descriptor": {"stage": "entry", "planDigest": "plan-digest", "request": {"user": "source"}},
            "input": {"system": "extract", "user": "source", "schema": {"type": "object"}},
            "checkpoint": {"output": {"records": [{"name": "Hill"}], "calls": [{"seconds": 0.1}]}},
        }],
    }


def test_frozen_lease_replays_exact_plan_and_input_and_only_changes_reply_visibility(frozen):
    lease = replay.FrozenLease(frozen)
    saved = copy.deepcopy(frozen["captures"][0])
    assert lease.call("resolve_selection") == {"configuration": frozen["effective"]}
    assert lease.call("historical_coverage") == {}
    assert lease.call("publish_plan", "new-id", "entry", copy.deepcopy(frozen["plans"]["entry"]["manifest"])) == \
        frozen["plans"]["entry"]
    before = lease.call("capture_unit", "new-id", saved["unitKey"], copy.deepcopy(saved["descriptor"]))
    assert before == {**saved, "checkpoint": None}
    assert before["input"] == saved["input"]
    lease.done.add(saved["id"])
    assert lease.call("capture_unit", "another-id", saved["unitKey"], saved["descriptor"]) == saved
    assert lease.looked_up == {saved["unitKey"]}
    assert lease.visited_plans == {"entry": "plan-digest"}
    assert frozen["captures"][0] == saved


@pytest.mark.parametrize("changed", [False, True], ids=["unknown", "changed"])
def test_frozen_lease_rejects_unknown_or_changed_request(frozen, changed):
    lease = replay.FrozenLease(frozen)
    saved = frozen["captures"][0]
    descriptor = copy.deepcopy(saved["descriptor"])
    key = saved["unitKey"] if changed else "unknown-entry"
    if changed:
        descriptor["request"]["user"] = "changed source"
    with pytest.raises(replay.ReplayMismatch, match="unknown or changed frozen request"):
        lease.call("capture_unit", "new-id", key, descriptor)
    assert not lease.looked_up


@pytest.mark.parametrize("changed", [False, True], ids=["unknown", "changed"])
def test_frozen_lease_rejects_unknown_or_changed_plan(frozen, changed):
    lease = replay.FrozenLease(frozen)
    stage = "entry" if changed else "unknown-stage"
    manifest = copy.deepcopy(frozen["plans"]["entry"]["manifest"])
    if changed:
        manifest["entries"].append("new-entry")
    with pytest.raises(replay.ReplayMismatch, match="unknown or changed frozen plan"):
        lease.call("publish_plan", "new-id", stage, manifest)
    assert not lease.visited_plans


def test_frozen_lease_never_finalizes_or_recomposes_saved_input(frozen):
    lease = replay.FrozenLease(frozen)
    saved = copy.deepcopy(frozen["captures"][0]["input"])
    with pytest.raises(replay.ReplayMismatch, match="unexpected coordination operation: finalize_input"):
        lease.call("finalize_input", "capture-1", {"user": "recomposed"})
    assert lease.by_id["capture-1"]["input"] == saved


@pytest.mark.parametrize("duplicate", ["id", "unitKey", "both"])
def test_frozen_lease_rejects_duplicate_capture_id_or_unit_key(frozen, duplicate):
    extra = copy.deepcopy(frozen["captures"][0])
    if duplicate != "both":
        extra["unitKey" if duplicate == "id" else "id"] = "different"
    frozen["captures"].append(extra)
    with pytest.raises(replay.ReplayMismatch, match="duplicate frozen capture"):
        replay.FrozenLease(frozen)


@pytest.mark.parametrize("field", ["input", "checkpoint"])
@pytest.mark.parametrize("unfinished", ["missing", "null", "empty"])
def test_frozen_lease_rejects_unfinished_capture(frozen, field, unfinished):
    capture = frozen["captures"][0]
    if unfinished == "missing":
        del capture[field]
    else:
        capture[field] = None if unfinished == "null" else {}
    with pytest.raises(replay.ReplayMismatch, match="unfinished frozen capture"):
        replay.FrozenLease(frozen)


def test_frozen_lease_rejects_changed_selection_and_changed_publication(frozen):
    lease = replay.FrozenLease(frozen)
    values, coverage = [{"value": "Hill"}], {"sourceGeneration": "generation-1"}
    assert lease.call("publish_snapshot", "snapshot-1", "selection-1", values, coverage) == \
        {"values": values, "coverage": coverage}
    lease.call("publish_snapshot", "snapshot-1", "selection-1", values, coverage)
    with pytest.raises(replay.ReplayMismatch, match="changed selection"):
        lease.call("publish_snapshot", "snapshot-2", "selection-2", values, coverage)
    with pytest.raises(replay.ReplayMismatch, match="changed publication"):
        lease.call("publish_snapshot", "snapshot-1", "selection-1", [{"value": "Valley"}], coverage)
    assert lease.round_publications == [replay.publication(values, coverage)] * 2


def test_normalization_only_removes_top_level_clocks_and_keeps_saved_call_timings():
    artifact = {"started": "earlier", "seconds": 5, "records": [{"name": "Hill"}],
                "calls": [{"seconds": 0.1, "started": "saved-clock"}]}
    changed = {**artifact, "started": "later", "seconds": 10}
    assert replay.stable(artifact) == replay.stable(changed)
    changed = copy.deepcopy(changed)
    changed["calls"][0]["seconds"] = 0.2
    assert replay.stable(artifact) != replay.stable(changed)
    assert artifact["seconds"] == 5


def test_publication_normalizes_diagnostic_clocks_not_values_evidence_or_saved_call_timings():
    values = [{"value": "Hill", "evidence": {"segment": "p1_s0"}}]
    coverage = {"diagnostics": {"started": "earlier", "seconds": 5, "calls": [{"seconds": 0.1}]}}
    changed = copy.deepcopy(coverage)
    changed["diagnostics"].update(started="later", seconds=10)
    assert replay.publication(values, coverage) == replay.publication(values, changed)
    changed["diagnostics"]["calls"][0]["seconds"] = 0.2
    assert replay.publication(values, coverage) != replay.publication(values, changed)
    other_values = copy.deepcopy(values)
    other_values[0]["evidence"]["segment"] = "p2_s0"
    assert replay.publication(values, coverage) != replay.publication(other_values, coverage)
    assert coverage["diagnostics"]["started"] == "earlier"


def _report():
    rounds = [
        {"pending": ["entry-1"], "scopes": "scope-1", "new_publications": ["prefix-1"],
         "started": ["entry-1"], "completed": ["entry-1"], "publication_visits": 2,
         "coordination": {"resolve_selection": 1, "publish_plan": 3, "capture_unit": 2,
                          "publish_snapshot": 2, "historical_coverage": 1}},
        {"pending": [], "scopes": "scope-1", "new_publications": [], "started": [], "completed": [],
         "publication_visits": 1,
         "coordination": {"resolve_selection": 1, "publish_plan": 2, "capture_unit": 1,
                          "publish_snapshot": 1, "historical_coverage": 1}},
    ]
    coordination = Counter()
    for row in rounds:
        coordination.update(row["coordination"])
    # Final publications occur after the last row's coordination counters were copied.
    coordination["publish_snapshot"] += 2
    session = {
        "rounds": 2, "planning_cpu_seconds": 0.2, "planning_wall_seconds": 0.3,
        "artifact": "artifact-digest", "evidence": "evidence-digest", "records": 1,
        "scopes": "scope-1", "plans": {"entry": "plan-digest"},
        "inputs": {"entry-1": "input-digest"}, "publications": ["prefix-1", "final-1"],
        "final_publications": ["final-1"], "coordination": dict(coordination), "per_round": rounds,
    }
    return {
        "source_sha": "source-revision", "fixture_sha256": "fixture-digest", "counts_sha256": "counts-digest",
        "source_manifest_sha256": "manifest-digest", "chunks": 2, "attempts": 2, "fingerprints": 3,
        "fresh_model_calls": 0, "fresh_tokenizer_requests": 0,
        "sessions": [session, copy.deepcopy(session)],
    }


def _compare(tmp_path, capsys, baseline, candidate):
    paths = [tmp_path / "baseline.json", tmp_path / "candidate.json"]
    for path, report in zip(paths, [baseline, candidate], strict=True):
        path.write_text(json.dumps(report), encoding="utf-8")
    status = replay.compare(SimpleNamespace(baseline=paths[0], candidate=paths[1]))
    verdict = json.loads(capsys.readouterr().out)
    assert verdict["equivalent"] is (status == 0)
    assert bool(verdict["problems"]) is (status != 0)
    return status


@pytest.mark.parametrize("side", ["baseline", "candidate"])
def test_compare_does_not_use_timing_only_reports_as_equivalence_proof(tmp_path, capsys, side):
    baseline, candidate = _report(), _report()
    (baseline if side == "baseline" else candidate)["timing_only"] = True
    assert _compare(tmp_path, capsys, baseline, candidate) == 1


def test_compare_accepts_identical_reports_and_different_source_or_planning_clocks(tmp_path, capsys):
    baseline = _report()
    candidate = copy.deepcopy(baseline)
    assert _compare(tmp_path, capsys, baseline, candidate) == 0
    candidate["source_sha"] = "candidate-revision"
    candidate["sessions"][0].update(planning_cpu_seconds=0.1, planning_wall_seconds=0.15)
    assert _compare(tmp_path, capsys, baseline, candidate) == 0


@pytest.mark.parametrize("field", ["fixture_sha256", "counts_sha256", "source_manifest_sha256",
                                   "chunks", "attempts", "fingerprints"])
def test_compare_rejects_changed_pinned_inputs_and_replay_settings(tmp_path, capsys, field):
    baseline = _report()
    candidate = copy.deepcopy(baseline)
    candidate[field] = "changed" if isinstance(candidate[field], str) else candidate[field] + 1
    assert _compare(tmp_path, capsys, baseline, candidate) == 1


@pytest.mark.parametrize(("field", "changed"), [
    ("rounds", 3), ("artifact", "changed-artifact"), ("evidence", "changed-evidence"), ("records", 2),
    ("scopes", "changed-scope"), ("plans", {"entry": "changed-plan"}),
    ("inputs", {"entry-1": "changed-input"}), ("publications", ["changed-publication"]),
    ("final_publications", ["changed-final-publication"]),
])
def test_compare_rejects_mutated_outputs_plans_inputs_and_publications(tmp_path, capsys, field, changed):
    baseline = _report()
    candidate = copy.deepcopy(baseline)
    candidate["sessions"][-1][field] = changed
    assert _compare(tmp_path, capsys, baseline, candidate) == 1


@pytest.mark.parametrize("round_index", [0, 1])
@pytest.mark.parametrize("field", ["pending", "scopes", "new_publications", "started", "completed"])
def test_compare_rejects_changed_schedule_in_any_round(tmp_path, capsys, round_index, field):
    baseline = _report()
    candidate = copy.deepcopy(baseline)
    candidate["sessions"][-1]["per_round"][round_index][field] = "changed" if field == "scopes" else ["changed"]
    assert _compare(tmp_path, capsys, baseline, candidate) == 1


@pytest.mark.parametrize("extra", [False, True], ids=["missing", "extra"])
def test_compare_reports_mismatched_round_count_without_crashing(tmp_path, capsys, extra):
    baseline = _report()
    candidate = copy.deepcopy(baseline)
    rounds = candidate["sessions"][-1]["per_round"]
    if extra:
        rounds.append(copy.deepcopy(rounds[-1]))
    else:
        rounds.pop()
    assert _compare(tmp_path, capsys, baseline, candidate) == 1


@pytest.mark.parametrize("extra", [False, True], ids=["missing", "extra"])
def test_compare_rejects_mismatched_session_count(tmp_path, capsys, extra):
    baseline = _report()
    candidate = copy.deepcopy(baseline)
    if extra:
        candidate["sessions"].append(copy.deepcopy(candidate["sessions"][-1]))
    else:
        candidate["sessions"].pop()
    assert _compare(tmp_path, capsys, baseline, candidate) == 1


def _adjust_coordination(session, routine, delta, aggregate_only):
    if not aggregate_only:
        row = session["per_round"][0]["coordination"]
        row[routine] = row.get(routine, 0) + delta
    totals = session["coordination"]
    totals[routine] = totals.get(routine, 0) + delta


@pytest.mark.parametrize("aggregate_only", [False, True], ids=["per-round", "after-round"])
@pytest.mark.parametrize("routine", ["publish_plan", "capture_unit", "publish_snapshot"])
def test_compare_accepts_only_allowlisted_coordination_reductions(tmp_path, capsys, aggregate_only, routine):
    baseline = _report()
    candidate = copy.deepcopy(baseline)
    _adjust_coordination(candidate["sessions"][-1], routine, -1, aggregate_only)
    assert _compare(tmp_path, capsys, baseline, candidate) == 0


@pytest.mark.parametrize("aggregate_only", [False, True], ids=["per-round", "after-round"])
@pytest.mark.parametrize("routine", ["publish_plan", "capture_unit", "publish_snapshot", "historical_coverage",
                                    "resolve_selection", "unexpected_operation"])
def test_compare_rejects_all_extra_coordination_including_final_publication_calls(
        tmp_path, capsys, aggregate_only, routine):
    baseline = _report()
    candidate = copy.deepcopy(baseline)
    _adjust_coordination(candidate["sessions"][-1], routine, 1, aggregate_only)
    assert _compare(tmp_path, capsys, baseline, candidate) == 1


@pytest.mark.parametrize("aggregate_only", [False, True], ids=["per-round", "after-round"])
@pytest.mark.parametrize("routine", ["resolve_selection", "historical_coverage"])
def test_compare_rejects_unexpected_coordination_reductions(tmp_path, capsys, aggregate_only, routine):
    baseline = _report()
    candidate = copy.deepcopy(baseline)
    _adjust_coordination(candidate["sessions"][-1], routine, -1, aggregate_only)
    assert _compare(tmp_path, capsys, baseline, candidate) == 1


class _SyntheticChat:
    url = "http://unused.invalid/v1/chat/completions"
    model = "synthetic-model"
    headers = {}

    def tokenize_body(self, *, system, user, schema=None):
        return {"model": self.model, "system": system, "user": user, "schema": schema}

    def complete(self, **kwargs):
        pytest.fail("fresh generation reached the adapter")


class _SyntheticFields(_SyntheticChat):
    pass


class _SyntheticReasoning(_SyntheticChat):
    pass


@pytest.fixture
def synthetic_replay(tmp_path, monkeypatch, frozen):
    frozen["state"]["source"] = {"generation": "generation-1"}
    fixture = tmp_path / "fixture.json"
    fixture.write_text(json.dumps(frozen), encoding="utf-8")
    args = SimpleNamespace(fixture=fixture, run=tmp_path / "unused-run", counts=tmp_path / "counts.json",
                           report=tmp_path / "report.json", routes=None, collect_tokenize=False,
                           chunks=1, attempts=1, fingerprints=1, memory=False, timing=False)
    chat = SimpleNamespace(fields=_SyntheticFields(), reasoning=_SyntheticReasoning())
    monkeypatch.setattr(replay, "effective", lambda lease: (object(), chat))
    monkeypatch.setattr(replay, "load", lambda run: SimpleNamespace(generation="generation-1"))
    monkeypatch.setattr(replay, "memory", lambda: {})
    # The harness owns fresh subprocess caches; isolate this in-process guard test instead.
    monkeypatch.setattr(replay.tokens, "_attempts", OrderedDict())
    monkeypatch.setattr(replay.tokens, "_compiled", OrderedDict())
    monkeypatch.setattr(replay.tokens, "_kept", 0)
    monkeypatch.setattr(replay.requests, "post", lambda *args, **kwargs: pytest.fail("unexpected network request"))
    return args


@pytest.mark.parametrize("collect_with_other_route", [False, True], ids=["offline", "unmapped-route"])
def test_replay_rejects_unknown_tokenizer_observation_without_network(
        tmp_path, monkeypatch, synthetic_replay, collect_with_other_route):
    args = synthetic_replay
    if collect_with_other_route:
        args.collect_tokenize = True
        args.routes = tmp_path / "routes.json"
        args.routes.write_text(json.dumps({"http://different.invalid": "http://unused.invalid"}), encoding="utf-8")

    def dispatch(run, evidence, request, router, **kwargs):
        return replay.tokens.counter_for(router.fields)

    monkeypatch.setattr(replay, "dispatch", dispatch)
    with pytest.raises(replay.tokens.BudgetUnavailable, match="unknown frozen tokenizer request"):
        replay.replay(args)
    assert not args.report.exists()
    assert not args.counts.exists()


@pytest.mark.parametrize("role", ["fields", "reasoning"])
def test_replay_forbids_fresh_generation_for_each_adapter(monkeypatch, synthetic_replay, role):
    def dispatch(run, evidence, request, router, **kwargs):
        return getattr(router, role).complete(system="extract", user="source")

    monkeypatch.setattr(replay, "dispatch", dispatch)
    with pytest.raises(replay.ReplayMismatch, match="fresh model generation is forbidden"):
        replay.replay(synthetic_replay)
    assert not synthetic_replay.report.exists()
