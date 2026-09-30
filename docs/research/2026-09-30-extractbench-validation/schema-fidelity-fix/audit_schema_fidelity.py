"""Offline, sanitized schema inventory; reads development data_schema only."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

from experiments.harness.extractbench import SCHEMA_POLICY, decoded, inference_schema
from kei_exp.canonical import canonical_json
from kei_exp.kie.extract.schema import Schema, notes


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def walk(value, path=""):
    if not isinstance(value, dict):
        return
    yield path, value
    # Property names such as "description" are not schema keywords. Traverse
    # schema locations only; never descend into descriptions, defaults or enums.
    for key in ("properties", "$defs", "definitions", "patternProperties", "dependentSchemas"):
        for name, child in value.get(key, {}).items():
            escaped = name.replace("~", "~0").replace("/", "~1")
            yield from walk(child, path + "/" + key + "/" + escaped)
    for key in ("items", "contains", "additionalProperties", "propertyNames", "not", "if", "then", "else"):
        yield from walk(value.get(key), path + "/" + key)
    for key in ("anyOf", "oneOf", "allOf", "prefixItems"):
        for index, child in enumerate(value.get(key, [])):
            yield from walk(child, path + "/" + key + "/" + str(index))


def audit(selection_path: Path, snapshot: Path) -> dict:
    selection = json.loads(selection_path.read_text())
    wanted = {group["selected_representative_id"]: group["group_id"]
              for group in selection["groups"] if group["split"] == "development"}
    documents, enums, totals = [], [], Counter()
    for source in selection["dataset_files"]:
        path = snapshot / source["path"]
        if sha(path) != source["sha256"] or path.stat().st_size != source["bytes"]:
            raise ValueError("pinned JSONL checksum or size mismatch: " + source["path"])
        with path.open() as stream:
            for line in stream:
                row = json.loads(line)  # Gold fields remain serialized strings.
                if row["id"] not in wanted:
                    continue
                original = decoded(row, "data_schema")
                adapted = inference_schema(original)
                counts = Counter()
                for pointer, node in walk(original):
                    counts.update(key for key in ("description", "enum", "format", "default", "examples") if key in node)
                    if "enum" in node:
                        values = node["enum"]
                        nonnull = [value for value in values if value is not None]
                        enums.append({"source_id": row["id"], "json_pointer": pointer,
                                      "declared_type": node.get("type"), "choices": len(values),
                                      "nonnull_choices": len(nonnull),
                                      "all_nonnull_are_strings": all(isinstance(v, str) for v in nonnull),
                                      "enum_sha256": hashlib.sha256(canonical_json(values)).hexdigest()})
                totals.update(counts)
                schema = Schema.model_validate(adapted)
                documents.append({"source_id": row["id"], "source_group": wanted[row["id"]],
                                  "original_schema_sha256": hashlib.sha256(canonical_json(original)).hexdigest(),
                                  "inference_schema_sha256": hashlib.sha256(canonical_json(adapted)).hexdigest(),
                                  "keyword_counts": dict(counts), "prompt_note_count": len(notes(schema.nodes))})
    if len(documents) != len(wanted) or {d["source_id"] for d in documents} != set(wanted):
        raise ValueError("development representatives missing or duplicated")
    return {"dataset_revision": selection["dataset_revision"], "selection_sha256": sha(selection_path),
            "schema_policy_version": SCHEMA_POLICY, "development_schemas": len(documents),
            "keyword_counts": dict(totals), "documents": documents, "enums": enums,
            "gold_decodings": 0, "heldout_schema_decodings": 0, "network_requests": 0,
            "model_calls": 0, "tokenizer_calls": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("selection", type=Path)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = audit(args.selection, args.snapshot)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(f"Audited {result['development_schemas']} development schemas; {len(result['enums'])} enums; no inference.")
