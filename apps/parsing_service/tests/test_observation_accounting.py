"""An extra measurement cannot disappear behind a correct projected field."""
import importlib.util
import hashlib
import json
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "experiments/extraction/extraction_ablation_accounting.py"
spec = importlib.util.spec_from_file_location("observation_accounting", path)
accounting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounting)


def test_expected_measurement_does_not_hide_an_extra_wrong_or_duplicate_measurement():
    artifact = {"records": [{"thermal_data": [{"value": 35}, {"value": 92}, {"value": 35}]}], "evidence": []}
    fields = [{"prediction_path": ["records", 0, "thermal_data", 0, "value"],
               "expected_empty": False, "result": "correct"}]
    result = accounting.observations(artifact, fields)
    assert result["array_items"] == 3
    assert result["by_projection_status"] == {"used_by_gold_projection": 1, "not_selected_by_gold_projection": 2}
    assert result["exact_duplicate_items"] == 1
    assert result["items"][1]["value"] == {"value": 92}
    assert result["items"][1]["projection_status"] != "false_positive"


def test_unannotated_arrays_remain_unannotated_and_citations_do_not_change_labels():
    artifact = {"records": [{"finds": ["bead"]}], "evidence": [{"path": ["records", 0, "finds", 0], "segment": "p1_s0"}]}
    result = accounting.observations(artifact, None)
    assert result["by_projection_status"] == {"unannotated": 1}
    assert result["items"][0]["evidence"] == artifact["evidence"]


def test_grounding_comparison_flags_changed_upstream_content():
    a = {"records": [{"value": 35}], "inventory": []}
    b = {"records": [{"value": 92}], "inventory": []}
    rows = accounting.grounding_comparability({"paper--base--0": a, "paper--quote--0": b}, [{"id": "paper"}],
        [{"factor": "article.grounding", "control": "base", "treatment": "quote"}])
    assert not rows[0]["identical_upstream_records_and_inventory"]


def test_stage_costs_include_failed_calls_and_keep_unknown_usage_distinct_from_zero():
    calls = [
        {"stage": "record", "ok": True, "input_tokens": 100, "output_tokens": 20, "seconds": 3},
        {"stage": "record", "ok": False, "input_tokens": 80, "output_tokens": 40, "seconds": 5},
        {"stage": "inventory", "ok": False, "input_tokens": None, "output_tokens": None, "seconds": 0}]
    result = accounting.stage_costs({"calls": calls}, {"fresh_calls": 0, "reused_calls": 2,
                                                      "wall_seconds_this_attempt": None})
    records = result["stages"]["record"]
    assert (records["calls"], records["failed_calls"], records["input_tokens_reported"],
            records["output_tokens_reported"], records["recorded_call_seconds"]) == (2, 1, 180, 60, 8)
    assert result["stages"]["inventory"]["input_tokens_unknown_calls"] == 1
    assert result["stages"]["inventory"]["output_tokens_unknown_calls"] == 1
    assert result["fresh_calls"] == 0 and result["reused_calls"] == 2
    assert result["wall_seconds_this_attempt"] is None


def test_accounting_uses_analysis_snapshot_not_a_cell_that_finished_afterward(tmp_path, monkeypatch):
    manifest = {"id": "snapshot", "sources": [], "comparisons": []}
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    artifact = {"records": [], "calls": [], "schema": {"schemaNodes": []}}
    receipt = {"artifact_sha256": hashlib.sha256(json.dumps(artifact, sort_keys=True).encode()).hexdigest()}
    for cell in ("analyzed", "finished_later"):
        directory = tmp_path / "cells" / cell
        directory.mkdir(parents=True)
        (directory / "pin.json").write_text(json.dumps({"manifest_sha256":
            hashlib.sha256(manifest_path.read_bytes()).hexdigest()}))
        (directory / "result.json").write_text(json.dumps({"artifact": artifact, "execution": receipt}))
    report = tmp_path / "analysis.json"
    report.write_text(json.dumps({"study": "snapshot", "accuracy": {},
                                  "cells": [{"id": "analyzed", "attempts": [receipt]}]}))
    output = tmp_path / "accounting.json"
    monkeypatch.setattr("sys.argv", ["accounting", str(tmp_path), str(report), str(output)])
    accounting.main()
    assert set(json.loads(output.read_text())["cells"]) == {"analyzed"}


def test_same_page_link_does_not_turn_wrong_value_into_supported_correctness():
    artifact = {"schema": {"schemaNodes": [{"name": "year", "valueSource": "document"}]}}
    fields = [
        {"field": "temperature", "expected_empty": False, "result": "correct",
         "evidence": {"status": "candidate_page_overlap"}},
        {"field": "temperature", "expected_empty": False, "result": "incorrect",
         "evidence": {"status": "candidate_page_overlap"}},
        {"field": "yield", "expected_empty": False, "result": "incorrect",
         "evidence": {"status": "missing"}},
        {"field": "year", "expected_empty": False, "result": "correct",
         "evidence": {"status": "missing"}}]
    result = accounting.evidence_localization(artifact, fields)
    assert result["reported_record_fields"] == 3
    assert result["by_evidence_status"] == {"candidate_page_overlap": 2, "missing": 1}
    assert result["by_value_result"]["incorrect"] == {"candidate_page_overlap": 1, "missing": 1}
    assert accounting.evidence_localization(artifact, None) == {"status": "unannotated"}


def test_field_links_separate_status_metadata_and_do_not_count_duplicate_or_dangling_links():
    temperature = ["records", 0, "thermal_data", 0, "value"]
    artifact = {
        "schema": {"schemaNodes": []},
        "records": [{"thermal_data": [{"value": 35}, {"value": 92}],
                     "field_statuses": [{"field": "yield", "status": "not_reported", "reason": "absent"}]}],
        "evidence": [{"path": temperature}, {"path": temperature},
                     {"path": ["records", 0, "thermal_data", 9, "value"]},
                     {"path": ["records", 0, "field_statuses", 0, "reason"]}]}
    counts = accounting.record_field_links(artifact)["by_field"]
    assert counts == {"thermal_data": {"populated_leaves": 2, "linked_leaves": 1},
                      "field_statuses": {"populated_leaves": 3, "linked_leaves": 1}}


def test_field_link_denominator_excludes_unverified_filename_boolean_null_and_blank_values():
    artifact = {"schema": {"schemaNodes": [{"name": "filename", "valueSource": "source-filename"}]},
                "unverified": ["title"], "records": [{"filename": "paper.pdf", "title": "Study",
                    "count": 0, "flag": True, "missing": None, "blank": " \t", "items": []}],
                "evidence": [{"path": ["records", 0, "filename"]}, {"path": ["records", 0, "flag"]}]}
    assert accounting.record_field_links(artifact)["by_field"] == {
        "count": {"populated_leaves": 1, "linked_leaves": 0}}
