"""Reproduce the Illinois development diagnosis without inference or source excerpts.

Run with the Parsing Service environment and PYTHONPATH=src:.; positional arguments
are the saved development directory and a new JSON output file. This is a dated
audit helper for the frozen evaluator, not a replacement scorer or an extractor.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import socket


CASE = "short--uillinois_rate_card_carpool_2024"
NETWORK_ATTEMPTS = 0


def deny_network(*args, **kwargs):
    global NETWORK_ATTEMPTS
    NETWORK_ATTEMPTS += 1
    raise RuntimeError("This development audit prohibits network connections")


def read(path):
    return json.loads(path.read_text())


def file_sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Audit output must be a new file")
    # Guard imports as well as scoring; this process never needs a provider.
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network

    from experiments.harness import evaluate as evaluator
    from experiments.harness.data import case_of
    from kei_exp.canonical import canonical_json

    def sha(value):
        return hashlib.sha256(canonical_json(value)).hexdigest()

    repo = Path(__file__).resolve().parents[4]
    selection_path = repo / "docs/research/2026-09-30-extractbench-selection.json"
    selection = read(selection_path)
    eligible = [g for g in selection["groups"] if g["split"] == "development"
                and g["selected_representative_id"].replace("/", "--") == CASE]
    assert len(eligible) == 1
    root = args.root.resolve()
    dataset_path = root / "admitted-dataset.json"
    entry = next(c for c in read(dataset_path)["cases"] if c["id"] == CASE)
    assert entry["split"] == "dev" and entry["group"] == eligible[0]["group_id"]
    # Open only this selected development annotation and inference input.
    case = case_of(entry, root)
    result_path = root / "out/cells" / ("base--" + CASE) / "result.json"
    sealed = read(result_path)
    prediction = sealed["artifact"]
    assert sha(prediction) == sealed["execution"]["artifact_sha256"]
    assert prediction["source"]["digest"] == case.evidence.digest
    study_path = root / "execution-study.json"
    study = read(study_path)
    rules = evaluator.Eval(**study["evaluation"])

    # Capture the actual virtual records passed by score_structured to the real
    # scorer. Do not recreate or change matching, absent handling, or comparators.
    units = []
    original_score = evaluator._score_case

    def capture(virtual, rows, local_rules, *, raw=False):
        result = original_score(virtual, rows, local_rules, raw=raw)
        if not raw:
            pairs, duplicates, extras = evaluator._match(
                virtual, list(virtual.gold), evaluator._Records(rows, local_rules),
                evaluator.kinds_for(virtual.schema, local_rules), local_rules)
            units.append((virtual, rows, local_rules, pairs, duplicates, extras))
        return result

    evaluator._score_case = capture
    try:
        counts, _ = evaluator.score_case(case, prediction, rules)
    finally:
        evaluator._score_case = original_score

    expected_counts = {"gold_records": 29, "matched_records": 29,
        "repeated_gold_records": 28, "repeated_matched_records": 28,
        "missing_records": 0, "duplicated_records": 0, "hallucinated_records": 0,
        "gold_value_fields": 86, "gold_absent_fields": 28, "raw_tp": 57,
        "tp": 78, "hallucinated_fields": 28, "wrong_values": 8,
        "raw_wrong_values": 29, "strict_records": 0, "raw_strict_records": 0}
    assert {k: counts.get(k, 0) for k in expected_counts} == expected_counts
    source_text = "\n".join(p.text for p in case.evidence.passages)
    errors, per_field, pairing = [], Counter(), []
    for virtual, rows, local_rules, pairs, duplicates, extras in units:
        repeated = len(virtual.gold) == 28
        collection = "items" if repeated else "document"
        assert not duplicates and not extras
        pairing.append({"collection": collection, "matched": len(pairs),
                        "identity_order": all(i == j for i, j in pairs.items())})
        by_field = {(r["record"], r["field"]): r for r in rows["fields"]}
        kinds = evaluator.kinds_for(virtual.schema, local_rules)
        for i, j in sorted(pairs.items()):
            for name, item in virtual.gold[j]["fields"].items():
                row = by_field[(i, name)]
                state = evaluator.gold_state(item)
                if state == "unannotated":
                    continue
                if state == "absent":
                    raw_ok = canonical_ok = row["status"] == "absent"
                    classification = "title_used_as_section"
                else:
                    raw_ok = evaluator.accepted("exact", row.get("raw"), item, local_rules)
                    canonical_ok = evaluator.accepted(kinds[name], row.get("value"), item, local_rules)
                    classification = ("case_only" if canonical_ok else
                        "billing_basis_vocabulary" if name == "rate_basis" else "issuer_specificity")
                per_field[(collection, name, "raw_correct" if raw_ok else
                           "canonical_only" if canonical_ok else "canonical_error")] += 1
                if raw_ok and canonical_ok:
                    continue
                if classification == "case_only":
                    assert str(row["value"]).casefold() == str(item["value"]).casefold()
                path = f"items[{j}].{name}" if repeated else name
                rule = case.annotations["field_rules"].get(path, {})
                value = row.get("value")
                errors.append({"path": path, "collection": collection,
                    "predicted_record": i, "gold_record": j, "field": name,
                    "gold_state": state, "raw_correct": raw_ok,
                    "canonical_correct": canonical_ok, "classification": classification,
                    "gold_value_sha256": sha(item.get("value")),
                    "predicted_value_sha256": sha(value),
                    "predicted_literal_in_native_source": isinstance(value, str)
                        and value.casefold() in source_text.casefold(),
                    "gold_has_evidence_value_alternative": any(e.get("value") is not None
                        for e in rule.get("evidence", []))})
    classes = dict(Counter(e["classification"] for e in errors))
    assert classes == {"issuer_specificity": 1, "title_used_as_section": 28,
                       "billing_basis_vocabulary": 7, "case_only": 21}
    expected = case.annotations["expected_output"]
    predicted = prediction["records"][0]
    section_values = {r["section"] for r in predicted["items"]}
    assert len(section_values) == 1 and all(r["section"] is None for r in expected["items"])
    assert predicted["issuing_org"] == expected["issuing_org"][:len(predicted["issuing_org"])]
    assert len(expected["issuing_org"].split()) - len(predicted["issuing_org"].split()) == 2
    metrics = evaluator.metrics(counts)
    assert metrics["field"]["f1"] == .78
    assert metrics["raw_exact"]["field"]["f1"] == .57
    assert NETWORK_ATTEMPTS == 0
    pins = {"selection": selection_path, "dataset": dataset_path,
        "input": root / entry["inference_file"], "annotation": root / entry["annotations_file"],
        "sealed_result": result_path, "execution_study": study_path,
        "scorer": repo / "prototypes/parsing_service/experiments/harness/evaluate.py",
        "adapter": repo / "prototypes/parsing_service/experiments/harness/extractbench.py",
        "helper": Path(__file__).resolve()}
    output = {"audit_date": "2026-09-30", "baseline_commit": "406263e58c030b367af75ddf1a9e16717ac9c1e5",
        "case": CASE, "arm": "A0", "source_group": case.group,
        "scope": "one selected development case; original scorer and sealed prediction unchanged",
        "network_attempts": NETWORK_ATTEMPTS, "fresh_extraction_calls": 0,
        "heldout_annotations_opened": 0, "scorer_counts": expected_counts,
        "raw_field": metrics["raw_exact"]["field"], "canonical_field": metrics["field"],
        "matching": pairing, "error_classes": classes,
        "per_field": [{"collection": c, "field": f, "status": s, "count": n}
                      for (c, f, s), n in sorted(per_field.items())],
        "source_checks": {"section_distinct_predicted_values": 1,
            "section_predictions_are_source_literal": all(e["predicted_literal_in_native_source"]
                for e in errors if e["field"] == "section"),
            "issuer_prediction_is_gold_prefix_missing_two_tokens": True,
            "literal_presence_is_not_semantic_support": True},
        "file_sha256": {key: file_sha(path) for key, path in pins.items()}, "errors": errors,
        "interpretation_limit": "Script verifies scoring and literal presence; semantic diagnoses require the dated visual/code review. No human adjudication or technique comparison."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as stream:
        json.dump(output, stream, indent=2)
        stream.write("\n")
    print(json.dumps({"counts_reproduced": True, "error_classes": classes,
                      "network_attempts": NETWORK_ATTEMPTS, "fresh_extraction_calls": 0}))


if __name__ == "__main__":
    main()
