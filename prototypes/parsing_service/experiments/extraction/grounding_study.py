"""Register and execute grounding-only cells over immutable, replay-verified records.

Registration: python -m experiments.extraction.grounding_study PARENT BUNDLES OUTPUT
Execution uses the existing experiments.extraction.study capture/receipt runner.
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

from kei_exp.kie.extract.evidence import load
from kei_exp.kie.extract.grounding import ground_records
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.method import LimitedCounter
from kei_exp.kie.extract.run import PROMPT_VERSION, fingerprint
from kei_exp.kie.extract.routing import VERSION as ROUTING_VERSION
from kei_exp.kie.extract.spans import VERSION as SPAN_VERSION
from kei_exp.kie.extract.stages import leaves, merge

from .fixed_upstream import normalized, prepare, restore_contexts
from .manifest import checked, code_pin, digest, pin, read, validate, write_new

FACTORS = {
    "quoted": {"grounding": "quoted"},
    "spans": {"grounding": "spans"},
    "spans_unresolved": {"grounding": "spans", "grounding_schedule": "unresolved"},
    "spans_policy": {"grounding": "spans", "evidence_policy": "schema"},
    "spans_unresolved_policy": {"grounding": "spans", "grounding_schedule": "unresolved", "evidence_policy": "schema"},
    "spans_routed": {"grounding": "spans", "grounding_schedule": "unresolved", "evidence_policy": "schema",
                     "grounding_routing": "origin_lexical"},
}
GROUNDING_OPTIONS = {"grounding", "grounding_schedule", "evidence_policy", "grounding_routing"}


def validate_fixed_options(options: dict, original: dict) -> None:
    stripped = []
    for item in (options, original):
        copy = normalized(item)
        copy["article"] = {key: value for key, value in copy["article"].items() if key not in GROUNDING_OPTIONS}
        stripped.append(copy)
    if stripped[0] != stripped[1] or options["article"]["grounding"] not in {"quoted", "spans"}:
        raise ValueError("fixed grounding may change only grounding options on the bounded upstream")


class RecordedCounts:
    """Save every admission probe, including refused/split batches, for exact replay."""
    def __init__(self, counter, directory: Path, provider: dict):
        self.counter, self.directory, self.provider = counter, directory, provider
        self.context_tokens = counter.context_tokens
        if self.context_tokens != provider["context_tokens"]:
            raise ValueError("grounding tokenizer context differs from registered provider")

    def request_tokens(self, system, user, schema=None):
        request = dict(system=system, user=user, schema=schema)
        path = self.directory / (digest(json.dumps(request, sort_keys=True).encode()) + ".json")
        if path.exists():
            saved = read(path)
            if saved["request"] != normalized(request) or saved["provider"] != self.provider:
                raise ValueError("grounding tokenizer cache request/provider mismatch")
            return saved["count"]
        count = self.counter.request_tokens(system, user, schema)
        write_new(path, {"request": request, "provider": self.provider, "count": count})
        return count


class ModelBudget:
    """Bound cumulative captured model time, including reused replies on resumption.

    Admission stops before the next call; one in-flight reply may exceed the bound.
    This is neither a wall-time deadline nor a substitute for the product deadline.
    """
    def __init__(self, chat, limit: float):
        self.chat, self.model, self.limit, self.seconds = chat, chat.model, limit, 0.0

    def complete(self, **request):
        if self.seconds >= self.limit:
            raise TimeoutError("registered cumulative grounding model-time budget exhausted")
        reply = self.chat.complete(**request)
        self.seconds += reply.seconds
        return reply


def fixed_grounding(source: dict, request, chat, counters, *, model_seconds: float) -> dict:
    bundle_path = checked(source["fixed_upstream"])
    bundle = read(bundle_path)
    evidence = load(Path(source["run"]))
    if (evidence.generation, evidence.digest) != (bundle["generation"], bundle["digest"]):
        raise ValueError("fixed upstream canonical generation changed")
    schema, method = request.schema_, request.options.article
    if normalized(schema.model_dump(by_alias=True, exclude_none=True)) != bundle["schema"]:
        raise ValueError("grounding schema differs from the pinned upstream bundle")
    if method is None or request.options.strategy != "article":
        raise ValueError("fixed grounding requires an explicit Article method")
    validate_fixed_options(request.options.dumped(), bundle["upstream_options"])
    contexts = restore_contexts(bundle["contexts"], evidence.passages)
    value_contexts = [restore_contexts(saved, evidence.passages) for saved in bundle["value_contexts"]]
    counter = LimitedCounter(counters["reasoning"], method.context_tokens)
    limited = ModelBudget(chat.chats()["reasoning"], model_seconds)
    started, clock = datetime.now(UTC).isoformat(), time.monotonic()
    support = ground_records([(evidence.passages, fields) for fields in bundle["fields"]], schema, limited,
        check=lambda: None, budget=request.options.record_chars, counter=counter, method=method,
        identities=bundle["inventory"], contexts=contexts, value_contexts=value_contexts, origins=bundle["value_origins"])
    grounded = {link.path for link in support.links}
    paths = [("records", number, *path) for number, fields in enumerate(bundle["fields"]) for path, _ in leaves(fields)]
    ungrounded = [list(path) for path in paths if path not in grounded]
    def total(name):
        values = [getattr(call, name) for call in support.calls]
        return None if any(value is None for value in values) else sum(values)
    artifact = {"extraction_version": 1, "execution_scope": "grounding_on_fixed_upstream",
        "run_id": bundle["run_id"], "generation": bundle["generation"], "digest": bundle["digest"],
        "schema": bundle["schema"], "strategy": "article", "options": request.options.dumped(),
        "model": chat.model, "models": chat.models, "prompt_version": PROMPT_VERSION, "method_version": 1,
        "started": started, "seconds": round(time.monotonic() - clock, 3), "complete": False,
        "records": bundle["records"], "inventory": bundle["inventory"], "contexts": bundle["contexts"],
        "value_contexts": bundle["value_contexts"], "conflicts": bundle["conflicts"],
        "evidence": [{**asdict(link), "path": list(link.path), "bbox_pt": list(link.bbox_pt)} for link in support.links],
        "quoted_support": support.proofs, "ungrounded": ungrounded,
        "unverified": [node.name for node in schema.document_nodes],
        "issues": [{**asdict(issue), "path": list(issue.path) if issue.path else None} for issue in support.issues],
        "calls": [asdict(call) for call in support.calls],
        "tokens": {"input": total("input_tokens"), "output": total("output_tokens")},
        "upstream": source["fixed_upstream"],
        "completion": {"processing": all(call.ok for call in support.calls), "source_coverage": "fixed_upstream",
            "grounding": "complete" if not ungrounded else "partial", "record_recall": "unmeasured",
            "document_fields": "unverified" if schema.document_nodes else "not_applicable"}}
    if method.grounding == "spans":
        artifact["span_grounding_version"] = SPAN_VERSION
    if method.evidence_policy == "schema":
        eligible = set(paths) - {tuple(item["path"]) for item in support.skipped}
        artifact["grounding_eligibility"] = {"all_record_leaves": len(paths),
            "eligible_record_leaves": len(eligible), "skipped": support.skipped}
        artifact["completion"]["eligible_grounding"] = (
            "not_applicable" if not eligible else "complete" if eligible <= grounded else "partial")
    if method.grounding_routing:
        artifact["grounding_routing_version"] = ROUTING_VERSION
        artifact["value_origins"] = [{**item, "path": ["records", number, *item["path"]]}
            for number, origins in enumerate(bundle["value_origins"]) for item in origins]
        artifact["grounding_routes"] = support.routes
    artifact["fingerprint"] = digest(json.dumps({"method": fingerprint(artifact, request, chat.models),
        "upstream_sha256": source["fixed_upstream"]["sha256"], "scope": artifact["execution_scope"]}, sort_keys=True).encode())
    checked(source["fixed_upstream"])
    return artifact


def validate_bundle(source: dict, parent_pin: dict) -> None:
    bundle = read(checked(source["fixed_upstream"]))
    if (bundle["version"] != 1 or bundle["source"] != source["id"]
            or bundle["provenance"]["manifest"] != parent_pin
            or bundle["schema"] != read(checked(source["schema"]))
            or (bundle["generation"], bundle["digest"]) != (source["generation"], source["digest"])):
        raise ValueError("fixed upstream bundle does not match its source/parent/schema")
    for name in ("manifest", "result", "verification"):
        checked(bundle["provenance"][name])
    for item in bundle["provenance"]["captures"] + bundle["provenance"]["tokenizer_probes"]:
        checked(item)
    parent = read(checked(bundle["provenance"]["result"]))["artifact"]
    for name in ("records", "inventory", "contexts", "value_contexts", "conflicts"):
        if bundle[name] != parent[name]:
            raise ValueError(f"fixed upstream {name} differ from original bounded artifact")
    from kei_exp.kie.extract.schema import Schema
    schema = Schema.model_validate(bundle["schema"])
    if [merge(fields, bundle["document"], bundle["source_name"], schema) for fields in bundle["fields"]] != bundle["records"]:
        raise ValueError("fixed grounding fields do not reproduce the pinned records")
    if bundle["provenance"]["fresh_calls"] != 0:
        raise ValueError("upstream preparation must not generate new replies")


def preflight_fixed(study: dict, cells: list[dict], output: Path, counter) -> list[dict]:
    """Tokenizer-only all-NONE scenario, not an estimate of fresh support or latency."""
    from kei_exp.kie.extract.models import Router
    provider = study["providers"]["reasoning"]
    reports = []
    for cell in cells:
        counted = RecordedCounts(counter, output / "token-counts" / cell["id"], provider)
        batches = []
        class NoSupport:
            model = provider["model"]

            def complete(self, *, system, user, schema, max_tokens=None):
                batches.append(len(schema["required"]))
                answer = {claim: {"label": "NONE", "attribution": False,
                    **({"quote": ""} if "quote" in shape["properties"] else {})}
                    for claim, shape in schema["properties"].items()}
                return Reply(text=json.dumps(answer), input_tokens=counted.request_tokens(system, user, schema),
                             output_tokens=0, seconds=0, finish="stop")
        client = NoSupport()
        source = next(source for source in study["sources"] if source["id"] == cell["source"])
        artifact = fixed_grounding(source, cell["request"], Router(client, client), {"reasoning": counted},
                                   model_seconds=study["grounding_study"]["model_seconds_per_cell"])
        reports.append({"cell": cell["id"], "scenario": "scripted all-NONE; no model generation",
            "grounding_requests": len(artifact["calls"]), "input_tokens": artifact["tokens"]["input"],
            "claim_batch_sizes": batches, "issues": artifact["issues"],
            "all_record_leaves": sum(1 for fields in read(checked(source["fixed_upstream"]))["fields"]
                                     for _ in leaves(fields))})
        print(f"preflight {cell['id']}: {len(batches)} all-NONE batches", flush=True)
    return reports


def register(parent: Path, bundles: Path, output: Path) -> dict:
    original = read(parent / "manifest.json")
    study = normalized(original)
    study["id"] = "extraction-fixed-grounding-20260928-r5"
    study["order_seed"] = 20260928
    study["repeats"] = 1
    study["methods"] = {}
    for name, factors in FACTORS.items():
        method = normalized(original["methods"]["bounded"])
        method["article"].update(factors)
        study["methods"][name] = method
    study["comparisons"] = [{"control": a, "treatment": b, "factor": "article." + factor} for a, b, factor in [
        ("quoted", "spans", "grounding"), ("spans", "spans_unresolved", "grounding_schedule"),
        ("spans", "spans_policy", "evidence_policy"),
        ("spans_unresolved", "spans_unresolved_policy", "evidence_policy"),
        ("spans_policy", "spans_unresolved_policy", "grounding_schedule"),
        ("spans_unresolved_policy", "spans_routed", "grounding_routing")]]
    study["interactions"] = [{"name": "scheduling_x_policy", "baseline": "spans", "a": "spans_unresolved",
                              "b": "spans_policy", "ab": "spans_unresolved_policy"}]
    study["grounding_study"] = {"parent": pin(parent / "manifest.json"),
        "protocol": pin(Path(__file__).with_name("grounding-protocol.md")), "model_seconds_per_cell": 10800,
        "interpretation": "Fresh grounding only; identical replay-verified upstream records. No held-out semantic labels."}
    study["sources"] = [source for source in study["sources"] if "bounded" in source["methods"]]
    for source in study["sources"]:
        source["methods"] = list(FACTORS)
        bundle = read(bundles / f"{source['id']}.json")
        replayed = prepare(parent, source["id"], checked(bundle["provenance"]["verification"]))
        if normalized(replayed) != bundle:
            raise ValueError("prepared upstream bundle differs from exact replay, including origins")
        write_new(output / "upstream" / f"{source['id']}.json", bundle)
        source["fixed_upstream"] = pin(output / "upstream" / f"{source['id']}.json")
        schema_path = output / "schemas" / f"{source['id']}.json"
        write_new(schema_path, bundle["schema"])
        source["schema"] = pin(schema_path)
        validate_bundle(source, study["grounding_study"]["parent"])
    study["code_files"] = code_pin(Path(__file__).resolve().parents[2])
    validate(study, Path(__file__).resolve().parents[2])
    write_new(output / "manifest.json", study)
    return study


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("parent", type=Path)
    parser.add_argument("bundles", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    study = register(args.parent, args.bundles, args.output)
    print(f"Registered {len(study['sources']) * len(study['methods'])} grounding-only cells")


if __name__ == "__main__":
    main()
