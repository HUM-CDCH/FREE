"""Regenerate metrics from immutable cells; uncertainty is paired by document, never by fields."""
from __future__ import annotations

import argparse
import importlib.util
import json
import random
import statistics
from collections import Counter, defaultdict
from pathlib import Path

from kei_exp.kie.extract.stages import leaves
from kei_exp.kie.extract.schema import Schema, evidence_policy
from .manifest import checked, digest, pin, read, validate, write_new


def paired_interval(deltas: list[float], *, seed: int = 20260927, draws: int = 10000) -> dict:
    if not deltas:
        return {"documents": 0, "mean": None, "percentile_95": None}
    rng = random.Random(seed)
    samples = sorted(statistics.mean(rng.choices(deltas, k=len(deltas))) for _ in range(draws))
    return {"documents": len(deltas), "mean": statistics.mean(deltas),
            "percentile_95": [samples[int(draws * .025)], samples[int(draws * .975)]],
            "unit": "document", "bootstrap_seed": seed, "draws": draws}


def document_fields(fields: list[dict], names: set[str]) -> list[dict]:
    """Match the frozen scorer: repeated metadata fails if any sample row fails."""
    groups = defaultdict(list)
    for field in fields:
        if field["field"] in names:
            groups[(field["source_id"], field["field"])].append(field)
    rank = {"correct": 0, "needs_review": 1, "incorrect": 2}
    return [{**group[0], "result": max((f["result"] for f in group), key=rank.__getitem__)}
            for group in groups.values()]


def exact_projected_fields(fields: list[dict]) -> list[dict]:
    """Strict representation diagnostic after the frozen alignment and projection gates."""
    return [{**field, "result": "correct" if field["result"] == "correct" and
             json.dumps(field["expected"], sort_keys=True) == json.dumps(field["actual"], sort_keys=True)
             else "incorrect"} for field in fields]


def diagnostic(artifact: dict) -> dict:
    populated = {("records", number, *path) for number, record in enumerate(artifact["records"])
                 for path, _ in leaves(record) if path[0] not in artifact.get("unverified", [])
                 and path[0] not in {n["name"] for n in artifact["schema"]["schemaNodes"]
                                    if n.get("valueSource") == "source-filename"}}
    grounded = {tuple(link["path"]) for link in artifact["evidence"]}
    calls = artifact["calls"]
    result = {"records": len(artifact["records"]), "populated_record_leaves": len(populated),
            "linked_record_leaves": len(populated & grounded),
            "link_rate": len(populated & grounded) / len(populated) if populated else None,
            "calls": len(calls), "failed_calls": sum(not call["ok"] for call in calls),
            "input_tokens": artifact["tokens"]["input"], "output_tokens": artifact["tokens"]["output"],
            "model_seconds": sum(call["seconds"] for call in calls),
            "max_counted_input": max((call.get("counted_input_tokens") or 0 for call in calls), default=0),
            "issues": dict(Counter(issue["code"] for issue in artifact["issues"])),
            "proposed": len(artifact.get("proposed", [])), "rejected": len(artifact.get("rejected", [])),
            "completion": artifact.get("completion", artifact.get("completeness")),
            "interpretation": "Links and quoted substrings are diagnostics, not independent semantic correctness."}
    if "grounding_eligibility" in artifact:
        schema = Schema.model_validate(artifact["schema"])
        skipped = {path: evidence_policy(schema.record_nodes, path[2:]) for path in populated
                   if evidence_policy(schema.record_nodes, path[2:]) != "quoted"}
        saved = artifact["grounding_eligibility"]
        if (saved["all_record_leaves"] != len(populated)
                or saved["eligible_record_leaves"] != len(populated) - len(skipped)
                or len(saved["skipped"]) != len(skipped)
                or {tuple(item["path"]): item["policy"] for item in saved["skipped"]} != skipped):
            raise ValueError("grounding eligibility disagrees with schema and populated records")
        eligible = populated - skipped.keys()
        if grounded & skipped.keys():
            raise ValueError("policy-skipped fields must not have grounding links")
        result["grounding_eligibility"] = {
            "eligible_record_leaves": len(eligible), "linked_eligible_record_leaves": len(eligible & grounded),
            "eligible_link_rate": len(eligible & grounded) / len(eligible) if eligible else None,
            "skipped_record_leaves": len(skipped), "skipped_by_policy": dict(Counter(skipped.values()))}
    return result


def analyze(study: dict, output: Path) -> dict:
    cells = validate(study, Path(__file__).resolve().parents[2], verify_files=False)
    gold_path, scorer_path = checked(study["evaluation"]["gold"]), checked(study["evaluation"]["scorer"])
    spec = importlib.util.spec_from_file_location("frozen_scorer", scorer_path)
    scorer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scorer)
    gold = read(gold_path)
    rows, missing, extra_queue, accuracy = [], [], [], {}
    for cell in cells:
        directory = output / "cells" / cell["id"]
        path = directory / "result.json"
        if not path.exists():
            terminals = sorted(directory.glob("attempt-*.finished.json"))
            missing.append({"cell": cell["id"], "status": read(terminals[-1]) if terminals else "not_completed"})
            continue
        cell_pin = read(directory / "pin.json")
        if cell_pin["manifest_sha256"] != digest((output / "manifest.json").read_bytes()):
            raise ValueError("mixed study cell")
        completed = read(path)
        artifact, execution = completed["artifact"], completed["execution"]
        terminals = sorted(directory.glob("attempt-*.finished.json"))
        if execution["artifact_sha256"] != digest(json.dumps(artifact, sort_keys=True).encode()):
            raise ValueError(f"unsealed or changed result: {cell['id']}")
        row = {key: cell[key] for key in ("id", "source", "method", "repeat")}
        row.update(diagnostic(artifact))
        row["attempts"] = [read(p) for p in terminals if read(p)["attempt"] != execution["attempt"]] + [execution]
        if cell["source"] in gold["sources"]:
            bundle = {"format": "collagen-free-predictions-v1", "documents": [{"source_id": cell["source"],
                "source_sha256": gold["sources"][cell["source"]]["sha256"], "artifact_sha256": digest(path.read_bytes()),
                "artifact": artifact}]}
            scored = scorer.score(gold, bundle, fingerprints={"gold_sha256": digest(gold_path.read_bytes()),
                                                              "scorer_sha256": digest(scorer_path.read_bytes())})
            metrics = scored["per_paper_sample_fields"][cell["source"]]
            row["accuracy"] = metrics
            fields = [f for f in scored["fields"] if f["source_id"] == cell["source"]]
            row["document_field_accuracy"] = scorer.metrics(document_fields(fields, scorer.DOCUMENT_FIELDS))
            exact = exact_projected_fields(fields)
            row["exact_projected_match"] = {
                "sample_fields": scorer.metrics([f for f in exact if f["field"] not in scorer.DOCUMENT_FIELDS]),
                "document_fields": scorer.metrics(document_fields(exact, scorer.DOCUMENT_FIELDS))}
            row["identity_alignment"] = dict(Counter(a["status"] for a in scored["alignment"]
                                                     if a["source_id"] == cell["source"]))
            row["extra_prediction_indices_unscored"] = scored["extra_prediction_indices_unscored"].get(cell["source"], [])
            for index in row["extra_prediction_indices_unscored"]:
                extra_queue.append({"cell": cell["id"], "record": index, "fields": artifact["records"][index],
                                    "status": "unadjudicated; gold is not exhaustive"})
            accuracy[cell["id"]] = {"metrics": metrics, "fields": [f for f in scored["fields"]
                                       if f["source_id"] == cell["source"]]}
        rows.append(row)
    effects = []
    for comparison in study["comparisons"]:
        paired = []
        for source in study["sources"]:
            control = [r for r in rows if r["source"] == source["id"] and r["method"] == comparison["control"]]
            treatment = [r for r in rows if r["source"] == source["id"] and r["method"] == comparison["treatment"]]
            if len(control) != study["repeats"] or len(treatment) != study["repeats"]:
                continue
            delta = {"source": source["id"]}
            for metric in ("calls", "input_tokens", "output_tokens", "records", "link_rate"):
                if all(r[metric] is not None for r in control + treatment):
                    delta[metric] = statistics.mean(r[metric] for r in treatment) - statistics.mean(r[metric] for r in control)
            if all("accuracy" in r for r in control + treatment):
                delta["accuracy"] = statistics.mean(r["accuracy"]["populated"]["accuracy_lower_bound"] for r in treatment) - statistics.mean(
                    r["accuracy"]["populated"]["accuracy_lower_bound"] for r in control)
            paired.append(delta)
        effects.append({**comparison, "paired": paired,
                        "accuracy_effect": paired_interval([p["accuracy"] for p in paired if "accuracy" in p])})
    interactions = []
    for interaction in study.get("interactions", []):
        paired = []
        for source in study["sources"]:
            values = {}
            for role in ("baseline", "a", "b", "ab"):
                matched = [r for r in rows if r["source"] == source["id"] and r["method"] == interaction[role]
                           and "accuracy" in r]
                if len(matched) == study["repeats"]:
                    values[role] = statistics.mean(r["accuracy"]["populated"]["accuracy_lower_bound"] for r in matched)
            if len(values) == 4:
                paired.append({"source": source["id"], "difference_of_differences":
                               values["ab"] - values["a"] - values["b"] + values["baseline"]})
        interactions.append({**interaction, "paired": paired,
                             "effect": paired_interval([p["difference_of_differences"] for p in paired])})
    return {"study": study["id"], "analyzer": pin(Path(__file__)),
            "expected_cells": len(cells), "completed_cells": len(rows), "missing": missing,
            "cells": rows, "comparisons": effects, "interactions": interactions,
            "extra_prediction_review_queue": extra_queue, "accuracy": accuracy,
            "limits": ["Development corpus, no independently annotated held-out test set.",
                       "Human gold is not exhaustive; extra predictions are unscored, never assumed false positives.",
                       "Intervals resample documents; small-sample descriptive uncertainty, not proof of generalization.",
                       "Greedy decoding; repeats would measure serving variability, not independent document samples.",
                       "Conditional one-factor effects; combined changes are not attributed to a single technique.",
                       "Exact projected match is a supplementary representation diagnostic, not the primary normalized score or a source-span metric. It retains frozen alignment/projection failures and distinguishes case, whitespace, list order, JSON types and integer/float distinctions. Pending semantics receive no exact credit.",
                       "Direct model calls: no DBOS queue, authenticated HTTP, or deployment latency measurement.",
                       "Unannotated PDFs have operational metrics only; no fabricated accuracy or block F1."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("study_output", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    report = analyze(read(args.study_output / "manifest.json"), args.study_output)
    write_new(args.report, report)
    print(f"{report['completed_cells']}/{report['expected_cells']} completed cells; {len(report['missing'])} missing")


if __name__ == "__main__":
    main()
