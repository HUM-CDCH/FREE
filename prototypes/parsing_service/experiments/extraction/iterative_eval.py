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
    python -m experiments.extraction.iterative_eval pipeline CONFIG.json
    python -m experiments.extraction.iterative_eval report  CONFIG.json
    python -m experiments.extraction.iterative_eval compare BASELINE.json CANDIDATE.json

`run` scores a pilot of the first `pilot` documents, then continues to the whole set and scores that too. Both
phases reuse completed cells, so a full run never re-extracts a pilot document. `compare` is the improvement
step: it reports, field by field, how much a candidate's metrics moved from a baseline's. `pipeline` is the
fixed three-round developer loop: pilot-1 over two documents, pilot-2 over the same two with pilot-1's
shadow-review differences as patterns-only guidance, then a batch over every document with pilot-2's.

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

from kei_exp.kie.extract.llm import ModelOutputError, OpenAIChat, parse_json
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


def _comparison(options: dict) -> dict:
    """The `compare_key` options out of a metrics-options dict, which also
    carries `exhaustive` and `identity`."""
    return {name: options[name] for name in ("casefold", "numeric") if name in options}


def _counts(gold: list, predicted: list, options: dict) -> tuple[int, int, int, bool]:
    """TP/FP/FN over one cell's value multisets, and whether the cell matched exactly."""
    comparison = _comparison(options)
    expected = Counter(compare_key(value, **comparison) for value in gold)
    actual = Counter(compare_key(value, **comparison) for value in predicted)
    true_positive = sum((expected & actual).values())
    return true_positive, sum((actual - expected).values()), sum((expected - actual).values()), expected == actual


def _path_value(record: dict, field: str):
    """A dotted field's value in one record, or None when it is absent."""
    cursor = record
    for step in field.split("."):
        if not isinstance(cursor, dict) or step not in cursor:
            return None
        cursor = cursor[step]
    return cursor


def _record_key(record: dict, identity: list[str], options: dict) -> tuple | None:
    """A record's alignment key from its identity fields; None when any identity
    field is empty, so it is reported unmatched rather than matched loosely."""
    if not identity:
        return None
    comparison = _comparison(options)
    parts = []
    for field in identity:
        value = _path_value(record, field)
        if value is None or value == "" or value == []:
            return None
        items = value if isinstance(value, list) else [value]
        parts.append(tuple(str(compare_key(item, **comparison)) for item in items))
    return tuple(parts)


def align_records(gold_rows: list[dict], records: list[dict], identity: list[str], options: dict) -> dict:
    """Align predicted records to gold rows one-to-one and mutually by identity
    value. A key held by more than one row or record on either side aligns
    nothing, so ambiguous records are reported instead of guessed."""
    gold_by_key, predicted_by_key = defaultdict(list), defaultdict(list)
    for index, row in enumerate(gold_rows):
        key = _record_key(row, identity, options)
        if key is not None:
            gold_by_key[key].append(index)
    for index, record in enumerate(records):
        key = _record_key(record, identity, options)
        if key is not None:
            predicted_by_key[key].append(index)
    pairs, matched_gold, matched_predicted = [], set(), set()
    for key, gold_indexes in gold_by_key.items():
        predicted_indexes = predicted_by_key.get(key, [])
        if len(gold_indexes) == 1 and len(predicted_indexes) == 1:
            pairs.append((gold_indexes[0], predicted_indexes[0]))
            matched_gold.add(gold_indexes[0])
            matched_predicted.add(predicted_indexes[0])
    return {"pairs": [(gold_rows[gold], records[predicted]) for gold, predicted in pairs],
            "unmatched_gold_rows": [row for index, row in enumerate(gold_rows) if index not in matched_gold],
            "unmatched_predicted_records": [record for index, record in enumerate(records)
                                            if index not in matched_predicted]}


def _row_values(row: dict, fields: list[str]) -> dict[str, list]:
    return {field: list(row.get(field) or []) for field in fields}


# The default record-identity column: a Catalog document's gold rows and
# predicted records align on this field unless the configuration names another.
DEFAULT_IDENTITY = ("amino_acid_hydroxyproline_value",)


def _identity_fields(fields: list[str], options: dict) -> list[str]:
    configured = options.get("identity")
    if configured:
        return list(configured)
    if DEFAULT_IDENTITY[0] in fields:
        return list(DEFAULT_IDENTITY)
    return fields[:1]


def _record_values(record: dict, fields: list[str]) -> dict[str, list]:
    top, dotted = artifact_fields({"records": [record]})
    return {field: list(dotted.get(field) or top.get(field) or []) for field in fields}


def _comparison_units(rows: list[dict], records: list[dict], fields: list[str], options: dict) -> tuple[list[dict], dict]:
    """One (expected, actual) unit per document, or per aligned/unmatched record,
    with the record-alignment accounting. A single-record document keeps the
    original pooled comparison."""
    if len(records) <= 1 and len(rows) <= 1:
        top, dotted = artifact_fields({"records": records})
        units = [{"kind": "aligned",
                  "expected": {field: [value for row in rows for value in row.get(field, [])] for field in fields},
                  "actual": {field: list(dotted.get(field) or top.get(field) or []) for field in fields}}]
        return units, {"aligned": 1 if rows or records else 0, "unmatched_gold": 0, "unmatched_predicted": 0}
    identity = _identity_fields(fields, options)
    alignment = align_records(rows, records, list(identity), options)
    units = [{"kind": "aligned", "expected": _row_values(row, fields), "actual": _record_values(record, fields)}
             for row, record in alignment["pairs"]]
    units += [{"kind": "unmatched_gold", "expected": _row_values(row, fields),
               "actual": {field: [] for field in fields}} for row in alignment["unmatched_gold_rows"]]
    units += [{"kind": "unmatched_predicted", "expected": {field: [] for field in fields},
               "actual": _record_values(record, fields)} for record in alignment["unmatched_predicted_records"]]
    return units, {"aligned": len(alignment["pairs"]),
                   "unmatched_gold": len(alignment["unmatched_gold_rows"]),
                   "unmatched_predicted": len(alignment["unmatched_predicted_records"])}


def _ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _scores(tp: int, fp: int, fn: int, *, exhaustive: bool = True) -> dict:
    """Precision, recall and F1. Against a non-exhaustive gold sheet, a
    prediction with no gold counterpart is unscored, not a false positive, so
    precision and F1 are not computed and only recall is reported."""
    precision = _ratio(tp, tp + fp) if exhaustive else None
    recall = _ratio(tp, tp + fn)
    f1 = (2 * precision * recall / (precision + recall) if precision and recall
          else (0.0 if tp or fp or fn else None)) if exhaustive else None
    return {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall, "f1": f1,
            "precision_computed": exhaustive}


def score(gold: dict, predictions: dict[str, dict | None], *, phase: str, eval_id: str,
          options: dict | None = None) -> dict:
    """Field-level micro/macro precision, recall and F1 of `predictions` (by
    document key) against `gold`. Against an exhaustive gold (the default) a
    prediction with no gold counterpart is a false positive; against a
    non-exhaustive gold it is an unscored extra and precision/F1 are not
    computed."""
    options = options or {}
    exhaustive = bool(options.get("exhaustive", True))
    fields = list(gold["fields"])
    per_field: dict[str, dict] = {field: {"tp": 0, "fp": 0, "fn": 0, "extras": 0, "tp_present": 0,
                                          "fp_present": 0, "fn_present": 0, "exact": 0, "cells": 0}
                                  for field in fields}
    per_document: dict[str, dict] = {}
    totals = {"tp": 0, "fp": 0, "fn": 0, "extras": 0, "tp_present": 0, "fp_present": 0,
              "fn_present": 0, "exact": 0, "cells": 0}
    failed, missing = [], []
    record_alignment = {"aligned": 0, "unmatched_gold": 0, "unmatched_predicted": 0}
    scored = 0
    for key, rows in gold["documents"].items():
        artifact = predictions.get(key)
        if artifact is None:
            missing.append(key)
            records: list[dict] = []
        else:
            records = list(artifact.get("records") or [])
            scored += 1
        units, alignment = _comparison_units(rows, records, fields, options)
        for name, value in alignment.items():
            record_alignment[name] += value
        document = {"tp": 0, "fp": 0, "fn": 0, "extras": 0, "tp_present": 0, "fp_present": 0,
                    "fn_present": 0, "exact": 0, "cells": 0}
        for field in fields:
            tp = fp = fn = extras = 0
            exact = True
            any_expected = any_actual = False
            for unit in units:
                expected = unit["expected"].get(field, [])
                actual = unit["actual"].get(field, [])
                any_expected = any_expected or bool(expected)
                any_actual = any_actual or bool(actual)
                unit_tp, unit_fp, unit_fn, unit_exact = _counts(expected, actual, options)
                tp += unit_tp
                fn += unit_fn
                exact = exact and unit_exact
                if exhaustive:
                    fp += unit_fp
                else:
                    extras += unit_fp
            present = (any_expected, any_actual)
            tp_present = present[0] and present[1]
            fp_present = present[1] and not present[0]
            fn_present = present[0] and not present[1]
            document.update(tp=document["tp"] + tp, fp=document["fp"] + fp, fn=document["fn"] + fn,
                            extras=document["extras"] + extras,
                            tp_present=document["tp_present"] + tp_present, fp_present=document["fp_present"] + fp_present,
                            fn_present=document["fn_present"] + fn_present, exact=document["exact"] + int(exact),
                            cells=document["cells"] + 1)
            per_field[field].update(tp=per_field[field]["tp"] + tp, fp=per_field[field]["fp"] + fp,
                                    fn=per_field[field]["fn"] + fn, extras=per_field[field]["extras"] + extras,
                                    tp_present=per_field[field]["tp_present"] + tp_present,
                                    fp_present=per_field[field]["fp_present"] + fp_present,
                                    fn_present=per_field[field]["fn_present"] + fn_present,
                                    exact=per_field[field]["exact"] + int(exact),
                                    cells=per_field[field]["cells"] + 1)
        for name in totals:
            totals[name] += document[name]
        per_document[key] = {**_scores(document["tp"], document["fp"], document["fn"], exhaustive=exhaustive),
                             "unscored_extras": document["extras"],
                             "record_alignment": alignment,
                             "presence": _scores(document["tp_present"], document["fp_present"], document["fn_present"]),
                             "exact_cells": document["exact"], "cells": document["cells"]}
    macro = {}
    for metric in ("precision", "recall", "f1"):
        values = [value for field in fields
                  if (value := _scores(per_field[field]["tp"], per_field[field]["fp"],
                                       per_field[field]["fn"], exhaustive=exhaustive)[metric]) is not None]
        macro[metric] = sum(values) / len(values) if values else None
    per_field_out = {}
    for field in fields:
        item = per_field[field]
        per_field_out[field] = {**_scores(item["tp"], item["fp"], item["fn"], exhaustive=exhaustive),
                                "unscored_extras": item["extras"],
                                "presence": _scores(item["tp_present"], item["fp_present"], item["fn_present"]),
                                "exact_cells": item["exact"], "cells": item["cells"]}
    return {"eval": eval_id, "phase": phase, "generated_at": datetime.now(UTC).isoformat(),
            "gold": {"path": gold["path"], "sha256": gold["sha256"], "fields": fields},
            "documents": sorted(gold["documents"]), "documents_scored": scored,
            "documents_missing": missing, "documents_failed": failed,
            "comparison": options,
            "micro": _scores(totals["tp"], totals["fp"], totals["fn"], exhaustive=exhaustive),
            "presence": _scores(totals["tp_present"], totals["fp_present"], totals["fn_present"]),
            "macro": macro,
            "exact_cells": {"matched": totals["exact"], "total": totals["cells"],
                            "accuracy": _ratio(totals["exact"], totals["cells"])},
            "record_alignment": record_alignment,
            "unscored_extras": {"count": totals["extras"], "exhaustive": exhaustive,
                                "by_field": {field: per_field[field]["extras"] for field in fields}},
            "per_field": per_field_out, "per_document": per_document}


def anchor_coverage(predictions: dict[str, dict | None]) -> dict:
    """Evidence-anchor coverage: the share of populated, grounding-eligible
    record leaves that carry at least one locatable Evidence anchor. Coverage,
    never semantic correctness: a link does not prove the value is entailed."""
    populated = linked = eligible = eligible_linked = skipped = 0
    for artifact in predictions.values():
        if artifact is None:
            continue
        unverified = set(artifact.get("unverified") or [])
        schema = artifact.get("schema") or {}
        source_named = {node["name"] for node in schema.get("schemaNodes", [])
                        if node.get("valueSource") == "source-filename"}
        paths = {("records", index, *path)
                 for index, record in enumerate(artifact.get("records", []) or [])
                 for path, _ in leaves(record)
                 if path[0] not in unverified and path[0] not in source_named}
        grounded = {tuple(link["path"]) for link in artifact.get("evidence") or []}
        eligibility = artifact.get("grounding_eligibility")
        skipped_paths = {tuple(item["path"]) for item in eligibility["skipped"]} if eligibility else set()
        eligible_paths = paths - skipped_paths
        populated += len(paths)
        linked += len(paths & grounded)
        eligible += len(eligible_paths)
        eligible_linked += len(eligible_paths & grounded)
        skipped += len(skipped_paths)
    return {"populated_record_leaves": populated, "linked_record_leaves": linked,
            "link_rate": _ratio(linked, populated),
            "eligible_record_leaves": eligible, "linked_eligible_record_leaves": eligible_linked,
            "eligible_link_rate": _ratio(eligible_linked, eligible),
            "skipped_record_leaves": skipped,
            "interpretation": "Evidence-anchor coverage, not semantic correctness."}


def shadow_effort(gold: dict, predictions: dict[str, dict | None], keys) -> dict:
    """Shadow-reviewer effort: the value changes that would turn the round's
    saved values into gold, as `edited + rejected + added + deleted`. A whole
    field with no gold values is one rejection; otherwise an edit is one field
    decision and added/deleted count the values that must be supplied/removed.
    Nothing here writes review state."""
    counts = {"edited": 0, "rejected": 0, "added": 0, "deleted": 0}
    for key in keys:
        artifact = predictions.get(key)
        top, dotted = artifact_fields(artifact) if artifact else ({}, {})
        for field in gold["fields"]:
            expected = Counter(compare_key(value) for row in gold["documents"].get(key, [])
                               for value in row.get(field, []))
            actual = Counter(compare_key(value) for value in (dotted.get(field) or top.get(field) or []))
            if expected == actual:
                continue
            if not actual:
                counts["added"] += sum(expected.values())
                continue
            if not expected:
                counts["rejected"] += 1
                continue
            shared = sum((expected & actual).values())
            removed = sum((actual - expected).values())
            missing = sum((expected - actual).values())
            if shared and not missing:
                counts["deleted"] += removed
            elif shared and not removed:
                counts["added"] += missing
            else:
                counts["edited"] += 1
    return {**counts, "effort": sum(counts.values()),
            "interpretation": "Shadow review; no decision, correction or finalization is written."}


JUDGE_PROMPT_VERSION = 1
JUDGE_MAX_TOKENS = 1500
JUDGE_VALUE_CHARS = 4000

JUDGE_SYSTEM = (
    "You compare one extracted field against its gold answer. Return strict JSON only. Two values match when they "
    "are semantically equivalent: wording, word order, singular/plural, punctuation, casing and differently written "
    "units do not matter. A gold value with no extracted counterpart is missing. An extracted value with no gold "
    "counterpart is extra. Judge only the values given; never invent one. When equivalence is unclear, mark it "
    "uncertain instead of matching it."
)

JUDGE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "extracted": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "value": {"type": "string"},
                    "verdict": {"type": "string", "enum": ["match", "extra", "uncertain"]},
                    "gold_value": {"type": ["string", "null"]},
                },
                "required": ["value", "verdict"],
            },
        },
        "missing_gold": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["extracted", "missing_gold"],
}


def judge_prompt(field: str, gold_values: list, predicted_values: list) -> tuple[str, str]:
    """The exact prompt one (document, field) pair is judged with. Values are
    bounded so one very long cell cannot blow the judge's context."""
    render = lambda values: json.dumps(values, ensure_ascii=False)[:JUDGE_VALUE_CHARS]
    return JUDGE_SYSTEM, (f"Field: {field}\nGold values: {render(gold_values)}\n"
                          f"Extracted values: {render(predicted_values)}")


def judge_pair(capture, field: str, gold_values: list, predicted_values: list) -> dict | None:
    """One pair's verdict as `{tp, fp, fn, uncertain, verdict}`, or None when the
    judge failed (a refusal, a cut-off reply or unreadable JSON). A failed pair
    stays unjudged rather than being counted as wrong."""
    system, user = judge_prompt(field, gold_values, predicted_values)
    try:
        reply = capture.complete(system=system, user=user, schema=JUDGE_SCHEMA, max_tokens=JUDGE_MAX_TOKENS)
    except Exception:  # noqa: BLE001 - an unreachable or refusing judge leaves the pair unjudged
        return None
    if reply.finish == "length":
        return None
    try:
        verdict = parse_json(reply.text)
    except ModelOutputError:
        return None
    if not isinstance(verdict, dict) or not isinstance(verdict.get("extracted"), list) \
            or not isinstance(verdict.get("missing_gold"), list):
        return None
    items = [item for item in verdict["extracted"] if isinstance(item, dict)]
    return {"tp": sum(1 for item in items if item.get("verdict") == "match"),
            "fp": sum(1 for item in items if item.get("verdict") == "extra"),
            "uncertain": sum(1 for item in items if item.get("verdict") == "uncertain"),
            "fn": len(verdict["missing_gold"]), "verdict": verdict}


def judge_round(gold: dict, predictions: dict[str, dict | None], keys, capture, options: dict, *,
                model: str) -> dict:
    """The semantic layer: strict matches count as true positives, and only the
    pairs strict matching could not confirm go to the reasoning model's judge."""
    fields = list(gold["fields"])
    per_field = {field: {"tp": 0, "fp": 0, "fn": 0, "judged": 0, "unjudged": 0} for field in fields}
    totals = {"tp": 0, "fp": 0, "fn": 0, "judged": 0, "unjudged": 0, "uncertain": 0}
    verdicts = []
    for key in sorted(keys):
        artifact = predictions.get(key)
        top, dotted = artifact_fields(artifact) if artifact else ({}, {})
        for field in fields:
            expected = [value for row in gold["documents"].get(key, []) for value in row.get(field, [])]
            actual = list(dotted.get(field) or top.get(field) or [])
            tp, fp, fn, exact = _counts(expected, actual, options)
            verdict = None
            if exact:
                counts = {"tp": tp, "fp": 0, "fn": 0, "uncertain": 0}
            else:
                result = judge_pair(capture, field, expected, actual)
                if result is None:
                    totals["unjudged"] += 1
                    per_field[field]["unjudged"] += 1
                    verdicts.append({"document": key, "field": field, "gold": expected, "predicted": actual,
                                     "status": "unjudged"})
                    continue
                verdict = result["verdict"]
                counts = {name: result[name] for name in ("tp", "fp", "fn", "uncertain")}
            for name in ("tp", "fp", "fn"):
                totals[name] += counts[name]
                per_field[field][name] += counts[name]
            totals["judged"] += 1
            totals["uncertain"] += counts["uncertain"]
            per_field[field]["judged"] += 1
            verdicts.append({"document": key, "field": field, "gold": expected, "predicted": actual,
                             "status": "judged", **counts, "verdict": verdict})
    return {"prompt_version": JUDGE_PROMPT_VERSION, "model": model,
            "micro": _scores(totals["tp"], totals["fp"], totals["fn"]),
            "judged": totals["judged"], "unjudged": totals["unjudged"], "uncertain": totals["uncertain"],
            "per_field": {field: {**_scores(item["tp"], item["fp"], item["fn"]),
                                  "judged": item["judged"], "unjudged": item["unjudged"]}
                          for field, item in per_field.items()},
            "verdicts": verdicts}


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
             f"({percent(metrics['exact_cells']['accuracy'])})"]
    coverage = metrics.get("anchor_coverage")
    if coverage:
        lines.append(f"- Evidence-anchor coverage {percent(coverage['eligible_link_rate'])} "
                     f"({coverage['linked_eligible_record_leaves']}/{coverage['eligible_record_leaves']} eligible; "
                     f"raw {percent(coverage['link_rate'])})")
    effort = metrics.get("reviewer_effort")
    if effort:
        lines.append(f"- Shadow reviewer effort {effort['effort']} (edited {effort['edited']}, "
                     f"rejected {effort['rejected']}, added {effort['added']}, deleted {effort['deleted']})")
    judge = metrics.get("judge")
    if judge and judge.get("micro"):
        lines.append(f"- Judge (semantic) precision {percent(judge['micro']['precision'])} "
                     f"recall {percent(judge['micro']['recall'])} F1 {percent(judge['micro']['f1'])} over "
                     f"{judge['judged']} judged pair(s); {judge['unjudged']} unjudged")
    extras = metrics.get("unscored_extras")
    if extras and not extras["exhaustive"]:
        by_field = ", ".join(f"{field} {count}" for field, count in extras["by_field"].items() if count)
        lines.append(f"- Non-exhaustive gold: {extras['count']} unscored extra prediction(s); precision/F1 not "
                     f"computed" + (f" ({by_field})" if by_field else ""))
    lines += ["", "| field | P | R | F1 | TP | FP | FN | exact | cells |",
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
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


def metrics_row(label: str, status: dict, metrics: dict | None, *, gold_sha256: str | None) -> dict:
    """One round's flat metrics row: the table's unit is one round, not a field."""
    micro = (metrics or {}).get("micro") or {}
    presence = (metrics or {}).get("presence") or {}
    exact = (metrics or {}).get("exact_cells") or {}
    coverage = (metrics or {}).get("anchor_coverage") or {}
    effort = (metrics or {}).get("reviewer_effort") or {}
    judge = (metrics or {}).get("judge") or {}
    judge_micro = judge.get("micro") or {}
    return {
        "Round": label,
        "Status": status.get("status"),
        "Documents": len(status.get("documents") or []),
        "Scored": (metrics or {}).get("documents_scored"),
        "Failed": len((metrics or {}).get("documents_failed") or []),
        "Precision": micro.get("precision"),
        "Recall": micro.get("recall"),
        "F1": micro.get("f1"),
        "Presence precision": presence.get("precision"),
        "Presence recall": presence.get("recall"),
        "Presence F1": presence.get("f1"),
        "Exact accuracy": exact.get("accuracy"),
        "Anchor coverage": coverage.get("eligible_link_rate"),
        "Anchor coverage (raw)": coverage.get("link_rate"),
        "Effort": effort.get("effort"),
        "Edited": effort.get("edited"),
        "Rejected": effort.get("rejected"),
        "Added": effort.get("added"),
        "Deleted": effort.get("deleted"),
        "Judge precision": judge_micro.get("precision"),
        "Judge recall": judge_micro.get("recall"),
        "Judge F1": judge_micro.get("f1"),
        "Judged": judge.get("judged"),
        "Unjudged": judge.get("unjudged"),
        "Gold sha256": gold_sha256,
        "Guidance sha256": status.get("guidance_sha256"),
        "Error": status.get("error"),
    }


def write_metrics_table(output: Path, rows: list[dict]) -> None:
    """The per-round metrics table a developer reads: one row per round, written
    as both `metrics.csv` and `metrics.xlsx`."""
    import csv

    if not rows:
        return
    output.mkdir(parents=True, exist_ok=True)
    with (output / "metrics.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    import openpyxl  # a developer dependency, kept out of the service runtime

    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Rounds"
    sheet.append(list(rows[0]))
    for row in rows:
        sheet.append(list(row.values()))
    workbook.save(output / "metrics.xlsx")


# --- running ----------------------------------------------------------------------------------------------------

def _role_providers(config: dict) -> dict[str, dict]:
    providers = config.get("providers") or {}
    missing = {"fields", "reasoning"} - set(providers)
    if missing:
        raise ValueError(f"providers must name every role; missing {sorted(missing)}")
    return providers


# The version 1 Catalog path recovers from a whitespace loop by re-sending the
# schema as a grammar bounding whitespace between JSON tokens (catalog.py's
# MAX_WHITESPACE). Article has no such recovery, so the harness sends the fields
# role through the same bounded grammar by default: the loop becomes a served
# reply instead of an unanswered root. Set `max_whitespace: 0` to disable it.
DEFAULT_MAX_WHITESPACE = 16


def provider_client_kwargs(role: str, max_whitespace) -> dict:
    """The bounded grammar applies to the fields role only: its values calls are
    the ones a whitespace loop can leave unanswered."""
    return {"max_whitespace": max_whitespace} if role == "fields" and max_whitespace else {}


class GuidanceChat:
    """The evaluation harness's own guidance seam: it appends a patterns-only
    correction block to the system prompt of its field-role value calls. The
    product never constructs it, so no durable admission can send this input."""

    def __init__(self, chat, guidance: str):
        self.chat, self.guidance, self.model = chat, guidance, chat.model

    def complete(self, **request):
        if self.guidance:
            request = {**request, "system": (request.get("system") or "") + self.guidance}
        return self.chat.complete(**request)

    def __getattr__(self, name):
        return getattr(self.chat, name)


class GuidanceCounter:
    """The token counter of a guided chat: it counts the same block the chat
    appends, so admission sees the prompt that is actually sent (an uncounted
    block can push a request past the served context and get a bare 400)."""

    def __init__(self, counter, guidance: str):
        self.counter, self.guidance = counter, guidance

    def request_tokens(self, system, user, schema=None):
        return self.counter.request_tokens((system or "") + self.guidance, user, schema)

    def __getattr__(self, name):
        return getattr(self.counter, name)


def _extract_document(run_dir: Path, request: ExtractRequest, providers: dict[str, dict], cell_dir: Path,
                      *, guidance: str = "", max_whitespace=DEFAULT_MAX_WHITESPACE) -> dict:
    """One extraction through the service's entrypoint, with resumable call captures beside the cell."""
    clients = {role: OpenAIChat(url=provider["base_url"].rstrip("/") + "/v1/chat/completions",
                                model=provider["model"], **provider_client_kwargs(role, max_whitespace))
               for role, provider in providers.items()}
    counters = {role: counter_for(chat) for role, chat in clients.items()}
    captures = {role: Capture(chat, cell_dir / "calls", role) for role, chat in clients.items()}
    if guidance:
        counters["fields"] = GuidanceCounter(counters["fields"], guidance)
        captures["fields"] = GuidanceChat(captures["fields"], guidance)
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
    metrics_options = {"casefold": True, "numeric": True, "exhaustive": bool(config.get("exhaustive", True)),
                       "identity": config.get("identity"), **(config.get("comparison") or {})}
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


GUIDANCE_HEADER = (
    "\nResearcher correction examples (patterns only). Extract facts and Evidence solely from the target source; "
    "these examples never supply target facts or anchors.\n"
)


def guidance_examples(gold: dict, predictions: dict[str, dict | None], keys) -> list[dict]:
    """Patterns-only examples for the next round: each field whose extracted
    values differ from gold, with the values the next round should reach. Fields
    that already match, and fields neither side claims, produce nothing."""
    examples, seen = [], set()
    for key in keys:
        artifact = predictions.get(key)
        if artifact is None:
            continue
        top, dotted = artifact_fields(artifact)
        for field in gold["fields"]:
            expected = [value for row in gold["documents"].get(key, []) for value in row.get(field, [])]
            actual = dotted.get(field) or top.get(field) or []
            if not expected and not actual:
                continue
            if Counter(compare_key(value) for value in expected) == Counter(compare_key(value) for value in actual):
                continue
            example = {"field": field, "expected": expected[0] if len(expected) == 1 else expected}
            marker = json.dumps(example, sort_keys=True, ensure_ascii=False)
            if marker not in seen:
                seen.add(marker)
                examples.append(example)
    return examples


DEFAULT_GUIDANCE_CHARS = 8000


def capped_examples(examples: list[dict], *, max_chars: int = DEFAULT_GUIDANCE_CHARS) -> list[dict]:
    """The leading examples that fit the guidance budget: many or long gold
    values must not push the prompt past the context the model serves."""
    kept: list[dict] = []
    for example in examples:
        candidate = [*kept, example]
        if kept and len(GUIDANCE_HEADER + json.dumps(candidate, ensure_ascii=False, sort_keys=True)) > max_chars:
            break
        kept = candidate
    return kept


def guidance_text(examples: list[dict], *, max_chars: int = DEFAULT_GUIDANCE_CHARS) -> str:
    """The block appended to field-role prompts; empty when nothing changed."""
    kept = capped_examples(examples, max_chars=max_chars)
    return GUIDANCE_HEADER + json.dumps(kept, ensure_ascii=False, sort_keys=True) if kept else ""


PIPELINE_ROUNDS = ("PILOT_1", "PILOT_2", "BATCH")


def configured_pilot_entries(config: dict, entries: list[dict]) -> list[dict]:
    """The fixed two-document pilot: a configured pair, else the first two
    documents in upload order."""
    pair = config.get("pilot_documents")
    if not pair:
        if len(entries) < 2:
            raise ValueError("the pipeline needs at least two documents for its pilot")
        return entries[:2]
    if len(pair) != 2:
        raise ValueError("pilot_documents must name exactly two documents")
    by_key = {entry["key"]: entry for entry in entries}
    keys = [_document_key(str(name)) for name in pair]
    missing = [key for key in keys if key not in by_key]
    if missing:
        raise ValueError(f"pilot_documents names documents absent from the configuration: {missing}")
    return [by_key[key] for key in keys]


def _extract_round(label: str, entries: list[dict], config: dict, request: ExtractRequest,
                   providers: dict[str, dict], runs_root: Path, output: Path,
                   existing: dict[str, Path], guidance: str,
                   max_whitespace=DEFAULT_MAX_WHITESPACE) -> dict[str, dict | None]:
    """One round's documents, with resumable cells under rounds/<label>/cells."""
    results: dict[str, dict | None] = {}
    for index, entry in enumerate(entries, 1):
        cell_dir = output / "rounds" / label.lower() / "cells" / _slug(entry["key"])
        completed = cell_dir / "result.json"
        if completed.is_file():
            results[entry["key"]] = read(completed)["artifact"]
            print(f"{label} {index}/{len(entries)} {entry['key']} reused", flush=True)
            continue
        run_dir = _ensure_run(entry, config, runs_root, existing)
        print(f"{label} {index}/{len(entries)} {entry['key']} extracting", flush=True)
        try:
            artifact = _extract_document(run_dir, request, providers, cell_dir, guidance=guidance,
                                         max_whitespace=max_whitespace)
        except Exception as error:  # noqa: BLE001 - one failed document must not lose the rest of the round
            _write(cell_dir / "failure.json", {"error_type": type(error).__name__, "error": str(error),
                                               "at": datetime.now(UTC).isoformat()})
            results[entry["key"]] = None
            print(f"{label} {index}/{len(entries)} {entry['key']} FAILED: {error}", flush=True)
            continue
        _write(completed, {"artifact": artifact,
                           "artifact_sha256": digest(json.dumps(artifact, sort_keys=True).encode()),
                           "at": datetime.now(UTC).isoformat()})
        results[entry["key"]] = artifact
    return results


def run_pipeline(config: dict, root: Path) -> dict:
    """The fixed three-round developer pipeline: pilot-1 over two documents,
    pilot-2 over the same two with pilot-1's shadow-review differences as
    guidance, then a batch over every document with pilot-2's."""
    if config.get("schema") is None:
        raise ValueError("the configuration names no schema")
    schema_path = _resolve(root, config["schema"])
    schema = _load_json(schema_path)
    request = ExtractRequest.model_validate({"schema": schema, "options": config.get("options") or {}})
    providers = _role_providers(config)
    output = _resolve(root, config["output"])
    runs_root = _resolve(root, config["runs_root"]) if config.get("runs_root") else output / "runs"
    metrics_options = {"casefold": True, "numeric": True, "exhaustive": bool(config.get("exhaustive", True)),
                       "identity": config.get("identity"), **(config.get("comparison") or {})}
    separators = tuple(config.get("cell_separators", DEFAULT_SEPARATORS))
    gold = load_gold(_resolve(root, config["golden"]), sheet=config.get("golden_sheet"),
                     file_column=config.get("golden_file_column"), separators=separators)
    entries = resolve_documents(config, root)
    unknown = [entry["key"] for entry in entries if entry["key"] not in gold["documents"]]
    if unknown:
        raise ValueError(f"documents absent from the golden sheet: {unknown}")
    pilot_entries = configured_pilot_entries(config, entries)
    pilot_keys = [entry["key"] for entry in pilot_entries]

    output.mkdir(parents=True, exist_ok=True)
    _write(output / "config.json", config)
    existing = _runs_by_name(runs_root)
    rounds: list[dict] = []
    table_rows: list[dict] = []
    predictions: dict[str, dict | None] = {}
    guidance = ""
    max_whitespace = config.get("max_whitespace", DEFAULT_MAX_WHITESPACE)
    judge_config = config.get("judge") or {}
    for label, subset in (("PILOT_1", pilot_entries), ("PILOT_2", pilot_entries), ("BATCH", entries)):
        keys = {entry["key"] for entry in subset}
        try:
            if label != "PILOT_1":
                examples = capped_examples(guidance_examples(gold, predictions, pilot_keys))
                guidance = guidance_text(examples)
                _write(output / "rounds" / label.lower() / "guidance.json", examples)
                print(f"{label}: {len(examples)} guidance example(s)", flush=True)
            results = _extract_round(label, subset, config, request, providers, runs_root, output, existing, guidance,
                                     max_whitespace=max_whitespace)
            scored_gold = {"path": gold["path"], "sha256": gold["sha256"], "fields": gold["fields"],
                           "documents": {key: rows for key, rows in gold["documents"].items() if key in keys}}
            metrics = score(scored_gold, results, phase=label, eval_id=config.get("id", "eval"),
                            options=metrics_options)
            metrics["documents_failed"] = sorted(key for key in keys if results.get(key) is None)
            metrics["anchor_coverage"] = anchor_coverage(results)
            metrics["reviewer_effort"] = shadow_effort(gold, results, keys)
            if judge_config.get("enabled"):
                try:
                    provider = providers["reasoning"]
                    judge_chat = OpenAIChat(url=provider["base_url"].rstrip("/") + "/v1/chat/completions",
                                            model=provider["model"], max_whitespace=DEFAULT_MAX_WHITESPACE)
                    judge_capture = Capture(judge_chat,
                                            output / "rounds" / label.lower() / "judge" / "calls", "judge")
                    judged = judge_round(gold, results, keys, judge_capture, metrics_options,
                                         model=provider["model"])
                    verdicts = judged.pop("verdicts", [])
                    metrics["judge"] = judged
                    _write(output / "rounds" / label.lower() / "judge" / "verdicts.json", verdicts)
                    print(f"{label}: judged {judged['judged']} pair(s), {judged['unjudged']} unjudged", flush=True)
                except Exception as error:  # noqa: BLE001 - a judge failure must not fail the round
                    metrics["judge"] = {"error_type": type(error).__name__, "error": str(error)}
            _write(output / "rounds" / label.lower() / "metrics.json", metrics)
            (output / "rounds" / label.lower() / "report.md").write_text(render(metrics), encoding="utf-8")
            status = {"label": label, "status": "SUCCEEDED" if not metrics["documents_failed"] else "FAILED",
                      "documents": [entry["key"] for entry in subset],
                      "guidance_sha256": digest(guidance.encode()),
                      "metrics": f"rounds/{label.lower()}/metrics.json",
                      "failed": metrics["documents_failed"]}
            table_rows.append(metrics_row(label, status, metrics, gold_sha256=gold["sha256"]))
            predictions = results
            print(f"{label}: F1 {metrics['micro']['f1']} over {metrics['documents_scored']}/{len(keys)} documents",
                  flush=True)
        except Exception as error:  # noqa: BLE001 - a failed round is recorded, not lost
            status = {"label": label, "status": "FAILED", "documents": [entry["key"] for entry in subset],
                      "guidance_sha256": digest(guidance.encode()),
                      "error_type": type(error).__name__, "error": str(error)}
            table_rows.append(metrics_row(label, status, None, gold_sha256=gold["sha256"]))
            _write(output / "rounds" / label.lower() / "status.json", status)
            print(f"{label} FAILED: {error}", flush=True)
        else:
            _write(output / "rounds" / label.lower() / "status.json", status)
        rounds.append(status)

    manifest = {
        "eval": config.get("id"), "mode": "pipeline", "generated_at": datetime.now(UTC).isoformat(),
        "gold": {key: gold[key] for key in ("path", "sha256", "sheet")}, "schema": pin(schema_path),
        "documents": [entry["key"] for entry in entries], "pilot_documents": pilot_keys,
        "request": request.options.dumped(), "rounds": rounds}
    write_metrics_table(output, table_rows)
    _write(output / "manifest.json", manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subparsers = parser.add_subparsers(dest="command", required=True)
    gold_parser = subparsers.add_parser("gold", help="print the parsed golden sheet for inspection")
    gold_parser.add_argument("config", type=Path)
    run_parser = subparsers.add_parser("run", help="run the pilot and/or full extraction and score it")
    run_parser.add_argument("config", type=Path)
    run_parser.add_argument("--phase", choices=["pilot", "full"], default="full")
    pipeline_parser = subparsers.add_parser("pipeline", help="run the fixed pilot-1 -> pilot-2 -> batch pipeline")
    pipeline_parser.add_argument("config", type=Path)
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
        for round_report in sorted((output / "rounds").glob("*/report.md")):
            print(round_report.read_text(encoding="utf-8"))
        return
    if args.command == "pipeline":
        run_pipeline(config, root)
        return
    run_eval(config, root, phase=args.phase)


if __name__ == "__main__":
    main()
