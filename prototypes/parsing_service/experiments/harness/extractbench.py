"""Small pinned ExtractBench adapter. Downloads/ingests selected development PDFs only.

Public JSONL categories describe length, not study splits. Original annotations stay in
separate evaluator-only files. Inference schemas preserve structural names/types and
representable string choices; descriptions contain answers and evidence locations.
"""
from __future__ import annotations

import hashlib
import json
from importlib.metadata import version
from pathlib import Path

import requests

from experiments.extraction.manifest import digest, write_new
from kei_exp.canonical import canonical_json
from kei_exp.kie.extract.schema import Schema

ADAPTER = "extractbench-v1"  # Annotation format; schema conversion is versioned separately.
SCHEMA_POLICY = "structural-string-enums-v2"


def save(path: Path, data: dict) -> None:
    if path.exists():
        if json.loads(path.read_text()) != data:
            raise ValueError(f"refusing to overwrite a different artifact: {path}")
    else:
        write_new(path, data)


def sha_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def decoded(row: dict, key: str):
    value = row[key]
    return json.loads(value) if isinstance(value, str) else value


def inference_schema(original: dict) -> dict:
    """Preserve objects, arrays and string choices; refuse unrepresentable enums and ambiguous unions."""
    def resolve(node):
        if "$ref" in node:
            ref = node["$ref"]
            if not ref.startswith("#/"):
                raise ValueError("external schema references are unsupported")
            target = original
            for key in ref[2:].split("/"):
                target = target[key.replace("~1", "/").replace("~0", "~")]
            resolved = resolve(target)
        elif choices := node.get("anyOf", node.get("oneOf")):
            choices = [resolve(c) for c in choices if c.get("type") != "null"]
            if len(choices) != 1:
                raise ValueError("only nullable single-type schema unions are supported")
            resolved = choices[0]
        else:
            return node
        if "enum" in node:
            values = [v for v in node["enum"] if "enum" not in resolved or v in resolved["enum"]]
            resolved = {**resolved, "enum": values}
        return resolved

    def node(name, raw, path):
        raw = resolve(raw)
        kind = raw.get("type", "object" if "properties" in raw else None)
        if isinstance(kind, list):
            kinds = [k for k in kind if k != "null"]
            if len(kinds) != 1:
                raise ValueError(f"ambiguous type at {path}")
            kind = kinds[0]
        out = {"id": digest(path.encode())[:16], "name": name, "type": kind}
        if "enum" in raw:
            values = [v for v in raw["enum"] if v is not None]
            if kind != "string" or len(values) < 2 or not all(isinstance(v, str) for v in values):
                raise ValueError(f"only string enums with at least two choices are supported at {path}")
            out["allowedValues"] = values
        if kind == "object":
            out["children"] = [node(k, v, f"{path}.{k}") for k, v in raw.get("properties", {}).items()]
        elif kind == "array":
            item = node("item", raw["items"], path + "[]")
            if item["type"] == "object":
                out["children"] = item["children"]
            elif item["type"] == "array":
                raise ValueError(f"nested scalar arrays unsupported at {path}")
            else:
                if "allowedValues" in item:
                    raise ValueError(f"scalar-array item enums are unsupported at {path}")
                out["itemType"] = item["type"]
        elif kind not in ("string", "integer", "number", "boolean"):
            raise ValueError(f"unsupported schema type {kind!r} at {path}")
        return out
    root = resolve(original)
    if root.get("type") != "object":
        raise ValueError("expected an object document schema")
    if "enum" in root:
        raise ValueError("root object enums are unsupported")
    schema = {"recordDescription": "One complete document, including all records in every repeated array.",
              "schemaNodes": [node(k, v, k) for k, v in root["properties"].items()]}
    return Schema.model_validate(schema).model_dump(mode="json", by_alias=True, exclude_none=True)


def parse_native(pdf: Path) -> tuple[list[dict], dict]:
    """One native-text line per passage, PDF order, physical one-based pages; no OCR or invented geometry."""
    import pypdfium2 as pdfium
    passages, page_info = [], []
    with pdfium.PdfDocument(pdf) as document:
        for number in range(len(document)):
            page = document[number]
            textpage = page.get_textpage()
            try:
                text = textpage.get_text_range()
                lines = [line for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if line.strip()]
                passages.extend({"id": f"p{number + 1}_s{i}", "page": number + 1, "text": line} for i, line in enumerate(lines))
                page_info.append({"page": number + 1, "characters": sum(map(len, lines)), "lines": len(lines)})
            finally:
                textpage.close()
                page.close()
    empty = [p["page"] for p in page_info if not p["characters"]]
    return passages, {"name": "pdfium-native-lines-v1", "pypdfium2": version("pypdfium2"),
                      "pdfium": str(pdfium.PDFIUM_INFO), "pages": page_info, "empty_text_pages": empty,
                      "ocr": False, "geometry": "unavailable", "page_count": len(page_info)}


def _download(member: dict, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (member["id"].replace("/", "--") + ".pdf")
    if not path.exists():
        response = requests.get(member["pdf_url"], timeout=120)
        response.raise_for_status()
        path.write_bytes(response.content)
    data = path.read_bytes()
    expected = member["pdf_checksum"]
    actual = (hashlib.sha256(data).hexdigest() if expected["algorithm"] == "sha256" else
              hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest())
    if actual != expected["digest"] or len(data) != member["pdf_bytes"]:
        raise ValueError(f"PDF checksum mismatch: {member['id']}")
    return path


def prepare(selection_path: Path, snapshot: Path, output: Path, *, smoke: bool = False) -> dict:
    selection = json.loads(selection_path.read_text())
    groups = [g for g in selection["groups"] if g["split"] == "development" and (not smoke or g["smoke"])]
    wanted = {g["selected_representative_id"]: g for g in groups}
    cases, records, failures = [], [], []
    for source in selection["dataset_files"]:
        path = snapshot / source["path"]
        if sha_file(path) != source["sha256"]:
            raise ValueError(f"dataset checksum mismatch: {source['path']}")
        with path.open() as stream:
            for line in stream:
                row = json.loads(line)
                if row["id"] not in wanted:
                    continue  # do not decode or inspect any holdout annotations
                group = wanted[row["id"]]
                member = next(m for m in group["related_members"] if m["id"] == row["id"])
                identity = row["id"].replace("/", "--")
                pdf = _download(member, output / "pdfs")
                passages, parser = parse_native(pdf)
                original = decoded(row, "data_schema")
                schema = inference_schema(original)
                source_pin = {"source_id": row["id"], "source_group": group["group_id"],
                              "dataset_revision": selection["dataset_revision"], "row_sha256": digest(line.encode()),
                              "pdf_sha256": sha_file(pdf), "original_schema_sha256": digest(canonical_json(original)),
                              "inference_schema_sha256": digest(canonical_json(schema)),
                              "parser": parser, "tags": row["tags"], "length_category": row["category"]}
                source_pin["source_sha256"] = digest(canonical_json(passages))
                records.append(source_pin)
                if parser["empty_text_pages"]:
                    failures.append({"source_id": row["id"], "reason": "native_text_unavailable", "pages": parser["empty_text_pages"]})
                    continue
                expected, rules = decoded(row, "expected_output"), decoded(row, "field_rules")
                gold = [{"fields": {k: {"absent": True} if v is None else {"value": v} for k, v in expected.items()}}]
                # inference_schema accepts only an object root: the document is one record, whatever the chunking
                save(output / "inputs" / f"{identity}.json", {"schema": schema, "passages": passages, "record_scope": "document"})
                save(output / "annotations" / f"{identity}.json", {"gold": gold, "annotations": {
                    "adapter": ADAPTER, "expected_output": expected, "field_rules": rules, "original_schema": original,
                    "repeated_structure": decoded(row, "repeated_structure"), "source": source_pin}})
                cases.append({"id": identity, "group": group["group_id"], "split": "dev",
                              "inference_file": f"inputs/{identity}.json", "annotations_file": f"annotations/{identity}.json"})
    if set(wanted) != {r["source_id"] for r in records}:
        raise ValueError("selected development source ids were missing from pinned JSONLs")
    save(output / "dataset.json", {"version": 1, "cases": cases})
    manifest = {"adapter": ADAPTER, "selection_sha256": sha_file(selection_path), "dataset_revision": selection["dataset_revision"],
                "selected_documents": len(groups), "ingested_documents": len(cases), "source_groups": len(groups),
                "holdout_documents_ingested": 0, "documents": records, "failures": failures,
                "scoring": "custom harness leaf/record metrics; not official ExtractBench scores",
                "schema_policy_version": SCHEMA_POLICY,
                "schema_policy": "structural names/types and representable string enums; descriptions/examples/defaults removed before inference"}
    save(output / "adapter-manifest.json", manifest)
    return manifest
