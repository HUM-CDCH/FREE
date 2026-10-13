"""Offline Article occurrence-lineage study; no model, parser, network, or benchmark claims.

Run from the Parsing Service with its Python environment:
  PYTHONPATH=src:. python -m experiments.extraction.occurrence_study register OUTPUT
  PYTHONPATH=BASELINE/src:. python -m experiments.extraction.occurrence_study run OUTPUT baseline
  PYTHONPATH=src:. python -m experiments.extraction.occurrence_study run OUTPUT proposed

BASELINE is an archived Parsing Service directory at the comparison's base revision.
Inputs are synthetic, frozen Passage projections (not a PDF/parser evaluation). Fixed
contexts replace the partitioner to isolate assembly/routing. A deterministic reader
and first-support verifier stand in for providers; tokens are word-count proxies.
Calls use the real Article implementation and existing immutable capture infrastructure.
"""
from __future__ import annotations

import argparse
import ast
from collections import Counter, defaultdict, deque
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import platform
import re
import subprocess
import time
from unittest.mock import patch

from experiments.extraction.manifest import checked, pin, read, write_new
from experiments.extraction.study import Capture
from kei_exp.kie.extract import article
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.run import ExtractRequest
from kei_exp.kie.extract.stages import leaves
from kei_exp.kie.passages import Evidence, Passage


class WordCounter:
    """Deterministic accounting only: neither a tokenizer nor measured model usage."""
    context_tokens = 131072

    def request_tokens(self, system, user, schema=None):
        return len(system.split()) + len(user.split()) + 5

    def identity(self):
        return {"source": "simulated-word-count", "model": "scripted", "template_tokens": 5}


class Scripted:
    model = "scripted"

    def __init__(self, role, mode):
        self.role, self.mode = role, mode

    def complete(self, *, system, user, schema, max_tokens=None):
        answer = self.values(user, schema) if self.role == "fields" else self.verify(user, schema)
        text = json.dumps(answer, ensure_ascii=False)
        return Reply(text, WordCounter().request_tokens(system, user, schema), len(text.split()), "stop", 0.0)

    def values(self, user, schema):
        rows = [{"code": m[1], "amount": int(m[2]),
                 **({"materials": m[3].split(",")} if m[3] else {})}
                for m in re.finditer(r"Item (Slot\d+): amount (\d+)(?:; materials ([a-z,]+))?\.", user)]
        if self.mode == "omit_tail":
            rows = rows[:-1]
        answer = {}
        for name in schema["properties"]:
            if name == "items":
                answer[name] = rows or None
            elif name == "permit":
                found = re.findall(r"Permit (P-\d+)\.", user)
                answer[name] = found[0] if found else None
            elif name == "rate":
                found = re.findall(r"Rate (\d+)\.", user)
                answer[name] = int(found[0]) if found else None
        return answer

    def verify(self, user, schema):
        evidence = []
        for line in user.split("### Evidence\n", 1)[1].splitlines():
            match = re.fullmatch(r"(E\d+): p\d+_s\d+ \w+ \[\d+:\d+\]: (.*)", line)
            if match:
                evidence.append((match[1], ast.literal_eval(match[2])))
        answer, enclosing = {}, {}
        for line in user.split("### Claims\n", 1)[1].split("### Evidence", 1)[0].splitlines():
            if line.startswith("Within "):
                enclosing = json.loads(line.split(": ", 1)[1])
            match = re.fullmatch(r"(C\d+) \(([^)]+)\): (.*)", line)
            if not match:
                continue
            claim, field, value = match.groups()
            labels = schema["properties"][claim]["properties"]["label"]["enum"]
            code = enclosing.get("code") if field.startswith("items.") else None
            label = next((label for label, text in evidence if label in labels
                          and (not code or f"Item {code}:" in text)
                          and re.search(r"(?<!\w)" + re.escape(value) + r"(?!\w)", text)), "NONE")
            answer[claim] = {"label": label, "attribution": label != "NONE"}
        return answer


def passage(page, index, text, label="Text"):
    return Passage(f"p{page}_s{index}", page, index, text, label, (0, index * 10, 100, index * 10 + 9), "block")


def schema(*, nested=False, scalar=None):
    children = [{"id": "code", "name": "code", "type": "string"},
                {"id": "amount", "name": "amount", "type": "integer"}]
    if nested:
        children.append({"id": "materials", "name": "materials", "type": "array", "itemType": "string"})
    nodes = [{"id": "items", "name": "items", "type": "array", "children": children}]
    if scalar:
        nodes.append({"id": scalar, "name": scalar, "type": "string" if scalar == "permit" else "integer"})
    return {"recordScope": "document", "recordDescription": "One document with every printed item occurrence.",
            "schemaNodes": nodes}


def fixture(name, texts, *, nested=False, scalar=None, contexts=None, mode="honest", note=""):
    source = [passage(page, index, text) for page, page_texts in enumerate(texts, 1)
              for index, text in enumerate(page_texts)]
    defined_schema = schema(nested=nested, scalar=scalar)
    reader = Scripted("fields", "honest")
    fields = reader.values("\n".join(p.text for p in source), {"properties": {"items": {}}})
    expected = fields
    gold = []
    index = 0
    for p in source:
        for row in reader.values(p.text, {"properties": {"items": {}}})["items"] or []:
            for path, value in leaves(row):
                gold.append({"path": ["items", index, *path], "value": value, "segment": p.id,
                             "page": p.page, "start": 0, "end": len(p.text)})
            index += 1
    if scalar:
        values = [(p, reader.values(p.text, {"properties": {scalar: {}}})[scalar]) for p in source]
        present = [(p, value) for p, value in values if value is not None]
        expected[scalar] = present[0][1] if present and len({v for _, v in present}) == 1 else None
        if expected[scalar] is not None:
            p, value = present[0]
            gold.append({"path": [scalar], "value": value, "segment": p.id,
                         "page": p.page, "start": 0, "end": len(p.text)})
    units = contexts or [{"primary": [p.id for p in source if p.page == page], "overlap": []}
                         for page in range(1, len(texts) + 1)]
    return {"id": name, "source": [asdict(p) for p in source], "contexts": units,
            "schema": defined_schema, "expected": expected, "gold": gold, "provider_mode": mode, "note": note}


def origin_gold(case):
    """Independent source-order truth: the reader emits one array item per complete printed row."""
    by_id = {p["id"]: p for p in case["source"]}
    result = defaultdict(list)
    gold_by_segment = defaultdict(list)
    for leaf in case["gold"]:
        gold_by_segment[leaf["segment"]].append(leaf)
    for unit, context in enumerate(case["contexts"]):
        ids = [*context.get("overlap", []), *context["primary"]]
        if context.get("heading"):
            ids = sorted(set([context["heading"], *ids]), key=lambda k: (by_id[k]["page"], by_id[k]["index"]))
        rows = [segment for segment in ids if by_id[segment]["text"].startswith("Item ")
                and re.search(r": amount \d+", by_id[segment]["text"])]
        if case["provider_mode"] == "omit_tail":
            rows = rows[:-1]
        for index, segment in enumerate(rows):
            for leaf in gold_by_segment[segment]:
                path = leaf["path"]
                if path[0] == "items":
                    result[tuple(path)].append({"unit": unit, "path": ["items", index, *path[2:]]})
        for segment in ids:
            for leaf in gold_by_segment[segment]:
                if leaf["path"][0] != "items":
                    result[tuple(leaf["path"])].append({"unit": unit, "path": leaf["path"]})
    return result


def fixtures():
    cases = [fixture(f"repeated_{size}", [[f"Item Slot{i:04}: amount {10+i}." for i in range(size // 10)]
                                         for _ in range(10)],
                     note="Ten disjoint page contexts repeat equal row patterns; occurrence identity is source order.")
             for size in (10, 100, 500, 1000)]
    for where, pages, name in ((0, 10, "null_after_value"), (299, 300, "sparse_late_300_pages")):
        texts = [["No permit stated here."] for _ in range(pages)]
        texts[where] = ["Permit P-900."]
        cases.append(fixture(name, texts, scalar="permit"))
    cases += [
        fixture("scalar_conflict", [["Rate 10."], ["Rate 20."]], scalar="rate"),
        fixture("overlap_join", [["Item Slot0000: amount 10.", "Item Slot0001: amount 11."],
                                 ["Item Slot0002: amount 12."]], contexts=[
                    {"primary": ["p1_s0", "p1_s1"], "overlap": []},
                    {"primary": ["p2_s0"], "overlap": ["p1_s1"]}]),
        fixture("nested_equal_items", [["Item Slot0000: amount 10; materials clay,clay."],
                                       ["Item Slot0000: amount 10; materials clay,clay."]], nested=True),
        fixture("same_page_equal_occurrences", [["Item Slot0000: amount 10.", "Item Slot0000: amount 10."]],
                note="Known limit: exact value origins do not identify distinct equal spans within one context."),
        fixture("shared_heading_only", [["Item table", "Item Slot0000: amount 10."],
                                        ["Item Slot0000: amount 10."]], contexts=[
                    {"primary": ["p1_s1"], "overlap": [], "heading": "p1_s0"},
                    {"primary": ["p2_s0"], "overlap": [], "heading": "p1_s0"}],
                note="An inherited shared heading alone must not join two disjoint equal rows."),
        fixture("schema_valid_omitted_tails", [[f"Item Slot{page*10+i:04}: amount {10+i}." for i in range(10)]
                                               for page in range(10)], mode="omit_tail",
                note="Reader intentionally returns nine of ten items per context with valid JSON and stop finish."),
        fixture("split_continuation", [["Item Slot0000:"], ["amount 10."]],
                note="Known limit: a fixed context boundary splits one row; scripted local reader cannot complete it."),
    ]
    # This gold item crosses a context boundary, unlike the regular row grammar above.
    cases[-1]["expected"] = {"items": [{"code": "Slot0000", "amount": 10}]}
    cases[-1]["gold"] = [
        {"path": ["items", 0, "code"], "value": "Slot0000", "segment": "p1_s0", "page": 1, "start": 0, "end": 14},
        {"path": ["items", 0, "amount"], "value": 10, "segment": "p2_s0", "page": 2, "start": 0, "end": 10}]
    return cases


def metrics(case, result):
    actual, expected = result["records"][0], case["expected"]
    wanted, returned = expected.get("items") or [], actual.get("items") or []
    key = lambda value: json.dumps(value, sort_keys=True)
    available = defaultdict(deque)
    for index, item in enumerate(wanted):
        available[key(item)].append(index)
    alignment = {}
    for index, item in enumerate(returned):
        if available[key(item)]:
            alignment[index] = available[key(item)].popleft()
    gold = {tuple(item["path"]): item for item in case["gold"]}
    links = {tuple(item["path"])[2:]: item for item in result["evidence"]}
    proofs = {tuple(item["path"])[2:]: item for item in result["quoted_support"]}
    origins = {tuple(item["path"])[2:]: item for item in result["value_origins"]}
    expected_origins = origin_gold(case)
    correct = page_correct = span_correct = origin_correct = populated = 0
    for path, value in leaves(actual):
        populated += 1
        target = (("items", alignment.get(path[1], -1), *path[2:]) if path[0] == "items" else path)
        expected_leaf = gold.get(target)
        if expected_leaf is None or expected_leaf["value"] != value:
            continue
        correct += 1
        link, proof = links.get(path, {}), proofs.get(path, {})
        page_correct += link.get("page") == expected_leaf["page"]
        span_correct += all(proof.get(k) == expected_leaf[k] for k in ("segment", "start", "end"))
        origin_correct += origins.get(path, {}).get("sources") == expected_origins.get(target)
    ratio = lambda n, d: n / d if d else None
    calls = Counter(item["stage"] for item in result["calls"])
    gold_segments = {leaf["segment"] for leaf in case["gold"]}
    relevant = sum(bool(gold_segments.intersection([*unit["primary"], *unit["overlap"]]))
                   for unit in case["contexts"])
    return {"expected_array_occurrences": len(wanted), "returned_array_occurrences": len(returned),
            "array_count_delta": len(returned) - len(wanted), "matched_array_occurrences": len(alignment),
            "missing_array_occurrences": len(wanted) - len(alignment),
            "extra_array_occurrences": len(returned) - len(alignment),
            "array_occurrence_precision": ratio(len(alignment), len(returned)),
            "array_occurrence_recall": ratio(len(alignment), len(wanted)),
            "array_occurrence_f1": ratio(2 * len(alignment), len(returned) + len(wanted)),
            "exact_root": actual == expected,
            "expected_populated_leaves": len(gold), "returned_populated_leaves": populated,
            "field_value_precision": ratio(correct, populated), "field_value_recall": ratio(correct, len(gold)),
            "field_value_f1": ratio(2 * correct, populated + len(gold)),
            "page_occurrence_accuracy": ratio(page_correct, len(gold)),
            "canonical_span_occurrence_accuracy": ratio(span_correct, len(gold)),
            "exact_origin_source_accuracy": ratio(origin_correct, len(gold)),
            "page_correct_leaves": page_correct, "span_correct_leaves": span_correct,
            "supported_returned_leaves": len(links), "unsupported_returned_leaves": len(result["ungrounded"]),
            "calls_by_stage": dict(calls), "simulated_tokens": result["tokens"],
            "source_contexts_total": len(case["contexts"]), "source_contexts_with_gold": relevant,
            "source_contexts_exposed": calls["record"],
            "exposed_context_precision": ratio(relevant, calls["record"]),
            "attempted_source_region_recall": (1.0 if relevant and calls["record"] == len(case["contexts"])
                                                else None),
            "provider_retries": 0, "selective_escalations": None,
            "failed_calls": sum(not c["ok"] for c in result["calls"]),
            "issue_codes": dict(Counter(i["code"] for i in result["issues"])),
            "completion": result["completion"], "complete": result["complete"],
            "value_disagreements": result.get("disagreements", [])}


def register(output):
    path = output / "inputs.json"
    write_new(path, fixtures())
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    write_new(output / "manifest.json", {"version": 1, "base_revision": revision,
        "inputs": pin(path), "script": pin(Path(__file__)), "python": platform.python_version(),
        "model": "scripted", "network_calls": 0, "repeats": 1,
        "metric_scope": "Custom synthetic occurrence metrics, not official ExtractBench evaluation.",
        "factor": "Article occurrence lineage implementation; all inputs and provider logic fixed.",
        "metric_definitions": {
            "array_occurrence": "An item inside the one Article root, not a Catalog record.",
            "alignment": "Exact item multiset, equal items matched in source order; no fuzzy matching.",
            "field_value": "Populated leaves on exactly matched items, plus matching document scalars.",
            "grounding": "Correct page/span divided by gold populated leaves, including missing output leaves.",
            "attempted_source_region_recall": "Exposure of gold-bearing fixed contexts, not successful discovery.",
            "provider_retries": "Zero by design: scripted providers return one valid stop reply per request.",
            "selective_escalations": "Not applicable: no escalation policy is implemented or simulated."},
        "limitations": ["No live model accuracy, tokenizer, latency, dollar-cost, parser or OCR measurements.",
                        "One deterministic run per arm; wall time includes Python and artifact IO.",
                        "Partitioning replaced by frozen contexts; no inference about partitioner recall.",
                        "Synthetic span gold uses entire canonical row ranges, not character-level value boxes."]})


def run(output, arm):
    manifest = read(output / "manifest.json")
    cases = read(checked(manifest["inputs"]))
    checked(manifest["script"])
    arm_dir = output / arm
    arm_dir.mkdir(parents=True, exist_ok=True)
    source_dir = Path(article.__file__).parent
    write_new(arm_dir / "implementation.json", {"python": platform.python_version(), "model": "scripted",
        "module_root": str(source_dir), "files": {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                                   for path in sorted(source_dir.glob("*.py"))}})
    summary = []
    for case in cases:
        target = arm_dir / case["id"]
        source = tuple(Passage(**p) for p in case["source"])
        by_id = {p.id: p for p in source}
        contexts = [Context(tuple(by_id[k] for k in unit["primary"]),
                            tuple(by_id[k] for k in unit["overlap"]),
                            by_id.get(unit.get("heading"))) for unit in case["contexts"]]
        evidence = Evidence(case["id"], "synthetic-v1", manifest["inputs"]["sha256"],
                            "synthetic.txt", max(p.page for p in source), source)
        request = ExtractRequest(schema=case["schema"], options={"strategy": "article", "article": {
            "context": "bounded", "context_tokens": 131072, "grounding": "spans",
            "grounding_schedule": "unresolved", "grounding_routing": "origin_lexical"}})
        providers = {role: Capture(Scripted(role, case["provider_mode"]), target / "calls", role)
                     for role in ("fields", "reasoning")}
        started = time.perf_counter()
        with patch.object(article, "source_contexts", return_value=contexts), \
                patch.object(article, "partition", return_value=contexts):
            result = article.extract(None, evidence, request, Router(**providers),
                                     counter={role: WordCounter() for role in providers})
        elapsed = time.perf_counter() - started
        write_new(target / "result.json", result)
        score = {"case": case["id"], "arm": arm, "wall_seconds": elapsed, **metrics(case, result)}
        write_new(target / "metrics.json", score)
        summary.append(score)
        print(json.dumps(score), flush=True)
    write_new(arm_dir / "summary.json", summary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["register", "run"])
    parser.add_argument("output", type=Path)
    parser.add_argument("arm", nargs="?")
    args = parser.parse_args()
    if args.action == "register":
        register(args.output)
    elif not args.arm or not re.fullmatch(r"[a-zA-Z0-9_-]+", args.arm):
        parser.error("run requires a safe arm name")
    else:
        run(args.output, args.arm)


if __name__ == "__main__":
    main()
