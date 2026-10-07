"""Reporting must retain failures and registered denominators in incomplete snapshots."""
import copy
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("ablation_tables", Path(__file__).resolve().parents[1]
                                            / "experiments/extraction/extraction_ablation_tables.py")
tables = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tables)


def snapshot():
    comparison = {"control": "control", "treatment": "treatment", "factor": "context"}
    manifest = {"id": "study", "sources": [{"id": source, "methods": ["control", "treatment"]}
                                            for source in ["paper1", "paper2"]],
                "methods": {"control": {}, "treatment": {}}, "repeats": 1, "comparisons": [comparison]}
    rows = []
    for source, method, correct in [("paper1", "control", 2), ("paper1", "treatment", 0), ("paper2", "control", 2)]:
        rows.append({"id": f"{source}--{method}--0", "source": source, "method": method, "repeat": 0,
                     "completion": {"processing": bool(correct)}, "records": int(bool(correct)), "calls": 1,
                     "failed_calls": int(not correct), "input_tokens": 10, "output_tokens": correct,
                     "linked_record_leaves": correct, "populated_record_leaves": correct,
                     "accuracy": {"populated": {"correct": correct, "total": 2, "needs_review": 0},
                                  "empty": {"correct": 1, "total": 1}}, "extra_prediction_indices_unscored": [],
                     "identity_alignment": {"matched": int(bool(correct)), "missing": int(not correct)},
                     "issues": {"context_exceeded": 1} if not correct else {}})
    for row in rows:
        row["document_field_accuracy"] = {"populated": {"correct": 1, "total": 2}}
        row["exact_projected_match"] = {"sample_fields": {"populated": {"correct": 0, "total": 2}},
                                        "document_fields": {"populated": {"correct": 0, "total": 2}}}
    analysis = {"study": "study", "expected_cells": 4, "completed_cells": 3, "cells": rows, "limits": ["Development only."],
                "missing": [{"cell": "paper2--treatment--0", "status": "not_completed"}],
                "comparisons": [{**comparison, "paired": [{"source": "paper1", "calls": 0, "input_tokens": 0}],
                                 "accuracy_effect": {"documents": 1, "mean": -1, "percentile_95": [-1, -1]}}]}
    accounting = {"study": "study", "cells": {r["id"]: {} for r in rows},
                  "stage_costs": {r["id"]: {"stages": {}, "fresh_calls": int(bool(r["records"])), "reused_calls": 0}
                                  for r in rows}}
    return manifest, analysis, accounting, {"paper1", "paper2"}


def test_failed_result_counts_as_observed_and_missing_pair_keeps_its_denominator():
    report = tables.render(*snapshot())
    assert "**3/4 sealed cells**; **1 missing**" in report
    assert "| treatment | 1/2 | 1 | 0 |" in report
    assert "| paper1--treatment--0 | 0/2 |" in report
    assert "| control → treatment | context | 1/2 | -100.00 | — | 1/2 | +0.00 | 1/2 | +0 |" in report
    assert "[-100.00, -100.00]" not in report  # one document cannot support an uncertainty interval
    assert "paper2--treatment--0" in report and "not_completed" in report
    assert "| paper1--control--0 | 0/2 | 1/2 | 0/2 |" in report


@pytest.mark.parametrize("known_delta", [None, 0, 20])
def test_refused_input_retains_pair_but_has_no_measured_token_cost(known_delta):
    manifest, analysis, accounting, gold = snapshot()
    observed = analysis["comparisons"][0]
    del observed["paired"][0]["input_tokens"]
    refused = analysis["cells"][1]
    refused["input_tokens"] = refused["output_tokens"] = None
    if known_delta is not None:
        row = copy.deepcopy(refused)
        row.update(id="paper2--treatment--0", source="paper2", input_tokens=10 + known_delta, output_tokens=0)
        analysis["cells"].append(row)
        analysis.update(completed_cells=4, missing=[])
        accounting["cells"][row["id"]] = {}
        accounting["stage_costs"][row["id"]] = {"stages": {}, "fresh_calls": 1, "reused_calls": 0}
        observed["paired"].append({"source": "paper2", "calls": 0, "input_tokens": known_delta})
        observed["accuracy_effect"] = {"documents": 2, "mean": -1, "percentile_95": [-1, -1]}
    report = tables.render(manifest, analysis, accounting, gold)
    assert "| paper1--treatment--0 | 0 | 0/0 | 1 | 1 | — | — |" in report
    if known_delta is None:
        assert "| 1/2 | +0.00 | 0/2 | — |" in report
    else:
        assert f"| 2/2 | +0.00 | 1/2 | {known_delta:+d} |" in report


@pytest.mark.parametrize("damage", ["drop_missing", "duplicate_pair", "drop_accounting", "wrong_gold_n"])
def test_inconsistent_snapshot_or_pair_denominators_are_refused(damage):
    manifest, analysis, accounting, gold = copy.deepcopy(snapshot())
    if damage == "drop_missing":
        analysis["missing"] = []
    elif damage == "duplicate_pair":
        analysis["comparisons"][0]["paired"] *= 2
    elif damage == "drop_accounting":
        accounting["cells"].pop("paper1--control--0")
    else:
        analysis["comparisons"][0]["accuracy_effect"]["documents"] = 2
    with pytest.raises(ValueError):
        tables.render(manifest, analysis, accounting, gold)


def test_missing_processing_flag_is_unreported_instead_of_successful():
    manifest, analysis, accounting, gold = snapshot()
    analysis["cells"][0]["completion"] = None
    report = tables.render(manifest, analysis, accounting, gold)
    assert "| control | 2/2 | 0 | 1 |" in report


def test_old_analysis_without_corrected_reporting_is_refused():
    manifest, analysis, accounting, gold = snapshot()
    del analysis["cells"][0]["exact_projected_match"]
    with pytest.raises(ValueError, match="regenerate analysis"):
        tables.render(manifest, analysis, accounting, gold)
