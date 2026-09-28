"""Reporting must reject incorrect source locations and retain failed work in costs."""
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path
import runpy
from types import SimpleNamespace

import pytest

from experiments.extraction import manifest, study
from experiments.extraction.manifest import pin, write_new
from kei_exp.kie.extract import run
from kei_exp.kie.extract.stages import verify
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages
from tests.test_extraction_rendering import table_passage
from tests.test_extraction_span_grounding import span_chat
from tests.test_grounding_study import frozen, registered  # shared registered fixed-upstream fixture


HELPER = Path(__file__).resolve().parents[3] / "docs/validation/extraction_grounding_report.py"
reporter = runpy.run_path(str(HELPER))


def supported(passage, label, value=1827):
    proofs = []
    links, _, issues = verify([passage], {"year": value}, SCHEMA, span_chat(label), record=0,
        counter=WordCounter(), record_context="Hill", span_ids=True, proofs=proofs)
    assert links and not issues
    return {"quoted_support": proofs, "evidence": [asdict(link) for link in links]}


@pytest.mark.parametrize("change", ["offset", "identity", "geometry", "attribution", "foreign_claim"])
def test_source_audit_rejects_changed_location_even_with_an_exact_quote(change):
    passage = passages(["Hill\t1827\nHill\t1827"])[0]
    artifact = supported(passage, "E1")
    claims = {("records", 0, "year"): 1827}
    result, proofs = reporter["source_validity"](artifact, evidence([passage]), claims)
    assert result["all_literal_locations_valid"] and result["semantic_precision"] is None
    assert result["evidence_recall"] is None and len(proofs) == 1
    if change == "offset":
        artifact["quoted_support"][0]["start"] = 1
    elif change == "identity":
        artifact["quoted_support"][0]["span"] = "p1_s0@10:19"
    elif change == "geometry":
        artifact["evidence"][0]["precision"] = "cell"
    elif change == "attribution":
        artifact["quoted_support"][0]["attribution"] = "human_gold"
    else:
        artifact["quoted_support"][0]["path"] = ["records", 1, "year"]
    with pytest.raises(ValueError):
        reporter["source_validity"](artifact, evidence([passage]), claims)


def test_source_audit_preserves_coarse_cell_identity_and_multiple_proofs():
    passage = table_passage()
    artifact = supported(passage, "E5", value=37)
    artifact["quoted_support"] *= 2  # two units may attest the same retained claim
    result, proofs = reporter["source_validity"](artifact, evidence([passage]), {("records", 0, "year"): 37})
    assert result["proofs_checked"] == 2 and result["retained_links_checked"] == 1
    assert result["by_source_kind"] == {"table_cell": 2}
    assert proofs[("records", 0, "year")][0]["cell"] == "r2_c0"
    assert artifact["evidence"][0]["cell"] is None


def test_capture_cost_keeps_missing_reply_unknown_usage_and_prior_uncertainty(tmp_path):
    terminal = {"fresh_calls": 1, "reused_calls": 0, "unknown_prior_completions": 1,
                "wall_seconds_this_attempt": 10}
    request = {"schema": {"required": ["C1", "C2"]}}
    write_new(tmp_path / "calls/reasoning-0001.request.json", request)
    write_new(tmp_path / "calls/reasoning-0001.reply.json", {"input_tokens": 100, "output_tokens": None, "seconds": 3})
    write_new(tmp_path / "calls/reasoning-0002.request.json", request)
    result = reporter["capture_cost"](tmp_path, terminal)
    assert result["saved_replies"] == 1 and result["requests_without_reply"] == 1
    assert result["input_tokens_reported"] == 100 and result["input_tokens_total"] is None
    assert result["input_tokens_unknown_requests"] == 2 and result["output_tokens_unknown_requests"] == 3
    assert result["claim_decisions_requested"] == 4
    assert result["recorded_call_seconds"] == 3 and not result["call_seconds_complete"]
    write_new(tmp_path / "calls/fields-0001.request.json", request)
    with pytest.raises(ValueError, match="upstream call"):
        reporter["capture_cost"](tmp_path, terminal)


def test_route_coverage_preserves_refused_and_remaining_units():
    claims = {("records", 0, "year"): 1827}
    route = {"path": ["records", 0, "year"], "order": [1, 0, 2], "origin_units": [1],
        "attempted": [0], "refused": [1], "remaining": [2], "supported": True, "coverage": "stopped_after_support"}
    artifact = {"grounding_routes": [route], "evidence": [{"path": route["path"]}]}
    counts = reporter["route_coverage"](artifact, claims, 3)
    assert counts["refused_claim_unit_pairs"] == counts["remaining_claim_unit_pairs"] == 1
    assert counts["non_origin_attempts"] == 1
    route["remaining"] = [1]
    with pytest.raises(ValueError, match="reconcile"):
        reporter["route_coverage"](artifact, claims, 3)


def test_comparisons_leave_failed_pairs_unavailable_and_differences_unadjudicated():
    study = {"sources": [{"id": "Doc"}], "comparisons": [{"control": "a", "treatment": "b"}]}
    a = {"status": "completed", "diagnostics": {"linked_record_leaves": 1}, "refused_claim_unit_pairs": 0,
        "cost": {"captured_requests": 2, "input_tokens_total": 100, "output_tokens_total": 10,
                 "recorded_call_seconds": 1, "call_seconds_complete": True}}
    b = deepcopy(a)
    b["diagnostics"]["linked_record_leaves"] = 0
    b["refused_claim_unit_pairs"] = 2
    b["cost"]["captured_requests"] = 0
    rows = {"Doc--a--0": a, "Doc--b--0": b}
    bundles = {"Doc": {"fields": [{"year": 1827}]}}
    proofs = {"Doc--a--0": {("records", 0, "year"): [{"quote": "1827"}]}, "Doc--b--0": {}}
    comparisons, queue = reporter["comparison_rows"](study, rows, proofs, bundles)
    pair = comparisons[0]["documents"][0]
    assert pair["deltas_treatment_minus_control"]["captured_requests"] == -2
    assert pair["deltas_treatment_minus_control"]["refused_claim_unit_pairs"] == 2
    assert queue[0]["change"] == "dropped" and queue[0]["status"] == "unadjudicated"
    b["status"] = "failed"
    comparisons, queue = reporter["comparison_rows"](study, rows, proofs, bundles)
    assert "unavailable" in comparisons[0]["documents"][0]["comparison"]
    assert "deltas_treatment_minus_control" not in comparisons[0]["documents"][0] and not queue
    effect = comparisons[0]["document_effects"]["metrics"]["captured_requests"]
    assert effect["documents"] == 0 and effect["mean"] is None and effect["percentile_95"] is None
    assert effect["excluded_documents"] == [{"source": "Doc", "reason": "incomplete_pair"}]


def test_document_effects_use_equal_document_weights_and_metric_specific_denominators():
    documents = [
        {"source": "A", "deltas": {"captured_requests": -1, "input_tokens_total": None}},
        {"source": "B", "deltas": {"captured_requests": 3, "input_tokens_total": 0}},
        {"source": "Failed", "statuses": ["completed", "failed"]},
    ]
    result = reporter["document_effects"](documents, "deltas")
    calls = result["metrics"]["captured_requests"]
    # Two equally weighted documents yield bootstrap means -1, 1, 3.
    assert calls["documents"] == 2 and calls["mean"] == 1 and calls["percentile_95"] == [-1, 3]
    assert calls["unit"] == "document" and calls["draws"] == 10000
    assert calls["included_sources"] == ["A", "B"]
    assert calls["excluded_documents"] == [{"source": "Failed", "reason": "incomplete_pair"}]
    tokens = result["metrics"]["input_tokens_total"]
    assert tokens["documents"] == 1 and tokens["mean"] == 0 and tokens["percentile_95"] is None
    assert tokens["status"] == "insufficient_documents"
    assert tokens["excluded_documents"] == [
        {"source": "A", "reason": "unknown_metric"}, {"source": "Failed", "reason": "incomplete_pair"}]
    assert result["registered_documents"] == 3
    assert reporter["document_effects"](documents, "deltas") == result


def test_all_pending_document_effects_are_unavailable_for_every_metric():
    result = reporter["document_effects"]([{"source": "Pending"}], "deltas")
    assert len(result["metrics"]) == 6
    for effect in result["metrics"].values():
        assert effect["status"] == "unavailable" and effect["documents"] == 0
        assert effect["mean"] is None and effect["percentile_95"] is None
        assert effect["included_sources"] == []
        assert effect["excluded_documents"] == [{"source": "Pending", "reason": "incomplete_pair"}]


def test_complete_six_arm_report_checks_captures_locations_routes_and_changed_links(frozen, tmp_path, monkeypatch):
    configured, source, output, _, provider = registered(frozen, tmp_path)
    cells = manifest.validate(configured, Path(__file__).resolve().parents[1])
    def answer(system, user, schema):
        return {claim: ({"label": "NONE", "quote": "", "attribution": False} if "quote" in shape["properties"]
            else {"label": shape["properties"]["label"]["enum"][0], "attribution": True})
            for claim, shape in schema["properties"].items()}
    monkeypatch.setattr(study, "OpenAIChat", lambda **_: CountingChat(answer))
    monkeypatch.setattr(study, "counter_for", lambda _: WordCounter())
    monkeypatch.setattr(study.requests, "get", lambda *_args, **_kwargs: SimpleNamespace(
        raise_for_status=lambda: None,
        json=lambda: {"data": [{"id": provider["model"], "max_model_len": provider["context_tokens"]}]}))
    for cell in cells:
        assert study.execute(configured, pin(output / "manifest.json")["sha256"], cell, output) == "completed"
    replay_cell = runpy.run_path(str(HELPER.with_name("extraction_grounding_replay.py")))["replay_cell"]
    def forbidden(*_args, **_kwargs):
        pytest.fail("report or replay made an HTTP request")
    monkeypatch.setattr(study.requests.Session, "request", forbidden)
    verification = {"manifest": pin(output / "manifest.json"), "cells": [replay_cell(configured, cell, output) for cell in cells]}
    write_new(output / "verified.json", verification)
    report = reporter["report"]
    monkeypatch.setitem(report.__globals__, "load", lambda _: run.load(tmp_path))
    result = report(configured, cells, output, output / "verified.json")
    assert result["cell_statuses"] == {"completed": 6}
    assert all(row["upstream_records_unchanged"] for row in result["cells"])
    quoted = next(row for row in result["cells"] if row["method"] == "quoted")
    assert quoted["literal_validity"]["status"] == "no_proofs"
    assert quoted["literal_validity"]["all_literal_locations_valid"] is None
    routed = next(row for row in result["cells"] if row["method"] == "spans_routed")
    assert routed["route_coverage"]["stopped_after_support"] == 2
    assert result["comparisons"][0]["documents"][0]["link_changes"] == {"added": 2}
    assert all(value == 0 for value in result["interactions"][0]["documents"][0]["difference_of_differences"].values())
    interaction = result["interactions"][0]["document_effects"]["metrics"]["captured_requests"]
    assert interaction["documents"] == 1 and interaction["mean"] == 0 and interaction["percentile_95"] is None
    assert result["comparisons"][0]["document_effects"]["registered_documents"] == 1
    assert all(item["status"] == "unadjudicated" for item in result["link_review_queue"])
    # A valid old replay receipt cannot bless captures changed after verification.
    reply = next((output / "cells" / cells[0]["id"] / "calls").glob("*.reply.json"))
    reply.write_text(reply.read_text() + "\n")
    with pytest.raises(ValueError, match="captures changed"):
        report(configured, cells, output, output / "verified.json")
