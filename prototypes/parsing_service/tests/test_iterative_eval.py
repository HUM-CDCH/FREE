"""The developer iterative-eval harness: golden Excel, field-level P/R/F1, pilot->full, improvement."""
from __future__ import annotations

import json
from pathlib import Path

import openpyxl
import pytest

from experiments.extraction import iterative_eval

SCHEMA = {
    "recordDescription": "One dated sample.",
    "recordScope": "document",
    "schemaNodes": [
        {"id": "n", "name": "sample_name", "type": "string"},
        {"id": "y", "name": "year", "type": "integer"},
        {"id": "m", "name": "materials", "type": "array",
         "children": [{"id": "mi", "name": "item", "type": "string"}]},
    ],
}


def _golden(tmp_path: Path) -> Path:
    path = tmp_path / "golden.xlsx"
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "gold"
    sheet.append(["file", "sample_name", "year", "materials"])
    sheet.append(["sources/paper-a.pdf", "Alpha", 1990, '["bone", "antler"]'])
    sheet.append(["paper-b", "Beta", 2000, "bone"])  # blank-free single value; second row names the file plainly
    sheet.append([None, None, None, None])
    workbook.save(path)
    return path


def test_load_gold_reads_columns_and_cells(tmp_path: Path):
    gold = iterative_eval.load_gold(_golden(tmp_path))
    assert gold["document_column"] == "file"
    assert gold["fields"] == ["sample_name", "year", "materials"]
    assert set(gold["documents"]) == {"paper-a", "paper-b"}
    assert gold["documents"]["paper-a"][0]["materials"] == ["bone", "antler"]
    assert gold["documents"]["paper-b"][0]["year"] == [2000]
    assert gold["documents"]["paper-b"][0]["materials"] == ["bone"]


def test_score_counts_precision_recall_and_f1(tmp_path: Path):
    gold = iterative_eval.load_gold(_golden(tmp_path))
    predictions = {
        "paper-a": {"records": [{"sample_name": "alpha", "year": 1990, "materials": ["bone", "antler"]}]},
        "paper-b": {"records": [{"sample_name": "Beta", "year": 2005, "materials": ["bone", "shell"]}]},
    }
    metrics = iterative_eval.score(gold, predictions, phase="full", eval_id="t")
    assert metrics["micro"]["tp"] == 6  # sample_name x2, year x1, materials x3
    assert metrics["micro"]["fp"] == 2  # the extra 2005 and the extra "shell"
    assert metrics["micro"]["fn"] == 1  # the missed 2000
    assert metrics["micro"]["precision"] == pytest.approx(6 / 8)
    assert metrics["micro"]["recall"] == pytest.approx(6 / 7)
    assert metrics["presence"]["f1"] == 1.0  # every field was at least populated
    assert metrics["per_field"]["year"]["fp"] == 1 and metrics["per_field"]["year"]["fn"] == 1
    assert metrics["exact_cells"] == {"matched": 4, "total": 6, "accuracy": pytest.approx(4 / 6)}
    assert "| sample_name |" in iterative_eval.render(metrics)


def test_compare_reports_the_improvement(tmp_path: Path):
    gold = iterative_eval.load_gold(_golden(tmp_path))
    weak = iterative_eval.score(gold, {"paper-a": None, "paper-b": None}, phase="pilot", eval_id="v1")
    strong = iterative_eval.score(gold, {"paper-a": {"records": [{"sample_name": "Alpha", "year": 1990}]},
                                         "paper-b": {"records": [{"sample_name": "Beta", "year": 2000}]}},
                                  phase="pilot", eval_id="v2")
    report = iterative_eval.compare(weak, strong)
    assert report["delta"]["micro"]["f1"] > 0
    assert "improved" in report["conclusion"]
    assert "sample_name" in report["per_field"]


def _run_dir(root: Path, key: str) -> Path:
    directory = root / "runs" / key
    directory.mkdir(parents=True)
    (directory / "params.json").write_text(json.dumps({"source_name": f"{key}.pdf"}), encoding="utf-8")
    return directory


def test_run_eval_pilots_then_covers_the_whole_set_and_reuses_cells(tmp_path: Path, monkeypatch):
    (tmp_path / "schema.json").write_text(json.dumps(SCHEMA), encoding="utf-8")
    _golden(tmp_path)
    config = {
        "id": "t", "schema": "schema.json", "golden": "golden.xlsx", "output": "eval-out", "pilot": 1,
        "options": {"strategy": "article"},
        "providers": {"fields": {"base_url": "http://x", "model": "f"},
                      "reasoning": {"base_url": "http://x", "model": "r"}},
        "documents": ["paper-a.pdf", "paper-b.pdf"],
        "runs": {"paper-a": "runs/paper-a", "paper-b": "runs/paper-b"},
    }
    _run_dir(tmp_path, "paper-a")
    _run_dir(tmp_path, "paper-b")
    artifacts = {
        "paper-a": {"records": [{"sample_name": "Alpha", "year": 1990, "materials": ["bone", "antler"]}]},
        "paper-b": {"records": [{"sample_name": "Beta", "year": 2000, "materials": ["bone"]}]},
    }
    calls = []

    def fake(run_dir, request, providers, cell_dir):
        calls.append(run_dir.name)
        return artifacts[run_dir.name]

    monkeypatch.setattr(iterative_eval, "_extract_document", fake)
    pilot, full = iterative_eval.run_eval(config, tmp_path, phase="full")
    assert pilot["documents"] == ["paper-a"] and pilot["micro"]["f1"] == 1.0
    assert full["documents"] == ["paper-a", "paper-b"] and full["micro"]["f1"] == 1.0
    assert (tmp_path / "eval-out" / "metrics-full.json").is_file()
    assert (tmp_path / "eval-out" / "report-pilot.md").is_file()
    assert len(calls) == 2
    iterative_eval.run_eval(config, tmp_path, phase="full")  # completed cells are reused, not re-extracted
    assert len(calls) == 2
