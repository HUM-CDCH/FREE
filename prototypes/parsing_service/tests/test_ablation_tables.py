"""Reporting must retain failures and registered denominators in incomplete snapshots."""
import copy
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("ablation_tables", Path(__file__).resolve().parents[3]
                                            / "docs/validation/extraction_ablation_tables.py")
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
    assert "| control → treatment | context | 1/2 | -100.00 | — | 1/2 |" in report
    assert "[-100.00, -100.00]" not in report  # one document cannot support an uncertainty interval
    assert "paper2--treatment--0" in report and "not_completed" in report


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
