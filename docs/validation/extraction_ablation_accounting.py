"""Report observations that a projected score can hide, without changing extraction or its scorer.

Usage: python docs/validation/extraction_ablation_accounting.py STUDY_DIR ANALYSIS_JSON OUTPUT_JSON
This is supplementary descriptive accounting, not a new accuracy metric or new gold labels.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


def array_items(value, path=()):
    """Every array item, including nested collections, with its exact artifact path."""
    if isinstance(value, dict):
        for name, child in value.items():
            yield from array_items(child, (*path, name))
    elif isinstance(value, list):
        for number, child in enumerate(value):
            item_path = (*path, number)
            yield item_path, child
            yield from array_items(child, item_path)


def prefix(parent, child):
    return tuple(child[:len(parent)]) == tuple(parent)


def observations(artifact: dict, scored_fields: list[dict] | None) -> dict:
    selected = [field["prediction_path"] for field in scored_fields or [] if field.get("prediction_path")]
    items = []
    collections = {}
    for number, record in enumerate(artifact["records"]):
        for path, value in array_items(record, ("records", number)):
            container = path[:-1]
            bucket = collections.setdefault(container, [])
            serialized = json.dumps(value, sort_keys=True, ensure_ascii=False)
            duplicate = serialized in bucket
            bucket.append(serialized)
            used = any(prefix(path, field_path) for field_path in selected)
            status = ("unannotated" if scored_fields is None else
                      "used_by_gold_projection" if used else "not_selected_by_gold_projection")
            items.append({"path": list(path), "value": value, "projection_status": status,
                          "exact_duplicate_within_collection": duplicate,
                          "evidence": [link for link in artifact.get("evidence", []) if prefix(path, link["path"])],
                          "quoted_support": [proof for proof in artifact.get("quoted_support", [])
                                             if prefix(path, proof["path"])]})
    raw_items = [{"record": candidate["record"], "window": candidate["window"], "path": list(path), "value": value}
                 for candidate in artifact.get("raw_candidates", [])
                 for path, value in array_items(candidate["fields"])]
    return {"array_items": len(items),
            "by_projection_status": dict(Counter(item["projection_status"] for item in items)),
            "exact_duplicate_items": sum(item["exact_duplicate_within_collection"] for item in items),
            "by_collection": [{"path": list(path), "items": len(values), "exact_duplicates": len(values) - len(set(values))}
                              for path, values in collections.items()],
            "items": items, "raw_catalog_array_items": raw_items,
            "gold_empty_contradictions": [field for field in scored_fields or []
                                          if field["expected_empty"] and field["result"] == "incorrect"],
            "limits": "Not selected by projection is unscored, not false. Duplicate counts use exact JSON within a collection, not semantic equivalence. Evidence links do not establish entailment."}


def grounding_comparability(artifacts: dict[str, dict], sources: list[dict], comparisons: list[dict]) -> list[dict]:
    """Grounding cannot cause an upstream raw-value change; make regenerated-input differences visible."""
    rows = []
    for comparison in comparisons:
        if comparison["factor"] != "article.grounding":
            continue
        for source in sources:
            left = f"{source['id']}--{comparison['control']}--0"
            right = f"{source['id']}--{comparison['treatment']}--0"
            if left not in artifacts or right not in artifacts:
                continue
            a, b = artifacts[left], artifacts[right]
            equal = a["records"] == b["records"] and a.get("inventory") == b.get("inventory")
            rows.append({"source": source["id"], "control": left, "treatment": right,
                         "identical_upstream_records_and_inventory": equal,
                         "interpretation": "Grounding comparison has fixed upstream content" if equal else
                         "Regenerated upstream content differs; raw-value changes are not caused by grounding"})
    return rows


def stage_costs(artifact: dict, execution: dict) -> dict:
    """Account for failed calls too; unknown provider usage must not become reported zero usage."""
    stages = {}
    for call in artifact["calls"]:
        row = stages.setdefault(call["stage"], {"calls": 0, "failed_calls": 0,
            "input_tokens_reported": 0, "output_tokens_reported": 0,
            "input_tokens_unknown_calls": 0, "output_tokens_unknown_calls": 0,
            "recorded_call_seconds": 0.0})
        row["calls"] += 1
        row["failed_calls"] += not call["ok"]
        row["recorded_call_seconds"] += call["seconds"]
        for kind in ("input", "output"):
            tokens = call[f"{kind}_tokens"]
            if tokens is None:
                row[f"{kind}_tokens_unknown_calls"] += 1
            else:
                row[f"{kind}_tokens_reported"] += tokens
    return {"stages": stages,
            "fresh_calls": execution.get("fresh_calls"), "reused_calls": execution.get("reused_calls"),
            "wall_seconds_this_attempt": execution.get("wall_seconds_this_attempt"),
            "timing_scope": "Recorded request durations include failures and shared serving contention. Reused replies retain historical durations; these sums are not fresh replay latency or end-to-end wall time."}


def evidence_localization(artifact: dict, scored_fields: list[dict] | None) -> dict:
    """Summarize the frozen scorer's coarse gold-page labels without upgrading them to entailment."""
    if scored_fields is None:
        return {"status": "unannotated"}
    document = {node["name"] for node in artifact["schema"]["schemaNodes"]
                if node.get("valueSource", "record") != "record"}
    fields = [field for field in scored_fields if not field["expected_empty"] and field["field"] not in document]
    return {"status": "development_gold_pages", "reported_record_fields": len(fields),
            "by_evidence_status": dict(Counter(field["evidence"]["status"] for field in fields)),
            "by_value_result": {result: dict(Counter(field["evidence"]["status"] for field in fields
                                                    if field["result"] == result))
                                for result in sorted({field["result"] for field in fields})},
            "limits": "Same-page candidate evidence can support a different subject or value. This is coarse localization from the frozen scorer, not independent semantic entailment or exhaustive evidence recall. Document fields are excluded because Article does not verify them."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("study", type=Path)
    parser.add_argument("analysis", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    read = lambda path: json.loads(path.read_text())
    manifest = read(args.study / "manifest.json")
    report = read(args.analysis)
    if report["study"] != manifest["id"]:
        raise ValueError("analysis belongs to another study")
    artifacts, counts, costs, localization = {}, {}, {}, {}
    manifest_hash = hashlib.sha256((args.study / "manifest.json").read_bytes()).hexdigest()
    for entry in report["cells"]:
        path = args.study / "cells" / entry["id"] / "result.json"
        if read(path.parent / "pin.json")["manifest_sha256"] != manifest_hash:
            raise ValueError("mixed cell manifest")
        completed = read(path)
        artifact = completed["artifact"]
        if hashlib.sha256(json.dumps(artifact, sort_keys=True).encode()).hexdigest() != completed["execution"]["artifact_sha256"]:
            raise ValueError("changed completed artifact")
        if completed["execution"]["artifact_sha256"] != entry["attempts"][-1]["artifact_sha256"]:
            raise ValueError("analysis and completed artifact disagree")
        cell = path.parent.name
        artifacts[cell] = artifact
        fields = report["accuracy"].get(cell, {}).get("fields")
        counts[cell] = observations(artifact, fields)
        costs[cell] = stage_costs(artifact, completed["execution"])
        localization[cell] = evidence_localization(artifact, fields)
    output = {"study": manifest["id"], "kind": "supplementary descriptive accounting; no extraction or scoring changes",
              "accounting_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "analysis_sha256": hashlib.sha256(args.analysis.read_bytes()).hexdigest(), "cells": counts,
              "stage_costs": costs,
              "evidence_localization": localization,
              "grounding_comparability": grounding_comparability(artifacts, manifest["sources"], manifest["comparisons"])}
    with args.output.open("x") as target:
        json.dump(output, target, indent=2, ensure_ascii=False)
        target.write("\n")


if __name__ == "__main__":
    main()
