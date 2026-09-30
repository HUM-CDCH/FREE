"""Cases: a canonical source, its schema, and gold that says what is present, what is absent and what is not annotated.

The source is the service's own `Evidence` (passages named `p{page}_s{index}`, half-open code-point spans), either read
from a verified canonical run (`run`) or given inline (`passages`), whose digest then pins every field it was given.
Gold names every annotation state apart: `{"value": v}` present, `{"absent": true}` explicitly absent, `{}` or a missing
field not annotated. Gold evidence spans are jointly required unless labelled `supports: false` (a decoy: the same text
elsewhere). Coordinates come from the canonical passages only; an inline passage without a box has none.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from scipy.optimize import linear_sum_assignment

from experiments.extraction.manifest import digest
from kei_exp.canonical import canonical_json
from kei_exp.kie.extract.acceptance import typed_value
from kei_exp.kie.extract.schema import Node, Schema
from kei_exp.kie.extract.stages import normal
from kei_exp.kie.passages import Evidence, Passage, load
from kei_exp.pagefile import load_result, segment_id

SPLITS = ("fit", "calibration", "dev", "test")   # score fitting, calibration, selection, final: never mixed


@dataclass(frozen=True)
class InferenceCase:
    """Only source and schema may cross the inference boundary; no annotation container exists here."""
    id: str
    evidence: Evidence
    schema: Schema
    record_key: tuple[str, ...] = ()
    ocr_confidence: dict[str, float] = field(default_factory=dict)
    geometry: dict[str, tuple] = field(default_factory=dict)
    record_scope: str = "records"


@dataclass(frozen=True)
class Case:
    id: str
    group: str                                   # one source and everything derived from it; splits never divide it
    split: str
    evidence: Evidence
    schema: Schema
    gold: tuple[dict, ...]                       # {"fields": {name: gold field}, "cross_page": bool}
    record_key: tuple[str, ...] = ()
    exhaustive: bool = True                      # false: predicted records without gold are unadjudicated, not wrong
    ocr_confidence: dict[str, float] = field(default_factory=dict)   # segment id -> engine confidence, when known
    geometry: dict[str, tuple] = field(default_factory=dict)         # segment id -> bbox_pt, only where the source has one
    annotations: dict = field(default_factory=dict)  # evaluator-only original annotations and source provenance
    record_scope: str = "records"                    # "document": the schema's top level is one object per document

    def inference(self) -> InferenceCase:
        return InferenceCase(self.id, self.evidence, self.schema, self.record_key, self.ocr_confidence, self.geometry, self.record_scope)


def canon(value: Any) -> Any:
    """A comparable, hashable form that keeps types apart (true is not 1) and ignores list order and string case/spacing."""
    if isinstance(value, dict):
        return ("obj", tuple(sorted((key, canon(item)) for key, item in value.items())))
    if isinstance(value, (list, tuple)):
        return ("arr", tuple(sorted((canon(item) for item in value), key=repr)))
    if value is None:
        return ("null",)
    if isinstance(value, bool):
        return ("bool", value)
    if isinstance(value, (int, float)):
        return ("num", float(value))
    return ("str", normal(str(value)))


INELIGIBLE = 1e6      # an assignment edge below the identity threshold: chosen only when nothing eligible is left


def assign(score: np.ndarray, need: list[int]) -> list[tuple[int, int]]:
    """Pairs (row, column) with score at least the column's need, chosen to maximise how many pairs there are and then
    their total score. Masking ineligible edges first is what stops one from displacing an eligible pair."""
    cost = np.where(score >= np.array(need)[None, :], -score, INELIGIBLE)
    return [(int(r), int(c)) for r, c in zip(*linear_sum_assignment(cost), strict=True) if cost[r, c] < INELIGIBLE]


def typed(raw: Any, node: Node) -> tuple[Any, bool]:
    """The value as the schema types it, and whether typing changed it; None when it does not conform. A blank or an
    empty list is the model saying nothing, which is None."""
    if raw in (None, "", []):
        return None, False
    if node.type == "array" and node.item_type is not None and isinstance(raw, list):
        items = [typed_value(item, Node(id=node.id, name=node.name, type=node.item_type)) for item in raw]
        return (None, False) if any(item is None for item in items) else (items, json.dumps(items) != json.dumps(raw))
    if node.type in ("array", "object"):
        return raw, False
    value = typed_value(raw, node)
    return value, value is not None and json.dumps(value) != json.dumps(raw)     # 40.0 -> 40 is a change; 40 == 40.0 is not


def inline_evidence(case_id: str, passages: list[dict]) -> tuple[Evidence, dict[str, float], dict[str, tuple]]:
    ids = [item["id"] for item in passages]
    if len(set(ids)) != len(ids):
        raise ValueError(f"{case_id}: passage ids repeat")
    counts: dict[int, int] = {}
    built, confidence, geometry = [], {}, {}
    for item in passages:
        index = counts[item["page"]] = counts.get(item["page"], -1) + 1
        box = tuple(float(v) for v in item["bbox_pt"]) if item.get("bbox_pt") else None
        built.append(Passage(id=item["id"], page=item["page"], index=index, text=item["text"], label=item.get("label", "Text"),
                             bbox_pt=box or (0.0, 0.0, 0.0, 0.0), extent="block"))
        if box:
            geometry[item["id"]] = box
        if item.get("confidence") is not None:
            confidence[item["id"]] = float(item["confidence"])
    pin = digest(canonical_json([{"id": i["id"], "page": i["page"], "text": i["text"], "label": i.get("label", "Text"),
                                  "bbox_pt": i.get("bbox_pt"), "confidence": i.get("confidence")} for i in passages]))
    evidence = Evidence(run_id=case_id, generation="inline", digest=pin, source_name=case_id,
                        page_count=max((p.page for p in built), default=0), passages=tuple(built))
    return evidence, confidence, geometry


def resolve(evidence: Evidence, ref: dict) -> str:
    """The text a reference names; a reference that leaves its snapshot is an error, never approximated."""
    text = next((p.text for p in evidence.passages if p.id == ref["segment"]), None)
    if text is None or not 0 <= ref["start"] < ref["end"] <= len(text):
        raise ValueError(f"evidence reference {ref} does not resolve in source {evidence.digest[:12]}")
    return text[ref["start"]:ref["end"]]


def _check_gold(case_id: str, schema: Schema, gold: list[dict], evidence: Evidence, key: tuple[str, ...]) -> None:
    nodes = {node.name: node for node in schema.record_nodes}
    if set(key) - set(nodes):
        raise ValueError(f"{case_id}: record_key names fields the schema lacks: {sorted(set(key) - set(nodes))}")
    seen: set[tuple] = set()
    for record in gold:
        for name, item in record["fields"].items():
            if name not in nodes:
                raise ValueError(f"{case_id}: gold field {name!r} is not in the schema")
            if "absent" in item and "value" in item:
                raise ValueError(f"{case_id}: gold field {name!r} is both absent and valued")
            if "value" in item and typed(item["value"], nodes[name])[0] is None:
                raise ValueError(f"{case_id}: gold value {item['value']!r} does not conform to field {name!r}")
            for ref in item.get("evidence", []):
                resolve(evidence, ref)
        if key and all("value" in record["fields"].get(name, {}) for name in key):
            identity = tuple(normal(str(record["fields"][name]["value"])) for name in key)
            if identity in seen:
                raise ValueError(f"{case_id}: gold repeats the record key {identity}")
            seen.add(identity)


def case_of(item: dict, base: Path = Path(".")) -> Case:
    if "inference_file" in item:
        item = {**item, **json.loads((base / item["inference_file"]).read_text()),
                **json.loads((base / item["annotations_file"]).read_text())}
    schema = Schema.model_validate(item["schema"] if isinstance(item["schema"], dict)
                                   else json.loads((base / item["schema"]).read_text()))
    if "run" in item:
        run = base / item["run"]
        evidence = load(run)
        loaded = load_result(run / "result", require_complete=True)
        confidence = {segment_id(number, index): each.confidence for number, page in loaded.pages.items()
                      for index, each in enumerate(page.segments) if each.confidence is not None}
        geometry = {p.id: p.bbox_pt for p in evidence.passages}
    else:
        evidence, confidence, geometry = inline_evidence(item["id"], item["passages"])
    key = tuple(item.get("record_key", ()))
    scope = item.get("record_scope", "records")
    if scope not in ("records", "document"):
        raise ValueError(f"{item['id']}: record_scope must be 'records' or 'document'")
    _check_gold(item["id"], schema, item["gold"], evidence, key)
    return Case(item["id"], item["group"], item["split"], evidence, schema, tuple(item["gold"]), key,
                item.get("exhaustive", True), confidence, geometry, item.get("annotations", {}), scope)


def check_splits(cases: list[Case]) -> None:
    """Refuse a dataset whose splits leak: unknown split names, repeated ids, or a group present in two splits."""
    if len({case.id for case in cases}) != len(cases):
        raise ValueError("case ids repeat")
    seen: dict[str, str] = {}
    for case in cases:
        if case.split not in SPLITS:
            raise ValueError(f"{case.id}: split {case.split!r} is not one of {SPLITS}")
        if seen.setdefault(case.group, case.split) != case.split:
            raise ValueError(f"group {case.group!r} is in both {seen[case.group]!r} and {case.split!r}: split leakage")


def load_cases(path: Path) -> list[Case]:
    data = json.loads(path.read_text())
    if data.get("version") != 1:
        raise ValueError("dataset version 1 required")
    cases = [case_of(item, path.parent) for item in data["cases"]]
    check_splits(cases)
    return cases
