"""Fixed-upstream studies must not rerun values or hide changes behind a valid seal."""
from copy import deepcopy
from dataclasses import replace
import json
import runpy
from pathlib import Path

import pytest

from experiments.extraction import fixed_upstream, grounding_study, manifest, study
from experiments.extraction.analyze import diagnostic
from experiments.extraction.manifest import pin, read, write_new
from kei_exp.kie.extract import run
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.models import Router
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages


@pytest.fixture
def frozen(tmp_path, monkeypatch):
    source = passages(["Hill background", "Hill year 1827"])
    canonical = evidence(source)
    for module in (run, fixed_upstream, grounding_study, manifest):
        monkeypatch.setattr(module, "load", lambda _: canonical)
    contexts = [Context((p,)) for p in source]
    monkeypatch.setattr("kei_exp.kie.extract.article.source_contexts", lambda *_: contexts)
    monkeypatch.setattr("kei_exp.kie.extract.article.partition", lambda *_args, **_kwargs: contexts)
    def reasoning(system, user, schema):
        if "records" in schema["properties"]:
            offered = schema["properties"]["records"]["items"]["properties"]["passages"]["items"]["enum"]
            return {"records": [{"label": "Hill", "identity": {"site": "Hill"}, "passages": offered}]}
        return {claim: "NONE" for claim in schema["properties"]}
    provider = {"base_url": "http://unused", "model": "fake/extractor", "context_tokens": WordCounter.context_tokens}
    parent = tmp_path / "parent"
    directory = parent / "cells/Doc--bounded--0"
    # Article is one document root (version 2): its site is read by the value calls, no longer bound by an inventory.
    fields = study.Capture(CountingChat(lambda s, u, schema: {"title": "Document", "site": "Hill" if "Hill" in u else None,
                                                              "year": 1827 if "1827" in u else None}),
                           directory / "calls", "fields")
    reason = study.Capture(CountingChat(reasoning), directory / "calls", "reasoning")
    options = {"strategy": "article", "article": {"context": "bounded", "identity": "conservative",
               "identity_fields": ["site"], "prompt": "schema", "grounding": "semantic"}}
    request = run.ExtractRequest(schema=SCHEMA, options=options)
    count = grounding_study.RecordedCounts(WordCounter(), tmp_path / "counts", provider)
    artifact = run.extract(tmp_path, request, Router(fields, reason), counter={"fields": count, "reasoning": count})
    write_new(directory / "result.json", {"artifact": artifact})
    write_new(tmp_path / "schema.json", artifact["schema"])
    source_config = {"id": "Doc", "run": str(tmp_path), "schema": pin(tmp_path / "schema.json"),
        "generation": canonical.generation, "digest": canonical.digest, "canonical_files": [],
        "methods": ["bounded"], "identity_fields": ["site"], "exposure": "development"}
    original = {"id": "parent", "version": 1, "repeats": 1, "order_seed": 1, "sources": [source_config],
        "methods": {"bounded": options}, "providers": {role: provider for role in ("fields", "reasoning")},
        "comparisons": [], "interactions": [], "evaluation": {}}
    write_new(parent / "manifest.json", original)
    report = {"manifest": pin(parent / "manifest.json"), "script": pin(Path(__file__)), "verified": [{
        "cell": "Doc--bounded--0", "fresh_model_calls": 0, "fresh_tokenizer_probes": 0,
        "equal_except_top_level_clocks": True, "result": pin(directory / "result.json"),
        "captures": [pin(p) for p in sorted((directory / "calls").glob("*.json"))],
        "tokenizer_probes": [pin(p) for p in sorted((tmp_path / "counts").glob("*.json"))]}]}
    write_new(tmp_path / "verification.json", report)
    bundle = fixed_upstream.prepare(parent, "Doc", tmp_path / "verification.json")
    write_new(tmp_path / "bundles/Doc.json", bundle)
    return parent, tmp_path / "bundles", artifact, provider


def registered(frozen, tmp_path):
    parent, bundles, original, provider = frozen
    output = tmp_path / "study"
    configured = grounding_study.register(parent, bundles, output)
    source = configured["sources"][0]
    return configured, source, output, original, provider


def test_preparation_reproduces_records_and_origins_without_a_grounding_reply(frozen, tmp_path):
    _, bundles, original, _ = frozen
    bundle = read(bundles / "Doc.json")
    assert bundle["records"] == original["records"] and bundle["inventory"] == original["inventory"]
    assert {call["stage"] for call in bundle["upstream_calls"]} == {"document", "record"}  # no identity inventory
    assert bundle["provenance"]["fresh_calls"] == 0
    assert bundle["value_origins"][0][1] == {"path": ["year"], "kind": "value",
        "sources": [{"unit": 1, "path": ["year"]}]}


@pytest.mark.parametrize("change", ["fields", "origins", "request"])
def test_registration_refuses_upstream_drift_even_when_records_look_unchanged(frozen, tmp_path, change):
    parent, bundles, _, _ = frozen
    path = bundles / "Doc.json"
    bundle = read(path)
    if change == "fields":
        bundle["fields"][0]["year"] = 1900
    elif change == "origins":
        bundle["value_origins"][0][1]["sources"][0]["unit"] = 0
    else:
        bundle["upstream_options"]["article"]["prompt"] = "reference"
    path.write_text(json.dumps(bundle))
    with pytest.raises(ValueError, match="differs from exact replay"):
        grounding_study.register(parent, bundles, tmp_path / "bad")
    assert not (tmp_path / "bad/manifest.json").exists()


def test_fixed_runner_uses_only_grounding_and_preserves_upstream_across_all_methods(frozen, tmp_path):
    configured, source, output, original, _ = registered(frozen, tmp_path)
    def reason(system, user, schema):
        assert "### Claims" in user
        return {claim: {"label": "NONE", "attribution": False,
                       **({"quote": ""} if "quote" in shape["properties"] else {})}
                for claim, shape in schema["properties"].items()}
    fields = CountingChat(lambda *_: pytest.fail("fixed runner generated upstream fields"))
    seen = []
    for name, method in configured["methods"].items():
        request = manifest.request(source, method)
        result = grounding_study.fixed_grounding(source, request, Router(fields, CountingChat(reason)),
            {"reasoning": WordCounter()}, model_seconds=10800)
        assert result["records"] == original["records"] and result["inventory"] == original["inventory"]
        assert not fields.calls and all(call["stage"] == "grounding" for call in result["calls"])
        assert result["execution_scope"] == "grounding_on_fixed_upstream"
        assert diagnostic(result)["populated_record_leaves"] == 2
        seen.append(result["fingerprint"])
    assert len(set(seen)) == len(configured["methods"]) == 6
    cells = manifest.validate(configured, Path(__file__).resolve().parents[1])
    assert len(cells) == 6
    configured["methods"]["spans"]["article"]["context"] = "full"
    with pytest.raises(ValueError, match="not exactly"):
        manifest.validate(configured, Path(__file__).resolve().parents[1])


def test_fixed_runner_refuses_a_shared_upstream_option_change_before_generation(frozen, tmp_path):
    configured, source, _, _, _ = registered(frozen, tmp_path)
    method = deepcopy(configured["methods"]["spans"])
    method["article"]["prompt"] = "reference"
    chat = CountingChat(lambda *_: pytest.fail("changed upstream must not generate"))
    with pytest.raises(ValueError, match="only grounding options"):
        grounding_study.fixed_grounding(source, manifest.request(source, method), Router(chat, chat),
            {"reasoning": WordCounter()}, model_seconds=10800)


def test_preflight_is_an_all_none_scenario_and_caches_every_admission_probe(frozen, tmp_path):
    configured, source, output, original, provider = registered(frozen, tmp_path)
    cells = manifest.validate(configured, Path(__file__).resolve().parents[1])
    report = grounding_study.preflight_fixed(configured, cells, output, WordCounter())
    assert len(report) == 6 and all(item["grounding_requests"] > 0 for item in report)
    assert all(item["all_record_leaves"] == 2 for item in report)
    probes = list((output / "token-counts").rglob("*.json"))
    assert probes and all(read(path)["provider"] == provider for path in probes)
    class Offline(WordCounter):
        def request_tokens(self, *_):
            pytest.fail("a cached admission probe made a fresh tokenizer call")
    assert grounding_study.preflight_fixed(configured, cells, output, Offline()) == report


def test_time_budget_counts_replayed_replies_and_retains_the_inflight_overrun(tmp_path):
    chat = CountingChat(lambda *_: {"ok": True})
    class Timed:
        model = chat.model
        def complete(self, **request):
            return replace(chat.complete(**request), seconds=2)
    request = dict(system="S", user="U", schema={}, max_tokens=2)
    capture = study.Capture(Timed(), tmp_path, "reasoning")
    budget = grounding_study.ModelBudget(capture, 1)
    budget.complete(**request)
    with pytest.raises(TimeoutError, match="model-time budget"):
        budget.complete(**request)
    replay = study.Capture(Timed(), tmp_path, "reasoning")
    budget = grounding_study.ModelBudget(replay, 1)
    budget.complete(**request)
    with pytest.raises(TimeoutError):
        budget.complete(**request)
    assert len(chat.calls) == 1 and replay.reused == 1 and replay.fresh == 0


@pytest.mark.parametrize("budget", [10800, 0.01])
def test_runner_dispatch_and_offline_replay_preserve_completed_and_budget_outcomes(frozen, tmp_path, monkeypatch, budget):
    configured, source, output, _, provider = registered(frozen, tmp_path)
    configured["grounding_study"]["model_seconds_per_cell"] = budget
    (output / "manifest.json").write_text(json.dumps(configured))
    cell = manifest.validate(configured, Path(__file__).resolve().parents[1])[0]
    generated = []
    def reason(system, user, schema):
        assert "### Claims" in user
        generated.append(user)
        return {claim: {"label": "NONE", "quote": "", "attribution": False} for claim in schema["properties"]}
    class Timed(CountingChat):
        def complete(self, **request):
            return replace(super().complete(**request), seconds=1)
    monkeypatch.setattr(study, "OpenAIChat", lambda **_: Timed(reason))
    monkeypatch.setattr(study, "counter_for", lambda _: WordCounter())
    class Models:
        def raise_for_status(self): pass
        def json(self): return {"data": [{"id": provider["model"], "max_model_len": provider["context_tokens"]}]}
    monkeypatch.setattr(study.requests, "get", lambda *_args, **_kwargs: Models())
    study_hash = pin(output / "manifest.json")["sha256"]
    assert study.execute(configured, study_hash, cell, output) == ("completed" if budget == 10800 else "failed")
    directory = output / "cells" / cell["id"]
    terminal = read(directory / "attempt-001.finished.json")
    assert terminal["fresh_calls"] == len(generated) > 0
    if budget == 10800:
        saved = read(directory / "result.json")
        assert all(call["stage"] == "grounding" for call in saved["artifact"]["calls"])
        assert study.execute(configured, study_hash, cell, output) == "retained_completed"
        assert len(generated) == saved["execution"]["fresh_calls"]
    else:
        assert not (directory / "result.json").exists() and terminal["error_type"] == "TimeoutError"
    helper = Path(__file__).resolve().parents[3] / "docs/validation/extraction_grounding_replay.py"
    replay_cell = runpy.run_path(str(helper))["replay_cell"]
    def forbidden(*_args, **_kwargs):
        pytest.fail("offline replay made an HTTP request")
    monkeypatch.setattr(study.requests.Session, "request", forbidden)
    replayed = replay_cell(configured, cell, output)
    assert replayed["exact_replay"] and replayed["calls"] == len(generated)
    assert replayed["fresh_model_calls"] == replayed["fresh_tokenizer_probes"] == 0
    all_cells = manifest.validate(configured, Path(__file__).resolve().parents[1])
    verification = {"manifest": pin(output / "manifest.json"), "cells": [
        replayed if other["id"] == cell["id"] else {"cell": other["id"], "status": "pending", "exact_replay": False}
        for other in all_cells]}
    write_new(output / "verified.json", verification)
    report_path = helper.with_name("extraction_grounding_report.py")
    report = runpy.run_path(str(report_path))["report"]
    monkeypatch.setitem(report.__globals__, "load", lambda _: run.load(tmp_path))
    reported = report(configured, all_cells, output, output / "verified.json")
    assert reported["cell_statuses"] == {terminal["status"]: 1, "pending": 5}
    row = next(row for row in reported["cells"] if row["id"] == cell["id"])
    assert row["cost"]["saved_replies"] == len(generated)
    assert row["cost"]["recorded_call_seconds"] == len(generated)
    assert not reported["link_review_queue"]
    if budget == 10800:
        assert row["upstream_records_unchanged"] and row["literal_validity"]["semantic_precision"] is None
    else:
        assert "diagnostics" not in row  # an exhausted cell has cost, not zero-quality measurements
    probes = list((output / "token-counts" / cell["id"]).glob("*.json"))
    probes[0].unlink()
    with pytest.raises(AssertionError, match="missing saved grounding token probe"):
        replay_cell(configured, cell, output)
