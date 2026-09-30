"""Evaluator-only compatibility check of prepared development gold and reply shape."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import socket

from jsonschema import validators

from experiments.harness.data import case_of
from experiments.harness.evaluate import Eval, check_invariants, metrics, score_case
from kei_exp.kie.extract.schema import json_schema


def null_shape(value, schema, path=()):
    """Complete a synthetic reply; never alter the source annotations."""
    missing = []
    if isinstance(value, dict):
        for name, child in schema["properties"].items():
            if name not in value:
                value[name] = None
                missing.append([*path, name])
            else:
                missing.extend(null_shape(value[name], child, (*path, name)))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            missing.extend(null_shape(child, schema["items"], (*path, index)))
    return missing


def prediction(case, value):
    return {"records": [value], "fields": [{"record": 0, "field": n.name,
            "value": value.get(n.name), "raw": value.get(n.name), "evidence": [],
            "status": "value" if value.get(n.name) is not None else "absent"} for n in case.schema.nodes]}


def check(selection_path: Path, prepared: Path) -> dict:
    selection = json.loads(selection_path.read_text())
    wanted = {g["selected_representative_id"].replace("/", "--"): g["group_id"]
              for g in selection["groups"] if g["split"] == "development"}
    manifest = json.loads((prepared / "adapter-manifest.json").read_text())
    assert manifest["selection_sha256"] == hashlib.sha256(selection_path.read_bytes()).hexdigest()
    assert manifest["schema_policy_version"] == "structural-string-enums-v2"
    data = json.loads((prepared / "dataset.json").read_text())
    documents = []
    for item in data["cases"]:
        assert item["split"] == "dev" and wanted[item["id"]] == item["group"]
        case = case_of(item, prepared)
        original = case.annotations["original_schema"]
        gold = case.annotations["expected_output"]
        adapted = json_schema(case.schema.nodes)
        shaped = copy.deepcopy(gold)
        missing = null_shape(shaped, adapted)
        checks = {}
        for label, schema, value in (("original", original, gold), ("adapted", adapted, gold),
                                     ("adapted_null_shape", adapted, shaped)):
            validator = validators.validator_for(schema)
            validator.check_schema(schema)
            errors = list(validator(schema).iter_errors(value))
            checks[label] = {"errors": len(errors), "validators": sorted({e.validator for e in errors})}
        before, _ = score_case(case, prediction(case, gold), Eval())
        after, _ = score_case(case, prediction(case, shaped), Eval())
        assert before == after and not check_invariants(after)
        scores = metrics(after)
        documents.append({"id": case.id, "source_group": case.group, "checks": checks,
                          "null_completed_paths": missing, "scoring_counts_unchanged": True,
                          "unannotated_collections": after.get("unannotated_collections", 0),
                          "raw_roundtrip_f1": scores["raw_exact"]["field"]["f1"],
                          "canonical_roundtrip_f1": scores["canonicalized"]["field"]["f1"]})
    return {"scope": "primary expected_output only; format assertions disabled; synthetic replies, not quality",
            "schema_policy_version": manifest["schema_policy_version"], "documents": documents,
            "development_annotation_documents_decoded": len(documents), "heldout_annotation_decodings": 0,
            "inference_or_tokenizer_requests": 0, "network_requests": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("selection", type=Path)
    parser.add_argument("prepared", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    def no_network(*args, **kwargs):
        raise RuntimeError("offline gold-schema audit attempted network access")
    socket.socket = no_network
    result = check(args.selection, args.prepared)
    with args.output.open("x") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(f"Checked {len(result['documents'])} development annotations; no inference.")
