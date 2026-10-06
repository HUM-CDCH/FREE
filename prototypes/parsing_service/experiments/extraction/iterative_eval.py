"""Iterative developer evaluation: golden Excel -> pilot/full extraction -> precision/recall/F1.

Developer-only. No Studio, no DBOS, no database: it parses any source PDF that has no canonical run yet
(a born-digital PDF needs no model server), extracts through the service's own entrypoint against the
configured model endpoints, and scores the artifacts against a golden Excel sheet.

The golden sheet is one worksheet: one row per document (or per record) and one column per schema field; the
first column, or the header that names the file, identifies the document. A cell holds a value, a JSON array,
or newline-separated values. Values are compared as multisets after NFKC/casefold/whitespace normalization, so
precision, recall and F1 are counted per (document, field).

    python -m experiments.extraction.iterative_eval gold    CONFIG.json
    python -m experiments.extraction.iterative_eval run     CONFIG.json [--phase pilot|full]
    python -m experiments.extraction.iterative_eval report  CONFIG.json
    python -m experiments.extraction.iterative_eval compare BASELINE.json CANDIDATE.json

`run` scores a pilot of the first `pilot` documents, then continues to the whole set and scores that too. Both
phases reuse completed cells, so a full run never re-extracts a pilot document. `compare` is the improvement
step: it reports, field by field, how much a candidate's metrics moved from a baseline's.

See `iterative-eval.example.json` for the configuration shape. It never starts a service, supplies credentials
or resets a database; it uses the endpoints and inputs the caller names.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import tempfile
import unicodedata
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

from kei_exp.kie.extract.llm import OpenAIChat
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.run import ExtractRequest, extract
from kei_exp.kie.extract.stages import leaves
from kei_exp.kie.extract.tokens import counter_for

from .manifest import digest, pin, read
from .study import Capture

# Header names that identify the document column, compared after `_header`. The first column is the fallback.
FILE_HEADERS = frozenset({
    "file", "files", "file name", "filename", "document", "documents", "document name", "document filename",
    "source", "source name", "source id", "source file", "pdf", "pdf name", "name",
})
DEFAULT_SEPARATORS = ("\n",)


def _write(path: Path, value) -> None:
    """Atomic replace, for derived artifacts a rerun is meant to overwrite (metrics, reports, config copies)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as target:
        temporary = Path(target.name)
        try:
            json.dump(value, target, ensure_ascii=False, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def _header(text) -> str:
    return " ".join(str(text or "").strip().casefold().replace("_", " ").split())


def _document_key(name: str) -> str:
    """A file's identity for matching: its stem, normalized. `Beier1988 GAC.pdf` and a run's `source_name` match."""
    return _header(Path(str(name).strip()).stem)


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(name).strip()) or "document"


def _cell_values(cell, separators: tuple[str, ...]) -> list:
    """What a golden cell claims: JSON array/dict, separator-split values, or one scalar. Blank cells claim nothing."""
    if cell is None or isinstance(cell, bool):
        return []
    if isinstance(cell, (int, float)):
        return [cell]
    text = str(cell).strip()
    if not text:
        return []
    if text[0] in "[{":
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        if parsed is not None:
            return list(parsed) if isinstance(parsed, list) else [parsed]
    for separator in separators:
        if separator and separator in text:
            return [part.strip() for part in text.split(separator) if part.strip()]
    return [text]


def load_gold(path: Path, *, sheet: str | None = None, file_column: str | None = None,
              separators: tuple[str, ...] = DEFAULT_SEPARATORS) -> dict:
    """Read the golden worksheet: `{document key: [ {field: [claimed values]} ]}`, plus the field list."""
    import openpyxl  # a developer dependency, kept out of the service runtime

    workbook = openpyxl.load_workbook(path, data_only=True, read_only=True)
    try:
        worksheet = workbook[sheet] if sheet else workbook.active
        rows = [list(row) for row in worksheet.iter_rows(values_only=True)]
    finally:
        workbook.close()
    if not rows:
        raise ValueError(f"golden sheet {path} has no rows")
    header = ["" if item is None else str(item).strip() for item in rows[0]]
    index = None
    if file_column is not None:
        wanted = _header(file_column)
        index = next((i for i, name in enumerate(header) if _header(name) == wanted), None)
        if index is None:
            raise ValueError(f"golden sheet has no column named {file_column!r}: {header}")
    if index is None:
        index = next((i for i, name in enumerate(header) if _header(name) in FILE_HEADERS), 0)
    fields = [name for i, name in enumerate(header) if i != index and name]
    if not fields:
        raise ValueError(f"golden sheet has no field columns beside the document column {header[index]!r}")
    documents: dict[str, list[dict]] = {}
    for number, row in enumerate(rows[1:], start=2):
        if not any(item is not None and str(item).strip() for item in row):
            continue
        name = row[index] if index < len(row) else None
        if name is None or not str(name).strip():
            raise ValueError(f"golden row {number} names no document")
        key = _document_key(str(name))
        documents.setdefault(key, []).append({
            field: _cell_values(row[i] if i < len(row) else None, separators) for i, field in enumerate(header)
            if i != index and field})
    return {"path": str(path.resolve()), "sha256": digest(path.read_bytes()), "sheet": sheet,
            "document_column": header[index] or "(first column)", "fields": fields, "documents": documents}


def compare_key(value, *, casefold: bool = True, numeric: bool = True):
    """The comparable form of one value: numbers as numbers, everything else NFKC/casefold/whitespace-normalized."""
    if isinstance(value, bool):
        return ("bool", value)
    if isinstance(value, (int, float)):
        return ("num", float(value))
    if isinstance(value, (dict, list)):
        return ("json", json.dumps(value, sort_keys=True, ensure_ascii=False))
    text = unicodedata.normalize("NFKC", str(value).strip())
    if casefold:
        text = text.casefold()
    text = " ".join(text.split())
    if numeric:
        try:
            return ("num", float(text))
        except ValueError:
            pass
    return ("text", text)


def artifact_fields(artifact: dict) -> tuple[dict[str, list], dict[str, list]]:
    """An artifact's populated leaves grouped by top-level field and by full dotted path."""
    top: dict[str, list] = defaultdict(list)
    dotted: dict[str, list] = defaultdict(list)
    for record in artifact.get("records", []) or []:
        for path, value in leaves(record):
            top[str(path[0])].append(value)
            dotted[".".join(str(step) for step in path)].append(value)
    return dict(top), dict(dotted)


def _counts(gold: list, predicted: list, options: dict) -> tuple[int, int, int, bool]:
    """TP/FP/FN over one cell's value multisets, and whether the cell matched exactly."""
    expected = Counter(compare_key(value, **options) for value in gold)
    actual = Counter(compare_key(value, **options) for value in predicted)
    true_positive = sum((expected & actual).values())
    return true_positive, sum((actual - expected).values()), sum((expected - actual).values()), expected == actual


def _ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _scores(tp: int, fp: int, fn: int) -> dict:
    precision, recall = _ratio(tp, tp + fp), _ratio(tp, tp + fn)
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else (0.0 if tp or fp or fn else None)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall, "f1": f1}


def score(gold: dict, predictions: dict[str, dict | None], *, phase: str, eval_id: str,
          options: dict | None = None) -> dict:
    """Field-level micro/macro precision, recall and F1 of `predictions` (by document key) against `gold`."""
    options = options or {}
    fields = list(gold["fields"])
    per_field: dict[str, dict] = {field: {"tp": 0, "fp": 0, "fn": 0, "tp_present": 0, "fp_present": 0,
                                          "fn_present": 0, "exact": 0, "cells": 0} for field in fields}
    per_document: dict[str, dict] = {}
    totals = {"tp": 0, "fp": 0, "fn": 0, "tp_present": 0, "fp_present": 0, "fn_present": 0, "exact": 0, "cells": 0}
    failed, missing = [], []
    scored = 0
    for key, rows in gold["documents"].items():
        artifact = predictions.get(key)
        if artifact is None:
            missing.append(key)
            predicted = {}
        else:
            top, dotted = artifact_fields(artifact)
            predicted = {field: (dotted.get(field) or top.get(field) or []) for field in fields}
            scored += 1
        document = {"tp": 0, "fp": 0, "fn": 0, "tp_present": 0, "fp_present": 0, "fn_present": 0,
                    "exact": 0, "cells": 0}
        for field in fields:
            expected = [value for row in rows for value in row.get(field, [])]
            actual = predicted.get(field, [])
            tp, fp, fn, exact = _counts(expected, actual, options)
            present = (bool(expected), bool(actual))
            tp_present = present[0] and present[1]
            fp_present = present[1] and not present[0]
            fn_present = present[0] and not present[1]
            document.update(tp=document["tp"] + tp, fp=document["fp"] + fp, fn=document["fn"] + fn,
                            tp_present=document["tp_present"] + tp_present, fp_present=document["fp_present"] + fp_present,
                            fn_present=document["fn_present"] + fn_present, exact=document["exact"] + int(exact),
                            cells=document["cells"] + 1)
            per_field[field].update(tp=per_field[field]["tp"] + tp, fp=per_field[field]["fp"] + fp,
                                    fn=per_field[field]["fn"] + fn, tp_present=per_field[field]["tp_present"] + tp_present,
                                    fp_present=per_field[field]["fp_present"] + fp_present,
                                    fn_present=per_field[field]["fn_present"] + fn_present,
                                    exact=per_field[field]["exact"] + int(exact),
                                    cells=per_field[field]["cells"] + 1)
        for name in totals:
            totals[name] += document[name]
        per_document[key] = {**_scores(document["tp"], document["fp"], document["fn"]),
                             "presence": _scores(document["tp_present"], document["fp_present"], document["fn_present"]),
                             "exact_cells": document["exact"], "cells": document["cells"]}
    macro = {}
    for metric in ("precision", "recall", "f1"):
        values = [value for field in fields
                  if (value := _scores(per_field[field]["tp"], per_field[field]["fp"],
                                       per_field[field]["fn"])[metric]) is not None]
        macro[metric] = sum(values) / len(values) if values else None
    per_field_out = {}
    for field in fields:
        item = per_field[field]
        per_field_out[field] = {**_scores(item["tp"], item["fp"], item["fn"]),
                                "presence": _scores(item["tp_present"], item["fp_present"], item["fn_present"]),
                                "exact_cells": item["exact"], "cells": item["cells"]}
    return {"eval": eval_id, "phase": phase, "generated_at": datetime.now(UTC).isoformat(),
            "gold": {"path": gold["path"], "sha256": gold["sha256"], "fields": fields},
            "documents": sorted(gold["documents"]), "documents_scored": scored,
            "documents_missing": missing, "documents_failed": failed,
            "comparison": options,
            "micro": _scores(totals["tp"], totals["fp"], totals["fn"]),
            "presence": _scores(totals["tp_present"], totals["fp_present"], totals["fn_present"]),
            "macro": macro,
            "exact_cells": {"matched": totals["exact"], "total": totals["cells"],
                            "accuracy": _ratio(totals["exact"], totals["cells"])},
            "per_field": per_field_out, "per_document": per_document}


def compare(baseline: dict, candidate: dict) -> dict:
    """How far `candidate` moved from `baseline`: overall and per-field deltas on precision, recall and F1."""
    def delta(metric: str, left: dict, right: dict) -> float | None:
        after, before = right.get(metric), left.get(metric)
        return after - before if after is not None and before is not None else None

    fields = sorted(set(baseline["per_field"]) | set(candidate["per_field"]))
    per_field = {}
    for field in fields:
        before = baseline["per_field"].get(field, {})
        after = candidate["per_field"].get(field, {})
        per_field[field] = {metric: delta(metric, before, after) for metric in ("precision", "recall", "f1")}
    overall = {metric: delta(metric, baseline["micro"], candidate["micro"]) for metric in ("precision", "recall", "f1")}
    conclusion = ("no F1 change" if overall["f1"] == 0 else
                  f"F1 {'improved' if (overall['f1'] or 0) > 0 else 'regressed'} by {abs(overall['f1'] or 0):.4f}")
    return {"baseline": {"eval": baseline.get("eval"), "phase": baseline.get("phase")},
            "candidate": {"eval": candidate.get("eval"), "phase": candidate.get("phase")},
            "delta": {"micro": overall, "presence": {metric: delta(metric, baseline["presence"], candidate["presence"])
                                                    for metric in ("precision", "recall", "f1")},
                      "macro": {metric: delta(metric, baseline["macro"], candidate["macro"])
                                for metric in ("precision", "recall", "f1")},
                      "exact_accuracy": delta("accuracy", baseline["exact_cells"], candidate["exact_cells"])},
            "per_field": per_field, "conclusion": conclusion}


def render(metrics: dict) -> str:
    """A human-readable report of one metrics artifact."""
    def percent(value) -> str:
        return "—" if value is None else f"{value:.3f}"

    lines = [f"# Iterative eval — {metrics['eval']} ({metrics['phase']})", "",
             f"- Documents: {metrics['documents_scored']} scored of {len(metrics['documents'])} golden rows"
             + (f"; missing predictions: {', '.join(metrics['documents_missing'])}" if metrics["documents_missing"] else ""),
             f"- Micro precision {percent(metrics['micro']['precision'])}  "
             f"recall {percent(metrics['micro']['recall'])}  F1 {percent(metrics['micro']['f1'])}",
             f"- Presence precision {percent(metrics['presence']['precision'])}  "
             f"recall {percent(metrics['presence']['recall'])}  F1 {percent(metrics['presence']['f1'])}",
             f"- Exact cells {metrics['exact_cells']['matched']}/{metrics['exact_cells']['total']} "
             f"({percent(metrics['exact_cells']['accuracy'])})", "",
             "| field | P | R | F1 | TP | FP | FN | exact | cells |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for field, item in metrics["per_field"].items():
        lines.append(f"| {field} | {percent(item['precision'])} | {percent(item['recall'])} | {percent(item['f1'])} "
                     f"| {item['tp']} | {item['fp']} | {item['fn']} | {item['exact_cells']}/{item['cells']} | {item['cells']} |")
    return "\n".join(lines) + "\n"


def render_comparison(report: dict) -> str:
    def signed(value) -> str:
        return "—" if value is None else f"{value:+.3f}"

    lines = [f"# Improvement: {report['baseline']['eval']} ({report['baseline']['phase']}) -> "
             f"{report['candidate']['eval']} ({report['candidate']['phase']})", "",
             f"**{report['conclusion']}**", "",
             f"- Overall micro precision {signed(report['delta']['micro']['precision'])}  "
             f"recall {signed(report['delta']['micro']['recall'])}  F1 {signed(report['delta']['micro']['f1'])}",
             f"- Exact-cell accuracy {signed(report['delta']['exact_accuracy'])}", "",
             "| field | ΔP | ΔR | ΔF1 |", "| --- | --- | --- | --- |"]
    for field, item in report["per_field"].items():
        lines.append(f"| {field} | {signed(item['precision'])} | {signed(item['recall'])} | {signed(item['f1'])} |")
    return "\n".join(lines) + "\n"


# --- running ----------------------------------------------------------------------------------------------------

def _role_providers(config: dict) -> dict[str, dict]:
    providers = config.get("providers") or {}
    missing = {"fields", "reasoning"} - set(providers)
    if missing:
        raise ValueError(f"providers must name every role; missing {sorted(missing)}")
    return providers


def _extract_document(run_dir: Path, request: ExtractRequest, providers: dict[str, dict], cell_dir: Path) -> dict:
    """One extraction through the service's entrypoint, with resumable call captures beside the cell."""
    clients = {role: OpenAIChat(url=provider["base_url"].rstrip("/") + "/v1/chat/completions",
                                model=provider["model"]) for role, provider in providers.items()}
    counters = {role: counter_for(chat) for role, chat in clients.items()}
    captures = {role: Capture(chat, cell_dir / "calls", role) for role, chat in clients.items()}
    return extract(run_dir, request, Router(**captures), counter=counters)


def _parse_pdf(pdf: Path, run_dir: Path, *, model: str, url: str | None) -> Path:
    """Convert a source PDF into a canonical run (native text needs no model server) with the service's stages."""
    from kei_exp import runs
    from kei_exp.kie.runner import convert
    from kei_exp.kie.stages.ocr import resolve
    from kei_exp.transcription.types import DEFAULT_URL, RunParams

    result_dir = run_dir / "result"
    run_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(pdf, run_dir / "input.pdf")
    params = RunParams(pdf=run_dir / "input.pdf", source_name=pdf.name, model=model, url=url or DEFAULT_URL,
                       cut="auto", result_dir=result_dir, page_source="pdf")
    convert(resolve(params))
    runs.write_json(run_dir / "params.json", {"source_name": pdf.name, "model": model, "url": url or DEFAULT_URL,
                                              "cut": "auto", "page_source": "pdf", "result_dir": str(result_dir)})
    return run_dir


def _runs_by_name(runs_root: Path) -> dict[str, Path]:
    found = {}
    if runs_root.is_dir():
        for directory in sorted(runs_root.iterdir()):
            params = directory / "params.json"
            if params.is_file():
                name = read(params).get("source_name") or directory.name
                found.setdefault(_document_key(name), directory)
    return found


def _resolve(root: Path, value) -> Path:
    """A configured path, absolute or relative to the configuration file's directory."""
    path = Path(value)
    return path if path.is_absolute() else (root / path).resolve()


def resolve_documents(config: dict, root: Path) -> list[dict]:
    """The source documents in configured order, each with a golden key, an optional PDF and an optional run."""
    entries: list[dict] = []
    for item in config.get("documents") or []:
        path = _resolve(root, item)
        if path.is_dir() and (path / "params.json").is_file():
            name = read(path / "params.json").get("source_name") or path.name
            entries.append({"key": _document_key(name), "pdf": None, "run": path})
        else:
            entries.append({"key": _document_key(path.name), "pdf": path, "run": None})
    if config.get("documents_dir"):
        directory = _resolve(root, config["documents_dir"])
        entries.extend({"key": _document_key(pdf.name), "pdf": pdf, "run": None} for pdf in sorted(directory.glob("*.pdf")))
    override = {}
    for name, directory in (config.get("runs") or {}).items():
        key = _document_key(name)
        found = _resolve(root, directory)
        if not (found / "params.json").is_file() and not (found / "result" / "result.json").is_file():
            raise ValueError(f"runs[{name!r}] is not a canonical run: {found}")
        override[key] = found
    for entry in entries:
        if entry["key"] in override:
            entry["run"] = override[entry["key"]]
    seen, ordered = set(), []
    for entry in entries:
        if entry["key"] in seen:
            raise ValueError(f"duplicate document {entry['key']!r}; give each source a distinct file name")
        seen.add(entry["key"])
        ordered.append(entry)
    if not ordered:
        raise ValueError("the configuration names no documents")
    return ordered


def _ensure_run(entry: dict, config: dict, runs_root: Path, existing: dict[str, Path]) -> Path:
    """The source's canonical run: the one it names, a matching one already under `runs_root`, or a fresh parse."""
    if entry["run"] is not None:
        return entry["run"]
    if entry["key"] in existing:
        return existing[entry["key"]]
    if entry["pdf"] is None or not entry["pdf"].is_file():
        raise ValueError(f"source {entry['key']!r} names no readable PDF or canonical run")
    parse = config.get("parse") or {}
    directory = runs_root / _slug(entry["key"])
    print(f"parse {entry['pdf']}", flush=True)
    return _parse_pdf(entry["pdf"], directory, model=parse.get("model", "granite_vision"), url=parse.get("url"))


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def run_eval(config: dict, root: Path, *, phase: str) -> tuple[dict, dict]:
    """Run the pilot and/or the full set, then score. Returns `(pilot metrics, full metrics)` as applicable."""
    if config.get("schema") is None:
        raise ValueError("the configuration names no schema")
    schema_path = _resolve(root, config["schema"])
    schema = _load_json(schema_path)
    request = ExtractRequest.model_validate({"schema": schema, "options": config.get("options") or {}})
    providers = _role_providers(config)
    output = _resolve(root, config["output"])
    runs_root = _resolve(root, config["runs_root"]) if config.get("runs_root") else output / "runs"
    metrics_options = {"casefold": True, "numeric": True, **(config.get("comparison") or {})}
    separators = tuple(config.get("cell_separators", DEFAULT_SEPARATORS))
    gold = load_gold(_resolve(root, config["golden"]), sheet=config.get("golden_sheet"),
                     file_column=config.get("golden_file_column"), separators=separators)

    entries = resolve_documents(config, root)
    unknown = [entry["key"] for entry in entries if entry["key"] not in gold["documents"]]
    if unknown:
        raise ValueError(f"documents absent from the golden sheet: {unknown}")
    order = list(entries)
    if config.get("shuffle"):
        random.Random(config.get("seed", 0)).shuffle(order)
    pilot_size = int(config.get("pilot", 5))
    if pilot_size < 1:
        raise ValueError("pilot must be a positive integer")
    pilot_entries, full_entries = order[:pilot_size], order

    (output / "config.json").parent.mkdir(parents=True, exist_ok=True)
    _write(output / "config.json", config)
    _write(output / "manifest.json", {"eval": config.get("id"), "generated_at": datetime.now(UTC).isoformat(),
                                      "gold": {key: gold[key] for key in ("path", "sha256", "sheet")},
                                      "schema": pin(schema_path),
                                      "order": [entry["key"] for entry in order],
                                      "pilot": [entry["key"] for entry in pilot_entries],
                                      "request": request.options.dumped()})
    existing = _runs_by_name(runs_root)
    results: dict[str, dict | None] = {}
    for index, entry in enumerate(order, 1):
        cell_dir = output / "cells" / _slug(entry["key"])
        completed = cell_dir / "result.json"
        if completed.is_file():
            results[entry["key"]] = read(completed)["artifact"]
            print(f"{index}/{len(order)} {entry['key']} reused", flush=True)
            continue
        run_dir = _ensure_run(entry, config, runs_root, existing)
        print(f"{index}/{len(order)} {entry['key']} extracting", flush=True)
        try:
            artifact = _extract_document(run_dir, request, providers, cell_dir)
        except Exception as error:  # noqa: BLE001 - one failed document must not lose the rest of the eval
            _write(cell_dir / "failure.json", {"error_type": type(error).__name__, "error": str(error),
                                               "at": datetime.now(UTC).isoformat()})
            results[entry["key"]] = None
            print(f"{index}/{len(order)} {entry['key']} FAILED: {error}", flush=True)
            continue
        _write(completed, {"artifact": artifact, "artifact_sha256": digest(json.dumps(artifact, sort_keys=True).encode()),
                           "at": datetime.now(UTC).isoformat()})
        results[entry["key"]] = artifact

    def score_subset(subset: list[dict], name: str) -> dict:
        keys = {entry["key"] for entry in subset}
        scored_gold = {"path": gold["path"], "sha256": gold["sha256"],
                       "fields": gold["fields"], "documents": {key: rows for key, rows in gold["documents"].items()
                                                               if key in keys}}
        metrics = score(scored_gold, {entry["key"]: results.get(entry["key"]) for entry in subset},
                        phase=name, eval_id=config.get("id", "eval"), options=metrics_options)
        failures = sorted(key for key in keys if results.get(key) is None)
        metrics["documents_failed"] = failures
        _write(output / f"metrics-{name}.json", metrics)
        (output / f"report-{name}.md").write_text(render(metrics), encoding="utf-8")
        print(f"{name}: F1 {metrics['micro']['f1']} over {metrics['documents_scored']}/{len(keys)} documents", flush=True)
        return metrics

    metrics = {}
    if phase in ("pilot", "full"):
        metrics["pilot"] = score_subset(pilot_entries, "pilot")
    if phase == "full":
        metrics["full"] = score_subset(full_entries, "full")
        baseline = config.get("baseline")
        if baseline:
            comparison = compare(read((root / baseline).resolve() if not Path(baseline).is_absolute()
                                      else Path(baseline)), metrics["full"])
            _write(output / "comparison.json", comparison)
            (output / "improvement.md").write_text(render_comparison(comparison), encoding="utf-8")
            print(comparison["conclusion"], flush=True)
    return metrics.get("pilot"), metrics.get("full")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subparsers = parser.add_subparsers(dest="command", required=True)
    gold_parser = subparsers.add_parser("gold", help="print the parsed golden sheet for inspection")
    gold_parser.add_argument("config", type=Path)
    run_parser = subparsers.add_parser("run", help="run the pilot and/or full extraction and score it")
    run_parser.add_argument("config", type=Path)
    run_parser.add_argument("--phase", choices=["pilot", "full"], default="full")
    report_parser = subparsers.add_parser("report", help="print the existing reports of one eval output")
    report_parser.add_argument("config", type=Path)
    compare_parser = subparsers.add_parser("compare", help="report how far a candidate metrics file moved")
    compare_parser.add_argument("baseline", type=Path)
    compare_parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    if args.command == "compare":
        print(render_comparison(compare(read(args.baseline), read(args.candidate))))
        return
    root = args.config.resolve().parent
    config = read(args.config)
    if args.command == "gold":
        separators = tuple(config.get("cell_separators", DEFAULT_SEPARATORS))
        gold = load_gold(_resolve(root, config["golden"]), sheet=config.get("golden_sheet"),
                         file_column=config.get("golden_file_column"),
                         separators=separators)
        print(json.dumps({"document_column": gold["document_column"], "fields": gold["fields"],
                          "documents": gold["documents"]}, ensure_ascii=False, indent=2))
        return
    if args.command == "report":
        output = _resolve(root, config["output"])
        for name in ("pilot", "full"):
            report = output / f"report-{name}.md"
            if report.is_file():
                print(report.read_text(encoding="utf-8"))
        improvement = output / "improvement.md"
        if improvement.is_file():
            print(improvement.read_text(encoding="utf-8"))
        return
    run_eval(config, root, phase=args.phase)


if __name__ == "__main__":
    main()
