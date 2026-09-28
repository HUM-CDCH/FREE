"""Freeze replay-verified upstream values and origins without any network access."""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, replace
from pathlib import Path

from kei_exp.kie.extract.article import extract_records
from kei_exp.kie.extract.contexts import Context, reconcile_values
from kei_exp.kie.extract.evidence import load
from kei_exp.kie.extract.method import ArticleOptions, LimitedCounter
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.stages import Issue, extract_document, merge

from .manifest import checked, pin, read, write_new
from .replay_reference import Captured, key


def normalized(value):
    return json.loads(json.dumps(value))


def restore_contexts(saved: list[dict], passages) -> list[Context]:
    by_id = {p.id: p for p in passages}
    if len(by_id) != len(passages):
        raise ValueError("canonical passage IDs must be unique")
    return [Context(tuple(by_id[name] for name in unit["primary"]),
                    tuple(by_id[name] for name in unit["overlap"]),
                    by_id[unit["heading"]] if "heading" in unit else None) for unit in saved]


class ReplayCounts:
    """Counts from sealed calls and pinned original-replay probes; missing means stop."""
    def __init__(self, captured: Captured, provider: dict, probes: list[dict]):
        self.context_tokens = provider["context_tokens"]
        self.counts = dict(captured.counts)
        for item in probes:
            probe = read(checked(item))
            if probe["provider"] != provider:
                raise ValueError("replay tokenizer provider differs from registered provider")
            name, count = key(probe["request"]), probe["count"]
            if self.counts.get(name) not in (None, count):
                raise ValueError("replay tokenizer counts disagree")
            self.counts[name] = count

    def request_tokens(self, system, user, schema=None):
        count = self.counts.get(key(dict(system=system, user=user, schema=schema)))
        if type(count) is not int or count < 0:
            raise ValueError("missing pinned tokenizer count; upstream preparation is offline")
        return count


def prepare(parent: Path, source_id: str, verification: Path) -> dict:
    study = read(parent / "manifest.json")
    source = next(item for item in study["sources"] if item["id"] == source_id)
    cell = f"{source_id}--bounded--0"
    report = read(verification)
    if report["manifest"] != pin(parent / "manifest.json"):
        raise ValueError("original replay belongs to another manifest")
    checked(report["script"])
    verified = next(item for item in report["verified"] if item["cell"] == cell)
    if (verified["fresh_model_calls"] != 0 or verified["fresh_tokenizer_probes"] != 0
            or verified["equal_except_top_level_clocks"] is not True):
        raise ValueError("upstream requires a successful HTTP-disabled original replay")
    directory = parent / "cells" / cell
    if verified["result"] != pin(directory / "result.json"):
        raise ValueError("parent result changed since original replay")
    captures = [pin(p) for p in sorted((directory / "calls").glob("*.json"))]
    if captures != verified["captures"]:
        raise ValueError("parent captures changed since original replay")
    for item in [source["schema"], *source["canonical_files"]]:
        checked(item)
    if source.get("pdf"):
        checked(source["pdf"])
    expected = read(directory / "result.json")["artifact"]
    if expected["schema"] != read(checked(source["schema"])):
        raise ValueError("parent schema differs from source pin")
    evidence = load(Path(source["run"]))
    if (evidence.generation, evidence.digest) != (source["generation"], source["digest"]):
        raise ValueError("canonical generation changed")
    schema = Schema.model_validate(expected["schema"])
    chats = {role: Captured(directory / "calls", role, provider["model"], provider["context_tokens"])
             for role, provider in study["providers"].items()}
    # Routing settings collect origins without changing any upstream request.
    method = ArticleOptions.model_validate({**expected["options"]["article"], "grounding": "spans",
        "grounding_schedule": "unresolved", "grounding_routing": "origin_lexical"})
    counters = {role: LimitedCounter(ReplayCounts(chats[role], provider, verified["tokenizer_probes"]),
                                     method.context_tokens) for role, provider in study["providers"].items()}
    contexts = restore_contexts(expected["contexts"], evidence.passages)
    router = Router(**chats)
    documents, calls, issues = [], [], []
    for context in contexts:
        document, attempts, problems = extract_document(replace(evidence, passages=context.passages), schema,
            router, budget=expected["options"]["record_chars"], counter=counters["fields"])
        documents.append(document)
        calls += attempts
        issues += problems
    document, conflicts = reconcile_values(documents) if len(documents) > 1 else (documents[0], [])
    issues += [Issue("conflicting_document_values", json.dumps(item, ensure_ascii=False)) for item in conflicts]
    extracted = extract_records(evidence.passages, schema, router, counters=counters,
        record_chars=expected["options"]["record_chars"], check=lambda: None, method=method, contexts=contexts)
    calls += extracted.calls
    issues += extracted.issues
    records = [merge(fields, document, evidence.source_name, schema) for _, fields in extracted.slices]
    value_contexts = [[unit.dumped() for unit in groups] for groups in extracted.value_contexts]
    current = {"records": records, "inventory": extracted.identities, "value_contexts": value_contexts,
               "conflicts": {"document": conflicts, "records": extracted.conflicts}}
    if normalized(current) != {key: expected[key] for key in current}:
        raise ValueError("fixed upstream differs from the original bounded extraction")
    if normalized([asdict(call) for call in calls]) != expected["calls"][:len(calls)] or any(
            call["stage"] != "grounding" for call in expected["calls"][len(calls):]):
        raise ValueError("upstream call accounting differs from original replay")
    if normalized([asdict(issue) for issue in issues]) != expected["issues"][:len(issues)]:
        raise ValueError("upstream diagnostics differ from original replay")
    if chats["fields"].index != len(chats["fields"].calls):
        raise ValueError("unconsumed upstream field replies")
    annotated = normalized(expected["schema"])
    annotations = []
    for node in annotated["schemaNodes"]:
        if node["id"] == "collagen.field_statuses":
            node["evidencePolicy"] = "derived"
            annotations.append({"id": node["id"], "policy": "derived", "reason": "absence/ambiguity diagnostics"})
    Schema.model_validate(annotated)
    return {"version": 1, "source": source_id, "run_id": evidence.run_id, "generation": evidence.generation,
        "digest": evidence.digest, "source_name": evidence.source_name, "schema": annotated,
        "policy_annotations": annotations, "upstream_options": expected["options"], **current,
        "fields": [fields for _, fields in extracted.slices], "document": document,
        "contexts": expected["contexts"], "value_origins": extracted.origins,
        "upstream_calls": [asdict(call) for call in calls], "upstream_issues": [asdict(issue) for issue in issues],
        "provenance": {"manifest": pin(parent / "manifest.json"), "result": verified["result"],
            "verification": pin(verification), "captures": captures, "tokenizer_probes": verified["tokenizer_probes"],
            "upstream_requests_replayed": sum(chat.index for chat in chats.values()), "fresh_calls": 0}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("parent", type=Path)
    parser.add_argument("source")
    parser.add_argument("verification", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    write_new(args.output, prepare(args.parent, args.source, args.verification))


if __name__ == "__main__":
    main()
